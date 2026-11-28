package com.ziptv.sources

import org.json.JSONObject

/**
 * Native port of plugins/cinemaos/cinemaos-hdhub.js: queries the HDHub Stremio addon /stream/ endpoint (keyed by
 * IMDb id) directly, drops "Download Only" mirrors, then Range-probes (head + tail) every candidate in parallel and
 * keeps only the playable ones, 1080p first, then 720p, then 4K, then the rest.
 */
class HdHubScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-hdhub"
    override val name = "CinemaOS · HdHub"
    override val description = "HDHub direct MKV / MP4 links"
    override val budgetMs = 20_000L

    private class Cand(
        val url: String,
        val n: Int,
        val quality: String,
        val label: String,
        val size: String,
        val host: String,
        val headers: Map<String, String>,
        val language: String?,
        val isHls: Boolean
    )

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        if (!Regex("^\\d+$").matches(req.tmdbId)) return emptyList()
        val type = if (req.isMovie) "movie" else "tv"
        val brief = http.tmdbBrief(type, req.tmdbId)
        val imdb = brief.imdbId
        if (imdb.isBlank()) return emptyList()
        // Circuit breaker: after two timeouts in a row the addon is skipped for five minutes.
        if (System.currentTimeMillis() < skipUntil) return emptyList()
        val path = if (req.isMovie) "movie/$imdb" else "series/$imdb%3A${req.season}%3A${req.episode}"
        val res = kotlinx.coroutines.withTimeoutOrNull(ANSWER_TIMEOUT_MS) {
            http.fetch("$BASE/stream/$path.json", timeoutMs = ANSWER_TIMEOUT_MS, maxBytes = 2 * 1024 * 1024)
        }
        if (res == null) {
            if (++timeouts >= 2) {
                skipUntil = System.currentTimeMillis() + SKIP_MS
                timeouts = 0
            }
            return emptyList()
        }
        timeouts = 0
        if (!res.ok) return emptyList()
        val streams = runCatching { JSONObject(res.text).optJSONArray("streams") }.getOrNull() ?: return emptyList()

        val all = ArrayList<Cand>()
        for (i in 0 until streams.length()) {
            val st = streams.optJSONObject(i) ?: continue
            val url = st.str("url") ?: continue
            if (st.str("externalUrl") != null) continue
            val desc = st.str("description") ?: st.str("title") ?: ""
            val lines = desc.split('\n')
            val n = qualityOf(st.str("name").orEmpty() + " " + desc)
            val size = Regex("💾\\s*([\\d.]+\\s*[GMK]B)").find(desc)?.groupValues?.get(1) ?: ""
            val first = lines.firstOrNull().orEmpty()
            val hm = Regex("^\\[([^\\]]+)\\]").find(first)?.groupValues?.get(1)
            val host = (hm ?: lines.last().split('|')[0].ifBlank { "HDHub" }).trim()
            val file = first.replace(Regex("^(\\[[^\\]]*\\]\\s*)+"), "").ifBlank { st.str("name") ?: "" }.trim()
            val bh = st.optJSONObject("behaviorHints")?.optJSONObject("proxyHeaders")?.optJSONObject("request")
            val headers = HashMap<String, String>()
            bh?.keys()?.forEach { k -> bh.str(k)?.let { headers[k] = it } }
            val lang = lines.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() && it.length <= 24 && !it.contains('|') }
            // CineJoy resolver links are keyed by TMDB id and have no file name: validate by id instead
            val cj = Regex("/resolve/cj/tmdb/(\\d+)/", RegexOption.IGNORE_CASE).find(url)?.groupValues?.get(1)
            if (cj != null) {
                if (cj != req.tmdbId) continue
                all += Cand(url, n, if (n > 0) "${n}p" else "HD", brief.title.ifBlank { "CineJoy" }, "", "CineJoy", headers, null, true)
                continue
            }
            if (file.isBlank() || !Regex("\\.(mkv|mp4|avi|webm|m4v|ts)\\b|\\d{3,4}p|[A-Za-z]{3,}", RegexOption.IGNORE_CASE).containsMatchIn(file)) continue
            if (!matchesRequest(file, brief.title, brief.year, req)) continue
            all += Cand(url, n, if (n > 0) (if (n >= 2160) "4K" else "${n}p") else "HD", file, size, host, headers, lang, false)
        }
        val cands = all
            .filter { !Regex("download only", RegexOption.IGNORE_CASE).containsMatchIn(it.host + " " + it.label) }
            .sortedBy { rank(it.n) }
            .take(MAX_CANDIDATES)

        // All candidates probed concurrently; stop once enough are verified.
        val ok = parallelUntil<Cand, Cand>(
            items = cands,
            timeoutMs = 12_000,
            enough = { false }
        ) { c ->
            val good = if (c.isHls) {
                val r = http.fetch(c.url, c.headers, timeoutMs = 7_000, maxBytes = 4096)
                r != null && r.ok && r.text.contains("#EXTM3U")
            } else http.isVideo(c.url, c.headers, timeoutMs = 7_000)
            if (good) c else null
        }

        // Every link the addon returned is kept: the ones that passed the probe lead, the rest follow.
        val okSet = ok.toHashSet()
        val unverified = cands.filter { it !in okSet }
        return (ok.sortedBy { rank(it.n) } + unverified.sortedBy { rank(it.n) }).map { x ->
            PluginRuntimeResult(
                name = "HDHub · ${x.host} · ${x.quality}",
                title = x.label.replace(Regex("\\.(mkv|mp4|avi|webm|m4v)$", RegexOption.IGNORE_CASE), "").replace('.', ' ').replace('_', ' ').trim(),
                language = x.language,
                url = x.url,
                quality = x.quality,
                size = x.size.ifEmpty { null },
                provider = "HDHub",
                type = if (x.isHls) "hls" else if (Regex("\\.mp4(\\?|&|$)", RegexOption.IGNORE_CASE).containsMatchIn(x.url)) "mp4" else "mkv",
                headers = x.headers
            )
        }
    }

    private fun norm(s: String) = s.lowercase().replace("&", " and ").replace(Regex("[^a-z0-9]+"), " ").trim()

    private val okFirstTokens = Regex(
        "^(19\\d\\d|20\\d\\d|s\\d+e\\d+.*|\\d+x\\d+|\\d{3,4}p|4k|uhd|bluray|blu|brrip|bdrip|webrip|web|webdl|hdrip|hdtv|dvdrip|hdcam|cam|remastered|proper|repack|extended|imax|unrated|uncut|hybrid|amzn|nf|hmax|dsnp|hevc|x264|x265|h264|h265|hindi|english|dual|multi|hq|10bit)$"
    )

    /** True when the file name is for the requested title (+ year for movies / SxxEyy for series). */
    private fun matchesRequest(file: String, title: String, year: String, req: CinemaScrapeRequest): Boolean {
        if (title.isBlank()) return true
        val nf = " " + norm(file) + " "
        val variants = LinkedHashSet<String>()
        val full = norm(title)
        variants += full
        if (full.startsWith("the ")) variants += full.removePrefix("the ")
        Regex("[:\\-–]").split(title).firstOrNull()?.let { v -> norm(v).takeIf { it.length >= 4 && it.split(' ').size >= 1 }?.let { variants += it } }
        if (!req.isMovie) {
            val s = req.season
            val e = req.episode
            val ep = Regex("\\bs0*${s}\\s?e0*${e}\\b|\\b0*${s}x0*${e}\\b")
            if (!ep.containsMatchIn(nf)) return false
        }
        for (v in variants) {
            var from = 0
            while (true) {
                val at = nf.indexOf(" $v ", from)
                if (at < 0) break
                val rest = nf.substring(at + v.length + 1).trim().split(' ').filter { it.isNotEmpty() }
                val first = rest.firstOrNull() ?: return true
                if (okFirstTokens.matches(first)) {
                    if (req.isMovie && year.length == 4 && Regex("^(19|20)\\d\\d$").matches(first)) {
                        val diff = Math.abs(first.toInt() - year.toInt())
                        if (diff > 1) { from = at + 1; continue }
                    }
                    return true
                }
                from = at + 1
            }
        }
        return false
    }

    private fun rank(q: Int) = when {
        q == 1080 -> 0
        q == 720 -> 1
        q >= 2160 -> 2
        else -> 3
    }

    private fun qualityOf(text: String): Int {
        if (Regex("2160p|\\b4k\\b|uhd", RegexOption.IGNORE_CASE).containsMatchIn(text)) return 2160
        return Regex("(\\d{3,4})p", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toIntOrNull() ?: 0
    }

    private companion object {
        const val BASE = "https://hdhub.thevolecitor.qzz.io/eyJ0b3Jib3giOiJ1bnNldCIsInF1YWxpdGllcyI6IjIxNjBwLDEwODBwLDcyMHAiLCJzb3J0IjoiZGVzYyJ9"
        const val MAX_CANDIDATES = 120
        const val ANSWER_TIMEOUT_MS = 8_000L
        const val SKIP_MS = 5 * 60_000L

        @Volatile private var timeouts = 0
        @Volatile private var skipUntil = 0L
    }
}
