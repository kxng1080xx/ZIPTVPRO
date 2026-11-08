package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Cast
import androidx.compose.material.icons.rounded.CastConnected
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ziptv.core.CastDevice
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Send the playing item to a TV (DLNA). The TV fetches it from our LanServer. */
class CastController(private val model: AppModel) {
    var devices by mutableStateOf<List<CastDevice>>(emptyList()); private set
    var searching by mutableStateOf(false); private set
    var target by mutableStateOf<String?>(null); private set   // TV name while casting
    var item by mutableStateOf<Playable?>(null); private set
    var paused by mutableStateOf(false); private set
    var position by mutableStateOf(0.0); private set
    var duration by mutableStateOf(0.0); private set

    fun discover() {
        if (searching) return
        searching = true
        model.scope.launch {
            devices = withContext(Dispatchers.IO) { runCatching { model.caster.discover() }.getOrDefault(emptyList()) }
            searching = false
        }
    }

    fun cast(d: CastDevice, p: Playable) {
        val kind = when (p.kind) {
            PlayKind.Live -> "live"; PlayKind.Movie -> "movie"; PlayKind.Episode -> "series"
            // ponytail: catch-up and recordings aren't served to TVs yet
            else -> { model.error = "This can't be cast yet"; return }
        }
        val ext = if (p.live) (if (model.user?.setting("stream_format") == "m3u8") "m3u8" else "ts") else p.extension ?: ""
        model.error = "Sending to ${d.name}…"
        model.scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { model.caster.play(d.id, kind, p.streamId, ext, p.title) } }
            r.onSuccess {
                model.stop() // the TV plays it now
                target = d.name; item = p; paused = false; position = 0.0; duration = 0.0
                model.error = "Casting to ${d.name}"
                poll()
            }.onFailure { model.error = "Couldn't cast: ${it.message}" }
        }
    }

    private fun poll() = model.scope.launch {
        while (isActive && target != null) {
            withContext(Dispatchers.IO) { runCatching { model.caster.status() }.getOrNull() }?.let {
                position = it.positionSecs; duration = it.durationSecs
            }
            delay(2_000)
        }
    }

    fun togglePause() = model.scope.launch(Dispatchers.IO) {
        runCatching { if (paused) model.caster.resume() else model.caster.pause() }.onSuccess { paused = !paused }
    }

    fun seek(secs: Double) = model.scope.launch(Dispatchers.IO) {
        runCatching { model.caster.seek(secs.toLong().coerceAtLeast(0).toULong()) }.onSuccess { position = secs }
    }

    fun stop() {
        target = null; item = null
        model.scope.launch(Dispatchers.IO) { model.caster.stop() }
    }
}

/** Player menu page: TVs on this network. */
@Composable
fun CastPicker(model: AppModel, item: Playable, onDone: () -> Unit) {
    val c = model.cast
    LaunchedEffect(Unit) { c.discover() }
    Column(Modifier.widthIn(min = 260.dp).padding(vertical = 4.dp)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Cast to TV", Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            if (c.searching) CircularProgressIndicator(Modifier.size(18.dp), color = Z.focus, strokeWidth = 2.dp)
            else Icon(Icons.Rounded.Refresh, "Search again", tint = Z.textMuted,
                modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50)).clickable { c.discover() }.padding(4.dp))
        }
        if (!c.searching && c.devices.isEmpty()) Text("No TVs found. Turn the TV on and make sure it's on the same Wi-Fi.",
            color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
        c.devices.forEach { d ->
            Row(Modifier.focusRing(RoundedCornerShape(10.dp)).clip(RoundedCornerShape(10.dp))
                .clickable { c.cast(d, item); onDone() }.padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Cast, null, tint = Z.focus, modifier = Modifier.size(20.dp))
                Text(d.name, Modifier.padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** "Casting to <TV>" bar with pause / seek / stop — the phone or PC is the remote now. */
@Composable
fun CastBanner(model: AppModel, modifier: Modifier) {
    val c = model.cast
    val tv = c.target ?: return
    val it = c.item ?: return
    Column(
        modifier.padding(12.dp).widthIn(max = 560.dp).clip(RoundedCornerShape(16.dp))
            .background(Z.bg.copy(alpha = 0.94f)).padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Rounded.CastConnected, null, tint = Z.focus, modifier = Modifier.size(24.dp))
            Column(Modifier.weight(1f)) {
                Text("CASTING TO ${tv.uppercase()}", color = Z.textMuted, style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(it.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Icon(if (c.paused) Icons.Rounded.PlayArrow else Icons.Rounded.Pause, if (c.paused) "Play" else "Pause", tint = Z.text,
                modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50)).clickable { c.togglePause() }.padding(6.dp))
            BannerButton("Stop", primary = false) { c.stop() }
        }
        if (it.seekable && c.duration > 0) {
            var drag by androidx.compose.runtime.remember { mutableStateOf<Float?>(null) }
            Slider(value = drag ?: (c.position / c.duration).toFloat().coerceIn(0f, 1f),
                onValueChange = { v -> drag = v }, onValueChangeFinished = { drag?.let { c.seek(it * c.duration) }; drag = null },
                colors = SliderDefaults.colors(thumbColor = Z.focus, activeTrackColor = Z.accent, inactiveTrackColor = Color.White.copy(alpha = 0.2f)))
        }
    }
}
