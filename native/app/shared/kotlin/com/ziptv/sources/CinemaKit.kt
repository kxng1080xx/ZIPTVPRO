package com.ziptv.sources

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.json.JSONObject
import java.net.URLDecoder
import java.net.URLEncoder

/** One playable candidate found for a release. [file] is the release / file name when the host page reports it. */
internal class DirectLink(val url: String, val server: String, val file: String? = null)

/** One release (quality + size) of a title; [resolve] turns it into direct links lazily, in parallel with the others. */
internal class Rel(
    val title: String,
    val q: Int,
    val sizeText: String?,
    val sizeGb: Double,
    val resolve: suspend () -> List<DirectLink>
)

/** After two failed first requests in a row a site is skipped for five minutes (same idea as the HdHub breaker). */
internal class CinemaBreaker {
    @Volatile private var misses = 0
    @Volatile private var skipUntil = 0L

    fun open(): Boolean = System.currentTimeMillis() < skipUntil

    fun report(ok: Boolean) {
        if (ok) {
            misses = 0
        } else {
            misses += 1
            if (misses >= 2) {
                skipUntil = System.currentTimeMillis() + 5 * 60_000L
                misses = 0
            }
        }
    }
}

/**
 * Helpers shared by the Hindmoviez / 4KHDHub / VegaMovies / HDhub4u / Movies4u scrapers: site domains, the
 * HubCloud page chain (plain HTTP GETs only, no challenge solving), title matching and result building.
 */
internal object CinemaKit {
    private const val DOMAINS_URL = "https://raw.githubusercontent.com/phisher98/TVVVV/main/domains.json"
    const val MAX_RELEASES = 5

    val HTML_HEADERS: Map<String, String> = mapOf(
        "User-Agent" to CinemaHttp.SAFARI_UA,
        "Accept" to "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language" to "en-US,en;q=0.9"
    )

    // ---- domains (the sites rotate hosts; the list is data only, nothing from it is executed) ----------------

    @Volatile private var domainsJson: JSONObject? = null
    @Volatile private var domainsAt = 0L
    @Volatile private var domainsTriedAt = 0L

    suspend fun domain(http: CinemaHttp, key: String, fallback: String): String {
        val now = System.currentTimeMillis()
        if (domainsJson == null || now - domainsAt > 30 * 60_000L) {
            if (now - domainsTriedAt > 2 * 60_000L) {
                domainsTriedAt = now
                val j = http.json(DOMAINS_URL, timeoutMs = 4_000)
                if (j != null) {
                    domainsJson = j
                    domainsAt = now
                }
            }
        }
        val v = domainsJson?.str(key)?.trim()?.trimEnd('/')
        return if (v != null && v.startsWith("http", ignoreCase = true)) v else fallback
    }

    /** Time left for the parallel resolve phase: the scraper budget minus what was already spent, with a safety margin. */
    fun left(budgetMs: Long, startedAt: Long): Long =
        (budgetMs - 2_500L - (System.currentTimeMillis() - startedAt)).coerceIn(3_000L, 13_000L)

    // ---- small string utils ---------------------------------------------------------------------------------

    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    fun b64(s: String): String? = runCatching {
        var t = s.trim().replace('-', '+').replace('_', '/')
        while (t.length % 4 != 0) t += "="
        String(Base64.decode(t, Base64.DEFAULT), Charsets.UTF_8)
    }.getOrNull()

    fun rot13(s: String): String {
        val sb = StringBuilder(s.length)
        for (c in s) {
            when (c) {
                in 'a'..'z' -> sb.append('a' + (c - 'a' + 13) % 26)
                in 'A'..'Z' -> sb.append('A' + (c - 'A' + 13) % 26)
                else -> sb.append(c)
            }
        }
        return sb.toString()
    }

    fun stripTags(s: String): String =
        s.replace(Regex("<[^>]+>"), " ").replace("&nbsp;", " ").replace("&amp;", "&").replace(Regex("\\s+"), " ").trim()

    fun originOf(url: String): String =
        Regex("^(https?://[^/]+)", RegexOption.IGNORE_CASE).find(url)?.groupValues?.get(1).orEmpty()

    fun norm(s: String): String = s.lowercase()
        .replace(Regex("&#?\\w+;"), " ")
        .replace("&", " and ")
        .replace(Regex("[^a-z0-9]+"), " ")
        .trim()

    fun qualityNum(text: String): Int {
        if (Regex("2160p|\\b4k\\b|\\buhd\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)) return 2160
        return Regex("(\\d{3,4})p", RegexOption.IGNORE_CASE).findAll(text)
            .mapNotNull { it.groupValues[1].toIntOrNull() }
            .filter { it in 240..4320 }
            .maxOrNull() ?: 0
    }

    fun qualityLabel(n: Int): String = when {
        n >= 2160 -> "4K"
        n > 0 -> "${n}p"
        else -> "HD"
    }

    fun rank(n: Int): Int = when {
        n == 1080 -> 0
        n == 720 -> 1
        n >= 2160 -> 2
        else -> 3
    }

    /** "3.2GB" / "450 MB" / "1.5 GB" -> (display text, size in GB); (null, 0.0) when there is none. */
    fun parseSize(text: String): Pair<String?, Double> {
        val m = Regex("([\\d]+(?:[.,]\\d+)?)\\s*(GB|MB)", RegexOption.IGNORE_CASE).find(text) ?: return null to 0.0
        val v = m.groupValues[1].replace(',', '.').toDoubleOrNull() ?: return null to 0.0
        val unit = m.groupValues[2].uppercase()
        return "${m.groupValues[1]} $unit" to (if (unit == "GB") v else v / 1024.0)
    }

    /** Removes quality tokens from a multi-quality post title so a single-release title carries one quality only. */
    fun stripQualities(text: String): String = text
        .replace(Regex("\\b(4K|2160p|1080p|720p|480p|360p)\\b", RegexOption.IGNORE_CASE), " ")
        .replace(Regex("\\s{2,}"), " ")
        .trim()

    /** True when [post] is a post for [title] (+ year for movies). */
    fun postMatches(post: String, title: String, year: String, isMovie: Boolean): Boolean {
        val t = norm(title)
        if (t.isEmpty()) return false
        val p = " " + norm(post) + " "
        val variants = ArrayList<String>()
        variants += t
        if (t.startsWith("the ")) variants += t.removePrefix("the ")
        val yearRx = Regex("^(19|20)\\d\\d$")
        val seriesRx = Regex("^(season|s\\d+|complete|series|web|\\d{3,4}p|4k|(19|20)\\d\\d|hindi|english|dual|all|tv)$")
        for (v in variants) {
            var from = 0
            while (true) {
                val at = p.indexOf(" $v ", from)
                if (at < 0) break
                val rest = p.substring(at + v.length + 2).trim().split(' ').filter { it.isNotEmpty() }
                val first = rest.firstOrNull() ?: return true
                if (isMovie) {
                    if (yearRx.matches(first)) {
                        if (year.length != 4) return true
                        if (Math.abs(first.toInt() - year.toInt()) <= 1) return true
                    }
                } else if (seriesRx.matches(first)) {
                    return true
                }
                from = at + 1
            }
        }
        return false
    }

    /** Season token check for multi-season posts: true when the post has no season marker or covers [season]. */
    fun seasonOk(post: String, season: Int): Boolean {
        val ms = Regex("season[s]?\\s*0*(\\d+)(?:\\s*(?:-|–|to|&|and)\\s*0*(\\d+))?", RegexOption.IGNORE_CASE)
            .findAll(post).toList()
        if (ms.isEmpty()) return true
        return ms.any { m ->
            val a = m.groupValues[1].toIntOrNull() ?: 0
            val b = m.groupValues[2].toIntOrNull() ?: a
            season in minOf(a, b)..maxOf(a, b)
        }
    }

    /** Nearest "quality [size]" label in the text just before [index] of [html]. */
    fun labelBefore(html: String, index: Int): String {
        val from = maxOf(0, index - 420)
        val text = stripTags(html.substring(from, index))
        val m = Regex("\\d{3,4}p[^\\[\\]]{0,40}\\[[^\\]]*\\]", RegexOption.IGNORE_CASE).findAll(text).lastOrNull()
            ?: return text.takeLast(80)
        val lead = text.substring(maxOf(0, m.range.first - 90), m.range.first).substringAfterLast("]")
        return (lead + m.value)
            .replace(Regex("Download( Links| Now)?|Episode List|How To Download", RegexOption.IGNORE_CASE), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    // ---- redirectors and the HubCloud chain -----------------------------------------------------------------

    private val KNOWN_FINAL = Regex("hubcloud|hubdrive|hblinks|hubcdn|vcloud|nexdrive|pixeldrain", RegexOption.IGNORE_CASE)

    /** Unwraps a greenmotors style interstitial (its page embeds the target as base64 / rot13 data). */
    suspend fun unwrap(http: CinemaHttp, url: String): String? {
        if (KNOWN_FINAL.containsMatchIn(CinemaHttp.hostOf(url))) return url
        val r = http.fetch(url, HTML_HEADERS, timeoutMs = 6_000, maxBytes = 256 * 1024) ?: return null
        if (!r.ok) return null
        val m = Regex("s\\('o','([^']+)'").find(r.text) ?: return null
        return runCatching {
            val a = b64(m.groupValues[1]) ?: return@runCatching null
            val b = b64(a) ?: return@runCatching null
            val json = b64(rot13(b)) ?: return@runCatching null
            val o = JSONObject(json).optString("o")
            b64(o)?.trim()?.takeIf { it.startsWith("http") }
        }.getOrNull()
    }

    private val HUB_PAGE = Regex(
        "https?://[^\"'\\s<>]*hubcloud[^\"'\\s<>]*/(?:drive|video)/[A-Za-z0-9_]+",
        RegexOption.IGNORE_CASE
    )

    /** Follows hblinks / hubdrive pages to the HubCloud page url (or returns the url when it already is one). */
    private suspend fun toHubCloud(http: CinemaHttp, url: String): String? {
        var cur = url
        for (i in 0 until 2) {
            if (HUB_PAGE.containsMatchIn(cur)) return cur
            val host = CinemaHttp.hostOf(cur)
            if (!Regex("hblinks|hubdrive", RegexOption.IGNORE_CASE).containsMatchIn(host)) return null
            val r = http.fetch(cur, HTML_HEADERS, timeoutMs = 6_000, maxBytes = 1024 * 1024) ?: return null
            if (!r.ok) return null
            cur = HUB_PAGE.find(r.text)?.value ?: return null
        }
        return if (HUB_PAGE.containsMatchIn(cur)) cur else null
    }

    /** Redirector / hblinks / hubdrive / hubcloud url -> direct links of the HubCloud page. */
    suspend fun resolveAny(http: CinemaHttp, url: String): List<DirectLink> {
        val real = unwrap(http, url) ?: return emptyList()
        val hub = toHubCloud(http, real) ?: return emptyList()
        return hubCloud(http, hub)
    }

    private fun gateUrl(html: String): String? {
        Regex("https?://[^\"'\\s<>]+/hubcloud\\.php\\?[^\"'\\s<>]+", RegexOption.IGNORE_CASE).find(html)
            ?.let { return it.value.replace("&amp;", "&") }
        Regex("var\\s+url\\s*=\\s*'(https?://[^']+)'").find(html)?.let { return it.groupValues[1] }
        val m = Regex("atob\\(atob\\('([^']+)'\\)\\)").find(html) ?: return null
        val a = b64(m.groupValues[1]) ?: return null
        return b64(a)?.trim()?.takeIf { it.startsWith("http") }
    }

    /** HubCloud (and vcloud) page -> direct media links: 10Gbps, FSL / FSLv2, plain file links, PixelDrain. */
    suspend fun hubCloud(http: CinemaHttp, pageUrl: String): List<DirectLink> {
        val origin = originOf(pageUrl)
        val headers = HTML_HEADERS + ("Referer" to "$origin/")
        val r1 = http.fetch(pageUrl, headers, timeoutMs = 6_000, maxBytes = 1024 * 1024) ?: return emptyList()
        if (!r1.ok) return emptyList()
        val gate = gateUrl(r1.text)
        val html = if (gate != null) {
            val r2 = http.fetch(gate, headers, timeoutMs = 6_000, maxBytes = 1024 * 1024) ?: return emptyList()
            if (!r2.ok) return emptyList()
            r2.text
        } else {
            r1.text
        }
        val file = Regex("<title>([^<]+)</title>", RegexOption.IGNORE_CASE).find(html)?.groupValues?.get(1)
            ?.replace("&amp;", "&")?.trim()
            ?.takeIf { Regex("\\.(mkv|mp4)$", RegexOption.IGNORE_CASE).containsMatchIn(it) }

        val direct = ArrayList<DirectLink>()
        val redirecting = ArrayList<String>()
        val rx = Regex("<a\\s+([^>]*)>(.*?)</a>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE))
        for (m in rx.findAll(html)) {
            val attrs = m.groupValues[1]
            if (!Regex("class\\s*=\\s*\"[^\"]*\\bbtn", RegexOption.IGNORE_CASE).containsMatchIn(attrs)) continue
            val href = Regex("href\\s*=\\s*\"([^\"]+)\"").find(attrs)?.groupValues?.get(1)?.replace("&amp;", "&") ?: continue
            if (!href.startsWith("http", ignoreCase = true)) continue
            val text = stripTags(m.groupValues[2]).lowercase()
            if (text.contains("telegram") || text.contains("zip") || text.contains("buzz") || text.contains("mega")) continue
            if (href.contains("/tg/go", ignoreCase = true) || href.contains("t.me/", ignoreCase = true)) continue
            when {
                text.contains("10gbps") -> redirecting += href
                Regex("pixeldrain\\.[a-z]+/u/", RegexOption.IGNORE_CASE).containsMatchIn(href) -> {
                    val id = Regex("pixeldrain\\.[a-z]+/u/([A-Za-z0-9]+)", RegexOption.IGNORE_CASE).find(href)?.groupValues?.get(1)
                    if (id != null) direct += DirectLink("https://pixeldrain.dev/api/file/$id", "PixelDrain", file)
                }
                text.contains("fslv2") -> direct += DirectLink(href, "FSLv2", file)
                text.contains("fsl") -> direct += DirectLink(href, "FSL", file)
                text.contains("download file") || text.contains("s3") -> direct += DirectLink(href, "Direct", file)
            }
        }
        val fast = coroutineScope {
            redirecting.take(2).map { u -> async { followGoogle(http, u) } }.map { it.await() }
        }
        val out = ArrayList<DirectLink>()
        for (u in fast) if (u != null) out += DirectLink(u, "10Gbps", file)
        out += direct
        return out
    }

    /** Follows the 10Gbps redirect chain and returns the signed Google video url it ends with. */
    private suspend fun followGoogle(http: CinemaHttp, url: String): String? {
        val r = http.fetch(url, HTML_HEADERS, timeoutMs = 7_000, maxBytes = 1) ?: return null
        val fin = r.finalUrl
        if (fin.isEmpty()) return null
        val at = fin.indexOf("link=")
        if (at >= 0) {
            var t = fin.substring(at + 5)
            if (t.startsWith("http%", ignoreCase = true)) t = runCatching { URLDecoder.decode(t, "UTF-8") }.getOrDefault(t)
            return t.takeIf { it.startsWith("http") }
        }
        return if (r.ok && CinemaHttp.hostOf(fin).contains("googleusercontent", ignoreCase = true)) fin else null
    }

    // ---- results --------------------------------------------------------------------------------------------

    private fun cleanFile(file: String): String = file
        .replace(Regex("^\\([^)]*\\)\\.?"), "")
        .replace(Regex("\\.(mkv|mp4|avi|webm|m4v)$", RegexOption.IGNORE_CASE), "")
        .replace('.', ' ').replace('_', ' ')
        .replace(Regex("\\s+"), " ").trim()

    private fun languageOf(text: String): String? {
        val info = SourceLanguage.parse(text)
        val names = info.codes.map { SourceLanguage.labelOf(it) }
        return names.joinToString(", ").ifEmpty { null }
    }

    private fun typeOf(url: String): String =
        if (Regex("\\.mp4(\\?|&|$)", RegexOption.IGNORE_CASE).containsMatchIn(url)) "mp4" else "mkv"

    /**
     * Resolves the best releases in parallel, keeps only links that pass the head Range probe, best quality first
     * (1080p, 720p, 4K, rest). Per-release failures and timeouts are swallowed.
     */
    suspend fun collect(
        http: CinemaHttp,
        provider: String,
        rels: List<Rel>,
        perRelTimeoutMs: Long = 13_000L
    ): List<PluginRuntimeResult> {
        val picked = rels
            .sortedWith(compareBy<Rel>({ rank(it.q) }, { it.sizeGb }))
            .take(MAX_RELEASES)
        val groups = parallelUntil<Rel, List<PluginRuntimeResult>>(picked, perRelTimeoutMs) { rel ->
            val links = rel.resolve().distinctBy { it.url }.take(4)
            val ok = parallelUntil<DirectLink, DirectLink>(links, 8_000L) { l ->
                if (http.isVideo(l.url, emptyMap(), 7_000)) l else null
            }
            if (ok.isEmpty()) null else ok.map { l -> result(provider, l, rel) }
        }
        return groups.flatten().sortedBy { rank(qualityNum(it.quality.orEmpty())) }
    }

    private fun result(provider: String, l: DirectLink, rel: Rel): PluginRuntimeResult {
        val fileClean = l.file?.let { cleanFile(it) }?.takeIf { qualityNum(it) > 0 }
        val title = fileClean ?: rel.title
        val q = if (qualityNum(title) > 0) qualityNum(title) else rel.q
        val quality = qualityLabel(q)
        return PluginRuntimeResult(
            name = "$provider · ${l.server} · $quality",
            title = title,
            language = languageOf(rel.title + " " + title),
            url = l.url,
            quality = quality,
            size = rel.sizeText,
            provider = provider,
            type = typeOf(l.url),
            headers = emptyMap()
        )
    }
}
