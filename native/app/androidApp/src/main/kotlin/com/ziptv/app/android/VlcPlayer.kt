package com.ziptv.app.android

import android.content.Context
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.ziptv.app.PlayerState
import com.ziptv.app.Track
import com.ziptv.app.VideoPlayer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import java.util.concurrent.Executors

/**
 * libVLC: plays the HEVC/E-AC3/MKV streams Android's own decoders choke on.
 * HARD RULE (v9 ANR fix 6.6.1): blocking libVLC calls (stop, setMedia, play)
 * never run on the main thread — they go through a single worker thread, which
 * also keeps them in order.
 */
class VlcPlayer(context: Context) : VideoPlayer {
    private val vlc = LibVLC(context.applicationContext, arrayListOf("--network-caching=1500", "--http-reconnect"))
    private val mp = MediaPlayer(vlc)
    private val worker = Executors.newSingleThreadExecutor()
    private val _state = MutableStateFlow<PlayerState>(PlayerState.Idle)
    override val state: StateFlow<PlayerState> = _state

    init {
        mp.setEventListener { e ->
            when (e.type) {
                MediaPlayer.Event.Buffering -> if (e.buffering < 100f) _state.value = PlayerState.Buffering(e.buffering.toInt())
                    else if (mp.isPlaying) _state.value = PlayerState.Playing
                MediaPlayer.Event.Playing -> _state.value = PlayerState.Playing
                MediaPlayer.Event.Paused -> _state.value = PlayerState.Paused
                MediaPlayer.Event.EncounteredError -> _state.value = PlayerState.Failed("The provider refused or dropped the stream.")
                MediaPlayer.Event.EndReached -> _state.value = PlayerState.Ended
                MediaPlayer.Event.Stopped -> if (_state.value !is PlayerState.Failed && _state.value != PlayerState.Ended) _state.value = PlayerState.Idle
            }
        }
    }

    override var deinterlace = false
    private var lastVolume = 100
    override var volume: Int
        get() = mp.volume.coerceIn(0, 100)
        set(v) { mp.volume = v.coerceIn(0, 100); if (v > 0) lastVolume = v }
    override var muted: Boolean
        get() = mp.volume == 0
        set(m) { mp.volume = if (m) 0 else lastVolume }

    override fun play(url: String, startMs: Long) {
        _state.value = PlayerState.Buffering(0)
        worker.execute {
            val media = Media(vlc, Uri.parse(url)).apply {
                setHWDecoderEnabled(true, false)
                if (startMs > 0) addOption(":start-time=${startMs / 1000}")
                if (deinterlace) { addOption(":deinterlace=1"); addOption(":deinterlace-mode=yadif2x") }
            }
            mp.media = media
            media.release()
            mp.play()
        }
    }

    override fun positionMs(): Long = mp.time.coerceAtLeast(0)
    override fun durationMs(): Long = mp.length.coerceAtLeast(0)
    override fun seekTo(ms: Long) = worker.execute { mp.time = ms.coerceAtLeast(0) }
    override fun audioTracks(): List<Track> = mp.audioTracks?.filter { it.id >= 0 }?.map { Track(it.id, it.name) } ?: emptyList()
    override fun subtitleTracks(): List<Track> = mp.spuTracks?.map { Track(it.id, it.name) } ?: emptyList()
    override fun selectAudio(id: Int) = worker.execute { mp.audioTrack = id }
    override fun selectSubtitle(id: Int) = worker.execute { mp.spuTrack = id }

    override fun togglePause() = worker.execute { if (mp.isPlaying) mp.pause() else mp.play() }
    override fun stop() = worker.execute { mp.stop() }

    override fun release() = worker.execute {
        mp.stop(); mp.release(); vlc.release()
    }

    // libVLC renders into one view at a time and throws if attached twice. Several Surfaces can
    // briefly coexist (fullscreen over the Live preview, mini player animating in), so the newest
    // one takes the video and, when it goes away, the previous one still on screen gets it back.
    private val layouts = ArrayList<VLCVideoLayout>()

    private fun attach(v: VLCVideoLayout) {
        if (mp.vlcVout.areViewsAttached()) mp.detachViews()
        mp.attachViews(v, null, false, false)
    }

    @Composable
    override fun Surface(modifier: Modifier) {
        AndroidView(
            factory = { ctx -> VLCVideoLayout(ctx).also { layouts += it; attach(it) } },
            onRelease = { v ->
                val wasCurrent = layouts.lastOrNull() === v
                layouts.remove(v)
                if (wasCurrent) layouts.lastOrNull()?.let(::attach) ?: mp.detachViews()
            },
            modifier = modifier,
        )
    }
}
