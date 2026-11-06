package com.ziptv.desktop

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
        MediaPlayerFactory(discovery, "--network-caching=1500", "--http-reconnect", "--no-video-title-show")
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
    // Tracked here: VLC reports "muted"/volume -1 until audio output exists, which showed a false mute icon.
    override var volume: Int = 100
        set(v) { field = v.coerceIn(0, 100); mp.audio().setVolume(field) }
    override var muted: Boolean = false
        set(m) { field = m; mp.audio().isMute = m }

    override fun play(url: String, startMs: Long) {
        _state.value = PlayerState.Buffering(0)
        val opts = buildList {
            if (startMs > 0) add(":start-time=${startMs / 1000}")
            if (deinterlace) { add(":deinterlace=1"); add(":deinterlace-mode=yadif2x") }
        }.toTypedArray()
        worker.execute { mp.media().play(url, *opts) }
    }

    override fun positionMs(): Long = mp.status().time().coerceAtLeast(0)
    override fun durationMs(): Long = mp.status().length().coerceAtLeast(0)
    override fun seekTo(ms: Long) = worker.execute { mp.controls().setTime(ms.coerceAtLeast(0)) }
    override fun audioTracks(): List<Track> = mp.audio().trackDescriptions().map { Track(it.id(), it.description()) }
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

    @Composable
    override fun Surface(modifier: Modifier) {
        Canvas(modifier) {
            frame.intValue // read so each new frame redraws
            val bmp = front ?: return@Canvas
            val img = bmp.asComposeImageBitmap()
            // Fit (letterbox) inside the available space.
            val scale = minOf(size.width / img.width, size.height / img.height)
            val w = (img.width * scale).toInt()
            val h = (img.height * scale).toInt()
            drawImage(
                img, srcOffset = IntOffset.Zero, srcSize = IntSize(img.width, img.height),
                dstOffset = IntOffset(((size.width - w) / 2).toInt(), ((size.height - h) / 2).toInt()),
                dstSize = IntSize(w, h),
            )
        }
    }
}
