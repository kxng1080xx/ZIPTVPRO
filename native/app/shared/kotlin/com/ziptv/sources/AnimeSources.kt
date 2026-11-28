package com.ziptv.sources

import com.ziptv.plugins.runtime.PluginRuntime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.URL

/**
 * The CinemaOS anime sources (MegaPlay, Anikoto, AnimeSalt, AnimeWorld, KickAssAnime): JavaScript plugins
 * from the CinemaOS repository, run in QuickJS (com.ziptv.plugins, ported from Nuvio). The scripts are
 * downloaded once and refreshed every 6 h; the last copy keeps working offline.
 */
object AnimeSources {
    private const val MANIFEST = "https://raw.githubusercontent.com/cinema-os/CinemaOS-TV-App/cinemaos/plugins/cinemaos/manifest.json"
    private const val REFRESH_MS = 6 * 60 * 60_000L

    /** Where the scripts are kept (the app's data folder); set at startup. */
    @Volatile var dir: File? = null

    class Plugin(val id: String, val name: String, val types: List<String>, val code: String)

    @Volatile private var loaded: Pair<Long, List<Plugin>>? = null

    private fun read(url: String): String? = runCatching {
        URL(url).openConnection().apply { connectTimeout = 10_000; readTimeout = 20_000 }.getInputStream().bufferedReader().use { it.readText() }
    }.getOrNull()

    suspend fun plugins(): List<Plugin> = withContext(Dispatchers.IO) {
        loaded?.let { (at, list) -> if (System.currentTimeMillis() - at < REFRESH_MS && list.isNotEmpty()) return@withContext list }
        val folder = File(dir ?: File(System.getProperty("java.io.tmpdir")), "plugins").apply { mkdirs() }
        val manifestFile = File(folder, "manifest.json")
        val manifest = read(MANIFEST)?.also { runCatching { manifestFile.writeText(it) } } ?: manifestFile.takeIf { it.exists() }?.readText()
            ?: return@withContext emptyList()
        val fresh = manifestFile.exists() && System.currentTimeMillis() - manifestFile.lastModified() < 1000 // just downloaded
        val base = MANIFEST.substringBeforeLast('/')
        val scrapers = runCatching { JSONObject(manifest).getJSONArray("scrapers") }.getOrNull() ?: return@withContext emptyList()
        val list = (0 until scrapers.length()).mapNotNull { i ->
            val s = scrapers.optJSONObject(i) ?: return@mapNotNull null
            if (!s.optBoolean("enabled", true)) return@mapNotNull null
            val file = s.optString("filename").takeIf { it.endsWith(".js") && !it.contains("..") } ?: return@mapNotNull null
            val local = File(folder, file)
            val code = (if (fresh || !local.exists()) read("$base/$file")?.also { runCatching { local.writeText(it) } } else null)
                ?: local.takeIf { it.exists() }?.readText() ?: return@mapNotNull null
            val types = s.optJSONArray("supportedTypes")?.let { a -> (0 until a.length()).map { a.optString(it) } }.orEmpty()
            Plugin(s.optString("id"), s.optString("name").ifBlank { file }, types, code)
        }
        if (list.isNotEmpty()) loaded = System.currentTimeMillis() to list
        list
    }

    /**
     * Long-running shows (Naruto Shippuden, One Piece…) are one entry on arm.haglund.dev with no TMDB season,
     * numbered by overall episode, so "season 3, episode 5" finds nothing there. This turns it into the
     * show's MyAnimeList/AniList id + overall episode (counted on IMDb's list via Cinemeta), which the
     * plugins also take. null = not such a show.
     */
    fun overall(tmdbId: String, season: Int, episode: Int): Pair<String, Int>? = runCatching {
        val arm = org.json.JSONArray(read("https://arm.haglund.dev/api/v2/themoviedb?id=$tmdbId") ?: return null)
        val e = (0 until arm.length()).map { arm.getJSONObject(it) }.firstOrNull {
            it.optString("media") in setOf("TV", "ONA") && it.isNull("themoviedb-season") && (it.has("myanimelist") || it.has("anilist"))
        } ?: return null
        val id = if (e.has("myanimelist")) "mal:${e.optInt("myanimelist")}" else "anilist:${e.optInt("anilist")}"
        if (season <= 1) return id to episode
        val imdb = e.optString("imdb").takeIf { it.startsWith("tt") } ?: return null
        val videos = JSONObject(read("https://v3-cinemeta.strem.io/meta/series/$imdb.json") ?: return null)
            .optJSONObject("meta")?.optJSONArray("videos") ?: return null
        val before = (0 until videos.length()).count { i ->
            val v = videos.optJSONObject(i); val s = v?.optInt("season") ?: 0
            s in 1 until season
        }
        id to before + episode
    }.getOrNull()

    /** One plugin's links (empty on any failure; PluginRuntime caps each run at 60 s). */
    suspend fun run(p: Plugin, tmdbId: String, movie: Boolean, season: Int?, episode: Int?): List<PluginRuntimeResult> {
        // Nuvio's rule: an episodic plugin that declares "series" gets "series", else "tv".
        val type = when {
            movie -> "movie"
            season != null && episode != null && p.types.any { it.equals("series", true) } -> "series"
            else -> "tv"
        }
        return runCatching { PluginRuntime.executePlugin(p.code, tmdbId, type, season, episode, p.id, respectSearchPause = false) }
            .getOrDefault(emptyList())
    }
}
