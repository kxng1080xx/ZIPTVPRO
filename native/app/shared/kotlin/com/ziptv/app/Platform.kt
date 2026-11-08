package com.ziptv.app

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.StateFlow

/**
 * How the user drives the app. Detected once at startup, never switched by the user:
 *  - Tv: Android TV / Fire TV / projectors / anything without a touchscreen -> D-pad first, 10-foot sizing
 *  - Touch: phones and tablets
 *  - Desktop: mouse + keyboard
 * Layout density (compact vs wide) is decided separately from the window width.
 */
enum class DeviceClass { Tv, Touch, Desktop }

sealed interface PlayerState {
    data object Idle : PlayerState
    data class Buffering(val percent: Int) : PlayerState
    data object Playing : PlayerState
    data object Paused : PlayerState
    /** Reached the end of a VOD file (auto-next hooks on this). */
    data object Ended : PlayerState
    data class Failed(val message: String) : PlayerState
}

/** An audio or subtitle track. id -1 = "off" (subtitles). */
data class Track(val id: Int, val name: String)

/** libVLC on Android, vlcj (VLC 3) on desktop. */
interface VideoPlayer {
    val state: StateFlow<PlayerState>
    /** Deinterlace (yadif2x = smooth 50/60 fps on interlaced sports/news). Applies on the next play(). */
    var deinterlace: Boolean
    /** startMs > 0 resumes a movie/episode where the user left off. */
    fun play(url: String, startMs: Long = 0)
    fun togglePause()
    fun stop()
    fun release()
    fun positionMs(): Long
    fun durationMs(): Long
    fun seekTo(ms: Long)
    fun audioTracks(): List<Track>
    fun subtitleTracks(): List<Track>
    fun selectAudio(id: Int)
    fun selectSubtitle(id: Int)
    /** 0..100 */
    var volume: Int
    var muted: Boolean

    @Composable
    fun Surface(modifier: Modifier)
}

/** Everything the shared UI needs from the host app. */
interface Platform {
    val device: DeviceClass
    /** "apk" or "pc": what the admin panel shows for this device. */
    val cloudPlatform: String
    val appVersion: String
    /** Writable folder for the catalog cache and saved playlists. */
    val dataDir: String
    fun logoIndexJson(): String?
    fun createPlayer(): VideoPlayer
    /** TMDB read token packaged at build time ("" = no About data). */
    fun tmdbToken(): String
    /** Opens a link outside the app (trailers). False when nothing can open it. */
    fun openUrl(url: String): Boolean
    /** Coil transformation applying [whitenDarkInk] to channel logos (null = off). */
    fun logoTransformation(): coil3.transform.Transformation? = null
    /** Whole-screen mode while the player is fullscreen (desktop: borderless fullscreen window; Android: immersive). */
    fun setScreenFullscreen(on: Boolean) {}
    /** In-app updater (Android): download [url] reporting 0..1, then open the system installer.
     *  Blocking; null = installer opened, else an error to show. Unsupported -> open the link instead. */
    val inAppUpdate: Boolean get() = false
    fun downloadAndInstall(url: String, progress: (Float) -> Unit): String? = "unsupported"
    /** Launch with the OS (desktop). null = not supported here; else (on, minimized). */
    fun autostart(): Pair<Boolean, Boolean>? = null
    fun setAutostart(on: Boolean, minimized: Boolean) {}
    /** Internet tunnel to this device's LAN server (desktop: Cloudflare quick tunnel). null = not here. */
    val tunnel: ShareTunnel? get() = null
    /** Picture-in-picture where the OS supports it; false = not available. */
    fun enterPip(): Boolean = false

    /** Space to keep clear of a camera cut-out (Android full-screen); zero elsewhere. */
    @Composable
    fun cutoutPadding(): androidx.compose.foundation.layout.PaddingValues = androidx.compose.foundation.layout.PaddingValues()

    /** Android: system back / remote BACK. Desktop: Escape. */
    @Composable
    fun BackHandler(enabled: Boolean, onBack: () -> Unit)
}

/** "Watch away from home": exposes the LAN server (Smart TV page) on a public HTTPS URL. */
interface ShareTunnel {
    /** null = off, "" = starting, else the public base URL (https://….trycloudflare.com). */
    val url: kotlinx.coroutines.flow.StateFlow<String?>
    /** What it's doing or why it stopped ("Downloading…", an error); null = nothing to say. */
    val note: kotlinx.coroutines.flow.StateFlow<String?>
    fun start(port: Int)
    fun stop()
}
