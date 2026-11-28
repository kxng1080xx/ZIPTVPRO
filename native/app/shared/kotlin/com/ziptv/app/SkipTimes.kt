package com.ziptv.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/** A part of an episode/movie the viewer may want to skip. Times in ms. */
data class Segment(val kind: Kind, val startMs: Long, val endMs: Long) {
    enum class Kind { Intro, Recap, Credits }
}

/**
 * Intro / recap / credits times, as in Nuvio: IntroDB (shows and movies, by IMDb id + IMDb season/episode) first,
 * AniSkip (anime, by MyAnimeList id + episode) for whatever IntroDB lacks. Both are free and keyless.
 */
object SkipTimes {
    private const val INTRODB = "https://api.introdb.app/segments"
    private const val ANISKIP = "https://api.aniskip.com/v2/skip-times"
    private val cache = ConcurrentHashMap<String, List<Segment>>()

    private fun get(url: String): String? = runCatching {
        URL(url).openConnection().apply { connectTimeout = 8_000; readTimeout = 10_000 }.getInputStream().bufferedReader().use { it.readText() }
    }.getOrNull()

    private fun JSONObject.span(key: String, kind: Segment.Kind): Segment? {
        val o = optJSONObject(key) ?: return null
        val s = o.optDouble("start_sec", Double.NaN).takeIf { it.isFinite() } ?: o.optLong("start_ms", -1).takeIf { it >= 0 }?.div(1000.0) ?: return null
        val e = o.optDouble("end_sec", Double.NaN).takeIf { it.isFinite() } ?: o.optLong("end_ms", -1).takeIf { it >= 0 }?.div(1000.0) ?: return null
        return if (s >= 0 && e > s) Segment(kind, (s * 1000).toLong(), (e * 1000).toLong()) else null
    }

    private fun introDb(imdb: String, season: Int?, episode: Int?): List<Segment> {
        val q = if (season == null || episode == null) "imdb_id=$imdb&is_movie=true" else "imdb_id=$imdb&season=$season&episode=$episode"
        val o = get("$INTRODB?$q")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return emptyList()
        return listOfNotNull(o.span("intro", Segment.Kind.Intro), o.span("recap", Segment.Kind.Recap), o.span("outro", Segment.Kind.Credits))
    }

    private fun aniSkip(mal: String, episode: Int): List<Segment> {
        val o = get("$ANISKIP/$mal/$episode?types=op&types=ed&types=recap&types=mixed-op&types=mixed-ed&episodeLength=0")
            ?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return emptyList()
        if (!o.optBoolean("found")) return emptyList()
        val r = o.optJSONArray("results") ?: return emptyList()
        return (0 until r.length()).mapNotNull { i ->
            val x = r.optJSONObject(i) ?: return@mapNotNull null
            val iv = x.optJSONObject("interval") ?: return@mapNotNull null
            val kind = when (x.optString("skipType")) {
                "op", "mixed-op" -> Segment.Kind.Intro
                "recap" -> Segment.Kind.Recap
                "ed", "mixed-ed" -> Segment.Kind.Credits
                else -> return@mapNotNull null
            }
            val s = iv.optDouble("startTime"); val e = iv.optDouble("endTime")
            // A credits mark in the first half is a bad submission (it would bring "Up next" up mid-episode).
            val length = x.optDouble("episodeLength", 0.0)
            if (kind == Segment.Kind.Credits && length > 0 && s < length / 2) return@mapNotNull null
            if (s >= 0 && e > s) Segment(kind, (s * 1000).toLong(), (e * 1000).toLong()) else null
        }
    }

    /** The anime's MAL id and episode number for AniSkip: per-season entries first, else one long show + overall number. */
    private fun malTarget(imdb: String, season: Int, episode: Int): Pair<String, Int>? {
        val arm = get("https://arm.haglund.dev/api/v2/imdb?id=$imdb")?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return null
        val tv = (0 until arm.length()).map { arm.getJSONObject(it) }
            .filter { it.optString("media") in setOf("TV", "ONA") && it.has("myanimelist") }
        tv.firstOrNull { it.optInt("themoviedb-season", -1) == season }?.let { return it.optInt("myanimelist").toString() to episode }
        val whole = tv.firstOrNull { it.isNull("themoviedb-season") } ?: return null
        return whole.optInt("myanimelist").toString() to Extras.overallEpisode(imdb, season, episode)
    }

    /** Segments for a movie (season/episode null) or an episode; empty when nobody has marked it. Cached per run. */
    suspend fun of(imdb: String, season: Int?, episode: Int?): List<Segment> {
        val key = "$imdb:$season:$episode"
        cache[key]?.let { return it }
        val found = coroutineScope {
            val db = async(Dispatchers.IO) { introDb(imdb, season, episode) }
            val ani = async(Dispatchers.IO) {
                if (season == null || episode == null) emptyList()
                else malTarget(imdb, season, episode)?.let { (mal, ep) -> aniSkip(mal, ep) }.orEmpty()
            }
            // One of each kind, IntroDB's first (Nuvio's priority).
            (db.await() + ani.await()).distinctBy { it.kind }
        }
        return found.also { cache[key] = it }
    }
}
