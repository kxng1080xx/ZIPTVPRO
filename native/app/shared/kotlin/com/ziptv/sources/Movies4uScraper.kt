package com.ziptv.sources

import org.json.JSONArray

/**
 * Movies4u (movies4u.garden), movies only: public WordPress REST search -> post -> m4ulinks list -> HubCloud pages ->
 * direct MKV links (10Gbps / PixelDrain). Hindi (ORG) + English. Plain GETs only; the site's own HTML search is not
 * used because it needs a browser session.
 */
class Movies4uScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-movies4u"
    override val name = "CinemaOS · Movies4u"
    override val description = "Movies4u Hindi / English MKV via HubCloud"
    override val budgetMs = 26_000L

    private val breaker = CinemaBreaker()

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        val startedAt = System.currentTimeMillis()
        if (!req.isMovie || !Regex("^\\d+$").matches(req.tmdbId) || breaker.open()) return emptyList()
        val brief = http.tmdbBrief("movie", req.tmdbId)
        if (brief.title.isBlank()) return emptyList()
        val base = CinemaKit.domain(http, "movies4u", "https://new9.movies4u.garden")

        val search = http.fetch(
            "$base/wp-json/wp/v2/search?subtype=post&per_page=10&search=" + CinemaKit.enc(brief.title),
            CinemaKit.HTML_HEADERS + ("Accept" to "application/json"), timeoutMs = 7_000, maxBytes = 1024 * 1024
        )
        breaker.report(search != null && search.ok)
        if (search == null || !search.ok) return emptyList()
        val arr = runCatching { JSONArray(search.text) }.getOrNull() ?: return emptyList()

        var postUrl: String? = null
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val t = o.str("title") ?: continue
            val u = o.str("url") ?: continue
            if (CinemaKit.postMatches(t, brief.title, brief.year, true)) {
                postUrl = u
                break
            }
        }
        val url = postUrl ?: return emptyList()
        val post = http.fetch(url, CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 3 * 1024 * 1024)
        if (post == null || !post.ok) return emptyList()
        val list = Regex("href=\"(https?://m4ulinks\\.[a-z]+/[a-z]+/\\d+)\"", RegexOption.IGNORE_CASE)
            .find(post.text)?.groupValues?.get(1) ?: return emptyList()
        val links = http.fetch(list, CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 2 * 1024 * 1024)
        if (links == null || !links.ok) return emptyList()

        val rels = ArrayList<Rel>()
        val seen = HashSet<String>()
        val rx = Regex("href=\"(https?://hubcloud\\.[a-z]+/(?:drive|video)/[A-Za-z0-9_]+)\"", RegexOption.IGNORE_CASE)
        for (m in rx.findAll(links.text)) {
            val hub = m.groupValues[1]
            if (!seen.add(hub)) continue
            val label = CinemaKit.labelBefore(links.text, m.range.first)
            val q = CinemaKit.qualityNum(label)
            if (q == 0) continue
            val (sizeText, gb) = CinemaKit.parseSize(label)
            if (gb > MAX_GB) continue
            val title = CinemaKit.stripTags(brief.title + " " + brief.year + " " + label)
            rels += Rel(title, q, sizeText, gb) { CinemaKit.hubCloud(http, hub) }
        }
        return CinemaKit.collect(http, "Movies4u", rels, CinemaKit.left(budgetMs, startedAt))
    }

    private companion object {
        const val MAX_GB = 12.0
    }
}
