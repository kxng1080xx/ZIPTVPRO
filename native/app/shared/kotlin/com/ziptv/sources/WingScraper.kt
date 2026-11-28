package com.ziptv.sources


/**
 * Native port of plugins/cinemaos/wing.js: downloads2.wing.st returns direct MKV / MP4 links; the top candidates are
 * Range-probed (head + tail) in parallel and only playable ones are returned, best quality first.
 */
class WingScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-wing"
    override val name = "CinemaOS · Wing"
    override val description = "Wing direct download links (MKV/MP4, up to 4K)"
    override val budgetMs = 22_000L

    private class Cand(
        val url: String,
        val quality: String,
        val size: String,
        val language: String,
        val title: String
    ) {
        val rank: Int get() = Regex("^\\d+").find(quality)?.value?.toIntOrNull() ?: 0
    }

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        if (!Regex("^\\d+$").matches(req.tmdbId)) return emptyList()
        val path = if (req.isMovie) "movie/${req.tmdbId}" else "tv/${req.tmdbId}/${req.season}/${req.episode}"
        val data = http.json("$API/$path", mapOf("Accept" to "application/json"), timeoutMs = 8_000) ?: return emptyList()
        val links = data.optJSONArray("links") ?: return emptyList()
        val seen = HashSet<String>()
        val out = ArrayList<Cand>()
        for (i in 0 until links.length()) {
            val l = links.optJSONObject(i) ?: continue
            val url = l.str("url") ?: continue
            if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url) || !seen.add(url)) continue
            val q = qualityLabel(l.opt("quality"))
            val name = l.str("name") ?: l.str("source") ?: ""
            val size = l.str("size") ?: ""
            out += Cand(url, q, size, langsOf(name).joinToString(", ").ifEmpty { "English" }, "Wing · ${l.str("source") ?: l.str("provider") ?: ""} · $name")
        }
        val cands = out.sortedByDescending { it.rank }
            .filter { !BAD_HOST.containsMatchIn(it.url) }
            .take(60)
        val verified = parallelUntil<Cand, Cand>(
            items = cands,
            timeoutMs = 12_000,
            enough = { false }
        ) { c ->
            // Fast HEAD first: Cloudflare challenge / HTML / dead links never reach the heavier Range probe.
            if (!http.headLooksPlayable(c.url, emptyMap(), timeoutMs = 3_000)) return@parallelUntil null
            if (http.isVideo(c.url, emptyMap(), timeoutMs = 7_000)) c else null
        }
        return verified.sortedByDescending { it.rank }.map { c ->
            PluginRuntimeResult(
                name = c.quality + (if (c.size.isNotEmpty()) " · ${c.size}" else ""),
                title = c.title,
                url = c.url,
                quality = c.quality,
                size = c.size.ifEmpty { null },
                language = c.language,
                provider = "Wing",
                type = if (Regex("\\.mp4(\\?|&|$)", RegexOption.IGNORE_CASE).containsMatchIn(c.url)) "mp4" else "mkv",
                headers = emptyMap()
            )
        }
    }

    private fun qualityLabel(q: Any?): String {
        val n = Regex("^\\s*(\\d+)").find(q?.toString().orEmpty())?.groupValues?.get(1)?.toIntOrNull() ?: 0
        return when {
            n >= 2160 -> "2160p"
            n >= 1440 -> "1440p"
            n >= 1080 -> "1080p"
            n >= 720 -> "720p"
            n >= 480 -> "480p"
            n > 0 -> "${n}p"
            else -> "Unknown"
        }
    }

    private fun langsOf(name: String): List<String> =
        LANGS.filter { Regex("\\b$it\\b", RegexOption.IGNORE_CASE).containsMatchIn(name) }

    private companion object {
        const val API = "https://downloads2.wing.st"
        // a.111477.xyz / p.111477.xyz sit behind a Cloudflare JavaScript challenge (HTML page, 403 to players); it is not bypassed.
        val BAD_HOST = Regex("^https?://(a|p)\\.111477\\.xyz/", RegexOption.IGNORE_CASE)
        val LANGS = listOf("Hindi", "English", "Tamil", "Telugu", "Malayalam", "Kannada", "Bengali", "Japanese", "Korean", "Spanish", "French")
    }
}
