package com.ziptv.app

import androidx.compose.ui.text.font.FontWeight
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
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
import androidx.compose.foundation.horizontalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
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

    // TV remote (Fire TV): the D-pad can't move from this full-screen box into the controls inside
    // it (nothing lies left/right/up/down of a full-screen box), and a focused button that fades out
    // with the controls takes focus with it, leaving every key dead. So on TV focus follows the
    // controls: shown -> Play/Pause (first button while loading), hidden -> this box (shortcuts).
    val tv = LocalDevice.current == DeviceClass.Tv
    val primary = remember { FocusRequester() }
    var focusAt by remember { mutableStateOf(0) } // 0 = elsewhere, 1 = this box, 2 = a control inside it
    // Movies/series: Left/Right with the controls hidden start scrubbing, and focus lands on the seek bar
    // (not Play/Pause) so the next presses keep seeking.
    val scrub = remember { SeekScrub() }
    val seekBar = remember { FocusRequester() }
    var toSeekBar by remember { mutableStateOf(false) }
    // PC keyboard: once a key is pressed, focus follows the controls exactly like a TV remote (arrows move between
    // buttons, Enter presses); moving the mouse goes back to mouse mode.
    var keys by remember { mutableStateOf(false) }
    LaunchedEffect(tv, keys, controls, focusAt, popOpen, state, toSeekBar) {
        if (!(tv || keys) || popOpen) return@LaunchedEffect // menus/sheets manage their own focus
        if (controls && toSeekBar) {
            toSeekBar = false
            if (runCatching { seekBar.requestFocus() }.isSuccess) return@LaunchedEffect
        }
        if (controls && focusAt != 2) runCatching { primary.requestFocus() }
        else if (!controls && focusAt != 1) runCatching { focus.requestFocus() }
    }

    // Wide layouts keep playing in the preview pane; compact has no preview, so leaving stops playback.
    val wide = LocalWide.current
    val exit = { if (wide) model.fullscreen = false else model.stop() }
    model.platform.BackHandler(enabled = true) { exit() }

    Box(
        Modifier.fillMaxSize().background(Color.Black)
            .onFocusChanged { focusAt = when { it.isFocused -> 1; it.hasFocus -> 2; else -> 0 } }
            .focusRequester(focus).focusable()
            .onPreviewKeyEvent { e ->
                poke++
                if (!tv && e.type == KeyEventType.KeyDown) keys = true
                if (e.type == KeyEventType.KeyUp) scrub.release() // a held arrow speeds scrubbing up; letting go resets it
                if (e.type != KeyEventType.KeyDown || controls) return@onPreviewKeyEvent false
                // TV: the arrows are how you reach the on-screen controls, so with the controls hidden Up/Down
                // only bring them up (poke above; focus lands on Play/Pause). On a movie/series Left/Right
                // seek (like any TV player) and hand focus to the seek bar. CH+/CH-/play-pause stay shortcuts.
                if (tv && item.seekable && (e.key == Key.DirectionLeft || e.key == Key.DirectionRight)) {
                    scrub.nudge(model, e.key == Key.DirectionRight); toSeekBar = true
                    return@onPreviewKeyEvent true
                }
                if (tv && e.key in setOf(Key.DirectionUp, Key.DirectionDown, Key.DirectionLeft, Key.DirectionRight)) return@onPreviewKeyEvent true
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
                        if (e.type == PointerEventType.Move || e.type == PointerEventType.Press) { poke++; keys = false }
                    }
                }
            }
            .clickable(remember { MutableInteractionSource() }, indication = null) { poke++ },
    ) {
        model.player.Surface(Modifier.fillMaxSize())

        // Paused long enough for the controls to fade: what's on, how long is left (Nuvio's pause screen).
        AnimatedVisibility(state == PlayerState.Paused && !controls && item.seekable && model.playError == null,
            enter = fadeIn(tween(600)), exit = fadeOut(tween(200)), modifier = Modifier.fillMaxSize()) { PauseScreen(model, item) }

        PlayerStatus(model)

        model.upNext?.let { UpNextCard(model, it, Modifier.align(Alignment.BottomEnd).padding(end = 24.dp, bottom = 140.dp)) }
            ?: SkipButton(model, item, Modifier.align(Alignment.BottomEnd).padding(end = 24.dp, bottom = 140.dp))

        AnimatedVisibility(controls, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize()) {
                TopBar(model, item, exit, Modifier.align(Alignment.TopCenter))
                // Panel needs room: wide layouts (PC/TV/tablet, phone in landscape) only.
                if (item.live && model.zapList.size > 1 && LocalWide.current) ChannelPanel(model, item, Modifier.align(Alignment.TopStart)) { poke++ }
                // The failure message and its Try again sit in the centre; don't cover them.
                if (model.playError == null) CenterControls(model, item, state, primary, Modifier.align(Alignment.Center)) { poke++ }
                PlayerChrome(model, item, inFullscreen = true, onActive = { popOpen = it }, onInteract = { poke++ }, scrub = scrub, seekFocus = seekBar)
            }
        }
    }
}

/** "You're watching", the title, the episode, its description and the time left; who paused it in Watch Together. */
@Composable
private fun PauseScreen(model: AppModel, item: Playable) {
    val episode = item.kind == PlayKind.Episode
    val show = item.title.substringBefore(" · ")
    val about by androidx.compose.runtime.produceState(item.plot, item) {
        if (value == null) value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            runCatching {
                model.tmdb.lookup(if (episode) com.ziptv.core.ContentKind.SERIES else com.ziptv.core.ContentKind.MOVIE, show, item.source?.year)
            }.getOrNull()?.overview?.ifBlank { null }
        }
    }
    val pos = model.player.positionMs(); val dur = model.player.durationMs()
    val left = (dur - pos).coerceAtLeast(0)
    val timeLeft = if (dur <= 0) null else {
        val min = ((left + 59_999) / 60_000).toInt()
        val ends = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(System.currentTimeMillis() + left))
        (if (min >= 60) "${min / 60} h ${min % 60} min left" else "$min min left") + " · Ends at $ends"
    }
    val together = model.watch.code?.let { if (model.watch.isHost) "Paused for everyone" else "Paused by the host" }
    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Color.Black.copy(alpha = 0.85f), 0.55f to Color.Black.copy(alpha = 0.35f), 1f to Color.Transparent))) {
        Column(Modifier.align(Alignment.BottomStart).padding(start = 56.dp, bottom = 72.dp, end = 24.dp).widthIn(max = 640.dp)) {
            Text("You're watching", color = Z.textMuted, style = MaterialTheme.typography.titleSmall)
            Text(show, color = Color.White, style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
            if (episode) Text("${item.title.substringAfter(" · ", "")} · ${item.subtitle}", color = Color.White,
                style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
            about?.let { Text(it, color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyLarge, maxLines = 4,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 14.dp)) }
            timeLeft?.let { Text(it, color = Z.textMuted, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp)) }
            together?.let { Text(it, color = Z.focus, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 6.dp)) }
        }
    }
}

@Composable
private fun TopBar(model: AppModel, item: Playable, exit: () -> Unit, modifier: Modifier) {
    Row(
        modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent))).padding(24.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Live with the channel panel: it carries LIVE, name and clock, so the bar shows only REC/sleep/close.
        val panel = item.live && model.zapList.size > 1 && LocalWide.current
        Column(Modifier.weight(1f).padding(start = if (panel) 280.dp else 0.dp)) {
            if (panel) {
                if (model.liveRecordings.let { model.recordingOf(item.streamId) } != null)
                    Text("● REC", color = Z.live, style = MaterialTheme.typography.labelLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
            } else {
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
        modifier.padding(if (phone) 8.dp else 16.dp).width(if (phone) 200.dp else 300.dp).clip(RoundedCornerShape(14.dp))
            .background(Brush.verticalGradient(listOf(Z.bg.copy(alpha = 0.9f), Z.bg.copy(alpha = 0.7f)))).padding(if (phone) 8.dp else 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("LIVE", color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(Z.live).padding(horizontal = 6.dp, vertical = 1.dp))
            Spacer(Modifier.width(8.dp))
            Text(item.title, style = if (phone) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleMedium,
                color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(now, color = Z.textMuted, style = if (phone) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelLarge)
        Spacer(Modifier.size(if (phone) 6.dp else 10.dp))
        // The playing channel + the next 3 (wrapping), like v9 — no scrolling list.
        Column {
            (0 until minOf(if (phone) 3 else 4, list.size)).forEach { k ->
                val ch = list[(cur + k) % list.size]
                val playing = ch.streamId == item.streamId
                val prog = rememberNow(model, ch)
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 2.dp).focusRing(RoundedCornerShape(10.dp), lift = 1.01f)
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (playing) Z.accentGradient else Brush.linearGradient(listOf(Color.Transparent, Color.Transparent)))
                        .clickable { model.playChannel(ch, list, full = true); poke() }.padding(if (phone) 4.dp else 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ChannelLogo(ch.logo, Modifier.size(if (phone) 22.dp else 32.dp), ch.altLogo)
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

/**
 * What the player is doing when there is no picture: "Loading…", "Retrying (2 of 4)…", or, once every
 * retry failed, the reason with Try again. Drawn over every player (fullscreen, Live preview, mini).
 */
@Composable
fun BoxScope.PlayerStatus(model: AppModel, compact: Boolean = false) {
    val state by model.player.state.collectAsState()
    val err = model.playError
    val waiting = state is PlayerState.Buffering || state == PlayerState.Idle || state is PlayerState.Failed ||
        (state == PlayerState.Ended && model.nowPlaying?.live == true)
    val finding = model.finding
    if (err == null && !waiting && finding == null) return
    Column(Modifier.align(Alignment.Center).padding(12.dp).clip(RoundedCornerShape(16.dp)).background(Color.Black.copy(alpha = 0.6f))
        .padding(horizontal = if (compact) 12.dp else 22.dp, vertical = if (compact) 10.dp else 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        if (err != null) {
            Text("Couldn't play this stream", fontWeight = FontWeight.SemiBold, color = Color.White,
                style = if (compact) MaterialTheme.typography.labelLarge else MaterialTheme.typography.titleMedium)
            if (!compact) Text(err, Modifier.padding(top = 4.dp), color = Z.textMuted,
                style = MaterialTheme.typography.bodyMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            Text("Try again", color = Color.White, fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = if (compact) 6.dp else 12.dp).focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
                    .background(Z.accentGradient).clickable { model.retryNow() }.padding(horizontal = 18.dp, vertical = 8.dp))
        } else {
            CircularProgressIndicator(Modifier.size(if (compact) 22.dp else 34.dp), color = Z.focus, strokeWidth = 3.dp)
            Text(finding ?: if (model.retry == 0) "Loading…" else "Retrying (${model.retry} of 4)…", Modifier.padding(top = if (compact) 6.dp else 10.dp),
                color = Color.White, style = if (compact) MaterialTheme.typography.labelMedium else MaterialTheme.typography.bodyMedium)
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
    val ni = if (i >= 0) i + 1 else guide.indexOfFirst { it.start > t }
    val next = guide.getOrNull(ni)
    val later = if (ni >= 0) guide.getOrNull(ni + 1) else null
    if (now == null && next == null) { Spacer(modifier); return }
    Row(modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
        now?.let { GuideCell("NOW", it, Z.focus, Modifier, compact) }
        next?.let { GuideCell("NEXT", it, Z.textMuted, Modifier, compact) }
        later?.let { GuideCell("LATER", it, Z.textMuted, Modifier, compact) }
    }
}

@Composable
private fun GuideCell(tag: String, p: com.ziptv.core.Programme, accent: Color, modifier: Modifier, compact: Boolean = false) {
    Row(modifier.padding(end = if (compact) 18.dp else 28.dp).widthIn(max = if (compact) 260.dp else 420.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(tag, color = Color.White, style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(if (tag == "NOW") Z.accentGradient
                else Brush.linearGradient(listOf(Z.surfaceHigh, Z.surfaceHigh))).padding(horizontal = 8.dp, vertical = 3.dp))
        Spacer(Modifier.width(10.dp))
        // Time on top, the show underneath.
        Column {
            Text("${clock(p.start)} – ${clock(p.end)}", color = accent, style = MaterialTheme.typography.labelMedium, maxLines = 1)
            Text(p.title, color = Color.White, style = if (compact) MaterialTheme.typography.titleSmall else MaterialTheme.typography.titleMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun CenterControls(model: AppModel, item: Playable, state: PlayerState, primary: FocusRequester, modifier: Modifier, poke: () -> Unit) {
    // [primary] = where the TV remote lands: Play/Pause, or the first button while it's hidden for loading.
    val loading = state is PlayerState.Buffering || state == PlayerState.Idle
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(28.dp), verticalAlignment = Alignment.CenterVertically) {
        if (item.live) RoundButton(Icons.Rounded.KeyboardArrowUp, "Previous channel",
            modifier = if (loading) Modifier.focusRequester(primary) else Modifier) { model.zap(-1); poke() }
        if (item.seekable) RoundButton(Icons.Rounded.Replay10, "Back 10 seconds",
            modifier = if (loading && !item.live) Modifier.focusRequester(primary) else Modifier) { model.player.seekTo(model.player.positionMs() - 10_000); poke() }
        // While loading, the spinner sits where this button is: leave the slot empty (side buttons stay put).
        if (loading) Spacer(Modifier.size(76.dp))
        else RoundButton(
            if (state == PlayerState.Paused) Icons.Rounded.PlayArrow else Icons.Rounded.Pause,
            if (state == PlayerState.Paused) "Play" else "Pause", big = true, modifier = Modifier.focusRequester(primary),
        ) { model.player.togglePause(); poke() }
        if (item.seekable) RoundButton(Icons.Rounded.Forward10, "Forward 10 seconds") { model.player.seekTo(model.player.positionMs() + 10_000); poke() }
        if (item.live) RoundButton(Icons.Rounded.KeyboardArrowDown, "Next channel") { model.zap(1); poke() }
    }
}

@Composable
private fun RoundButton(icon: ImageVector, label: String, big: Boolean = false, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val size = if (big) 76.dp else 52.dp
    Box(
        modifier.size(size).focusRing(RoundedCornerShape(50), lift = 1.08f).clip(RoundedCornerShape(50))
            .background(if (big) Z.accentGradient else Brush.linearGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Black.copy(alpha = 0.55f))))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = Color.White, modifier = Modifier.size(if (big) 40.dp else 26.dp)) }
}

/** Netflix-style "Up next" for series: shows the last ~20s of an episode, plays the next when it ends. */
/** "Skip intro" / "Skip recap" while one is on screen (Netflix / Nuvio style); OK on the remote skips. */
@Composable
private fun SkipButton(model: AppModel, item: Playable, modifier: Modifier) {
    val segs = model.segments
    if (segs.isEmpty() || !item.seekable) return
    val pos by androidx.compose.runtime.produceState(model.player.positionMs(), item, segs) {
        while (true) { value = model.player.positionMs(); kotlinx.coroutines.delay(400) }
    }
    val seg = segs.firstOrNull { it.kind != Segment.Kind.Credits && pos >= it.startMs && pos < it.endMs - 1_000 } ?: return
    val focus = remember { FocusRequester() }
    LaunchedEffect(seg) { runCatching { focus.requestFocus() } }
    Text(if (seg.kind == Segment.Kind.Recap) "Skip recap" else "Skip intro", color = Color.White, fontWeight = FontWeight.SemiBold,
        modifier = modifier.focusRequester(focus).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp))
            .background(Z.bg.copy(alpha = 0.85f)).clickable { model.skip(seg) }.padding(horizontal = 22.dp, vertical = 12.dp))
}

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
