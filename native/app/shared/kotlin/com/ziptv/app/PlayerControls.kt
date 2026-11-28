package com.ziptv.app

import androidx.compose.material.icons.rounded.Groups

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Bedtime
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Cast
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.AspectRatio
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.FiberManualRecord
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.PictureInPictureAlt
import androidx.compose.material.icons.rounded.HighQuality
import androidx.compose.material.icons.rounded.Sensors
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Subtitles
import androidx.compose.material.icons.rounded.Translate
import androidx.compose.material.icons.rounded.VolumeOff
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.focusable
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.focus.focusProperties
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.dp

private enum class Pop { None, More, Tracks, Sleep, Volume, Cast, Sources, Info }

/** "4K", "1080p"…; null when the source didn't say. */
private fun heightLabel(h: Int) = when { h >= 2160 -> "4K"; h > 0 -> "${h}p"; else -> null }

/**
 * v9's player control row + its popovers, shared by fullscreen and the Live
 * preview: NOW/NEXT on the left; Go Live, Volume, More (⋯) and Fullscreen on the
 * right. The More menu holds the secondary controls with labels. Call inside the
 * player's Box. [onActive] reports when a popover is open (keeps controls up).
 */
@Composable
fun BoxScope.PlayerChrome(model: AppModel, item: Playable, inFullscreen: Boolean, onActive: (Boolean) -> Unit = {}, onInteract: () -> Unit = {},
                           scrub: SeekScrub = remember { SeekScrub() }, seekFocus: androidx.compose.ui.focus.FocusRequester? = null) {
    var pop by remember { mutableStateOf(Pop.None) }
    val wide = LocalWide.current
    LaunchedEffect(pop) { onActive(pop != Pop.None) }
    val size = if (inFullscreen) 48.dp else 38.dp
    fun open(p: Pop) { pop = if (pop == p) Pop.None else p; onInteract() }

    Row(
        Modifier.align(Alignment.BottomCenter).fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.75f))))
            // NNL box (live): flush with the left and bottom edges, solid behind the programmes,
            // fading out to clear before the buttons on the right.
            .drawBehind {
                if (!item.live) return@drawBehind
                val end = (this.size.width - (if (inFullscreen) 340.dp else 250.dp).toPx()).coerceAtLeast(this.size.width * 0.4f)
                drawRect(Brush.horizontalGradient(0f to Color.Black.copy(alpha = 0.6f), 0.7f to Color.Black.copy(alpha = 0.6f),
                    1f to Color.Transparent, startX = 0f, endX = end))
            }
            .padding(horizontal = if (inFullscreen) 24.dp else 10.dp, vertical = if (inFullscreen) 14.dp else 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Phone page player: no room for NOW/NEXT next to the buttons (the guide is a tap away).
        when {
            item.seekable -> SeekInline(model, item, Modifier.weight(1f), onInteract, scrub, seekFocus) // VOD/catch-up: slim seek in the bar
            // Landscape phone: the NOW card sits right under the video, and the bar is too narrow for both.
            item.live && (inFullscreen || (LocalWide.current && !LocalShort.current)) -> NowNext(model, item, Modifier.weight(1f), compact = !inFullscreen)
            else -> Spacer(Modifier.weight(1f))
        }
        if (item.live || item.kind == PlayKind.Catchup) {
            ControlIcon(Icons.Rounded.Sensors, if (item.live) "Go to live" else "Back to live", size) { model.goLive(); onInteract() }
        }
        ControlIcon(Icons.Rounded.AspectRatio, "Picture size: ${model.player.pictureSize.name}", size) { model.nextPictureSize(); onInteract() }
        if (item.source != null) ControlIcon(Icons.Rounded.Cloud, "Sources", size, selected = pop == Pop.Sources) { open(Pop.Sources) }
        ControlIcon(Icons.Rounded.Info, "Stream info", size, selected = pop == Pop.Info) { open(Pop.Info) }
        ControlIcon(if (model.player.muted) Icons.Rounded.VolumeOff else Icons.Rounded.VolumeUp, "Volume", size) { open(Pop.Volume) }
        ControlIcon(Icons.Rounded.MoreHoriz, "More options", size, selected = pop == Pop.More) { open(Pop.More) }
        ControlIcon(Icons.Rounded.PictureInPictureAlt, "Picture in picture", size) {
            pop = Pop.None; onInteract()
            // No OS picture-in-picture (desktop): the in-app mini player is the PiP.
            // No system PiP (desktop, TVs, older phones): the app's own mini player is the PiP.
            if (!model.platform.enterPip()) { model.fullscreen = false; model.pip = true }
        }
        ControlIcon(if (inFullscreen) Icons.Rounded.FullscreenExit else Icons.Rounded.Fullscreen,
            if (inFullscreen) "Exit fullscreen" else "Fullscreen", size) { model.fullscreen = !inFullscreen; onInteract() }
    }

    val popMod = Modifier.align(Alignment.BottomEnd).padding(end = if (inFullscreen) 24.dp else 10.dp, bottom = size + if (inFullscreen) 36.dp else 18.dp)
    // Phone page player is too short for a popover: menus come up as a bottom sheet instead.
    val sheet = !inFullscreen && !wide
    @Composable fun Menu(content: @Composable () -> Unit) =
        if (sheet) Sheet({ pop = Pop.None }, content) else Popover(popMod, { pop = Pop.None }, content)
    // Esc (PC) / Back (remote) closes the open menu, not the player.
    model.platform.BackHandler(enabled = pop != Pop.None) { pop = Pop.None }
    when (pop) {
        Pop.More -> Menu {
            MenuItem(Icons.Rounded.Translate, "Audio track") { pop = Pop.Tracks }
            MenuItem(Icons.Rounded.Subtitles, "Subtitles") { pop = Pop.Tracks }
            if (item.live) {
                val recording = model.liveRecordings.let { model.recordingOf(item.streamId) } != null
                if (recording) MenuItem(Icons.Rounded.Stop, "Stop recording", tint = Z.live) { model.stopRecording(item.streamId); pop = Pop.None }
                else MenuItem(Icons.Rounded.FiberManualRecord, "Record this channel") { model.recordNow(); pop = Pop.None }
            }
            if ((item.kind == PlayKind.Movie || item.kind == PlayKind.Episode) && !model.watch.active) {
                MenuItem(Icons.Rounded.Groups, "Watch together") { model.watch.host(); pop = Pop.None }
            }
            MenuItem(Icons.Rounded.Cast, "Cast to TV") { pop = Pop.Cast }
            MenuItem(Icons.Rounded.Bolt, if (model.player.deinterlace) "Deinterlace (60fps) · On" else "Deinterlace (60fps)") {
                model.toggleDeinterlace(); pop = Pop.None
            }
            MenuItem(Icons.Rounded.HighQuality, if (model.player.upscale) "Upscaler · On" else "Upscaler") {
                model.toggleUpscale(); pop = Pop.None
            }
            MenuItem(Icons.Rounded.Bedtime, model.sleepAt?.let { "Sleep timer · ${((it - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)} min" }
                ?: "Sleep timer") { pop = Pop.Sleep }
            MenuItem(Icons.Rounded.Stop, "Stop") { pop = Pop.None; model.stop() }
        }
        Pop.Tracks -> Menu {
            LaunchedEffect(item) { model.findSources() } // the anime audio choices come from the links found
            val audio = remember { model.player.audioTracks() }
            val subs = remember { model.player.subtitleTracks() }
            val onAudio = remember { model.player.audioTrack() }
            val onSub = remember { model.player.subtitleTrack() }
            val choices = model.sourceOptions.let { model.audioChoices() }
            @Composable fun Choice(label: String, on: Boolean, pick: () -> Unit) =
                MenuItem(if (on) Icons.Rounded.Check else null, label, tint = if (on) Z.focus else Z.text) { pick(); pop = Pop.None }
            MenuItem(Icons.Rounded.ArrowBack, "Back") { pop = Pop.More }
            Label("AUDIO")
            // Anime: Japanese (Sub) / English (Dub)… each is another source, picked up at the same moment.
            choices.forEach { (label, l) -> Choice(label, l == model.link) { if (l != model.link) model.useSource(l) } }
            if (choices.isEmpty() || audio.size > 1) {
                if (audio.size <= 1 && choices.isEmpty()) Text("Only one track", color = Z.textMuted, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
                else audio.forEach { t -> Choice(t.name, t.id == onAudio) { model.player.selectAudio(t.id) } }
            }
            Label("SUBTITLES")
            Choice("Off", onSub < 0) { model.player.selectSubtitle(-1) }
            subs.filter { it.id >= 0 }.forEach { t -> Choice(t.name, t.id == onSub) { model.player.selectSubtitle(t.id) } }
        }
        Pop.Cast -> Menu { CastPicker(model, item) { pop = Pop.None } }
        // Where this movie/episode can play from: the provider, then every link the built-in sources found (best first).
        Pop.Sources -> Menu {
            LaunchedEffect(item) { model.findSources() }
            val now = model.link
            if (!Extras.isExt(item.url)) {
                MenuItem(if (now == null) Icons.Rounded.Check else null, "Your provider", tint = if (now == null) Z.focus else Z.text) {
                    model.useSource(null); pop = Pop.None
                }
            }
            val opts = model.sourceOptions
            when {
                opts == null -> Text("Searching…", color = Z.textMuted, modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp))
                opts.isEmpty() -> Text("No other sources found", color = Z.textMuted, modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp))
                else -> opts.sortedByDescending { it.height }.forEach { l -> // 4K at the top, then 1080p…
                    val on = l == now
                    MenuItem(if (on) Icons.Rounded.Check else null, listOfNotNull(heightLabel(l.height), l.source).joinToString(" · "),
                        tint = if (on) Z.focus else Z.text) { model.useSource(l); pop = Pop.None }
                }
            }
        }
        Pop.Info -> Menu {
            val picture by androidx.compose.runtime.produceState(model.player.videoSize(), item) {
                while (true) { value = model.player.videoSize(); kotlinx.coroutines.delay(1000) }
            }
            val l = model.link
            InfoRow("Playing from", l?.source ?: "Your provider")
            l?.let { heightLabel(it.height) }?.let { InfoRow("Listed as", it) }
            InfoRow("Picture", picture?.let { (w, h) -> "$w × $h" + (heightLabel(if (w >= 3800) 2160 else h)?.let { " ($it)" } ?: "") } ?: "Loading…")
            InfoRow("Your screen", if (model.platform.screen4k) "4K" else "HD")
        }
        Pop.Sleep -> Menu {
            MenuItem(Icons.Rounded.ArrowBack, "Back") { pop = Pop.More }
            listOf(15, 30, 45, 60, 90, 120).forEach { m -> MenuItem(null, "$m minutes") { model.setSleepTimer(m); pop = Pop.None } }
            if (model.sleepAt != null) MenuItem(null, "Turn off") { model.setSleepTimer(null); pop = Pop.None }
        }
        Pop.Volume -> if (sheet) Sheet({ pop = Pop.None }) {
            var v by remember { mutableFloatStateOf(model.player.volume / 100f) }
            Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                ControlIcon(if (model.player.muted) Icons.Rounded.VolumeOff else Icons.Rounded.VolumeUp,
                    if (model.player.muted) "Unmute" else "Mute", 40.dp) { model.player.muted = !model.player.muted }
                Slider(value = v, onValueChange = { v = it; model.player.volume = (it * 100).toInt(); model.player.muted = false },
                    colors = SliderDefaults.colors(thumbColor = Z.focus, activeTrackColor = Z.accent, inactiveTrackColor = Color.White.copy(alpha = 0.25f)),
                    modifier = Modifier.weight(1f).padding(horizontal = 12.dp))
                Text("${(v * 100).toInt()}", color = Z.textMuted, modifier = Modifier.width(32.dp))
            }
        } else {
            // v9: a narrow vertical slider directly above the speaker icon; drag up = louder.
            val sidePad = if (inFullscreen) 24.dp else 10.dp
            val endPad = sidePad + size * 3 + 30.dp + (size - 52.dp) / 2  // over the Volume button (FS, PiP, More to its right)
            var v by remember { mutableFloatStateOf(model.player.volume / 100f) }
            // D-pad / arrows: the panel takes focus when it opens; Up/Down = louder/quieter, OK = mute,
            // Left/Right/Back = close. (The slider is rotated, so its own arrow keys would go sideways.)
            val volFocus = remember { androidx.compose.ui.focus.FocusRequester() }
            LaunchedEffect(Unit) { runCatching { volFocus.requestFocus() } }
            fun nudge(by: Float) { v = (v + by).coerceIn(0f, 1f); model.player.volume = (v * 100).toInt(); model.player.muted = false; onInteract() }
            Column(
                Modifier.align(Alignment.BottomEnd).padding(end = endPad.coerceAtLeast(0.dp), bottom = size + if (inFullscreen) 36.dp else 18.dp)
                    .focusRequester(volFocus)
                    .onPreviewKeyEvent { e ->
                        if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (e.key) {
                            Key.DirectionUp -> { nudge(0.05f); true }
                            Key.DirectionDown -> { nudge(-0.05f); true }
                            Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> { model.player.muted = !model.player.muted; onInteract(); true }
                            Key.DirectionLeft, Key.DirectionRight, Key.Back, Key.Escape -> { pop = Pop.None; true }
                            else -> false
                        }
                    }
                    .focusRing(RoundedCornerShape(26.dp), lift = 1f).focusable()
                    .width(52.dp).clip(RoundedCornerShape(26.dp)).background(Z.bg.copy(alpha = 0.92f)).padding(vertical = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("${(v * 100).toInt()}", color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
                Slider(
                    value = v, onValueChange = { v = it; model.player.volume = (it * 100).toInt(); model.player.muted = false; onInteract() },
                    colors = SliderDefaults.colors(thumbColor = Z.focus, activeTrackColor = Z.accent, inactiveTrackColor = Color.White.copy(alpha = 0.25f)),
                    modifier = Modifier.padding(vertical = 8.dp).vertical().width(150.dp),
                )
                ControlIcon(if (model.player.muted) Icons.Rounded.VolumeOff else Icons.Rounded.VolumeUp,
                    if (model.player.muted) "Unmute" else "Mute", 36.dp) { model.player.muted = !model.player.muted; onInteract() }
            }
        }
        Pop.None -> {}
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun Sheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    androidx.compose.material3.ModalBottomSheet(onDismiss, containerColor = Z.surface) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 8.dp, end = 8.dp, bottom = 28.dp)) { content() }
    }
}

@Composable
private fun Popover(modifier: Modifier, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    // D-pad: focus moves onto the menu's first item when it opens (it stayed on the button below);
    // Back / Escape closes the menu instead of leaving the player.
    val enter = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { runCatching { enter.requestFocus() } }
    Column(
        // Focus stays inside an open menu: the arrows can't wander onto the buttons behind it.
        modifier.focusRequester(enter).focusProperties { onExit = { cancelFocusChange() } }.focusGroup()
            .onPreviewKeyEvent { e ->
                if (e.type == KeyEventType.KeyDown && (e.key == Key.Back || e.key == Key.Escape)) { onDismiss(); true } else false
            }
            .widthIn(min = 220.dp, max = 280.dp).heightIn(max = 360.dp).clip(RoundedCornerShape(14.dp))
            .background(Z.bg.copy(alpha = 0.96f)).verticalScroll(rememberScrollState()).padding(6.dp),
    ) { content() }
}

@Composable
private fun MenuItem(icon: ImageVector?, label: String, tint: Color = Z.text, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().focusRing(RoundedCornerShape(10.dp), lift = 1f).clip(RoundedCornerShape(10.dp))
            .clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(12.dp)) }
        Text(label, color = tint, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Text(label, color = Z.textMuted, modifier = Modifier.width(104.dp))
        Text(value, color = Z.text, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun Label(text: String) =
    Text(text, color = Z.textMuted, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 2.dp))

@Composable
private fun ControlIcon(icon: ImageVector, label: String, size: Dp, selected: Boolean = false, onClick: () -> Unit) {
    val source = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    val hovered by source.collectIsHoveredAsState()
    var focused by remember { mutableStateOf(false) }
    Box(
        Modifier.size(size).onFocusChanged { focused = it.isFocused }.focusRing(RoundedCornerShape(10.dp), lift = 1.06f).clip(RoundedCornerShape(10.dp))
            .background(if (selected) Color.White.copy(alpha = 0.18f) else Color.Transparent)
            .hoverable(source).clickable(source, androidx.compose.material3.ripple(), onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = Color.White, modifier = Modifier.size(size * 0.55f))
        // What the button does, above it: on mouse hover, and on D-pad focus (TV). Hidden while its menu is open.
        if ((hovered || focused) && !selected) {
            androidx.compose.ui.window.Popup(popupPositionProvider = AboveAnchor,
                properties = androidx.compose.ui.window.PopupProperties(focusable = false)) {
                Text(label, color = Color.White, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(Z.bg.copy(alpha = 0.92f))
                        .padding(horizontal = 10.dp, vertical = 5.dp))
            }
        }
    }
}

/** Centred above the button, 8 px clear of it, kept on screen. */
private object AboveAnchor : androidx.compose.ui.window.PopupPositionProvider {
    override fun calculatePosition(anchorBounds: androidx.compose.ui.unit.IntRect, windowSize: androidx.compose.ui.unit.IntSize,
                                   layoutDirection: androidx.compose.ui.unit.LayoutDirection, popupContentSize: androidx.compose.ui.unit.IntSize) =
        androidx.compose.ui.unit.IntOffset(
            (anchorBounds.left + (anchorBounds.width - popupContentSize.width) / 2).coerceIn(0, (windowSize.width - popupContentSize.width).coerceAtLeast(0)),
            (anchorBounds.top - popupContentSize.height - 8).coerceAtLeast(0),
        )
}

/** Rotates a horizontal control to vertical (bottom = min) and swaps its measured width/height. */
private fun Modifier.vertical(): Modifier = this
    .graphicsLayer { rotationZ = 270f }
    .layout { measurable, constraints ->
        val p = measurable.measure(Constraints(minWidth = constraints.minHeight, maxWidth = constraints.maxHeight,
            minHeight = constraints.minWidth, maxHeight = constraints.maxWidth))
        layout(p.height, p.width) { p.place(-(p.width - p.height) / 2, (p.width - p.height) / 2) }
    }

/**
 * D-pad / arrow-key scrubbing: each Left/Right press moves [target] (10 s, bigger steps while held), and the
 * player seeks once, shortly after the last press — no stutter from a seek per press. Shared by the player
 * screen (a press while the controls are hidden starts scrubbing) and the seek bar (which carries it on).
 */
class SeekScrub {
    var target by mutableStateOf<Long?>(null)
    private var held = 0
    fun nudge(model: AppModel, forward: Boolean) {
        val dur = model.player.durationMs()
        if (dur <= 0) { model.player.seekTo(model.player.positionMs() + if (forward) 10_000 else -10_000); return }
        held++
        val step = when { held > 20 -> 60_000L; held > 8 -> 30_000L; else -> 10_000L }
        target = ((target ?: model.player.positionMs()) + if (forward) step else -step).coerceIn(0, dur)
    }
    fun release() { held = 0 }
    fun commit(model: AppModel) { target?.let { model.player.seekTo(it) }; target = null; held = 0 }
}

/** Minimal seek: small times either side of a thin line with a small dot; sits in the control row. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun SeekInline(model: AppModel, item: Playable, modifier: Modifier, poke: () -> Unit,
                       scrub: SeekScrub = remember { SeekScrub() }, focus: androidx.compose.ui.focus.FocusRequester? = null) {
    // Start from the player's numbers so the bar exists (and can take D-pad focus) the moment it's shown.
    var pos by remember { mutableStateOf(model.player.positionMs()) }
    var dur by remember { mutableStateOf(model.player.durationMs()) }
    var dragging by remember { mutableStateOf(false) }
    var dragValue by remember { mutableFloatStateOf(0f) }
    var focused by remember { mutableStateOf(false) }
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    val target = scrub.target
    LaunchedEffect(item.url) {
        while (true) { if (!dragging && scrub.target == null) { pos = model.player.positionMs(); dur = model.player.durationMs() }; kotlinx.coroutines.delay(500) }
    }
    // One seek, 700 ms after the last press (each press restarts the wait).
    LaunchedEffect(target) { if (target != null) { kotlinx.coroutines.delay(700); pos = target; scrub.commit(model) } }
    androidx.compose.runtime.DisposableEffect(Unit) { onDispose { scrub.commit(model) } } // controls faded mid-scrub
    if (dur <= 0) { Spacer(modifier); return }
    val colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = Z.focus, inactiveTrackColor = Color.White.copy(alpha = 0.22f))
    val shown = when { dragging -> (dragValue * dur).toLong(); target != null -> target; else -> pos }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        val time = MaterialTheme.typography.labelMedium
        Text(hms(shown), color = if (target != null) Z.focus else Color.White, style = time, fontWeight = if (target != null) FontWeight.Bold else null)
        Slider(
            value = (shown.toFloat() / dur).coerceIn(0f, 1f),
            onValueChange = { dragging = true; dragValue = it; poke() },
            onValueChangeFinished = { model.player.seekTo((dragValue * dur).toLong()); pos = (dragValue * dur).toLong(); dragging = false },
            colors = colors,
            thumb = { Box(Modifier.size(if (dragging || focused) 14.dp else 10.dp).clip(RoundedCornerShape(50)).background(Color.White)) },
            track = { st ->
                SliderDefaults.Track(sliderState = st, modifier = Modifier.height(if (focused) 5.dp else 3.dp), colors = colors,
                    thumbTrackGapSize = 0.dp, drawStopIndicator = null)
            },
            modifier = Modifier.weight(1f).padding(horizontal = 10.dp).height(24.dp)
                .let { if (focus != null) it.focusRequester(focus) else it }
                .onFocusChanged { focused = it.isFocused || it.hasFocus }
                // TV remote / arrows: the Slider's own key handling moves 1% per press (~1 min on a movie) and
                // also eats Up/Down, trapping focus on the bar. Take the keys first: Left/Right scrub, Up leaves,
                // OK seeks now (or plays/pauses).
                .onPreviewKeyEvent { e ->
                    val down = e.type == KeyEventType.KeyDown
                    when (e.key) {
                        Key.DirectionLeft, Key.DirectionRight -> {
                            if (down) { scrub.nudge(model, e.key == Key.DirectionRight); poke() } else scrub.release()
                            true
                        }
                        Key.DirectionUp -> { if (down) focusManager.moveFocus(androidx.compose.ui.focus.FocusDirection.Up); true }
                        Key.DirectionDown -> true
                        Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> {
                            if (down) { if (scrub.target != null) { pos = scrub.target!!; scrub.commit(model) } else model.player.togglePause(); poke() }
                            true
                        }
                        else -> false
                    }
                }
                .focusRing(RoundedCornerShape(12.dp), lift = 1f),
        )
        Text("-" + hms((dur - shown).coerceAtLeast(0)), color = Z.textMuted, style = time)
    }
}
