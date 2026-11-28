package com.ziptv.sources


/** One movie / episode lookup. [mediaType] is "movie" or "tv". */
data class CinemaScrapeRequest(
    val tmdbId: String,
    val mediaType: String,
    val season: Int,
    val episode: Int,
) {
    val isMovie: Boolean get() = mediaType == "movie"
}

/** A built-in (native Kotlin) source. Returns the same result shape the JS plugins produce. */
interface CinemaScraper {
    val id: String

    /** Display name, e.g. "CinemaOS · Movy". */
    val name: String
    val description: String

    /** Hard cap for one run. */
    val budgetMs: Long

    suspend fun getStreams(req: CinemaScrapeRequest): List<PluginRuntimeResult>
}

/** Scraper debug logging is disabled; kept as a no-op so the ported scrapers stay identical to the TV app. */
internal object Log {
    @Suppress("UNUSED_PARAMETER")
    fun d(tag: String, msg: String) = Unit
}
