package com.ziptv.desktop

import androidx.compose.ui.draw.clipToBounds
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asComposeImageBitmap
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import com.ziptv.app.PlayerState
import com.ziptv.app.Track
import com.ziptv.app.VideoPlayer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.jetbrains.skia.Bitmap
import org.jetbrains.skia.ColorAlphaType
import org.jetbrains.skia.ImageInfo
import uk.co.caprica.vlcj.factory.MediaPlayerFactory
import uk.co.caprica.vlcj.player.base.MediaPlayer
import uk.co.caprica.vlcj.player.base.MediaPlayerEventAdapter
import uk.co.caprica.vlcj.player.embedded.videosurface.callback.BufferFormat
import uk.co.caprica.vlcj.player.embedded.videosurface.callback.BufferFormatCallback
import uk.co.caprica.vlcj.player.embedded.videosurface.callback.RenderCallback
import uk.co.caprica.vlcj.player.embedded.videosurface.callback.format.RV32BufferFormat
import java.nio.ByteBuffer
import java.util.concurrent.Executors

/**
 * VLC 3 via vlcj, rendered into a Compose bitmap (not a heavyweight AWT
 * canvas) so the player controls can draw on top of the video.
 * The installer ships its own trimmed VLC (app resources/vlc); dev runs use the installed VLC.
 */
class VlcjPlayer : VideoPlayer {
    private val factory = run {
        // vlcj's discovery checks jna.library.path first; plugins/ next to libvlc.dll is found by VLC itself.
        // ZIPTV_SYSTEM_VLC=1 forces the installed VLC (A/B debugging).
        if (System.getenv("ZIPTV_SYSTEM_VLC") == null) System.getProperty("compose.application.resources.dir")?.let { java.io.File(it, "vlc") }
            ?.takeIf { java.io.File(it, "libvlc.dll").exists() }
            ?.let { System.setProperty("jna.library.path", it.absolutePath) }
        val discovery = uk.co.caprica.vlcj.factory.discovery.NativeDiscovery()
        val found = discovery.discover()
        // One line so "which VLC is this?" is answerable from a user's PC.
        runCatching {
            java.io.File(System.getProperty("user.home"), ".ziptv10").apply { mkdirs() }
                .resolve("vlc.log").writeText("found=$found path=${discovery.discoveredPath()}")
        }
        // Without plugins.dat libVLC loads all ~300 plugin DLLs on every start (18 s cold with Defender).
        // A shipped cache is always stale (the installer gives files new dates), so VLC writes its own,
        // once per installed version, like vlc-cache-gen does.
        val marker = java.io.File(System.getProperty("user.home"), ".ziptv10/vlc-cache-" + (System.getProperty("jpackage.app-version") ?: "dev"))
        val args = listOfNotNull("--network-caching=1500", "--http-reconnect", "--no-video-title-show",
            "--reset-plugins-cache".takeIf { !marker.exists() })
        MediaPlayerFactory(discovery, *args.toTypedArray()).also { runCatching { marker.writeText("") } }
    }
    private val mp = factory.mediaPlayers().newEmbeddedMediaPlayer()
    private val worker = Executors.newSingleThreadExecutor()
    private val _state = MutableStateFlow<PlayerState>(PlayerState.Idle)
    override val state: StateFlow<PlayerState> = _state

    // Two bitmaps: VLC writes one while Compose draws the other.
    @Volatile private var front: Bitmap? = null
    private var back: Bitmap? = null
    private var pixels = ByteArray(0)
    private var width = 0
    private var height = 0
    private val frame = mutableIntStateOf(0)

    init {
        val formatCb = object : BufferFormatCallback {
            override fun getBufferFormat(sourceWidth: Int, sourceHeight: Int): BufferFormat {
                width = sourceWidth; height = sourceHeight
                pixels = ByteArray(width * height * 4)
                front = null; back = null
                return RV32BufferFormat(sourceWidth, sourceHeight)
            }
            override fun newFormatSize(bufferWidth: Int, bufferHeight: Int, displayWidth: Int, displayHeight: Int) {}
            override fun allocatedBuffers(buffers: Array<out ByteBuffer>) {}
        }
        val renderCb = object : RenderCallback {
            override fun lock(mediaPlayer: MediaPlayer) {}
            override fun display(mediaPlayer: MediaPlayer, nativeBuffers: Array<out ByteBuffer>, bufferFormat: BufferFormat, displayWidth: Int, displayHeight: Int) {
                val buf = nativeBuffers[0]
                buf.rewind(); buf.get(pixels, 0, minOf(pixels.size, buf.remaining()))
                // RV32 is BGRA in memory = Skia's N32 on Windows.
                val bmp = back ?: Bitmap().also { it.allocPixels(ImageInfo.makeN32(width, height, ColorAlphaType.OPAQUE)) }
                bmp.installPixels(bmp.imageInfo, pixels, width * 4)
                back = front
                front = bmp
                frame.intValue++
            }
            override fun unlock(mediaPlayer: MediaPlayer) {}
        }
        mp.videoSurface().set(factory.videoSurfaces().newVideoSurface(formatCb, renderCb, true))
        mp.events().addMediaPlayerEventListener(object : MediaPlayerEventAdapter() {
            override fun buffering(mediaPlayer: MediaPlayer, newCache: Float) {
                _state.value = if (newCache < 100f) PlayerState.Buffering(newCache.toInt()) else PlayerState.Playing
            }
            override fun playing(mediaPlayer: MediaPlayer) { _state.value = PlayerState.Playing }
            override fun paused(mediaPlayer: MediaPlayer) { _state.value = PlayerState.Paused }
            override fun error(mediaPlayer: MediaPlayer) {
                _state.value = PlayerState.Failed("The provider refused or dropped the stream.")
            }
            override fun finished(mediaPlayer: MediaPlayer) { _state.value = PlayerState.Ended }
            override fun stopped(mediaPlayer: MediaPlayer) {
                if (_state.value !is PlayerState.Failed && _state.value != PlayerState.Ended) _state.value = PlayerState.Idle
            }
        })
    }

    override var deinterlace = false
    override var upscale = false
    override var audioLanguage = "en"
    // Tracked here: VLC reports "muted"/volume -1 until audio output exists, which showed a false mute icon.
    override var volume: Int = 100
        set(v) { field = v.coerceIn(0, 100); mp.audio().setVolume(field) }
    override var muted: Boolean = false
        set(m) { field = m; mp.audio().isMute = m }

    override fun play(url: String, startMs: Long) {
        _state.value = PlayerState.Buffering(0)
        val opts = buildList {
            if (startMs > 0) add(":start-time=${startMs / 1000}")
            // GPU decoding (d3d11va, picked for HEVC movies/episodes) never reaches our frame callback:
            // picture stays black while audio plays. CPU decoding is cheap enough (~13% for 1080p HEVC).
            // ZIPTV_HW_DECODE=1 turns GPU decoding back on.
            if (System.getenv("ZIPTV_HW_DECODE") == null) add(":avcodec-hw=none")
            if (deinterlace) { add(":deinterlace=1"); add(":deinterlace-mode=yadif2x") }
            if (upscale) { add(":video-filter=sharpen"); add(":sharpen-sigma=0.45") }
            add(":audio-language=$audioLanguage")
        }.toTypedArray()
        worker.execute { mp.media().play(url, *opts) }
    }

    override fun positionMs(): Long = mp.status().time().coerceAtLeast(0)
    override fun durationMs(): Long = mp.status().length().coerceAtLeast(0)
    override fun videoSize(): Pair<Int, Int>? = runCatching { mp.video().videoDimension()?.let { it.width to it.height } }.getOrNull()?.takeIf { it.first > 0 }
    override fun seekTo(ms: Long) = worker.execute { mp.controls().setTime(ms.coerceAtLeast(0)) }
    // VLC lists "Disable" (id -1) as an audio track: picking it mutes with no way back from the menu.
    override fun audioTracks(): List<Track> = mp.audio().trackDescriptions().filter { it.id() >= 0 }.map { Track(it.id(), it.description()) }
    override fun audioTrack(): Int = runCatching { mp.audio().track() }.getOrDefault(-1)
    override fun subtitleTrack(): Int = runCatching { mp.subpictures().track() }.getOrDefault(-1)
    override fun addSubtitle(url: String, select: Boolean) =
        worker.execute { mp.media().addSlave(uk.co.caprica.vlcj.media.MediaSlaveType.SUBTITLE, url, select) }
    override fun subtitleTracks(): List<Track> = mp.subpictures().trackDescriptions().map { Track(it.id(), it.description()) }
    override fun selectAudio(id: Int) = worker.execute { mp.audio().setTrack(id) }
    override fun selectSubtitle(id: Int) = worker.execute { mp.subpictures().setTrack(id) }

    override fun togglePause() = worker.execute { mp.controls().pause() }
    override fun stop() = worker.execute { mp.controls().stop(); front = null; frame.intValue++ }

    override fun release() {
        worker.execute { mp.controls().stop(); mp.release(); factory.release() }
        worker.shutdown()
        // Wait for VLC to let go before the JVM exits; native teardown racing the exit crashed (-1).
        worker.awaitTermination(3, java.util.concurrent.TimeUnit.SECONDS)
    }

    override var pictureSize by androidx.compose.runtime.mutableStateOf(com.ziptv.app.PictureSize.Fit)

    @Composable
    override fun Surface(modifier: Modifier) {
        Canvas(modifier.clipToBounds()) {
            frame.intValue // read so each new frame redraws
            val bmp = front ?: return@Canvas
            val img = bmp.asComposeImageBitmap()
            // Fit = letterbox, Fill = cover (edges cut, clipped), Stretch = the whole area.
            val sx = size.width / img.width; val sy = size.height / img.height
            val (w, h) = when (pictureSize) {
                com.ziptv.app.PictureSize.Fit -> minOf(sx, sy).let { (img.width * it).toInt() to (img.height * it).toInt() }
                com.ziptv.app.PictureSize.Fill -> maxOf(sx, sy).let { (img.width * it).toInt() to (img.height * it).toInt() }
                com.ziptv.app.PictureSize.Stretch -> size.width.toInt() to size.height.toInt()
            }
            drawImage(
                img, srcOffset = IntOffset.Zero, srcSize = IntSize(img.width, img.height),
                dstOffset = IntOffset(((size.width - w) / 2).toInt(), ((size.height - h) / 2).toInt()),
                dstSize = IntSize(w, h),
                // Upscaler: bicubic instead of bilinear when stretching SD/720p to the window.
                filterQuality = if (upscale) androidx.compose.ui.graphics.FilterQuality.High else androidx.compose.ui.graphics.FilterQuality.Low,
            )
        }
    }
}
