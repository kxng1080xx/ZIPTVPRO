package com.ziptv.app

import com.ziptv.core.ContentKind
import com.ziptv.core.Episode
import com.ziptv.core.Movie
import com.ziptv.core.Provider
import com.ziptv.core.RelatedTitle
import com.ziptv.core.Series
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

/**
 * Movies and series the playlist doesn't have, from Cinemeta (Stremio's free catalog), played through the
 * built-in sources. Their ids are "ext:<imdb id>" (episodes "ext:<imdb>:<season>:<episode>") so the app can
 * tell them apart. Anything the playlist already has is left out: it shows once, and plays from the provider.
 */
object Extras {
    private const val PREFIX = "ext:"
    private const val BASE = "https://v3-cinemeta.strem.io"
    /** 50 a page: the 1000 most popular of each kind. Search finds the rest. */
    private const val PAGES = 20

    fun isExt(id: String?) = id?.startsWith(PREFIX) == true
    fun extId(imdb: String) = PREFIX + imdb
    /** "ext:tt0903747:1:2" -> "tt0903747"; null for the provider's own ids. */
    fun imdbOf(id: String?) = id?.takeIf(::isExt)?.removePrefix(PREFIX)?.substringBefore(':')

    private data class Item(val imdb: String, val name: String, val year: String?, val poster: String?, val rating: Float)

    private val tmdbIds = ConcurrentHashMap<String, String>() // imdb -> tmdb (the sources search by TMDB id)
    private val top = ConcurrentHashMap<String, List<Item>>()  // "movie" / "series", once per run

    private fun get(path: String): JSONObject? = runCatching {
        val c = URL("$BASE/$path").openConnection().apply { connectTimeout = 10_000; readTimeout = 15_000 }
        JSONObject(c.getInputStream().bufferedReader().use { it.readText() })
    }.getOrNull()

    private fun items(json: JSONObject?): List<Item> {
        val metas = json?.optJSONArray("metas") ?: return emptyList()
        return (0 until metas.length()).mapNotNull { i ->
            val m = metas.optJSONObject(i) ?: return@mapNotNull null
            val imdb = m.optString("imdb_id").ifBlank { m.optString("id") }.takeIf { it.startsWith("tt") } ?: return@mapNotNull null
            m.optString("moviedb_id").takeIf { it.isNotBlank() && it != "0" }?.let { tmdbIds[imdb] = it }
            Item(imdb, m.optString("name").ifBlank { return@mapNotNull null },
                Regex("""\d{4}""").find(m.optString("releaseInfo"))?.value,
                m.optString("poster").ifBlank { null }?.replace("/poster/small/", "/poster/medium/"),
                m.optString("imdbRating").toFloatOrNull() ?: 0f)
        }
    }

    private suspend fun topOf(type: String): List<Item> = top[type] ?: coroutineScope {
        (0 until PAGES).map { p -> async(Dispatchers.IO) { items(get("catalog/$type/top${if (p == 0) "" else "/skip=${p * 50}"}.json")) } }
            .awaitAll().flatten().distinctBy { it.imdb }
    }.also { if (it.isNotEmpty()) top[type] = it }

    /** Drops what this playlist already has (same cleaned title and year, matched in the core). */
    private fun missing(lib: Provider, kind: ContentKind, items: List<Item>): List<Item> {
        val have = lib.matchTitles(kind, items.map { RelatedTitle(it.name, it.year) })
        return items.filterIndexed { i, _ -> have.getOrNull(i) == null }
    }

    private fun Item.movie() = Movie(PREFIX + imdb, name, "", poster, rating, year, null, 0)
    private fun Item.series() = Series(PREFIX + imdb, name, "", poster, rating, year, 0)

    suspend fun movies(lib: Provider): List<Movie> = withContext(Dispatchers.IO) { missing(lib, ContentKind.MOVIE, topOf("movie")).map { it.movie() } }
    suspend fun series(lib: Provider): List<Series> = withContext(Dispatchers.IO) { missing(lib, ContentKind.SERIES, topOf("series")).map { it.series() } }

    // ------------------------------------------------------------ category rows (Movies / Series tabs)

    private val catalogs = ConcurrentHashMap<String, List<Item>>() // "movie/top/genre=Action" -> items, once per run

    private suspend fun catalog(type: String, paths: List<String>): List<Item> = coroutineScope {
        paths.map { p ->
            async(Dispatchers.IO) {
                catalogs["$type/$p"] ?: items(get("catalog/$type/$p.json")).also { if (it.isNotEmpty()) catalogs["$type/$p"] = it }
            }
        }.awaitAll().flatten().distinctBy { it.imdb }
    }

    /**
     * A category row (Cinemeta's "popular", "new this year", a genre…), newest/most popular first. Titles the playlist
     * has come as its own copy (so they play from the provider), shown with Cinemeta's clean name and poster; the
     * rest are extras. [hidden] = categories the playlist hides (those titles are left out).
     */
    suspend fun movieRow(lib: Provider, paths: List<String>, hidden: (String) -> Boolean): List<Movie> = withContext(Dispatchers.IO) {
        val items = catalog("movie", paths)
        val have = lib.matchTitles(ContentKind.MOVIE, items.map { RelatedTitle(it.name, it.year) })
        val own = lib.moviesByIds(have.filterNotNull()).associateBy { it.streamId }
        items.mapIndexedNotNull { i, it ->
            val m = have.getOrNull(i)?.let(own::get) ?: return@mapIndexedNotNull it.movie()
            if (hidden(m.categoryId)) null else m.copy(name = it.name, poster = it.poster ?: m.poster, year = it.year ?: m.year)
        }.distinctBy { it.streamId }
    }

    suspend fun seriesRow(lib: Provider, paths: List<String>, hidden: (String) -> Boolean): List<Series> = withContext(Dispatchers.IO) {
        val items = catalog("series", paths)
        val have = lib.matchTitles(ContentKind.SERIES, items.map { RelatedTitle(it.name, it.year) })
        val own = lib.seriesByIds(have.filterNotNull()).associateBy { it.seriesId }
        items.mapIndexedNotNull { i, it ->
            val s = have.getOrNull(i)?.let(own::get) ?: return@mapIndexedNotNull it.series()
            if (hidden(s.categoryId)) null else s.copy(name = it.name, cover = it.poster ?: s.cover, year = it.year ?: s.year)
        }.distinctBy { it.seriesId }
    }

    // ------------------------------------------------------------ Discover filter (Movies / Series tabs)

    private val year = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)

    /** Cinemeta catalog paths for a filter, a few pages deep (50 a page). New releases with a genre = that genre, this year and last. */
    private fun discoverPaths(show: String, genre: String?): Pair<List<String>, Boolean> {
        val g = genre?.let { URLEncoder.encode(it, "UTF-8") }
        fun pages(base: String, n: Int) = (0 until n).map { if (it == 0) base else if (base.contains('=')) "$base&skip=${it * 50}" else "$base/skip=${it * 50}" }
        return when {
            show == "New releases" && g == null -> (pages("year/genre=$year", 3) + pages("year/genre=${year - 1}", 3)) to false
            show == "New releases" -> pages("top/genre=$g", 8) to true // keep this year's and last year's
            g != null -> pages("top/genre=$g", if (show == "Popular") 3 else 6) to false
            else -> pages("top", if (show == "Popular") 3 else 6) to false
        }
    }

    private fun recentOnly(y: String?) = (y?.take(4)?.toIntOrNull() ?: 0) >= year - 1

    /** Movies for the filter (popularity order), merged with the playlist like the rows. "Recently added" = the provider's newest. */
    suspend fun discoverMovies(lib: Provider, show: String, genre: String?, hidden: (String) -> Boolean): List<Movie> {
        if (show == "Recently added") return withContext(Dispatchers.IO) { lib.recentlyAddedMovies(200u).filter { !hidden(it.categoryId) } }
        val (paths, recent) = discoverPaths(show, genre)
        return movieRow(lib, paths, hidden).let { l -> if (recent) l.filter { recentOnly(it.year) } else l }
    }

    suspend fun discoverSeries(lib: Provider, show: String, genre: String?, hidden: (String) -> Boolean): List<Series> {
        if (show == "Recently added") return withContext(Dispatchers.IO) { lib.recentlyAddedSeries(200u).filter { !hidden(it.categoryId) } }
        val (paths, recent) = discoverPaths(show, genre)
        return seriesRow(lib, paths, hidden).let { l -> if (recent) l.filter { recentOnly(it.year) } else l }
    }

    /** Search results the playlist doesn't have. */
    suspend fun search(lib: Provider, query: String): Pair<List<Movie>, List<Series>> = withContext(Dispatchers.IO) {
        val q = URLEncoder.encode(query.trim(), "UTF-8").replace("+", "%20")
        val m = async { missing(lib, ContentKind.MOVIE, items(get("catalog/movie/top/search=$q.json"))).take(20).map { it.movie() } }
        val s = async { missing(lib, ContentKind.SERIES, items(get("catalog/series/top/search=$q.json"))).take(20).map { it.series() } }
        m.await() to s.await()
    }

    private val metas = ConcurrentHashMap<String, JSONObject>()
    private fun meta(imdb: String, series: Boolean): JSONObject? = metas["$series:$imdb"]
        ?: get("meta/${if (series) "series" else "movie"}/$imdb.json")?.optJSONObject("meta")?.also { metas["$series:$imdb"] = it }

    /** An extra series' episodes (aired ones; specials left out). */
    fun episodes(seriesId: String): List<Episode> {
        val imdb = imdbOf(seriesId) ?: return emptyList()
        val m = meta(imdb, series = true) ?: return emptyList()
        m.optString("moviedb_id").takeIf { it.isNotBlank() && it != "0" }?.let { tmdbIds[imdb] = it }
        val v = m.optJSONArray("videos") ?: return emptyList()
        // "2008-01-28T05:00:00.000Z" sorts as text; java.time needs Android 8 (Fire TV sticks run 7.1).
        val today = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date())
        return (0 until v.length()).mapNotNull { i ->
            val e = v.optJSONObject(i) ?: return@mapNotNull null
            val season = e.optInt("season"); val number = e.optInt("episode", e.optInt("number"))
            if (season <= 0 || number <= 0) return@mapNotNull null
            val aired = e.optString("released").take(10).let { it.length < 10 || it <= today }
            if (!aired) return@mapNotNull null
            Episode("$PREFIX$imdb:$season:$number", season.toUInt(), number.toUInt(), e.optString("name").ifBlank { e.optString("title") },
                e.optString("overview").ifBlank { e.optString("description") }, e.optString("thumbnail").ifBlank { null }, null, 0u)
        }.sortedWith(compareBy({ it.season }, { it.number }))
    }

    /** Season/episode -> overall episode number (episodes of the earlier seasons + this one), for anime ids. */
    fun overallEpisode(imdb: String, season: Int, episode: Int): Int {
        if (season <= 1) return episode
        val v = meta(imdb, series = true)?.optJSONArray("videos") ?: return episode
        return (0 until v.length()).count { i -> v.optJSONObject(i)?.optInt("season")?.let { it in 1 until season } == true } + episode
    }

    /** TMDB id for an IMDb id (Cinemeta carries it). */
    fun tmdbId(imdb: String, series: Boolean): String? = tmdbIds[imdb]
        ?: meta(imdb, series)?.optString("moviedb_id")?.takeIf { it.isNotBlank() && it != "0" }?.also { tmdbIds[imdb] = it }

    /** TMDB id by name, for provider titles when the TMDB lookup has nothing (no token in this build). */
    fun tmdbIdByTitle(title: String, year: String?, series: Boolean): String? = imdbByTitle(title, year, series)?.let { tmdbId(it, series) }

    private val imdbByName = ConcurrentHashMap<String, String>()

    /** The IMDb id of a provider title, by its cleaned name (and year when known). */
    fun imdbByTitle(title: String, year: String?, series: Boolean): String? {
        val clean = com.ziptv.core.cleanName(title) // "EN - Dune (2021) 4K" -> "Dune", 2021
        val y = year?.take(4)?.takeIf { it.length == 4 } ?: clean.year
        val key = "$series:${clean.title.lowercase()}:$y"
        imdbByName[key]?.let { return it }
        val q = URLEncoder.encode(clean.title, "UTF-8").replace("+", "%20")
        val hits = items(get("catalog/${if (series) "series" else "movie"}/top/search=$q.json"))
        val hit = hits.firstOrNull { y == null || it.year == y } ?: return null
        return hit.imdb.also { imdbByName[key] = it }
    }

    /**
     * A provider series with IMDb/TMDB's season and episode labels (providers mislabel, e.g. "Season 403"),
     * plus the episodes the provider is missing (those play through the built-in sources). Provider episodes
     * keep their ids, so playback and watch progress are unchanged. Each provider episode is matched by:
     *  1. its own season/episode, when most of them exist on IMDb (the provider labels are fine), else
     *  2. "Season 403, Episode 1" = episode 403 overall, when every provider season is past IMDb's last, else
     *  3. its place in order (1st = 1st).
     * Provider episodes IMDb doesn't list (specials, not aired there yet) stay at the end as labelled.
     */
    fun relabel(provider: List<Episode>, imdb: List<Episode>): List<Episode> {
        if (imdb.isEmpty() || provider.isEmpty()) return provider.ifEmpty { imdb }
        val p = provider.sortedWith(compareBy({ it.season }, { it.number }))
        val at = imdb.withIndex().associate { (i, e) -> (e.season to e.number) to i }
        val lastSeason = imdb.maxOf { it.season }
        val which: List<Int?> = when {
            p.count { (it.season to it.number) in at } >= p.size * 0.8 -> p.map { at[it.season to it.number] }
            p.all { it.season > lastSeason } -> p.map { (it.season.toInt() + it.number.toInt() - 2).takeIf { i -> i in imdb.indices } }
            else -> p.indices.map { it.takeIf { i -> i in imdb.indices } }
        }
        val mine = HashMap<Int, Episode>()
        val rest = mutableListOf<Episode>()
        p.forEachIndexed { i, e -> val k = which[i]; if (k != null && k !in mine) mine[k] = e else rest += e }
        return imdb.mapIndexed { i, im ->
            mine[i]?.let { e -> e.copy(season = im.season, number = im.number, title = im.title.ifBlank { e.title },
                plot = im.plot.ifBlank { e.plot }, image = im.image ?: e.image) } ?: im
        } + rest
    }
}
