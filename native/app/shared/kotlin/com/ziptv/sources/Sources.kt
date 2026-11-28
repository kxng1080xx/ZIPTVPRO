package com.ziptv.sources

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap

// The CinemaOS built-in sources (ported from github.com/cinema-os/CinemaOS-Mobile, GPL-3.0).
// Everything else in this package is the scrapers as they were there; this file is ZIPTV's entry point.

/** One link a scraper found (the shape the CinemaOS scrapers return). */
data class PluginRuntimeResult(
    val title: String,
    val name: String? = null,
    val url: String,
    val quality: String? = null,
    val size: String? = null,
    val language: String? = null,
    val provider: String? = null,
    val type: String? = null,
    val seeders: Int? = null,
    val peers: Int? = null,
    val infoHash: String? = null,
    val headers: Map<String, String>? = null,
    val subtitles: List<PluginSubtitleResult>? = null,
)

data class PluginSubtitleResult(
    val url: String,
    val language: String,
    val name: String? = null,
    val headers: Map<String, String>? = null,
)

/** One search: [found] fills in as each source answers (the 4K badge, the Sources panel); [result] is the final list. */
class SourceSearch(val found: kotlinx.coroutines.flow.StateFlow<List<SourceLink>>, val result: Deferred<List<SourceLink>>)

/** A subtitle file that comes with a link (anime SUB streams): [label] "English", [lang] an ISO code when known. */
data class SubFile(val label: String, val lang: String?, val url: String, val headers: Map<String, String>)

/**
 * A playable link. [height] = 2160 for 4K, 1080, 720…, 0 = not stated. [audio] = "Japanese (Sub)", "English (Dub)"…
 * for anime links (the player's audio picker switches between them).
 */
data class SourceLink(
    val url: String, val headers: Map<String, String>, val height: Int, val source: String,
    val audio: String? = null, val subtitles: List<SubFile> = emptyList(),
    /** Audio languages the link says it has (ISO codes, e.g. "en", "hi"); empty = not stated. */
    val langs: Set<String> = emptySet(),
) {
    /** 2 = has [lang], 1 = doesn't say, 0 = other languages only. */
    fun langTier(lang: String) = when { lang in langs -> 2; langs.isEmpty() -> 1; else -> 0 }
    val is4k get() = height >= 2160
}

object Sources {
    private val http by lazy { CinemaHttp() }

    /** CinemaOS's priority order: Movy > HdHub > Wing > MovieBox > Hindmoviez > 4KHDHub > VegaMovies > HDhub4u > Movies4u. */
    private val scrapers: List<CinemaScraper> by lazy {
        listOf(
            MovyScraper(http), HdHubScraper(http), WingScraper(http), MovieBoxScraper(http),
            HindmoviezScraper(http), FourKHdHubScraper(http), VegaMoviesScraper(http),
            HdHub4uScraper(http), Movies4uScraper(http),
        )
    }

    // Links expire (signed CDN URLs), so a lookup is reused for a while only. The details page starts it
    // (for the 4K badge) and Play picks up the same one, often already finished.
    private const val KEEP_MS = 20 * 60_000L
    private val cache = ConcurrentHashMap<String, Pair<Long, SourceSearch>>()

    /**
     * Every source at once. Returns as soon as all have answered, or after [EARLY_MS] once something was
     * found (the slow ones rarely add anything); nothing at all after [MAX_MS]. Unranked; see [ranked].
     */
    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    fun lookup(tmdbId: String, movie: Boolean, season: Int?, episode: Int?): SourceSearch {
        val key = "$tmdbId:$movie:$season:$episode"
        val now = System.currentTimeMillis()
        cache[key]?.let { (at, s) ->
            val d = s.result
            val empty = d.isCompleted && runCatching { d.getCompleted().isEmpty() }.getOrDefault(true)
            if (now - at < KEEP_MS && !empty) return s // nothing found last time: look again
        }
        val found = kotlinx.coroutines.flow.MutableStateFlow<List<SourceLink>>(emptyList())
        // ponytail: GlobalScope so a lookup outlives the screen that started it (Play reuses it).
        val d = GlobalScope.async(Dispatchers.IO) { find(CinemaScrapeRequest(tmdbId, if (movie) "movie" else "tv", season ?: 1, episode ?: 1), found) }
        return SourceSearch(found, d).also { cache[key] = now to it }
    }

    private const val EARLY_MS = 12_000L
    private const val MAX_MS = 27_000L

    private val AUDIO = Regex("""\b(dub|sub|dual)\b""", RegexOption.IGNORE_CASE)

    /** "Anikoto · DUB": the source's short name, plus sub/dub when the link says (anime has both). */
    private fun links(name: String, results: List<PluginRuntimeResult>, anime: Boolean = false) = results
        .filter { r -> r.url.startsWith("http") && r.infoHash == null }
        .map { r ->
            val audio = AUDIO.find(listOfNotNull(r.name, r.title, r.language).joinToString(" "))?.value?.uppercase()
            SourceLink(r.url, r.headers.orEmpty(), CinemaKit.qualityNum(listOfNotNull(r.quality, r.title, r.name).joinToString(" ")),
                listOfNotNull(name.substringAfter("· ").trim(), audio).joinToString(" · "),
                audio = if (anime) animeAudio(r) else null,
                subtitles = r.subtitles.orEmpty().map { s -> subFile(s) },
                langs = SourceLanguage.parse(listOfNotNull(r.language, r.name, r.title).joinToString(" ")).codes)
        }

    /** CinemaOS's anime audio label: "Japanese (Sub)", "English (Dub)", "Hindi (Dub)"… null = can't tell. */
    private fun animeAudio(r: PluginRuntimeResult): String? {
        val info = SourceLanguage.parse(listOfNotNull(r.language, r.name, r.title).joinToString(" "))
        val code = info.primary ?: return null
        val suffix = when (info.kind) {
            StreamAudioKind.DUB -> "Dub"
            StreamAudioKind.SUB -> "Sub"
            StreamAudioKind.ORIGINAL -> if (code == "ja") "Sub" else "Original"
            else -> if (code == "ja") "Sub" else "Dub"
        }
        return "${SourceLanguage.labelOf(code)} ($suffix)"
    }

    /** "…/subtitles/eng-2.vtt" with no language given -> "English" (from the file name's ISO 639-2 code). */
    private fun subFile(s: PluginSubtitleResult): SubFile {
        val given = s.language.takeIf { it.isNotBlank() && !it.equals("Unknown", true) }
        val code = given?.takeIf { it.length in 2..3 } ?: Regex("""(?:^|[/_.-])([a-z]{3})(?:-\d+)?\.(?:vtt|srt|ass)""").find(s.url.substringBefore('?'))?.groupValues?.get(1)
        val fromCode = code?.let { java.util.Locale.forLanguageTag(if (it == "ger") "de" else if (it == "fre") "fr" else if (it == "chi") "zh" else it).getDisplayLanguage(java.util.Locale.ENGLISH) }
            ?.takeIf { it.isNotBlank() && !it.equals(code, true) }
        val label = (s.name?.takeIf { it.isNotBlank() && !it.equals("Unknown", true) } ?: given?.takeIf { it.length > 3 } ?: fromCode ?: code?.uppercase() ?: "Subtitles")
        return SubFile(label, code, s.url, s.headers.orEmpty())
    }

    private const val ANIME_MAX_MS = 45_000L // the JS anime sources chain several lookups

    private suspend fun find(req: CinemaScrapeRequest, found: kotlinx.coroutines.flow.MutableStateFlow<List<SourceLink>>): List<SourceLink> = coroutineScope {
        fun report(l: List<SourceLink>) = l.also { if (it.isNotEmpty()) found.update { cur -> (cur + it).distinctBy { x -> x.url } } }
        // Anime (arm.haglund.dev knows the TMDB id): the CinemaOS anime sources first, then the regular ones.
        val anime = runCatching { http.isAnimeTmdb(req.tmdbId) }.getOrDefault(false)
        val plugins = if (anime) runCatching { AnimeSources.plugins() }.getOrDefault(emptyList()) else emptyList()
        // Long-running shows: the same episode by MAL id + overall number (worked out once, only if needed).
        val overall = lazy { async(Dispatchers.IO) { if (req.isMovie) null else AnimeSources.overall(req.tmdbId, req.season, req.episode) } }
        val pluginJobs = plugins.map { p ->
            async {
                val byTmdb = AnimeSources.run(p, req.tmdbId, req.isMovie, req.season.takeIf { !req.isMovie }, req.episode.takeIf { !req.isMovie })
                val r = byTmdb.ifEmpty { overall.value.await()?.let { (id, ep) -> AnimeSources.run(p, id, false, null, ep) }.orEmpty() }
                report(links(p.name, r, anime = true))
            }
        }
        val scraperJobs = scrapers.map { s ->
            async {
                val r = withTimeoutOrNull(s.budgetMs) { runCatching { s.getStreams(req) }.getOrNull() }.orEmpty()
                report(links(s.name, r))
            }
        }
        val jobs = pluginJobs + scraperJobs
        val max = if (anime) ANIME_MAX_MS else MAX_MS
        val start = System.currentTimeMillis()
        while (true) {
            val t = System.currentTimeMillis() - start
            if (jobs.all { it.isCompleted } || t > max) break
            // Anime: wait for an anime source (the regular ones rarely have the right episode).
            if (t > EARLY_MS && (if (pluginJobs.isNotEmpty()) pluginJobs else jobs).any { it.isCompleted && it.getCompleted().isNotEmpty() }) break
            delay(250)
        }
        val done = jobs.filter { it.isCompleted }.flatMap { it.getCompleted() }.distinctBy { it.url } // priority order kept
        jobs.forEach { it.cancel() }
        done
    }

    /**
     * Best first. A 4K screen gets 4K, then 1080p, 720p…; anything else gets 1080p first and 4K only
     * after 720p (big files for no visible gain). Same quality keeps the sources' priority order.
     */
    fun ranked(links: List<SourceLink>, screen4k: Boolean, lang: String = "en"): List<SourceLink> = links.sortedWith(
        // The chosen audio language first (a 4K copy in another language is no use), then quality.
        compareByDescending<SourceLink> { it.langTier(lang) }.thenBy { l -> quality(l, screen4k) })

    private fun quality(l: SourceLink, screen4k: Boolean): Int {
        val h = l.height
        return when {
            screen4k && h >= 2160 -> 0
            h in 1080 until 2160 -> 1
            h in 720 until 1080 -> 2
            h >= 2160 -> 3
            h == 0 -> 4
            else -> 5
        }
    }
}
