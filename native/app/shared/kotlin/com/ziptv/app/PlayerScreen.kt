package com.ziptv.app

import androidx.compose.ui.text.font.FontWeight
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Bedtime
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Forward10
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PictureInPictureAlt
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Replay10
import androidx.compose.material.icons.rounded.Subtitles
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay


@Composable
fun PlayerScreen(model: AppModel) {
    val item = model.nowPlaying ?: return
    // In the OS PiP window only the picture fits — no controls, panels or guide.
    if (model.inSystemPip) {
        Box(Modifier.fillMaxSize().background(Color.Black)) { model.player.Surface(Modifier.fillMaxSize()) }
        return
    }
    val state by model.player.state.collectAsState()
    var poke by remember { mutableIntStateOf(0) }
    var controls by remember { mutableStateOf(true) }
    var popOpen by remember { mutableStateOf(false) }
    // v9 timing: controls + mini guide stay ~10s after any input or channel change (and while a menu is open).
    LaunchedEffect(poke, popOpen, item.url) { controls = true; if (!popOpen) { delay(10_000); controls = false } }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }

    // Wide layouts keep playing in the preview pane; compact has no preview, so leaving stops playback.
    val wide = LocalWide.current
    val exit = { if (wide) model.fullscreen = false else model.stop() }
    model.platform.BackHandler(enabled = true) { exit() }

    Box(
        Modifier.fillMaxSize().background(Color.Black)
            .focusRequester(focus).focusable()
            .onPreviewKeyEvent { e ->
                poke++
                if (e.type != KeyEventType.KeyDown || controls) return@onPreviewKeyEvent false
                // Controls hidden: remote/keyboard shortcuts (v9 parity).
                when (e.key) {
                    Key.DirectionUp, Key.ChannelUp, Key.PageUp -> { model.zap(-1); true }
                    Key.DirectionDown, Key.ChannelDown, Key.PageDown -> { model.zap(1); true }
                    Key.DirectionLeft -> { if (item.seekable) model.player.seekTo(model.player.positionMs() - 10_000); item.seekable }
                    Key.DirectionRight -> { if (item.seekable) model.player.seekTo(model.player.positionMs() + 10_000); item.seekable }
                    Key.Spacebar, Key.MediaPlayPause -> { model.player.togglePause(); true }
                    else -> false
                }
            }
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val e = awaitPointerEvent()
                        if (e.type == PointerEventType.Move || e.type == PointerEventType.Press) poke++
                    }
                }
            }
            .clickable(remember { MutableInteractionSource() }, indication = null) { poke++ },
    ) {
        model.player.Surface(Modifier.fillMaxSize())

        when (val s = state) {
            is PlayerState.Buffering, PlayerState.Idle ->
                CircularProgressIndicator(Modifier.align(Alignment.Center), color = Z.focus)
            is PlayerState.Failed ->
                Text("Couldn't play this stream. ${s.message}", Modifier.align(Alignment.Center).padding(24.dp), color = Z.text)
            else -> {}
        }

        model.upNext?.let { UpNextCard(model, it, Modifier.align(Alignment.BottomEnd).padding(end = 24.dp, bottom = 140.dp)) }

        AnimatedVisibility(controls, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize()) {
                TopBar(model, item, exit, Modifier.align(Alignment.TopCenter))
                // Panel needs room: wide layouts (PC/TV/tablet, phone in landscape) only.
                if (item.live && model.zapList.size > 1 && LocalWide.current) ChannelPanel(model, item, Modifier.align(Alignment.TopStart)) { poke++ }
                CenterControls(model, item, state, Modifier.align(Alignment.Center)) { poke++ }
                if (item.seekable) SeekBar(model, item, Modifier.align(Alignment.BottomCenter).padding(bottom = 76.dp)) { poke++ }
                PlayerChrome(model, item, inFullscreen = true, onActive = { popOpen = it }, onInteract = { poke++ })
            }
        }
    }
}

@Composable
private fun TopBar(model: AppModel, item: Playable, exit: () -> Unit, modifier: Modifier) {
    Row(
        modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent))).padding(24.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Live: the channel panel (top left) carries name + clock, so the bar only shows the rest.
        Column(Modifier.weight(1f).padding(start = if (item.live && model.zapList.size > 1 && LocalWide.current) 340.dp else 0.dp)) {
            if (item.live) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("LIVE", color = Color.White, style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Z.live).padding(horizontal = 8.dp, vertical = 2.dp))
                    if (model.liveRecordings.let { model.recordingOf(item.streamId) } != null) {
                        Spacer(Modifier.width(8.dp))
                        Text("● REC", color = Z.live, style = MaterialTheme.typography.labelLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
                    }
                }
                Spacer(Modifier.size(6.dp))
            }
            Text(item.title, style = MaterialTheme.typography.headlineMedium, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(item.subtitle, color = Z.textMuted, maxLines = 1)
        }
        model.sleepAt?.let {
            Text("Sleep in ${((it - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)} min", color = Z.textMuted,
                modifier = Modifier.padding(end = 12.dp))
        }
        RoundButton(Icons.Rounded.Close, "Close player", onClick = exit)
    }
}

/**
 * v9's live panel: what's playing + the time, then the channels around it with
 * what's on each; pick one to switch without leaving fullscreen.
 */
@Composable
private fun ChannelPanel(model: AppModel, item: Playable, modifier: Modifier, poke: () -> Unit) {
    val list = model.zapList
    val cur = list.indexOfFirst { it.streamId == item.streamId }.coerceAtLeast(0)
    val now = remember(item.streamId) { java.text.SimpleDateFormat("h:mm a · EEE, MMM d", java.util.Locale.getDefault()).format(java.util.Date()) }
    val phone = LocalDevice.current == DeviceClass.Touch // landscape phone: ~400dp tall, keep it small
    Column(
        modifier.padding(if (phone) 10.dp else 16.dp).width(if (phone) 240.dp else 320.dp).clip(RoundedCornerShape(16.dp))
            .background(Brush.verticalGradient(listOf(Z.bg.copy(alpha = 0.92f), Z.bg.copy(alpha = 0.75f)))).padding(12.dp),
    ) {
        Text(item.title, style = if (phone) MaterialTheme.typography.titleSmall else MaterialTheme.typography.titleLarge,
            color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(now, color = Z.textMuted, style = if (phone) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelLarge)
        Spacer(Modifier.size(if (phone) 6.dp else 10.dp))
        // The playing channel + the next 3 (wrapping), like v9 — no scrolling list.
        Column {
            (0 until minOf(4, list.size)).forEach { k ->
                val ch = list[(cur + k) % list.size]
                val playing = ch.streamId == item.streamId
                val prog = rememberNow(model, ch)
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 2.dp).focusRing(RoundedCornerShape(10.dp), lift = 1.01f)
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (playing) Z.accentGradient else Brush.linearGradient(listOf(Color.Transparent, Color.Transparent)))
                        .clickable { model.playChannel(ch, list, full = true); poke() }.padding(if (phone) 5.dp else 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ChannelLogo(ch.logo, Modifier.size(if (phone) 26.dp else 36.dp), ch.altLogo)
                    Spacer(Modifier.width(if (phone) 8.dp else 10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(ch.name, color = Color.White, style = if (phone) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelLarge,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(prog?.title ?: "—", color = if (playing) Color.White.copy(alpha = 0.85f) else Z.textMuted,
                            style = if (phone) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    qualityBadge(ch.rawName)?.let { Badge(it) }
                }
            }
        }
    }
}

/** v9's NOW / NEXT for the live channel, laid out inline with the player buttons. */
@Composable
fun NowNext(model: AppModel, item: Playable, modifier: Modifier, compact: Boolean = false) {
    val lib = model.library ?: return
    val guide by androidx.compose.runtime.produceState(emptyList<com.ziptv.core.Programme>(), item.streamId) {
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching { lib.epg(item.streamId) }.getOrDefault(emptyList())
        }
    }
    val t = System.currentTimeMillis() / 1000
    val i = guide.indexOfFirst { it.start <= t && it.end > t }
    val now = guide.getOrNull(i)
    val next = if (i >= 0) guide.getOrNull(i + 1) else guide.firstOrNull { it.start > t }
    if (now == null && next == null) { Spacer(modifier); return }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        now?.let { GuideCell("NOW", it, Z.focus, Modifier.weight(1f), compact) }
        next?.let { GuideCell("NEXT", it, Z.textMuted, Modifier.weight(1f), compact) }
    }
}

@Composable
private fun GuideCell(tag: String, p: com.ziptv.core.Programme, accent: Color, modifier: Modifier, compact: Boolean = false) {
    Row(modifier.padding(end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(tag, color = Color.White, style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(if (tag == "NOW") Z.accentGradient
                else Brush.linearGradient(listOf(Z.surfaceHigh, Z.surfaceHigh))).padding(horizontal = 8.dp, vertical = 3.dp))
        Spacer(Modifier.width(10.dp))
        if (!compact) {
            Text("${clock(p.start)} – ${clock(p.end)}", color = accent, style = MaterialTheme.typography.titleMedium, maxLines = 1)
            Spacer(Modifier.width(10.dp))
        }
        Text(p.title, color = Color.White, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun CenterControls(model: AppModel, item: Playable, state: PlayerState, modifier: Modifier, poke: () -> Unit) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(28.dp), verticalAlignment = Alignment.CenterVertically) {
        if (item.live) RoundButton(Icons.Rounded.KeyboardArrowUp, "Previous channel") { model.zap(-1); poke() }
        if (item.seekable) RoundButton(Icons.Rounded.Replay10, "Back 10 seconds") { model.player.seekTo(model.player.positionMs() - 10_000); poke() }
        RoundButton(
            if (state == PlayerState.Paused) Icons.Rounded.PlayArrow else Icons.Rounded.Pause,
            if (state == PlayerState.Paused) "Play" else "Pause", big = true,
        ) { model.player.togglePause(); poke() }
        if (item.seekable) RoundButton(Icons.Rounded.Forward10, "Forward 10 seconds") { model.player.seekTo(model.player.positionMs() + 10_000); poke() }
        if (item.live) RoundButton(Icons.Rounded.KeyboardArrowDown, "Next channel") { model.zap(1); poke() }
    }
}

@Composable
private fun SeekBar(model: AppModel, item: Playable, modifier: Modifier, poke: () -> Unit) {
    var pos by remember { mutableLongStateOf(0L) }
    var dur by remember { mutableLongStateOf(0L) }
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(item.url) {
        while (true) { if (!dragging) { pos = model.player.positionMs(); dur = model.player.durationMs() }; delay(500) }
    }
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp)) {
        if (item.seekable && dur > 0) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(hms(if (dragging) (dragValue * dur).toLong() else pos), color = Color.White, style = MaterialTheme.typography.labelLarge)
                Slider(
                    value = if (dragging) dragValue else (pos.toFloat() / dur).coerceIn(0f, 1f),
                    onValueChange = { dragging = true; dragValue = it; poke() },
                    onValueChangeFinished = { model.player.seekTo((dragValue * dur).toLong()); pos = (dragValue * dur).toLong(); dragging = false },
                    colors = SliderDefaults.colors(thumbColor = Z.focus, activeTrackColor = Z.accent, inactiveTrackColor = Color.White.copy(alpha = 0.25f)),
                    modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                )
                Text(hms(dur), color = Z.textMuted, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
private fun RoundButton(icon: ImageVector, label: String, big: Boolean = false, onClick: () -> Unit) {
    val size = if (big) 76.dp else 52.dp
    Box(
        Modifier.size(size).focusRing(RoundedCornerShape(50), lift = 1.08f).clip(RoundedCornerShape(50))
            .background(if (big) Z.accentGradient else Brush.linearGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Black.copy(alpha = 0.55f))))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = Color.White, modifier = Modifier.size(if (big) 40.dp else 26.dp)) }
}

/** Netflix-style "Up next" for series: shows the last ~20s of an episode, plays the next when it ends. */
@Composable
private fun UpNextCard(model: AppModel, next: Playable, modifier: Modifier) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(next.url) { runCatching { focus.requestFocus() } } // remote: OK = play now
    Row(
        modifier.widthIn(max = 460.dp).clip(RoundedCornerShape(16.dp)).background(Z.bg.copy(alpha = 0.92f)).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(width = 128.dp, height = 72.dp).clip(RoundedCornerShape(10.dp)).background(Z.surfaceHigh)) {
            next.image?.let { coil3.compose.AsyncImage(it, null, contentScale = androidx.compose.ui.layout.ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
        }
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text("UP NEXT · ${next.title.substringAfter(" · ")}", color = Z.focus, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
            Text(next.subtitle, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Starts in ${model.upNextIn}s", color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Play now", color = Color.White, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.focusRequester(focus).focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
                        .background(Z.accentGradient).clickable { model.playUpNext() }.padding(horizontal = 14.dp, vertical = 7.dp))
                Text("Cancel", color = Z.text,
                    modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
                        .background(Z.surfaceHigh).clickable { model.cancelUpNext() }.padding(horizontal = 14.dp, vertical = 7.dp))
            }
        }
    }
}
