package com.ziptv.sources

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Native port of plugins/cinemaos/moviebox.js (MovieBox v10): signed mobile API (HMAC-MD5 over a canonical request),
 * then per language (original + dubs, concurrently) the H5 play endpoint, falling back to mobile play-info with host
 * rotation, plus resourceDetectors and per-link captions. javax.crypto / MessageDigest replace crypto-js.
 */
class MovieBoxScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-moviebox"
    override val name = "CinemaOS · MovieBox"
    override val description = "MovieBox streams (MP4 / DASH, multi-language)"
    override val budgetMs = 26_000L

    private class MbStream(
        val url: String,
        val format: String,
        val quality: String,
        val qualityNum: Int,
        val language: String,
        val headers: Map<String, String>,
        val cdnThrottled: Boolean,
        val subjectId: String? = null,
        val streamId: String = ""
    )

    private class Cap(val url: String, val label: String)
    private class CallResult(val json: JSONObject, val host: String)
    private class Subj(val id: String, val lang: String, var path: String?)
    private class H5(val data: JSONObject?, val netFail: Boolean)

    private val deviceId = (1..32).map { "0123456789abcdef"[kotlin.random.Random.nextInt(16)] }.joinToString("")
    private val clientInfo = """{"package_name":"com.community.mbox.in","version_name":"4.0.03.0920.03","version_code":50020130,"os":"android","os_version":"14","device_id":"$deviceId","install_store":"official","gaid":"1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d","brand":"samsung","model":"SM-S918B","system_language":"en","net":"NETWORK_WIFI","region":"IN","timezone":"Asia/Calcutta","sp_code":""}"""

    @Volatile private var cachedToken: String? = null
    private val tokenLock = Mutex()
    @Volatile private var lastGoodHost: String? = null
    private val resultCache = ConcurrentHashMap<String, Pair<Long, List<PluginRuntimeResult>>>()

    // ---- signing -------------------------------------------------------------------------------

    private fun md5Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("MD5").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun md5Hex(s: String) = md5Hex(s.toByteArray(Charsets.UTF_8))

    private fun dec(s: String): String = try {
        URLDecoder.decode(s, "UTF-8")
    } catch (e: Exception) {
        s
    }

    private fun canonicalString(method: String, contentType: String, url: String, body: String?, ts: Long): String {
        val m = Regex("^https?://[^/?#]+([^?#]*)(?:\\?([^#]*))?", RegexOption.IGNORE_CASE).find(url)
        val path = m?.groupValues?.get(1)?.ifEmpty { "/" } ?: "/"
        val pairs = (m?.groupValues?.get(2) ?: "").split('&').filter { it.isNotEmpty() }.map { p ->
            val i = p.indexOf('=')
            if (i < 0) dec(p) to "" else dec(p.substring(0, i)) to dec(p.substring(i + 1))
        }
        val keys = pairs.map { it.first }.distinct().sorted()
        val query = keys.joinToString("&") { k -> pairs.filter { it.first == k }.joinToString("&") { "$k=${it.second}" } }
        val canonicalUrl = if (query.isNotEmpty()) "$path?$query" else path
        var bodyHash = ""
        var bodyLen = ""
        if (body != null) {
            val bytes = body.toByteArray(Charsets.UTF_8)
            bodyLen = bytes.size.toString()
            bodyHash = md5Hex(bytes)
        }
        return method.uppercase() + "\napplication/json\n" + contentType + "\n" + bodyLen + "\n" + ts + "\n" + bodyHash + "\n" + canonicalUrl
    }

    private fun signature(method: String, contentType: String, url: String, body: String?, ts: Long, alt: Boolean): String {
        val mac = Mac.getInstance("HmacMD5")
        mac.init(SecretKeySpec(if (alt) SECRET_ALT else SECRET_DEFAULT, "HmacMD5"))
        val out = Base64.encodeToString(mac.doFinal(canonicalString(method, contentType, url, body, ts).toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        return "$ts|2|$out"
    }

    private fun buildHeaders(
        url: String,
        method: String = "GET",
        body: String? = null,
        alt: Boolean = false,
        details: Boolean = false,
        playback: Boolean = false,
        token: String? = null
    ): Map<String, String> {
        val ts = System.currentTimeMillis()
        val contentType = if (method == "POST") "application/json; charset=utf-8" else "application/json"
        val h = LinkedHashMap<String, String>()
        h["User-Agent"] = APP_UA
        h["Accept"] = "application/json"
        h["Content-Type"] = contentType
        h["x-client-token"] = "$ts," + md5Hex(ts.toString().reversed())
        h["x-tr-signature"] = signature(method, contentType, url, body, ts, alt)
        h["x-client-info"] = clientInfo
        h["x-client-status"] = "0"
        if (details) h["x-play-mode"] = "2"
        if (playback) h["x-play-mode"] = "1"
        if (token != null) h["authorization"] = "Bearer $token"
        return h
    }

    // ---- token ---------------------------------------------------------------------------------

    private fun jwtExpiry(token: String): Long = try {
        JSONObject(b64UrlDecode(token.split('.')[1])).optLong("exp", 0) * 1000
    } catch (e: Exception) {
        0L
    }

    private fun tokenValid(t: String?) = !t.isNullOrEmpty() && jwtExpiry(t) > System.currentTimeMillis() + 60_000

    private suspend fun getToken(): String? {
        if (tokenValid(cachedToken)) return cachedToken
        return tokenLock.withLock {
            if (tokenValid(cachedToken)) return@withLock cachedToken
            for (host in hosts()) {
                val url = "$host/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1"
                for (ai in 0 until 2) {
                    val res = http.fetch(url, buildHeaders(url, alt = ai == 1), timeoutMs = 4_000, maxBytes = 1) ?: continue
                    val token = Regex("\"token\"\\s*:\\s*\"([^\"]+)\"").find(res.header("x-user"))?.groupValues?.get(1)
                    if (tokenValid(token)) {
                        cachedToken = token
                        lastGoodHost = host
                        return@withLock token
                    }
                }
            }
            null
        }
    }

    private fun hosts(): List<String> {
        val good = lastGoodHost ?: return HOSTS
        return listOf(good) + HOSTS.filter { it != good }
    }

    // ---- request with host rotation ------------------------------------------------------------

    private suspend fun call(
        path: String,
        method: String = "GET",
        body: String? = null,
        details: Boolean = false,
        playback: Boolean = false,
        accept: ((JSONObject) -> String)? = null
    ): CallResult? {
        val token = getToken()
        var fallback: CallResult? = null
        var rejects = 0 // authoritative "no usable data" answers - other hosts say the same
        for (host in hosts()) {
            if (rejects >= 2) break
            val url = host + path
            for (ai in 0 until 2) {
                val res = http.fetch(
                    url,
                    buildHeaders(url, method, if (method == "POST") (body ?: "") else null, ai == 1, details, playback, token),
                    method = method,
                    body = if (method == "POST") (body ?: "") else null,
                    timeoutMs = 5_000
                ) ?: continue
                val text = res.text.trim()
                if (!text.startsWith("{")) continue
                val json = runCatching { JSONObject(text) }.getOrNull() ?: continue
                if (json.optInt("code", -1) != 0) continue
                val verdict = accept?.invoke(json) ?: "ok"
                if (verdict == "reject") {
                    rejects++
                    break
                }
                if (verdict == "fallback") {
                    if (fallback == null) fallback = CallResult(json, host)
                    rejects++
                    break
                }
                lastGoodHost = host
                return CallResult(json, host)
            }
        }
        return fallback
    }

    // ---- stream helpers ------------------------------------------------------------------------

    private fun isBrokenUrl(u: String) = u.contains("b164fbfb43477929") || u.contains("macdn.aoneroom.com/other/")

    private fun realStreamUrl(rawUrl: String, signCookie: String?): String {
        val cookie = signCookie?.trim()?.removeSuffix(";").orEmpty()
        if (cookie.isNotEmpty()) {
            if (cookie.contains("urlprefix=")) {
                runCatching {
                    val decoded = b64UrlDecode(cookie.split("urlprefix=")[1].split(";")[0].split(":sign=")[0]).trim()
                    if (decoded.startsWith("http")) return (if (decoded.endsWith("/")) decoded else "$decoded/") + "index.mpd"
                }
            }
            if (cookie.contains("CloudFront-Policy=")) {
                runCatching {
                    val b64 = cookie.split("CloudFront-Policy=")[1].split(";")[0].replace('-', '+').replace('_', '/').replace('~', '=')
                    val policy = JSONObject(String(Base64.decode(padB64(b64), Base64.DEFAULT), Charsets.UTF_8))
                    val resource = policy.optJSONArray("Statement")?.optJSONObject(0)?.str("Resource")
                    if (resource != null && resource.startsWith("http")) {
                        val star = resource.lastIndexOf('*')
                        val base = resource.substring(0, if (star < 0) resource.length - 1 else star)
                        return (if (base.endsWith("/")) base else "$base/") + "index.mpd"
                    }
                }
            }
        }
        return rawUrl
    }

    private fun padB64(s: String): String {
        var b = s
        while (b.length % 4 != 0) b += "="
        return b
    }

    private fun b64UrlDecode(s: String): String =
        String(Base64.decode(padB64(s.replace('-', '+').replace('_', '/')), Base64.DEFAULT), Charsets.UTF_8)

    private fun formatOf(url: String, declared: String? = null): String {
        val d = declared.orEmpty().uppercase()
        if (d == "DASH") return "dash"
        if (d == "HLS") return "hls"
        if (Regex("\\.mpd(\\?|$)|/dash/").containsMatchIn(url)) return "dash"
        if (Regex("\\.m3u8(\\?|$)").containsMatchIn(url)) return "hls"
        return "mp4"
    }

    private fun qualityNum(r: String): Int = r.replace(Regex("\\D"), "").toIntOrNull() ?: 0

    private fun JSONObject.anyStr(name: String): String = if (isNull(name)) "" else opt(name).toString()

    // ---- search --------------------------------------------------------------------------------

    private fun norm(s: String) = s.lowercase().replace(Regex("[^a-z0-9]+"), "")
    private fun stripTags(t: String) =
        norm(t.replace(Regex("\\[[^\\]]*\\]"), " ").replace(Regex("\\bS\\d+(\\s*-\\s*S?\\d+)?\\b", RegexOption.IGNORE_CASE), " "))

    private suspend fun findSubject(title: String, year: String, type: String, season: Int, episode: Int): JSONObject? {
        val body = """{"page":1,"perPage":20,"keyword":${JSONObject.quote(title)},"restrictKid":1}"""
        val r = call("/wefeed-mobile-bff/subject-api/search/v2", method = "POST", body = body)
        val results = r?.json?.optJSONObject("data")?.optJSONArray("results") ?: JSONArray()
        val subjects = ArrayList<JSONObject>()
        for (i in 0 until results.length()) {
            val subs = results.optJSONObject(i)?.optJSONArray("subjects") ?: continue
            for (j in 0 until subs.length()) subs.optJSONObject(j)?.let { subjects += it }
        }
        if (type == "tv") {
            val base = norm(title)
            val byId = LinkedHashMap<String, JSONObject>()
            for (s in subjects) {
                if (s.optInt("subjectType") != 2 || stripTags(s.str("title").orEmpty()) != base) continue
                val sid = s.anyStr("subjectId")
                val prev = byId[sid]
                if (prev == null || (prev.str("title").orEmpty().contains('[') && !s.str("title").orEmpty().contains('['))) byId[sid] = s
            }
            val ordered = byId.values.sortedBy { if (it.str("title").orEmpty().contains('[')) 1 else 0 }
            val checks = coroutineScope {
                ordered.take(5).map { cand ->
                    async {
                        val si = call("/wefeed-mobile-bff/subject-api/season-info?subjectId=${cand.anyStr("subjectId")}", details = true)
                        val seasons = si?.json?.optJSONObject("data")?.optJSONArray("seasons")
                        var hit = false
                        if (seasons != null) for (k in 0 until seasons.length()) {
                            val x = seasons.optJSONObject(k) ?: continue
                            if (x.optInt("se", -1) == season && x.optInt("maxEp", 0) >= episode) hit = true
                        }
                        hit
                    }
                }.awaitAll()
            }
            val hitIdx = checks.indexOf(true)
            if (hitIdx >= 0) return ordered[hitIdx]
        }
        val want = if (type == "movie") 1 else 2
        var best: JSONObject? = null
        var bestScore = 0
        for (s in subjects) {
            if (s.optInt("subjectType") != want) continue
            val t = norm(s.str("title").orEmpty())
            val y = s.str("year") ?: s.str("releaseDate").orEmpty().take(4)
            var score = 0
            if (t == norm(title)) score += 50
            else if (t.contains(norm(title)) || norm(title).contains(t)) score += 15
            if (year.isNotEmpty() && y.isNotEmpty() && year == y) score += 35
            if (score > bestScore) {
                bestScore = score
                best = s
            }
        }
        return if (bestScore >= 40) best else null
    }

    // ---- H5 play endpoint ----------------------------------------------------------------------

    private fun h5Referer(detailPath: String, id: String) =
        "$H5_BASE/movies/$detailPath?id=$id&type=/movie/detail&detailSe=&detailEp=&lang=en"

    private suspend fun h5PlayOnce(subjectId: String, se: Int, ep: Int, detailPath: String): H5 {
        val token = getToken()
        val url = "$H5_BASE/wefeed-h5api-bff/subject/play?subjectId=$subjectId&se=$se&ep=$ep" +
            "&detailPath=${java.net.URLEncoder.encode(detailPath, "UTF-8")}&streamSignType=1&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1"
        val headers = LinkedHashMap<String, String>()
        headers["User-Agent"] = H5_UA
        headers["Origin"] = H5_BASE
        headers["Referer"] = h5Referer(detailPath, subjectId)
        headers["Accept"] = "application/json"
        headers["x-client-info"] = "{\"timezone\":\"Asia/Calcutta\"}"
        headers["x-request-lang"] = "en"
        headers["x-vip-restrict"] = "0"
        headers["x-no-high-risk-restrict"] = "0"
        headers["x-source"] = ""
        if (token != null) headers["Authorization"] = "Bearer $token"
        val res = http.fetch(url, headers, timeoutMs = 6_000) ?: return H5(null, true) // connect timeout / reset: no retry
        val text = res.text.trim()
        if (!text.startsWith("{")) return H5(null, false)
        return H5(runCatching { JSONObject(text).optJSONObject("data") }.getOrNull(), false)
    }

    private suspend fun h5Play(subjectId: String, se: Int, ep: Int, detailPath: String): JSONObject? {
        val first = h5PlayOnce(subjectId, se, ep, detailPath)
        if (first.netFail) return null
        if (first.data != null) return first.data
        val second = h5PlayOnce(subjectId, se, ep, detailPath)
        return if (second.netFail) null else second.data
    }

    // ---- resourceDetectors ---------------------------------------------------------------------

    private fun detectorStreams(detectors: JSONArray?, type: String, season: Int, episode: Int, language: String): List<MbStream> {
        val out = ArrayList<MbStream>()
        if (detectors == null) return out
        for (i in 0 until detectors.length()) {
            val list = detectors.optJSONObject(i)?.optJSONArray("resolutionList") ?: continue
            for (j in 0 until list.length()) {
                val v = list.optJSONObject(j) ?: continue
                val url = v.str("resourceLink").orEmpty()
                if (url.isEmpty() || url.startsWith("magnet:") || isBrokenUrl(url)) continue
                if (type == "tv") {
                    val vs = if (v.isNull("se")) null else v.optInt("se")
                    val ve = if (v.isNull("ep")) null else v.optInt("ep")
                    if (vs != null && ve != null && (vs != season || ve != episode)) continue
                }
                val n = qualityNum(v.anyStr("resolution"))
                out += MbStream(url, formatOf(url), if (n > 0) "${n}p" else "Auto", n, language, mapOf("User-Agent" to APP_UA), false)
            }
        }
        return out
    }

    // ---- subtitles -----------------------------------------------------------------------------

    private suspend fun getSubtitles(subjectId: String, streamId: String): List<Cap> {
        val rs = coroutineScope {
            listOf(
                async { call("/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=$subjectId&streamId=$streamId") },
                async { call("/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=$subjectId&resourceId=$streamId&episode=0") }
            ).awaitAll()
        }
        val out = ArrayList<Cap>()
        val seen = HashSet<String>()
        for (r in rs) {
            val caps = r?.json?.optJSONObject("data")?.optJSONArray("extCaptions") ?: continue
            for (i in 0 until caps.length()) {
                val cap = caps.optJSONObject(i) ?: continue
                val url = cap.str("url") ?: continue
                if (!seen.add(url)) continue
                out += Cap(url, cap.str("lanName") ?: cap.str("language") ?: cap.str("lan") ?: "Subtitle")
            }
        }
        return out
    }

    // ---- main ----------------------------------------------------------------------------------

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        val type = if (req.isMovie) "movie" else "tv"
        val cacheKey = "$type:${req.tmdbId}:${req.season}:${req.episode}"
        resultCache[cacheKey]?.let { if (System.currentTimeMillis() - it.first < 600_000) return it.second }

        val brief = coroutineScope {
            // warm the (mutex-guarded) token while TMDB resolves
            val tok = async { getToken() }
            val b = async { http.tmdbBrief(type, req.tmdbId) }
            tok.await()
            b.await()
        }
        if (brief.title.isEmpty()) return emptyList()
        val subject = findSubject(brief.title, brief.year, type, req.season, req.episode) ?: return emptyList()
        val subjectId = subject.anyStr("subjectId")

        val detail = call("/wefeed-mobile-bff/subject-api/get?subjectId=$subjectId", details = true)
        val d = detail?.json?.optJSONObject("data")
        var originalLang = "Original"
        val subjects = ArrayList<Subj>()
        val dubs = d?.optJSONArray("dubs")
        if (dubs != null) for (i in 0 until dubs.length()) {
            val dub = dubs.optJSONObject(i) ?: continue
            if (dub.anyStr("subjectId") == subjectId) originalLang = dub.str("lanName") ?: "Original"
            else subjects += Subj(dub.anyStr("subjectId"), niceDubLabel(dub.str("lanName") ?: ""), dub.str("detailPath"))
        }
        // "Original Audio" becomes "<title language> (Original Audio)" so the app can tell English originals from foreign ones.
        val tmdb = http.tmdbDetails(type, req.tmdbId)
        val originalCode = tmdb?.str("original_language")
        originalLang = if (originalCode != null) "${SourceLanguage.labelOf(originalCode)} (Original Audio)" else "Original Audio"
        val runtimeMin = runtimeMinutes(tmdb, type)
        val detailPath = d?.optJSONObject("subject")?.str("detailPath")
            ?: d?.str("detailPath")
            ?: d?.str("detailUrl")?.substringAfterLast('/')?.substringBefore('?')?.takeIf { it.isNotEmpty() }
            ?: ""
        // H5 play keys on detailPath, so a dub must use its OWN path (the original's returns the original audio)
        subjects.add(0, Subj(subjectId, originalLang, detailPath))

        val se = if (type == "tv") req.season else 0
        val ep = if (type == "tv") req.episode else 0
        val streams = java.util.Collections.synchronizedList(ArrayList<MbStream>())
        streams.addAll(detectorStreams(d?.optJSONArray("resourceDetectors"), type, req.season, req.episode, originalLang))
        val captions = java.util.Collections.synchronizedList(ArrayList<Cap>())
        val pushCaps: (JSONArray?, JSONArray?) -> Unit = { a, b ->
            for (list in listOf(a, b)) {
                if (list != null) for (i in 0 until list.length()) {
                    val cap = list.optJSONObject(i) ?: continue
                    val url = cap.str("url") ?: cap.str("file") ?: continue
                    captions += Cap(url, cap.str("lanName") ?: cap.str("language") ?: cap.str("name") ?: "Unknown")
                }
            }
        }

        val needed = minOf(subjects.size, maxOf(2, (subjects.size + 1) / 2))
        // wait for the original + most dubs; one hung dub host must not hold the whole result
        parallelUntil<Int, Int>(
            items = subjects.indices.toList(),
            timeoutMs = 16_000,
            enough = { got -> got.size >= needed && (0 in got || streams.isNotEmpty()) }
        ) { idx ->
            withTimeoutOrNull(14_000) {
                try {
                    scrapeSubject(subjects[idx], type, se, ep, streams, pushCaps)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // a failed language only drops that language
                }
            }
            idx
        }

        // a dub that resolved to the original's file is not a real language version
        val snapshot = synchronized(streams) { streams.toList() }
        val origUrls = snapshot.filter { it.subjectId == subjectId || it.subjectId == null }.map { it.url.substringBefore('?') }.toHashSet()
        val filtered = snapshot
            .filter { !(it.subjectId != null && it.subjectId != subjectId && it.url.substringBefore('?') in origUrls) }
            .sortedWith(compareBy<MbStream> { it.cdnThrottled }.thenByDescending { it.qualityNum })

        // Files far shorter than the title (half-episode "dub" cuts) are not a real version of it.
        val complete = if (runtimeMin > 0) dropShortFiles(filtered, runtimeMin) else filtered

        // Per-link subtitles (first few unique links only), bounded so they never delay playback by more than a moment.
        val capByUrl = HashMap<String, List<Cap>>()
        val seenRef = HashSet<String>()
        val refs = complete.filter { it.subjectId != null && it.streamId.isNotEmpty() && seenRef.add(it.subjectId + "|" + it.streamId) }
        withTimeoutOrNull(4_000) {
            coroutineScope {
                refs.take(4).map { st ->
                    async {
                        val caps = runCatching { getSubtitles(st.subjectId!!, st.streamId) }.getOrDefault(emptyList())
                        synchronized(capByUrl) {
                            complete.forEach { x ->
                                if (x.subjectId == st.subjectId && x.streamId == st.streamId) capByUrl[x.url + "|" + x.streamId] = caps
                            }
                        }
                    }
                }.awaitAll()
            }
        }

        val shared = synchronized(captions) { captions.toList() }.map { PluginSubtitleResult(url = it.url, language = it.label, name = "MovieBox") }
        val seenKeys = HashSet<String>()
        val out = complete
            .filter { seenKeys.add(it.url + "|" + it.quality + "|" + it.language) }
            .map { st ->
                val own = (synchronized(capByUrl) { capByUrl[st.url + "|" + st.streamId] } ?: emptyList())
                    .map { PluginSubtitleResult(url = it.url, language = it.label, name = "MovieBox") }
                PluginRuntimeResult(
                    name = "${st.quality} · ${st.format.uppercase()}",
                    title = "MovieBox · ${st.quality} · ${st.language}",
                    url = st.url,
                    quality = st.quality,
                    language = st.language,
                    provider = "MovieBox",
                    type = st.format,
                    headers = st.headers,
                    subtitles = if (own.isNotEmpty()) own else shared
                )
            }
        if (out.isNotEmpty()) resultCache[cacheKey] = System.currentTimeMillis() to out
        return out
    }

    /** "ptbr dub" -> "Portuguese (BR) Dub", "esla dub" -> "Spanish (LatAm) Dub"; unknown labels pass through. */
    private fun niceDubLabel(raw: String): String {
        val info = SourceLanguage.parse(raw)
        val code = info.primary ?: return raw
        val lower = raw.lowercase()
        val region = when {
            Regex("pt[-_ ]?br|brazil").containsMatchIn(lower) -> " (BR)"
            Regex("esla|latam|latino").containsMatchIn(lower) -> " (LatAm)"
            else -> ""
        }
        return "${SourceLanguage.labelOf(code)}$region Dub"
    }

    private fun runtimeMinutes(tmdb: JSONObject?, type: String): Int {
        if (tmdb == null) return 0
        if (type == "movie") return tmdb.optInt("runtime", 0)
        val list = tmdb.optJSONArray("episode_run_time")
        val fromList = if (list != null && list.length() > 0) list.optInt(0, 0) else 0
        if (fromList > 0) return fromList
        return tmdb.optJSONObject("last_episode_to_air")?.optInt("runtime", 0) ?: 0
    }

    /** Drops MP4 links whose real duration (mvhd) is under 60 percent of the TMDB runtime. Unknown durations stay. */
    private suspend fun dropShortFiles(streams: List<MbStream>, runtimeMin: Int): List<MbStream> {
        val mp4Urls = streams.filter { it.format == "mp4" }.map { it.url }.distinct().take(12)
        if (mp4Urls.isEmpty()) return streams
        val headersByUrl = streams.associate { it.url to it.headers }
        val durations = HashMap<String, Double>()
        val probed = parallelUntil<String, Pair<String, Double>>(
            items = mp4Urls,
            timeoutMs = 8_000,
            enough = { false },
        ) { u -> http.mp4DurationSec(u, headersByUrl[u] ?: emptyMap(), 6_000)?.let { u to it } }
        probed.forEach { durations[it.first] = it.second }
        val minSec = runtimeMin * 60.0 * 0.6
        val kept = streams.filter { st ->
            val d = durations[st.url]
            d == null || d >= minSec
        }
        // A wrong TMDB runtime must never empty the result.
        return kept.ifEmpty { streams }
    }

    private suspend fun scrapeSubject(
        s: Subj,
        type: String,
        se: Int,
        ep: Int,
        streams: MutableList<MbStream>,
        pushCaps: (JSONArray?, JSONArray?) -> Unit
    ) {
        val language = s.lang.ifEmpty { "Original" }
        if (s.path.isNullOrEmpty()) {
            val dd = call("/wefeed-mobile-bff/subject-api/get?subjectId=${s.id}", details = true)
            val ddd = dd?.json?.optJSONObject("data")
            s.path = ddd?.optJSONObject("subject")?.str("detailPath")
                ?: ddd?.str("detailPath")
                ?: ddd?.str("detailUrl")?.substringAfterLast('/')?.substringBefore('?')?.takeIf { it.isNotEmpty() }
        }
        val dPath = s.path
        if (!dPath.isNullOrEmpty()) {
            val h5 = h5Play(s.id, se, ep, dPath)
            var got = 0
            val hs = h5?.optJSONArray("streams")
            if (hs != null) for (i in 0 until hs.length()) {
                val st = hs.optJSONObject(i) ?: continue
                val url = st.str("url").orEmpty()
                if (url.isEmpty() || url.startsWith("magnet:") || isBrokenUrl(url)) continue
                for (r in (st.str("resolutions") ?: "Auto").split(',')) {
                    val n = qualityNum(r)
                    streams += MbStream(
                        url, formatOf(url, st.str("format")), if (n > 0) "${n}p" else "Auto", n, language,
                        mapOf("Referer" to "$H5_BASE/", "User-Agent" to H5_UA), false, s.id, st.anyStr("id")
                    )
                    got++
                }
            }
            val hd = h5?.optJSONArray("dash")
            if (hd != null) for (i in 0 until hd.length()) {
                val dsh = hd.optJSONObject(i) ?: continue
                val url = dsh.str("url").orEmpty()
                if (url.isEmpty() || isBrokenUrl(url)) continue
                val cookie = dsh.str("signCookie")?.trim()?.removeSuffix(";").orEmpty()
                val headers = LinkedHashMap<String, String>()
                headers["Origin"] = H5_BASE
                headers["Referer"] = h5Referer(dPath, s.id)
                headers["User-Agent"] = H5_UA
                if (cookie.isNotEmpty()) {
                    headers["Cookie"] = cookie
                    headers[dsh.str("signHeaderKey") ?: "X-MB-Token"] = cookie
                }
                for (r in (dsh.str("resolutions") ?: "Auto").split(',')) {
                    val n = qualityNum(r)
                    streams += MbStream(url, "dash", if (n > 0) "${n}p" else "Auto", n, language, headers, false, s.id, dsh.anyStr("id"))
                    got++
                }
            }
            pushCaps(h5?.optJSONArray("captions"), h5?.optJSONArray("extCaptions"))
            if (got > 0) return
        }

        val r = call(
            "/wefeed-mobile-bff/subject-api/play-info?subjectId=${s.id}&se=$se&ep=$ep",
            playback = true,
            accept = { json ->
                val list = json.optJSONObject("data")?.optJSONArray("streams")
                if (list == null || list.length() == 0) {
                    "reject"
                } else {
                    var allBroken = true
                    for (i in 0 until list.length()) {
                        val x = list.optJSONObject(i)
                        if (!isBrokenUrl(realStreamUrl(x?.str("url").orEmpty(), x?.str("signCookie")))) allBroken = false
                    }
                    if (allBroken) "reject" else if (json.optJSONObject("data")?.optInt("cdnThrottleLevel") == 1) "fallback" else "ok"
                }
            }
        )
        val data = r?.json?.optJSONObject("data")
        val list = data?.optJSONArray("streams")
        if (list != null) for (i in 0 until list.length()) {
            val st = list.optJSONObject(i) ?: continue
            val url = realStreamUrl(st.str("url").orEmpty(), st.str("signCookie"))
            if (url.isEmpty() || url.startsWith("magnet:") || isBrokenUrl(url)) continue
            val cookie = st.str("signCookie")?.trim()?.removeSuffix(";").orEmpty()
            val headers = LinkedHashMap<String, String>()
            headers["User-Agent"] = APP_UA
            headers["Referer"] = REFERER
            if (cookie.isNotEmpty()) headers["Cookie"] = cookie
            for (q in (st.str("resolutions") ?: "Auto").split(',')) {
                val n = qualityNum(q)
                streams += MbStream(
                    url, formatOf(url, st.str("format")), if (n > 0) "${n}p" else "Auto", n, language, headers,
                    data.optInt("cdnThrottleLevel") == 1, s.id, st.anyStr("id")
                )
            }
        }
        pushCaps(data?.optJSONArray("captions"), data?.optJSONArray("extCaptions"))
    }

    private companion object {
        val HOSTS = listOf(
            "https://api3.aoneroom.com",
            "https://api6.aoneroom.com",
            "https://api5.aoneroom.com",
            "https://api4.aoneroom.com",
            "https://api7.aoneroom.com",
            "https://api4sg.aoneroom.com",
            "https://apig.inmoviebox.com",
            "https://api.inmoviebox.com",
            "https://api-in.inmoviebox.com"
        )
        const val KEY_DEFAULT = "NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw=="
        const val KEY_ALT = "WHFuMm5uTzQxL0w5Mm8xaXVYaFNMSFRiWHZZNFo1Wlo2Mm04bVNMQQ=="
        const val APP_UA = "com.community.mbox.in/50020130 (Linux; U; Android 14; en_IN; SM-S918B; Build/UD1A.230803.041; Cronet/145.0.7582.0)"
        const val REFERER = "https://moviebox.ph/"
        const val H5_BASE = "https://movie-box.co"
        const val H5_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36"

        // base64 -> utf8 string -> base64 -> raw key bytes (same double decode as the plugin's keyOf)
        fun keyOf(b64: String): ByteArray {
            val inner = String(Base64.decode(b64, Base64.DEFAULT), Charsets.UTF_8)
            return Base64.decode(inner, Base64.DEFAULT)
        }

        val SECRET_DEFAULT: ByteArray by lazy { keyOf(KEY_DEFAULT) }
        val SECRET_ALT: ByteArray by lazy { keyOf(KEY_ALT) }
    }
}
