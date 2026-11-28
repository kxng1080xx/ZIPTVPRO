package com.ziptv.sources


/**
 * 4KHDHub (4khdhub.one): search page -> title page -> release blocks with "Download HubCloud" links (greenmotors
 * interstitial) -> HubCloud page -> direct MKV links (10Gbps / FSL). Movies and series (per-episode blocks). Plain GETs only.
 */
class FourKHdHubScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-4khdhub"
    override val name = "CinemaOS · 4KHDHub"
    override val description = "4KHDHub direct MKV links via HubCloud"
    override val budgetMs = 26_000L

    private val breaker = CinemaBreaker()

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        val startedAt = System.currentTimeMillis()
        if (!Regex("^\\d+$").matches(req.tmdbId) || breaker.open()) return emptyList()
        val type = if (req.isMovie) "movie" else "tv"
        val brief = http.tmdbBrief(type, req.tmdbId)
        if (brief.title.isBlank()) return emptyList()
        val base = CinemaKit.domain(http, "4khdhub", "https://4khdhub.one")

        val search = http.fetch(
            "$base/?s=" + CinemaKit.enc(brief.title),
            CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 2 * 1024 * 1024
        )
        breaker.report(search != null && search.ok)
        if (search == null || !search.ok) return emptyList()

        var pagePath: String? = null
        val cardRx = Regex("<a href=\"([^\"]+)\" class=\"movie-card\"[^>]*>(.*?)</a>", RegexOption.DOT_MATCHES_ALL)
        for (m in cardRx.findAll(search.text)) {
            val body = m.groupValues[2]
            val cardTitle = Regex("movie-card-title\">([^<]*)<").find(body)?.groupValues?.get(1).orEmpty()
            val cardYear = Regex("movie-card-meta\">\\s*(\\d{4})").find(body)?.groupValues?.get(1).orEmpty()
            val isSeries = Regex(">\\s*Series\\s*<").containsMatchIn(body)
            val isMovieCard = Regex(">\\s*Movies\\s*<").containsMatchIn(body)
            if (req.isMovie && !isMovieCard) continue
            if (!req.isMovie && !isSeries) continue
            if (CinemaKit.norm(cardTitle) != CinemaKit.norm(brief.title)) continue
            if (req.isMovie && brief.year.length == 4 && cardYear.length == 4 &&
                Math.abs(cardYear.toInt() - brief.year.toInt()) > 1
            ) continue
            pagePath = m.groupValues[1]
            break
        }
        val path = pagePath ?: return emptyList()
        val pageUrl = if (path.startsWith("http")) path else base + path
        val page = http.fetch(pageUrl, CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 4 * 1024 * 1024)
        if (page == null || !page.ok) return emptyList()

        val rels = if (req.isMovie) movieReleases(page.text) else episodeReleases(page.text, req)
        return CinemaKit.collect(http, "4KHDHub", rels, CinemaKit.left(budgetMs, startedAt))
    }

    private val hubLinkRx = Regex(
        "<a[^>]*href=\"([^\"]+)\"[^>]*>\\s*(?:<span[^>]*>)?\\s*Download\\s+HubCloud",
        RegexOption.IGNORE_CASE
    )

    private fun movieReleases(html: String): List<Rel> {
        val out = ArrayList<Rel>()
        val chunks = html.split("<div class=\"download-item").drop(1)
        for (c in chunks) {
            val link = hubLinkRx.find(c)?.groupValues?.get(1)?.replace("&amp;", "&") ?: continue
            val file = CinemaKit.stripTags(Regex("class=\"file-title\">(.*?)</div>", RegexOption.DOT_MATCHES_ALL).find(c)?.groupValues?.get(1).orEmpty())
            val badges = Regex("<span class=\"badge\"[^>]*>([^<]*)</span>").findAll(c).joinToString(" ") { it.groupValues[1] }
            val head = CinemaKit.stripTags(Regex("flex-1 text-left font-semibold\">(.*?)<br>", RegexOption.DOT_MATCHES_ALL).find(c)?.groupValues?.get(1).orEmpty())
            val label = file.ifBlank { head }
            if (label.isBlank()) continue
            val (sizeText, gb) = CinemaKit.parseSize(badges)
            if (gb > MAX_MOVIE_GB) continue
            val q = CinemaKit.qualityNum(label + " " + head)
            val title = (label + " " + badges).trim()
            out += Rel(title, q, sizeText, gb) { CinemaKit.resolveAny(http, link) }
        }
        return out
    }

    private fun episodeReleases(html: String, req: CinemaScrapeRequest): List<Rel> {
        val out = ArrayList<Rel>()
        val epRx = Regex("\\bs0*${req.season}\\s?e0*${req.episode}\\b", RegexOption.IGNORE_CASE)
        val chunks = html.split("<div class=\"episode-download-item").drop(1)
        for (c in chunks) {
            val file = CinemaKit.stripTags(Regex("episode-file-title\">(.*?)</div>", RegexOption.DOT_MATCHES_ALL).find(c)?.groupValues?.get(1).orEmpty())
            if (!epRx.containsMatchIn(file.replace('.', ' '))) continue
            val link = hubLinkRx.find(c)?.groupValues?.get(1)?.replace("&amp;", "&") ?: continue
            val sizeRaw = Regex("badge-size\">([^<]*)<").find(c)?.groupValues?.get(1).orEmpty()
            val (sizeText, gb) = CinemaKit.parseSize(sizeRaw)
            if (gb > MAX_EPISODE_GB) continue
            out += Rel(file, CinemaKit.qualityNum(file), sizeText, gb) { CinemaKit.resolveAny(http, link) }
        }
        return out
    }

    private companion object {
        const val MAX_MOVIE_GB = 14.0
        const val MAX_EPISODE_GB = 6.0
    }
}
