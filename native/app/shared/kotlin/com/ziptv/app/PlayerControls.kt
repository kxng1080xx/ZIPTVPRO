package com.ziptv.app

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
import androidx.compose.material.icons.rounded.FiberManualRecord
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.PictureInPictureAlt
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
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.dp

private enum class Pop { None, More, Tracks, Sleep, Volume }

/**
 * v9's player control row + its popovers, shared by fullscreen and the Live
 * preview: NOW/NEXT on the left; Go Live, Volume, More (⋯) and Fullscreen on the
 * right. The More menu holds the secondary controls with labels. Call inside the
 * player's Box. [onActive] reports when a popover is open (keeps controls up).
 */
@Composable
fun BoxScope.PlayerChrome(model: AppModel, item: Playable, inFullscreen: Boolean, onActive: (Boolean) -> Unit = {}, onInteract: () -> Unit = {}) {
    var pop by remember { mutableStateOf(Pop.None) }
    val wide = LocalWide.current
    LaunchedEffect(pop) { onActive(pop != Pop.None) }
    val size = if (inFullscreen) 48.dp else 38.dp
    fun open(p: Pop) { pop = if (pop == p) Pop.None else p; onInteract() }

    Row(
        Modifier.align(Alignment.BottomCenter).fillMaxWidth()
            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.75f))))
            .padding(horizontal = if (inFullscreen) 24.dp else 10.dp, vertical = if (inFullscreen) 14.dp else 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Phone page player: no room for NOW/NEXT next to the buttons (the guide is a tap away).
        if ((item.live || item.kind == PlayKind.Catchup) && (inFullscreen || LocalWide.current))
            NowNext(model, item, Modifier.weight(1f), compact = !inFullscreen) else Spacer(Modifier.weight(1f))
        if (item.live || item.kind == PlayKind.Catchup) {
            ControlIcon(Icons.Rounded.Sensors, if (item.live) "Go to live" else "Back to live", size) { model.goLive(); onInteract() }
        }
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
        if (sheet) Sheet({ pop = Pop.None }, content) else Popover(popMod, content)
    when (pop) {
        Pop.More -> Menu {
            MenuItem(Icons.Rounded.Translate, "Audio track") { pop = Pop.Tracks }
            MenuItem(Icons.Rounded.Subtitles, "Subtitles") { pop = Pop.Tracks }
            if (item.live) {
                val recording = model.liveRecordings.let { model.recordingOf(item.streamId) } != null
                if (recording) MenuItem(Icons.Rounded.Stop, "Stop recording", tint = Z.live) { model.stopRecording(item.streamId); pop = Pop.None }
                else MenuItem(Icons.Rounded.FiberManualRecord, "Record this channel") { model.recordNow(); pop = Pop.None }
            }
            MenuItem(Icons.Rounded.Bolt, if (model.player.deinterlace) "Deinterlace (60fps) · On" else "Deinterlace (60fps)") {
                model.toggleDeinterlace(); pop = Pop.None
            }
            MenuItem(Icons.Rounded.Bedtime, model.sleepAt?.let { "Sleep timer · ${((it - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)} min" }
                ?: "Sleep timer") { pop = Pop.Sleep }
            MenuItem(Icons.Rounded.Stop, "Stop") { pop = Pop.None; model.stop() }
        }
        Pop.Tracks -> Menu {
            val audio = remember { model.player.audioTracks() }
            val subs = remember { model.player.subtitleTracks() }
            MenuItem(Icons.Rounded.ArrowBack, "Back") { pop = Pop.More }
            Label("AUDIO")
            if (audio.isEmpty()) Text("Only one track", color = Z.textMuted, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
            audio.forEach { t -> MenuItem(null, t.name) { model.player.selectAudio(t.id); pop = Pop.None } }
            Label("SUBTITLES")
            MenuItem(null, "Off") { model.player.selectSubtitle(-1); pop = Pop.None }
            subs.filter { it.id >= 0 }.forEach { t -> MenuItem(null, t.name) { model.player.selectSubtitle(t.id); pop = Pop.None } }
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
            Column(
                Modifier.align(Alignment.BottomEnd).padding(end = endPad.coerceAtLeast(0.dp), bottom = size + if (inFullscreen) 36.dp else 18.dp)
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
private fun Popover(modifier: Modifier, content: @Composable () -> Unit) {
    Column(
        modifier.widthIn(min = 220.dp, max = 280.dp).heightIn(max = 360.dp).clip(RoundedCornerShape(14.dp))
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
private fun Label(text: String) =
    Text(text, color = Z.textMuted, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 2.dp))

@Composable
private fun ControlIcon(icon: ImageVector, label: String, size: Dp, selected: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.size(size).focusRing(RoundedCornerShape(10.dp), lift = 1.06f).clip(RoundedCornerShape(10.dp))
            .background(if (selected) Color.White.copy(alpha = 0.18f) else Color.Transparent).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = Color.White, modifier = Modifier.size(size * 0.55f)) }
}

/** Rotates a horizontal control to vertical (bottom = min) and swaps its measured width/height. */
private fun Modifier.vertical(): Modifier = this
    .graphicsLayer { rotationZ = 270f }
    .layout { measurable, constraints ->
        val p = measurable.measure(Constraints(minWidth = constraints.minHeight, maxWidth = constraints.maxHeight,
            minHeight = constraints.minWidth, maxHeight = constraints.maxWidth))
        layout(p.height, p.width) { p.place(-(p.width - p.height) / 2, (p.width - p.height) / 2) }
    }
