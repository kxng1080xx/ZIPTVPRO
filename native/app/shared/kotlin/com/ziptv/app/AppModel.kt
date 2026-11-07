package com.ziptv.app

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.ziptv.core.Channel
import com.ziptv.core.Cloud
import com.ziptv.core.ContentKind
import com.ziptv.core.CoreException
import com.ziptv.core.DeviceState
import com.ziptv.core.Provider
import com.ziptv.core.Reminder
import com.ziptv.core.SyncListener
import com.ziptv.core.UserStore
import com.ziptv.core.WatchProgress
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * A saved playlist. remoteId != null = it lives on this device's cloud record
 * (admin-provisioned or mirrored), so the admin panel can remove it.
 */
data class Playlist(
    val name: String,
    val server: String,
    val username: String,
    val password: String,
    val remoteId: String? = null,
    val hiddenTabs: List<String> = emptyList(),
    val hiddenCategories: List<String> = emptyList(),
) {
    val id get() = "$server|$username"
}

/** Saved playlists: one tab-separated line each (lists comma-joined). */
class PlaylistStore(dir: String) {
    private val file = File(dir, "playlists.tsv")
    fun load(): List<Playlist> = runCatching {
        file.readLines().mapNotNull { line ->
            val p = line.split('\t')
            if (p.size < 4) return@mapNotNull null
            fun list(i: Int) = p.getOrNull(i)?.split(',')?.filter { it.isNotBlank() } ?: emptyList()
            Playlist(p[0], p[1], p[2], p[3], p.getOrNull(4)?.ifBlank { null }, list(5), list(6))
        }
    }.getOrDefault(emptyList())

    fun save(list: List<Playlist>) {
        file.parentFile?.mkdirs()
        file.writeText(list.joinToString("\n") {
            listOf(it.name, it.server, it.username, it.password, it.remoteId ?: "",
                it.hiddenTabs.joinToString(","), it.hiddenCategories.joinToString(",")).joinToString("\t")
        })
    }
}

enum class Tab { Home, Live, Movies, Series, Search, Settings }

sealed interface Screen {
    data object Welcome : Screen
    data class Syncing(val message: String) : Screen
    data object Main : Screen
}

enum class PlayKind { Live, Catchup, Movie, Episode, Recording }

/** Everything the player and Continue Watching need about what's playing. */
data class Playable(
    val title: String,
    val subtitle: String,
    val url: String,
    val kind: PlayKind,
    val streamId: String,
    val image: String? = null,
    val extension: String? = null,
    val seriesId: String? = null,
) {
    val live get() = kind == PlayKind.Live
    val seekable get() = kind != PlayKind.Live
    val progressKey get() = when (kind) {
        PlayKind.Movie -> "movie:$streamId"
        PlayKind.Episode -> "episode:$streamId"
        else -> null
    }
}

class AppModel(val platform: Platform, val scope: CoroutineScope) {
    private val store = PlaylistStore(platform.dataDir)
    val recorder by lazy { com.ziptv.core.Recorder(File(platform.dataDir, "recordings").path) }
    /** Bumped when recordings change; the list also refreshes on a timer while one is running. */
    var recordingsVersion by mutableStateOf(0); private set
    val tmdb by lazy { com.ziptv.core.Tmdb(platform.tmdbToken(), File(platform.dataDir, "tmdb.json").path) }
    val cloud: Cloud = Cloud(File(platform.dataDir, "device_code").path, platform.cloudPlatform, platform.appVersion)

    var playlists by mutableStateOf(store.load()); private set
    var active by mutableStateOf<Playlist?>(null); private set
    /** LAN server: what cast receivers (and the TV page) fetch streams from. */
    val lan = com.ziptv.core.LanServer(8790.toUShort())
    val caster = com.ziptv.core.Caster(lan)
    val cast = CastController(this)
    private var libraryState by mutableStateOf<Provider?>(null)
    var library: Provider?
        get() = libraryState
        private set(v) { libraryState = v; lan.setProvider(v) }
    var user by mutableStateOf<UserStore?>(null); private set
    var screen by mutableStateOf<Screen>(Screen.Welcome); private set
    var device by mutableStateOf<DeviceState?>(null); private set
    var error by mutableStateOf<String?>(null)
    var tab by mutableStateOf(Tab.Home)
    /** Bumped after every sync so screens re-read the catalog. */
    var catalogVersion by mutableStateOf(0); private set
    /** Bumped when favorites/pins/progress change so lists re-read the store. */
    var userVersion by mutableStateOf(0); private set

    val player: VideoPlayer = platform.createPlayer()
    val watch = WatchTogether(this)
    var nowPlaying by mutableStateOf<Playable?>(null); private set
    var fullscreen by mutableStateOf(false)
    /** Detail pages opened from elsewhere (Home, Search). */
    var openMovie by mutableStateOf<com.ziptv.core.Movie?>(null)
    var openSeries by mutableStateOf<com.ziptv.core.Series?>(null)
    var showGuide by mutableStateOf(false)
    /** Live TV's selected category; the full guide opens on the same one. */
    private var liveCategoryState = mutableStateOf(CAT_ALL)
    /** Remembered per playlist, so the app reopens on the category you left. */
    var liveCategory: String
        get() = liveCategoryState.value
        set(v) {
            if (v == liveCategoryState.value) return
            liveCategoryState.value = v
            user?.setSetting("live_cat", v.takeIf { it != CAT_ALL })
        }
    /** True while the OS picture-in-picture window is showing (Android): render video only. */
    var inSystemPip by mutableStateOf(false)
    /** "Picture in picture" on desktop: force the mini player even on the Live page. */
    var pip by mutableStateOf(false)
    /** The header search box (shared by every screen); typing opens the results. */
    var searchQuery by mutableStateOf("")
    var sleepAt by mutableStateOf<Long?>(null); private set
    var dueReminder by mutableStateOf<Reminder?>(null)
    /** Set when GitHub has a newer v10 release for this platform. */
    var update by mutableStateOf<com.ziptv.core.UpdateInfo?>(null)
    /** Channels the live player zaps through (the list it was started from). */
    var zapList by mutableStateOf<List<Channel>>(emptyList()); private set
    private var progressJob: Job? = null

    // ------------------------------------------------------------ auto-next (series)
    /** The next episode, shown as "Up next" in the last ~20s of an episode; plays when this one ends. */
    var upNext by mutableStateOf<Playable?>(null); private set
    var upNextIn by mutableStateOf(0); private set
    private var upNextJob: Job? = null
    private var upNextCancelled = false

    private fun watchForNext(item: Playable) {
        upNextJob?.cancel(); upNext = null; upNextCancelled = false
        if (item.kind != PlayKind.Episode || item.seriesId == null) return
        upNextJob = scope.launch {
            var next: Playable? = null
            var looked = false
            while (isActive && nowPlaying === item) {
                delay(1000)
                val dur = player.durationMs(); val left = dur - player.positionMs()
                val ended = player.state.value == PlayerState.Ended
                if (!looked && dur > 0 && (left <= 25_000 || ended)) {
                    looked = true
                    next = withContext(Dispatchers.IO) { runCatching { nextEpisode(item) }.getOrNull() }
                }
                val n = next ?: continue
                if (upNextCancelled) continue
                if (left > 26_000 && !ended) { upNext = null; continue } // seeked back: hide until the end again
                upNext = n
                upNextIn = (left / 1000).toInt().coerceAtLeast(0)
                if (ended || left <= 800) { playUpNext(); break }
            }
        }
    }

    private fun nextEpisode(item: Playable): Playable? {
        val lib = library ?: return null
        val eps = lib.episodes(item.seriesId ?: return null).sortedWith(compareBy({ it.season }, { it.number }))
        val e = eps.getOrNull(eps.indexOfFirst { it.id == item.streamId }.takeIf { it >= 0 }?.plus(1) ?: return null) ?: return null
        val show = item.title.substringBefore(" · ")
        return Playable("$show · S${e.season}E${e.number}", e.title.ifBlank { "Episode ${e.number}" },
            lib.episodeUrl(e.id, e.extension), PlayKind.Episode, e.id, e.image ?: item.image, e.extension, item.seriesId)
    }

    fun playUpNext() {
        val n = upNext ?: return
        upNext = null
        play(n, full = true)
    }

    fun cancelUpNext() { upNextCancelled = true; upNext = null }

    private val logoIndex by lazy { platform.logoIndexJson() }

    fun start() {
        playlists.firstOrNull()?.let { open(it) }
        // Waiting on the activation screen: check every 3 s so a playlist added on /connect shows up
        // right away (5 min looked like "cloud sync doesn't work"). Set up: every 5 min.
        scope.launch { while (isActive) { heartbeat(); delay(if (playlists.isEmpty()) 3_000 else 5 * 60_000) } }
        scope.launch { while (isActive) { tick(); delay(15_000) } }
        scope.launch {
            delay(20_000) // after startup work
            update = withContext(Dispatchers.IO) { runCatching { com.ziptv.core.checkUpdate(platform.appVersion, platform.cloudPlatform) }.getOrNull() }
        }
    }

    // ---------------------------------------------------------------- cloud

    /** Check in now (Settings opened): pairing done on the other device shows without waiting 5 min. */
    fun refreshCloud() { scope.launch { heartbeat() } }

    /** Activation, admin playlists, expiry. Offline = keep working with what we have. */
    private suspend fun heartbeat() {
        val s = withContext(Dispatchers.IO) { runCatching { cloud.heartbeat() }.getOrNull() } ?: return
        device = s
        if (s.expired) {
            // Same rule as v9: an expired device loses its playlists until renewed.
            player.stop(); nowPlaying = null; fullscreen = false
            playlists = emptyList(); store.save(playlists)
            library = null; user = null; active = null; screen = Screen.Welcome
            return
        }
        val remote = s.playlists.map {
            Playlist(it.name, it.serverUrl, it.username, it.password, it.id, it.hiddenTabs, it.hiddenCategories)
        }
        val remoteIds = remote.map { it.id }.toSet()
        // Cloud is the source of truth for cloud-linked playlists; device-only ones stay.
        val merged = (remote + playlists.filter { it.remoteId == null && it.id !in remoteIds })
            // The same login added twice (or typed in and also sent from /connect) shows once.
            .distinctBy { Triple(it.server.trim().trimEnd('/').lowercase(), it.username.trim(), it.password) }
        if (merged != playlists) {
            val wasEmpty = playlists.isEmpty()
            playlists = merged
            store.save(merged)
            val act = active
            when {
                act == null || merged.none { it.id == act.id } -> merged.firstOrNull()?.let { open(it) } ?: run {
                    player.stop(); library = null; user = null; active = null; screen = Screen.Welcome
                }
                else -> active = merged.first { it.id == act.id } // picks up hidden-category changes
            }
            if (wasEmpty && merged.isNotEmpty()) error = "Playlist connected"
        }
    }

    // ------------------------------------------------------------ playlists

    private fun fileFor(p: Playlist, prefix: String) =
        File(platform.dataDir, "$prefix-${p.id.hashCode().toUInt()}.json").path

    /** Opens a playlist: cached catalog shows instantly, then a fresh sync runs. */
    fun open(p: Playlist) {
        stop()
        active = p
        val lib = Provider(p.server, p.username, p.password)
        library = lib
        user = UserStore(fileFor(p, "user"))
        player.deinterlace = user?.setting("deinterlace") == "1"
        liveCategoryState.value = user?.setting("live_cat") ?: CAT_ALL
        userVersion++
        scope.launch {
            val cached = withContext(Dispatchers.IO) {
                logoIndex?.let { runCatching { lib.setLogoIndex(it) } }
                lib.load(fileFor(p, "catalog"))
            }
            if (cached) {
                catalogVersion++
                screen = Screen.Main
                sync(background = true)
            } else {
                sync(background = false)
            }
        }
    }

    /** Validates the login first, so a typo never leaves a broken playlist saved. */
    fun add(p: Playlist, onDone: (String?) -> Unit) {
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    Provider(p.server, p.username, p.password).login()
                    // Mirror to the cloud so the admin panel sees it (best-effort).
                    val rid = runCatching { cloud.addPlaylist(p.name, p.server, p.username, p.password) }.getOrNull()
                    Result.success(p.copy(remoteId = rid?.ifBlank { null }))
                } catch (e: CoreException) {
                    Result.failure(e)
                }
            }
            result.onSuccess { saved ->
                playlists = listOf(saved) + playlists.filterNot { it.id == saved.id }
                store.save(playlists)
                open(saved)
                onDone(null)
            }.onFailure { onDone(it.message ?: "Could not sign in") }
        }
    }

    fun remove(p: Playlist) {
        p.remoteId?.let { rid -> scope.launch(Dispatchers.IO) { runCatching { cloud.removePlaylist(rid) } } }
        playlists = playlists.filterNot { it.id == p.id }
        store.save(playlists)
        File(fileFor(p, "catalog")).delete()
        if (active?.id == p.id) {
            stop(); library = null; user = null; active = null
            playlists.firstOrNull()?.let { open(it) } ?: run { screen = Screen.Welcome }
        }
    }

    /** Device AND cloud. Cloud first: if it can't be reached nothing changes, or the next heartbeat would re-add them. */
    fun removeAll(onDone: (String?) -> Unit) {
        scope.launch {
            val err = withContext(Dispatchers.IO) {
                runCatching { cloud.removeAllPlaylists() }.exceptionOrNull()?.message
            }
            if (err == null) {
                stop()
                playlists.forEach { File(fileFor(it, "catalog")).delete() }
                playlists = emptyList(); store.save(playlists)
                library = null; user = null; active = null; screen = Screen.Welcome
            }
            onDone(err)
        }
    }

    fun sync(background: Boolean = true) {
        val lib = library ?: return
        val p = active ?: return
        if (!background) screen = Screen.Syncing("Connecting")
        scope.launch {
            try {
                val summary = withContext(Dispatchers.IO) {
                    lib.sync(object : SyncListener {
                        override fun onProgress(message: String) {
                            if (!background) scope.launch { screen = Screen.Syncing(message) }
                        }
                    }).also { lib.save(fileFor(p, "catalog")) }
                }
                catalogVersion++
                screen = Screen.Main
                if (summary.skipped.isNotEmpty()) {
                    error = "Some lists could not be downloaded (${summary.skipped.joinToString()}). Kept the previous copy."
                }
            } catch (e: CoreException) {
                error = e.message
                screen = if (catalogVersion > 0) Screen.Main else Screen.Welcome
            }
        }
    }

    // --------------------------------------------------------- user data

    fun isHiddenTab(tab: Tab) = active?.hiddenTabs?.any { it.equals(tab.name, ignoreCase = true) } == true
    fun isHiddenCategory(id: String) = active?.hiddenCategories?.contains(id) == true

    fun isFavorite(kind: ContentKind, id: String) = user?.isFavorite(kind, id) == true
    fun toggleFavorite(kind: ContentKind, id: String) {
        user?.toggleFavorite(kind, id); userVersion++
    }
    fun togglePin(kind: ContentKind, categoryId: String) {
        user?.togglePin(kind, categoryId); userVersion++
    }

    fun addReminder(r: Reminder) { user?.addReminder(r); userVersion++; error = "Reminder set for ${r.title}" }
    fun removeReminder(r: Reminder) { user?.removeReminder(r.streamId, r.start); userVersion++ }
    fun hasReminder(streamId: String, start: Long) = user?.reminders()?.any { it.streamId == streamId && it.start == start } == true

    // ------------------------------------------------------------ playback

    fun playChannel(ch: Channel, list: List<Channel>, full: Boolean) {
        val lib = library ?: return
        zapList = list
        user?.addRecent(ch.streamId); userVersion++
        play(Playable(ch.name, "Live", liveUrl(lib, ch.streamId), PlayKind.Live, ch.streamId, ch.logo), full)
    }

    /** Catch-up -> back to the live channel; live -> reconnect at the live edge (v9 "Go Live"). */
    fun goLive() {
        val cur = nowPlaying ?: return
        val ch = zapList.firstOrNull { it.streamId == cur.streamId }
            ?: library?.channelsByIds(listOf(cur.streamId))?.firstOrNull() ?: return
        nowPlaying = null // force a fresh connection
        playChannel(ch, zapList.ifEmpty { listOf(ch) }, fullscreen)
    }

    /** Next/previous channel in the list playback started from. */
    fun zap(delta: Int) {
        val cur = nowPlaying?.takeIf { it.live } ?: return
        val i = zapList.indexOfFirst { it.streamId == cur.streamId }
        if (i < 0 || zapList.isEmpty()) return
        val next = zapList[(i + delta + zapList.size) % zapList.size]
        playChannel(next, zapList, full = fullscreen)
    }

    fun play(item: Playable, full: Boolean) {
        // Same stream already running (preview -> fullscreen): just resize, never reconnect —
        // a restart costs a provider connection and is often refused on busy accounts.
        if (nowPlaying?.url == item.url && player.state.value !is PlayerState.Failed) { fullscreen = full; return }
        progressJob?.cancel()
        saveProgress() // the item being replaced
        nowPlaying = item
        fullscreen = full
        val resume = item.progressKey?.let { user?.progress(it) }?.positionMs ?: 0L
        player.play(item.url, resume)
        item.progressKey?.let { startProgressSaver() }
        watchForNext(item)
    }

    fun stop() {
        pip = false
        upNextJob?.cancel(); upNext = null
        progressJob?.cancel()
        saveProgress()
        player.stop()
        nowPlaying = null
        fullscreen = false
    }

    private var lastCloudBackup = 0L

    private fun startProgressSaver() {
        progressJob = scope.launch {
            while (isActive) { delay(10_000); saveProgress() }
        }
    }

    private fun saveProgress() {
        val item = nowPlaying ?: return
        val key = item.progressKey ?: return
        val pos = player.positionMs(); val dur = player.durationMs()
        if (pos < 5_000 || dur <= 0) return
        val kind = if (item.kind == PlayKind.Movie) ContentKind.MOVIE else ContentKind.SERIES
        val p = WatchProgress(key, kind, item.title, item.subtitle, item.image, item.streamId, item.extension, item.seriesId,
            pos, dur, System.currentTimeMillis() / 1000)
        user?.setProgress(p); userVersion++
        val now = System.currentTimeMillis()
        val pid = active?.remoteId ?: active?.id ?: ""
        if (now - lastCloudBackup > 30_000) { // companion hand-off mirror, throttled
            lastCloudBackup = now
            scope.launch(Dispatchers.IO) { cloud.recordHistory(pid, p) }
        }
    }

    fun resume(p: WatchProgress) {
        val lib = library ?: return
        // From the other device: the cloud keeps no file type, so find it in this catalog first.
        if (p.extension == null) {
            scope.launch {
                val ext = withContext(Dispatchers.IO) {
                    runCatching {
                        if (p.kind == ContentKind.MOVIE) lib.moviesByIds(listOf(p.streamId)).firstOrNull()?.extension
                        else p.seriesId?.let { sid -> lib.episodes(sid).firstOrNull { it.id == p.streamId }?.extension }
                    }.getOrNull()
                }
                resume(p.copy(extension = ext ?: "mp4"))
            }
            return
        }
        val url = if (p.kind == ContentKind.MOVIE) lib.movieUrl(p.streamId, p.extension) else lib.episodeUrl(p.streamId, p.extension)
        play(Playable(p.title, p.subtitle, url, if (p.kind == ContentKind.MOVIE) PlayKind.Movie else PlayKind.Episode,
            p.streamId, p.image, p.extension, p.seriesId), full = true)
    }

    fun playCatchup(ch: Channel, title: String, start: Long, end: Long) {
        val lib = library ?: return
        val minutes = ((end - start) / 60).toUInt().coerceAtLeast(1u)
        play(Playable(title, "Catch-up · ${ch.name}", lib.catchupUrl(ch.streamId, start, minutes), PlayKind.Catchup, ch.streamId, ch.logo), true)
    }

    fun setSetting(key: String, value: String?) { user?.setSetting(key, value); userVersion++ }

    /** v9's Stream Format: some providers only serve live channels as HLS (.m3u8). */
    fun liveUrl(lib: Provider, id: String): String = lib.liveUrl(id).let {
        if (user?.setting("stream_format") == "m3u8" && it.endsWith(".ts")) it.dropLast(3) + ".m3u8" else it
    }

    /** Remembered per playlist; restarts the current stream so it takes effect now. */
    fun toggleDeinterlace() {
        val on = !player.deinterlace
        player.deinterlace = on
        user?.setSetting("deinterlace", if (on) "1" else null)
        userVersion++
        nowPlaying?.let { item -> val full = fullscreen; nowPlaying = null; play(item, full) }
        error = if (on) "Deinterlace on (smooth 60fps)" else "Deinterlace off"
    }

    /** Records the live channel until the current show ends (1h when there's no guide). */
    fun recordNow() {
        val item = nowPlaying?.takeIf { it.live } ?: return
        val lib = library ?: return
        scope.launch {
            val t = System.currentTimeMillis() / 1000
            val end = withContext(Dispatchers.IO) {
                runCatching { lib.epg(item.streamId) }.getOrDefault(emptyList()).firstOrNull { it.start <= t && it.end > t }
            }
            val title = end?.title ?: item.title
            // One-stream plans: the player already holds the only connection, so the recorder's
            // would be refused (0-byte "Failed" recordings). Free it for the recording instead.
            val maxCons = withContext(Dispatchers.IO) { runCatching { lib.login().maxConnections }.getOrNull() } ?: 0u
            val single = maxCons == 1u
            if (single) stop()
            val id = recorder.record(item.url, title, item.title, t, end?.end ?: (t + 3600))
            liveRecordings = liveRecordings + (item.streamId to id)
            recordingsVersion++
            error = if (single) "Recording $title. Your plan allows one stream at a time, so playback stopped — it'll be in Recordings."
                else "Recording $title"
        }
    }

    /** stream id -> recording id for "record now" captures, so the menu can offer Stop. */
    var liveRecordings by mutableStateOf<Map<String, String>>(emptyMap()); private set

    /** The running "record now" capture of this channel, if any (finished ones drop out). */
    fun recordingOf(streamId: String): String? {
        val id = liveRecordings[streamId] ?: return null
        val running = recorder.list().any { it.id == id && it.status == com.ziptv.core.RecordingStatus.RECORDING }
        if (!running) liveRecordings = liveRecordings - streamId
        return id.takeIf { running }
    }

    fun stopRecording(streamId: String) {
        liveRecordings[streamId]?.let { recorder.stop(it) }
        liveRecordings = liveRecordings - streamId
        recordingsVersion++
        error = "Recording stopped — it's in Recordings on Home"
    }

    /** Schedules a future (or current) programme; the app must stay open (same as v9). */
    fun recordProgramme(ch: Channel, title: String, start: Long, end: Long) {
        val lib = library ?: return
        recorder.record(liveUrl(lib, ch.streamId), title, ch.name, start, end)
        recordingsVersion++
        error = "Recording scheduled: $title"
    }

    fun playRecording(r: com.ziptv.core.Recording) {
        val url = java.io.File(r.path).toURI().toString()
        play(Playable(r.title, "Recording · ${r.channel}", url, PlayKind.Recording, r.id), full = true)
    }

    fun deleteRecording(r: com.ziptv.core.Recording) {
        recorder.delete(r.id); recordingsVersion++
    }

    fun setSleepTimer(minutes: Int?) {
        sleepAt = minutes?.let { System.currentTimeMillis() + it * 60_000L }
        error = minutes?.let { "Sleep timer: $it min" } ?: "Sleep timer off"
    }

    /** Sleep timer + reminders. */
    private fun tick() {
        sleepAt?.let { if (System.currentTimeMillis() >= it) { sleepAt = null; stop() } }
        val due = user?.dueReminders(System.currentTimeMillis() / 1000, 60) ?: emptyList()
        if (due.isNotEmpty()) { dueReminder = due.first(); userVersion++ }
    }
}

/** "http://host:8080/get.php?username=U&password=P&type=m3u_plus" -> (host, U, P). */
fun parseM3uUrl(url: String): Triple<String, String, String>? {
    val q = url.substringAfter('?', "")
    if (q.isEmpty()) return null
    val params = q.split('&').associate { it.substringBefore('=') to java.net.URLDecoder.decode(it.substringAfter('=', ""), "UTF-8") }
    val user = params["username"] ?: return null
    val pass = params["password"] ?: return null
    val host = url.substringBefore('?').substringBeforeLast('/')
    return Triple(host, user, pass)
}

/** "FHD", "4K"… from the provider's raw channel name. */
fun qualityBadge(rawName: String): String? {
    val n = rawName.uppercase()
    return when {
        Regex("""\b(4K|UHD|2160P?)\b""").containsMatchIn(n) -> "4K"
        Regex("""\b(FHD|1080P?)\b""").containsMatchIn(n) -> "FHD"
        Regex("""\b(HD|720P?)\b""").containsMatchIn(n) -> "HD"
        else -> null
    }
}
