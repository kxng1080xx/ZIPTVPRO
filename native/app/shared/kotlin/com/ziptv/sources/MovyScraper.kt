package com.ziptv.sources

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

/**
 * Native port of plugins/cinemaos/movy.js (movy.sx). api.wecollege.net hands out a per-title seed; each city
 * shard returns its sources encrypted with a seed-keyed stream cipher ("mvm1"). Playlists play with Movy's
 * Origin / Referer headers. Shards run concurrently (8 s each); we stop once two delivered sources.
 */
class MovyScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-movy"
    override val name = "CinemaOS · Movy"
    override val description = "Movy (movy.sx) HLS / MP4 streams"
    override val budgetMs = 19_000L

    private data class Src(val url: String, val quality: String, val type: String, val shard: String)
    private data class ShardResult(val shard: String, val data: JSONObject)

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        val tmdbNum = req.tmdbId.toLongOrNull() ?: return emptyList()
        val type = if (req.isMovie) "movie" else "tv"
        val (seed, info) = coroutineScope {
            val s = async { getSeed(tmdbNum) }
            val i = async { http.tmdbBrief(type, req.tmdbId) }
            s.await() to i.await()
        }
        Log.d(TAG, "seed=${seed?.take(8)} title='${info.title}' year=${info.year} imdb=${info.imdbId} tmdb=$tmdbNum")
        if (seed == null) return emptyList()
        val params = qs(
            "title" to info.title,
            "mediaType" to type,
            "year" to info.year,
            "tmdbId" to tmdbNum.toString(),
            "imdbId" to info.imdbId,
            "seasonId" to req.season.toString(),
            "episodeId" to req.episode.toString(),
            "enc" to "2",
            "seed" to seed
        )
        val shardHeaders = mapOf("User-Agent" to UA, "Accept" to "application/json, text/plain, */*") + SITE_HEADERS
        val results = parallelUntil<String, ShardResult>(
            items = SHARDS,
            timeoutMs = 8_000,
            enough = { got -> got.count { sourceCount(it.data) > 0 } >= 2 }
        ) { shard ->
            val t0 = System.currentTimeMillis()
            val res = http.fetch("$API/$shard/sources?$params", shardHeaders, timeoutMs = 8_000)
            if (res == null) { Log.d(TAG, "shard $shard: no response (${System.currentTimeMillis() - t0} ms)"); return@parallelUntil null }
            if (!res.ok) { Log.d(TAG, "shard $shard: HTTP ${res.code} ${res.text.take(80)}"); return@parallelUntil null }
            val plain = runCatching { decrypt(res.text, seed, tmdbNum.toInt()) }
                .onFailure {
                    val raw = runCatching { Base64.decode(res.text.trim().replace('-', '+').replace('_', '/').let { b -> b + "=".repeat((4 - b.length % 4) % 4) }, Base64.DEFAULT) }.getOrNull()
                    Log.d(TAG, "shard $shard: decrypt failed ${it.message} len=${res.text.length} ct=${res.header("content-type")} head='${res.text.take(48)}' tail='${res.text.takeLast(12)}' rawN=${raw?.size} seedLen=${seed.length} tmdb=$tmdbNum")
                }.getOrNull() ?: return@parallelUntil null
            Log.d(TAG, "shard $shard ok in ${System.currentTimeMillis() - t0} ms: ${plain.take(120)}")
            ShardResult(shard, JSONObject(plain))
        }

        val streams = ArrayList<Src>()
        val subtitles = ArrayList<PluginSubtitleResult>()
        val seen = HashSet<String>()
        for (r in results) {
            val sources = r.data.optJSONArray("sources") ?: JSONArray()
            for (i in 0 until sources.length()) {
                val s = sources.optJSONObject(i) ?: continue
                val url = s.str("url") ?: s.str("file") ?: continue
                if (!seen.add(url)) continue
                streams += Src(url, qualityOf(url, s.str("quality")), if (Regex("\\.mp4(\\?|$)").containsMatchIn(url)) "mp4" else "hls", r.shard)
            }
            val list = listOf("subtitles", "captions", "tracks", "subs").firstNotNullOfOrNull { r.data.optJSONArray(it) }
            if (list != null) {
                for (i in 0 until list.length()) {
                    val sub = list.opt(i)
                    val obj = sub as? JSONObject
                    val subUrl = (sub as? String) ?: obj?.str("url") ?: obj?.str("file") ?: obj?.str("src") ?: continue
                    if (seen.contains(subUrl)) continue
                    val kind = obj?.str("kind")
                    if (kind != null && !Regex("caption|subtitle", RegexOption.IGNORE_CASE).containsMatchIn(kind)) continue
                    seen += subUrl
                    val lang = (obj?.str("lang") ?: obj?.str("language") ?: obj?.str("srclang") ?: obj?.str("label") ?: "en").lowercase()
                    subtitles += PluginSubtitleResult(
                        url = subUrl,
                        language = lang,
                        name = obj?.str("name") ?: obj?.str("label") ?: lang.uppercase()
                    )
                }
            }
        }
        val headers = mapOf("User-Agent" to UA) + SITE_HEADERS

        // Real resolution from the HLS master RESOLUTION= (Movy's "1080p" server really tops out at 720p) and a token
        // check: links whose playlist / first segment does not answer (expired / IP-bound token) are dropped.
        val checked = parallelUntil<Src, Src>(
            items = streams,
            timeoutMs = 6_500,
            enough = { false },
        ) { st ->
            if (st.type != "hls") return@parallelUntil st
            val real = verifiedHeight(st.url, headers) ?: return@parallelUntil null
            if (real > 0) st.copy(quality = "${real}p") else st
        }
        val sorted = checked.sortedByDescending { rank(it.quality) }

        // No pre-verification (the RN app returns the shard answers straight away): shard CDN checks used to push
        // the scraper past its budget and drop every result.
        return sorted
            .map { st ->
                PluginRuntimeResult(
                    name = "${st.quality} · ${st.type.uppercase()}",
                    title = "Movy · ${st.quality} · ${st.shard}",
                    url = st.url,
                    quality = st.quality,
                    provider = "Movy",
                    language = "English",
                    type = st.type,
                    headers = headers,
                    subtitles = subtitles
                )
            }
    }

    private fun sourceCount(d: JSONObject) = d.optJSONArray("sources")?.length() ?: 0

    private suspend fun getSeed(tmdbId: Long): String? {
        val headers = mapOf("User-Agent" to UA) + SITE_HEADERS
        repeat(2) {
            val res = http.fetch("$API/seed?mediaId=$tmdbId", headers, timeoutMs = 5_000, maxBytes = 64 * 1024)
            Log.d(TAG, "seed fetch: ${res?.code} ${res?.text?.take(60)}")
            if (res == null) return null
            if (res.code == 429 && it == 0) { kotlinx.coroutines.delay(1_200); return@repeat }
            if (!res.ok) return null
            return runCatching { JSONObject(res.text).str("seed") }.getOrNull()
        }
        return null
    }

    /** Walk master -> variant -> first segment with Movy's headers; true only for real HLS whose first segment answers. */
    private suspend fun playlistOk(url: String, headers: Map<String, String>): Boolean {
        val host = CinemaHttp.hostOf(url)
        CinemaHttp.deadHosts[host]?.let { if (System.currentTimeMillis() - it < 600_000) return false }
        var ok = false
        try {
            var cur = url
            for (depth in 0 until 3) {
                val r = http.fetch(cur, headers, timeoutMs = 5_000, maxBytes = 512 * 1024) ?: break
                if (!r.ok) break
                val t = r.text
                if (!t.contains("#EXTM3U")) break
                val line = t.split('\n').map { it.trim() }.firstOrNull { it.isNotEmpty() && it[0] != '#' } ?: break
                val next = resolveUrl(cur, line)
                if (t.contains("#EXT-X-STREAM-INF") || Regex("\\.m3u8(\\?|$)", RegexOption.IGNORE_CASE).containsMatchIn(next)) {
                    cur = next
                    continue
                }
                val seg = http.fetch(next, headers + ("Range" to "bytes=0-1023"), timeoutMs = 5_000, maxBytes = 1)
                ok = seg?.ok == true
                break
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            ok = false
        }
        if (!ok) CinemaHttp.deadHosts[host] = System.currentTimeMillis()
        return ok
    }

    /**
     * Walks master -> variant -> first segment. Returns the best RESOLUTION= height declared by the master
     * (0 when the playlist is not a master), or null when the playlist or its first segment fails.
     */
    private suspend fun verifiedHeight(url: String, headers: Map<String, String>): Int? {
        val master = http.fetch(url, headers, timeoutMs = 5_000, maxBytes = 512 * 1024)
        if (master == null || !master.ok || !master.text.contains("#EXTM3U")) return null
        val height = Regex("RESOLUTION=\\d+x(\\d+)", RegexOption.IGNORE_CASE)
            .findAll(master.text).mapNotNull { it.groupValues[1].toIntOrNull() }.maxOrNull() ?: 0
        return if (playlistOk(url, headers)) height else null
    }

    private fun resolveUrl(base: String, ref: String): String {
        val r = ref.trim()
        if (Regex("^https?:", RegexOption.IGNORE_CASE).containsMatchIn(r)) return r
        if (r.startsWith("/")) return Regex("^https?://[^/]+", RegexOption.IGNORE_CASE).find(base)!!.value + r
        return base.replace(Regex("[?#].*$"), "").replace(Regex("[^/]*$"), "") + r
    }

    private fun qs(vararg pairs: Pair<String, String>) =
        pairs.joinToString("&") { (k, v) -> URLEncoder.encode(k, "UTF-8").replace("+", "%20") + "=" + URLEncoder.encode(v, "UTF-8").replace("+", "%20") }

    private fun qualityOf(url: String, q: String?): String {
        val m1 = Regex("(\\d{3,4})").find(q.orEmpty())?.groupValues?.get(1)
        val m2 = Regex("[-_/]s?(2160|1440|1080|720|480|360)p").find(url)?.groupValues?.get(1)
        val n = m1 ?: m2
        return if (n != null) "${n}p" else "Auto"
    }

    private fun rank(q: String) = Regex("^\\d+").find(q)?.value?.toIntOrNull() ?: 0

    // ---- mvm1 cipher ---------------------------------------------------------------------------

    private class CipherState(seed: String, tmdbId: Int) {
        val slots = IntArray(SLOTS)
        val present = BooleanArray(SLOTS)
        var acc: Int

        init {
            var i = mix(fnvSeed(seed) xor mix(tmdbId xor MS))
            for (r in 0 until 8) {
                val n = Integer.remainderUnsigned(i, SLOTS)
                i = Integer.rotateLeft(i + MS, 7 + (r and 7))
                slots[n] = i xor mix(i)
                present[n] = true
                i = mix(i + n)
            }
            acc = mix(i xor ACC_XOR)
        }

        fun next(offset: Int): Int {
            val r = Integer.remainderUnsigned(acc, SLOTS)
            val neg = if (present[r]) -1 else 0
            val x = slots[r] xor (MS * (offset + 1))
            var g = (acc xor x) or (acc and x and neg)
            g = Integer.rotateLeft(g + acc, r and 31) xor Integer.rotateLeft(acc, (r * 7) and 31)
            acc = mix(g + MS)
            slots[r] = acc
            present[r] = true
            return acc
        }
    }

    companion object {
        private const val TAG = "MovyScraper"
        private const val API = "https://api.wecollege.net"
        private val SHARDS = listOf("miami", "boise", "atlanta", "phoenix")
        private const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        private val SITE_HEADERS = mapOf("Origin" to "https://www.movy.sx", "Referer" to "https://www.movy.sx/")
        private const val SLOTS = 61
        private val MS = 0x9E3779B9.toInt()
        private val ACC_XOR = 0xA5A5A5A5.toInt()

        private fun mix(v: Int): Int {
            var l = v
            l = l xor (l ushr 16)
            l *= 0x85EBCA6B.toInt()
            l = l xor (l ushr 13)
            l *= 0xC2B2AE35.toInt()
            return l xor (l ushr 16)
        }

        private fun fnvSeed(s: String): Int {
            var o = 0x811C9DC5.toInt()
            for (ch in s) o = (o xor ch.code) * 16777619
            return mix(o)
        }

        fun decrypt(enc: String, seed: String, tmdbId: Int): String {
            var b64 = enc.trim().replace('-', '+').replace('_', '/')
            while (b64.length % 4 != 0) b64 += "="
            val raw = Base64.decode(b64, Base64.DEFAULT)
            val st = CipherState(seed, tmdbId)
            var idx = 0
            var off = 0
            while (idx < raw.size) {
                val d = st.next(off)
                var k = 0
                while (k < 4 && idx < raw.size) {
                    raw[idx] = (raw[idx].toInt() xor ((d ushr (8 * k)) and 0xff)).toByte()
                    idx++
                    k++
                }
                off++
            }
            if (raw.size < 4 || String(raw, 0, 4, Charsets.ISO_8859_1) != "mvm1") throw IllegalStateException("movy: bad payload")
            return String(raw, 4, raw.size - 4, Charsets.UTF_8)
        }
    }
}
