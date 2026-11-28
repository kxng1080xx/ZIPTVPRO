package com.ziptv.sources

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.json.JSONObject

/**
 * VegaMovies (vegamovies.latino), movies only: JSON search -> post -> nexdrive page -> G-Direct (fastdl embed, Google
 * video url) and vcloud (HubCloud style page: FSLv2 / 10Gbps). Hindi + English dual audio. Plain GETs only.
 */
class VegaMoviesScraper(private val http: CinemaHttp) : CinemaScraper {
    override val id = "cinemaos-vegamovies"
    override val name = "CinemaOS · VegaMovies"
    override val description = "VegaMovies direct MKV links"
    override val budgetMs = 24_000L

    private val breaker = CinemaBreaker()

    override suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult> {
        val startedAt = System.currentTimeMillis()
        if (!req.isMovie || !Regex("^\\d+$").matches(req.tmdbId) || breaker.open()) return emptyList()
        val brief = http.tmdbBrief("movie", req.tmdbId)
        if (brief.title.isBlank()) return emptyList()
        val base = CinemaKit.domain(http, "vegamovies", "https://vegamovies.latino")

        val search = http.fetch(
            "$base/search.php?q=" + CinemaKit.enc(brief.title),
            CinemaKit.HTML_HEADERS + ("Accept" to "application/json"), timeoutMs = 7_000, maxBytes = 2 * 1024 * 1024
        )
        breaker.report(search != null && search.ok)
        if (search == null || !search.ok) return emptyList()
        val hits = runCatching { JSONObject(search.text).optJSONArray("hits") }.getOrNull() ?: return emptyList()

        val paths = ArrayList<String>()
        for (i in 0 until hits.length()) {
            val d = hits.optJSONObject(i)?.optJSONObject("document") ?: continue
            val postTitle = d.str("post_title") ?: continue
            val link = d.str("permalink") ?: continue
            val imdbHit = brief.imdbId.isNotBlank() && d.str("imdb_id") == brief.imdbId
            if (imdbHit || CinemaKit.postMatches(postTitle, brief.title, brief.year, true)) paths += link
            if (paths.size >= 2) break
        }
        if (paths.isEmpty()) return emptyList()

        val rels = ArrayList<Rel>()
        for (p in paths) {
            val url = if (p.startsWith("http")) p else base + p
            val page = http.fetch(url, CinemaKit.HTML_HEADERS, timeoutMs = 7_000, maxBytes = 3 * 1024 * 1024)
            if (page == null || !page.ok) continue
            rels += releases(page.text)
        }
        return CinemaKit.collect(http, "VegaMovies", rels, CinemaKit.left(budgetMs, startedAt))
    }

    private fun releases(html: String): List<Rel> {
        val out = ArrayList<Rel>()
        val seen = HashSet<String>()
        val rx = Regex("<a [^>]*href=\"(https?://nexdrive\\.[a-z]+/[^\"]+)\"[^>]*>", RegexOption.IGNORE_CASE)
        for (m in rx.findAll(html)) {
            val link = m.groupValues[1]
            if (!seen.add(link)) continue
            val label = CinemaKit.labelBefore(html, m.range.first)
            val q = CinemaKit.qualityNum(label)
            if (q == 0) continue
            val (sizeText, gb) = CinemaKit.parseSize(label)
            if (gb > MAX_GB) continue
            out += Rel(label, q, sizeText, gb) { resolveNexdrive(link) }
        }
        return out
    }

    private suspend fun resolveNexdrive(url: String): List<DirectLink> {
        val r = http.fetch(url, CinemaKit.HTML_HEADERS, timeoutMs = 6_000, maxBytes = 1024 * 1024)
        if (r == null || !r.ok) return emptyList()
        val fastdl = Regex("href=\"(https?://fastdl\\.[a-z]+/embed\\?download=[^\"]+)\"", RegexOption.IGNORE_CASE)
            .find(r.text)?.groupValues?.get(1)?.replace("&amp;", "&")
        val vcloud = Regex("href=\"(https?://vcloud\\.[a-z]+/[A-Za-z0-9_]+)\"", RegexOption.IGNORE_CASE)
            .find(r.text)?.groupValues?.get(1)
        return coroutineScope {
            val a = async { if (fastdl != null) gDirect(fastdl) else emptyList() }
            val b = async { if (vcloud != null) CinemaKit.hubCloud(http, vcloud) else emptyList() }
            a.await() + b.await()
        }
    }

    private suspend fun gDirect(embed: String): List<DirectLink> {
        val r = http.fetch(embed, CinemaKit.HTML_HEADERS, timeoutMs = 6_000, maxBytes = 512 * 1024)
        if (r == null || !r.ok) return emptyList()
        val re = Regex("reurl\\s*=\\s*\"([^\"]+)\"").find(r.text)?.groupValues?.get(1) ?: return emptyList()
        val at = re.indexOf("link=")
        val direct = if (at >= 0) re.substring(at + 5) else re
        if (!direct.startsWith("http")) return emptyList()
        return listOf(DirectLink(direct, "G-Direct"))
    }

    private companion object {
        const val MAX_GB = 12.0
    }
}
