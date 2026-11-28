package com.ziptv.sources

import org.json.JSONObject

/**
 * HDhub4u site (not the Stremio addon behind the HdHub source), movies only: the site's own search host
 * (search.pingora.fyi, a Typesense endpoint) -> post -> greenmotors / hubdrive links -> hblinks -> HubCloud -> direct
 * MKV links. Hindi + English dual audio. Plain GETs only.
 */
class HdHub4uScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-hdhub4u"
    override val name = "CinemaOS · HDhub4u"
    override val description = "HDhub4u Hindi / English dual audio MKV via HubCloud"
    override val budgetMs = 26_000L

    private val breaker = CinemaBreaker()

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        val startedAt = System.currentTimeMillis()
        if (!req.isMovie || !Regex("^\\d+$").matches(req.tmdbId) || breaker.open()) return emptyList()
        val brief = http.tmdbBrief("movie", req.tmdbId)
        if (brief.title.isBlank()) return emptyList()
        val base = CinemaKit.domain(http, "HDHUB4u", "https://new17.hdhub4u.cl")

        val searchUrl = "https://search.pingora.fyi/collections/post/documents/search?q=" + CinemaKit.enc(brief.title) +
            "&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=8" +
            "&highlight_fields=none&use_cache=true&page=1"
        val search = http.fetch(
            searchUrl,
            CinemaKit.HTML_HEADERS + mapOf("Cookie" to "xla=s4t", "Referer" to "$base/", "Accept" to "application/json"),
            timeoutMs = 7_000, maxBytes = 2 * 1024 * 1024
        )
        breaker.report(search != null && search.ok)
        if (search == null || !search.ok) return emptyList()
        val hits = runCatching { JSONObject(search.text).optJSONArray("hits") }.getOrNull() ?: return emptyList()

        val posts = ArrayList<Pair<String, String>>()
        for (i in 0 until hits.length()) {
            val d = hits.optJSONObject(i)?.optJSONObject("document") ?: continue
            val postTitle = d.str("post_title") ?: continue
            val link = d.str("permalink") ?: continue
            val imdbHit = brief.imdbId.isNotBlank() && d.str("imdb_id") == brief.imdbId
            if (imdbHit || CinemaKit.postMatches(postTitle, brief.title, brief.year, true)) {
                // permalinks carry a dead host, only the path is used with the current domain
                val path = Regex("^https?://[^/]+(/.*)$").find(link)?.groupValues?.get(1) ?: link
                posts += (base + path) to postTitle
            }
            if (posts.size >= 2) break
        }
        if (posts.isEmpty()) return emptyList()

        val rels = ArrayList<Rel>()
        for ((url, postTitle) in posts) {
            val page = http.fetch(url, CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 3 * 1024 * 1024)
            if (page == null || !page.ok) continue
            rels += releases(page.text, postTitle)
        }
        return CinemaKit.collect(http, "HDhub4u", rels, CinemaKit.left(budgetMs, startedAt))
    }

    private fun releases(html: String, postTitle: String): List<Rel> {
        val out = ArrayList<Rel>()
        val seen = HashSet<String>()
        val head = CinemaKit.stripQualities(postTitle.substringBefore(" | ")).replace("&", "and")
        val rx = Regex("<a[^>]*href=\"(https?://[^\"]+)\"[^>]*>(?:\\s*<em>)?([^<]*(?:\\d{3,4}p|4K)[^<]*)(?:</em>)?</a>", RegexOption.IGNORE_CASE)
        for (m in rx.findAll(html)) {
            val link = m.groupValues[1].replace("&amp;", "&")
            val text = CinemaKit.stripTags(m.groupValues[2])
            if (!seen.add(link)) continue
            if (!Regex("greenmotors|hubdrive|hblinks|hubcloud", RegexOption.IGNORE_CASE).containsMatchIn(CinemaHttp.hostOf(link))) continue
            if (Regex("watch|player|trailer", RegexOption.IGNORE_CASE).containsMatchIn(text)) continue
            val q = CinemaKit.qualityNum(text)
            if (q == 0) continue
            val (sizeText, gb) = CinemaKit.parseSize(text)
            if (gb > MAX_GB) continue
            out += Rel("$head $text", q, sizeText, gb) { CinemaKit.resolveAny(http, link) }
        }
        return out
    }

    private companion object {
        const val MAX_GB = 12.0
    }
}
