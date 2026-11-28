package com.ziptv.sources

import java.net.URLDecoder

/**
 * Hindmoviez (hindmovie.im): search -> post -> mvlink page (movie) or mvlink season page (series) -> hshare page ->
 * GDirect page -> signed Google video url. Hindi + English dual audio MKV. Plain GETs only.
 */
class HindmoviezScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-hindmoviez"
    override val name = "CinemaOS · Hindmoviez"
    override val description = "Hindmoviez Hindi / English dual audio MKV"
    override val budgetMs = 24_000L

    private val breaker = CinemaBreaker()

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        val startedAt = System.currentTimeMillis()
        if (!Regex("^\\d+$").matches(req.tmdbId) || breaker.open()) return emptyList()
        val type = if (req.isMovie) "movie" else "tv"
        val brief = http.tmdbBrief(type, req.tmdbId)
        if (brief.title.isBlank()) return emptyList()
        val base = CinemaKit.domain(http, "hindmoviez", "https://v5.hindmovie.im")

        val search = http.fetch(
            "$base/?s=" + CinemaKit.enc(brief.title),
            CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 2 * 1024 * 1024
        )
        breaker.report(search != null && search.ok)
        if (search == null || !search.ok) return emptyList()

        val postRx = Regex("class=\"entry-title-link\"[^>]*href=\"([^\"]+)\"[^>]*>([^<]*)<")
        val posts = postRx.findAll(search.text)
            .map { it.groupValues[1] to CinemaKit.stripTags(it.groupValues[2]) }
            .filter { (_, t) ->
                CinemaKit.postMatches(t, brief.title, brief.year, req.isMovie) &&
                    (req.isMovie || CinemaKit.seasonOk(t, req.season))
            }
            .take(2)
            .toList()
        if (posts.isEmpty()) return emptyList()

        val rels = ArrayList<Rel>()
        for ((url, _) in posts) {
            val page = http.fetch(url, CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 3 * 1024 * 1024)
            if (page == null || !page.ok) continue
            rels += if (req.isMovie) movieReleases(page.text) else seasonReleases(page.text, req)
        }
        return CinemaKit.collect(http, "Hindmoviez", rels, CinemaKit.left(budgetMs, startedAt))
    }

    private val linkRx = Regex("href=\"(https?://mvlink\\.[a-z]+/(?:web/)?\\d+)\"", RegexOption.IGNORE_CASE)

    private fun movieReleases(html: String): List<Rel> {
        val out = ArrayList<Rel>()
        val seen = HashSet<String>()
        for (m in linkRx.findAll(html)) {
            val link = m.groupValues[1]
            if (link.contains("/web/") || !seen.add(link)) continue
            val label = CinemaKit.labelBefore(html, m.range.first)
            val (sizeText, gb) = CinemaKit.parseSize(label)
            if (gb > MAX_MOVIE_GB) continue
            out += Rel(label, CinemaKit.qualityNum(label), sizeText, gb) { resolveMovie(link) }
        }
        return out
    }

    private fun seasonReleases(html: String, req: CinemaScrapeRequest): List<Rel> {
        val out = ArrayList<Rel>()
        val seen = HashSet<String>()
        for (m in linkRx.findAll(html)) {
            val link = m.groupValues[1]
            if (!link.contains("/web/") || !seen.add(link)) continue
            val label = CinemaKit.labelBefore(html, m.range.first)
            val s = Regex("season\\s*0*(\\d+)", RegexOption.IGNORE_CASE).find(label)?.groupValues?.get(1)?.toIntOrNull()
            if (s != req.season) continue
            val (sizeText, gb) = CinemaKit.parseSize(label)
            out += Rel(label, CinemaKit.qualityNum(label), sizeText, gb) { resolveEpisode(link, req) }
        }
        return out
    }

    private suspend fun resolveMovie(mvlink: String): List<DirectLink> {
        val r = http.fetch(mvlink, CinemaKit.HTML_HEADERS, timeoutMs = 6_000, maxBytes = 1024 * 1024)
        if (r == null || !r.ok) return emptyList()
        val hs = Regex("href=\"(https?://hshare\\.[a-z]+/\\?id=[^\"]+)\"", RegexOption.IGNORE_CASE).find(r.text)?.groupValues?.get(1)
            ?: return emptyList()
        return fromHshare(hs.replace("&amp;", "&"))
    }

    private suspend fun resolveEpisode(mvlink: String, req: CinemaScrapeRequest): List<DirectLink> {
        val r = http.fetch(mvlink, CinemaKit.HTML_HEADERS, timeoutMs = 6_000, maxBytes = 1024 * 1024)
        if (r == null || !r.ok) return emptyList()
        val epRx = Regex("\\bs0*${req.season}\\s?e0*${req.episode}\\b", RegexOption.IGNORE_CASE)
        val hs = Regex("href=\"(https?://hshare\\.[a-z]+/\\?id=[^\"]+)\"", RegexOption.IGNORE_CASE).findAll(r.text)
            .map { it.groupValues[1].replace("&amp;", "&") }
            .firstOrNull { u -> u.lowercase().endsWith(".mkv") && epRx.containsMatchIn(u.replace('.', ' ')) }
            ?: return emptyList()
        return fromHshare(hs)
    }

    private suspend fun fromHshare(hshareUrl: String): List<DirectLink> {
        val fileName = runCatching {
            URLDecoder.decode(hshareUrl.substringAfter("?id=").replace("+", "%2B"), "UTF-8")
        }.getOrNull()
        val r = http.fetch(hshareUrl, CinemaKit.HTML_HEADERS, timeoutMs = 6_000, maxBytes = 512 * 1024)
        if (r == null || !r.ok) return emptyList()
        val gd = Regex("href=\"(https?://gdirect\\.[a-z]+/redirect\\.php\\?id=[^\"]+)\"", RegexOption.IGNORE_CASE)
            .find(r.text)?.groupValues?.get(1)?.replace("&amp;", "&") ?: return emptyList()
        val g = http.fetch(gd, CinemaKit.HTML_HEADERS, timeoutMs = 6_000, maxBytes = 512 * 1024)
        if (g == null || !g.ok) return emptyList()
        val direct = Regex("href=\"(https://video-downloads\\.googleusercontent\\.com/[^\"]+)\"").find(g.text)
            ?.groupValues?.get(1)?.replace("&amp;", "&") ?: return emptyList()
        return listOf(DirectLink(direct, "GDirect", fileName))
    }

    private companion object {
        const val MAX_MOVIE_GB = 12.0
    }
}
