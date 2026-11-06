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
    /** Picture-in-picture where the OS supports it; false = not available. */
    fun enterPip(): Boolean = false

    /** Space to keep clear of a camera cut-out (Android full-screen); zero elsewhere. */
    @Composable
    fun cutoutPadding(): androidx.compose.foundation.layout.PaddingValues = androidx.compose.foundation.layout.PaddingValues()

    /** Android: system back / remote BACK. Desktop: Escape. */
    @Composable
    fun BackHandler(enabled: Boolean, onBack: () -> Unit)
}
