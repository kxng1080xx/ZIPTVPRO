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
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ziptv.core.WatchContent
import com.ziptv.core.WatchState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs

/**
 * Watch Together (v9 parity, same cloud protocol): the host's player is the source of truth.
 * Host: sends position/pause on change + a 3 s heartbeat. Guests: poll every 1 s (2 s in the
 * lobby), follow pause/play, and hard-seek only when more than 2 s off. Clock skew is handled
 * with the server's clock (offset), never the local one.
 */
class WatchTogether(private val model: AppModel) {
    var code by mutableStateOf<String?>(null); private set
    var isHost by mutableStateOf(false); private set
    var state by mutableStateOf("lobby"); private set
    var guests by mutableStateOf(0); private set
    var title by mutableStateOf(""); private set

    private var job: Job? = null
    private var last: WatchState? = null
    private var offsetMs = 0L          // server clock - local clock
    private var offsetSeen = false
    private var settleUntil = 0L       // guest: skip drift checks while a load/seek settles
    private var sent: Triple<Double, Boolean, Long>? = null // host: (pos s, paused, at ms)

    val active get() = code != null

    /** Host a room for the movie/episode that's playing now. */
    fun host() {
        val item = model.nowPlaying ?: return
        val server = model.active?.server ?: return
        if (item.kind != PlayKind.Movie && item.kind != PlayKind.Episode) return
        val content = WatchContent(if (item.kind == PlayKind.Movie) "movie" else "series", item.streamId,
            item.extension ?: "", item.title, item.image ?: "")
        model.scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { model.cloud.watchCreate(server, content) } }
            r.onSuccess { c ->
                code = c; isHost = true; state = "lobby"; guests = 0; title = item.title
                if (model.player.state.value == PlayerState.Playing) model.player.togglePause() // wait in the lobby
                loop()
            }.onFailure { model.error = it.message ?: "Couldn't start Watch Together" }
        }
    }

    /** Join with a 4-letter code. */
    fun join(input: String, onDone: (String?) -> Unit) {
        val server = model.active?.server ?: return onDone("Add a playlist first")
        model.scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { model.cloud.watchJoin(server, input) } }
            r.onSuccess { s ->
                code = s.code; isHost = false; state = s.state; guests = s.guests.size
                title = s.content?.name ?: ""
                absorb(s)
                onDone(null)
                if (s.state == "playing") startGuestPlayback(s)
                loop()
            }.onFailure { onDone(it.message ?: "Couldn't join") }
        }
    }

    /** Host: release the guests and play. */
    fun start() {
        val c = code ?: return
        if (!isHost) return
        state = "playing"
        if (model.player.state.value == PlayerState.Paused) model.player.togglePause()
        val pos = model.player.positionMs() / 1000.0
        sent = Triple(pos, false, System.currentTimeMillis())
        model.scope.launch(Dispatchers.IO) { runCatching { model.cloud.watchUpdate(c, pos, false, "playing") } }
    }

    /** Guest leaves; host ends the room for everyone. */
    fun leave() {
        val c = code ?: return
        val host = isHost
        job?.cancel(); code = null; last = null; sent = null
        if (host) model.scope.launch(Dispatchers.IO) { model.cloud.watchEnd(c) }
    }

    private fun loop() {
        job?.cancel()
        job = model.scope.launch {
            while (isActive && code != null) {
                delay(if (state == "playing") 1000 else 2000)
                val c = code ?: break
                if (isHost && state == "playing") pushHostState(c)
                val r = withContext(Dispatchers.IO) { runCatching { model.cloud.watchPoll(c) } }
                val s = r.getOrElse {
                    if (it.message?.contains("isn't valid") == true) { // room gone: host ended it
                        if (!isHost) { model.stop(); model.error = "The host ended the session." }
                        code = null
                    }
                    null
                } ?: continue
                absorb(s)
                guests = s.guests.size
                val was = state
                state = s.state
                if (!isHost) {
                    when {
                        s.state == "ended" -> { code = null; model.stop(); model.error = "The host ended the session." }
                        s.state == "playing" && was != "playing" -> startGuestPlayback(s)
                        s.state == "playing" -> follow(s)
                    }
                }
            }
        }
    }

    private suspend fun pushHostState(c: String) {
        val pos = model.player.positionMs() / 1000.0
        val paused = model.player.state.value == PlayerState.Paused
        val now = System.currentTimeMillis()
        sent?.let { (p, wasPaused, at) ->
            val projected = if (wasPaused) p else p + (now - at) / 1000.0
            val changed = abs(pos - projected) > 1 || paused != wasPaused || now - at >= 3000
            if (!changed) return
        }
        sent = Triple(pos, paused, now)
        withContext(Dispatchers.IO) { runCatching { model.cloud.watchUpdate(c, pos, paused, null) } }
    }

    private fun startGuestPlayback(s: WatchState) {
        val content = s.content ?: return
        val lib = model.library ?: return
        val url = if (content.kind == "movie") lib.movieUrl(content.streamId, content.ext.ifBlank { null })
            else lib.episodeUrl(content.streamId, content.ext.ifBlank { null })
        settleUntil = System.currentTimeMillis() + 6000 // let the stream open before policing drift
        model.play(Playable(content.name, "Watch Together", url,
            if (content.kind == "movie") PlayKind.Movie else PlayKind.Episode, content.streamId,
            content.logo.ifBlank { null }, content.ext.ifBlank { null }), full = true)
    }

    /** Guest: match the host's pause state; hard-seek only when > 2 s off (micro-seeks judder). */
    private fun follow(s: WatchState) {
        val paused = model.player.state.value == PlayerState.Paused
        if (s.paused != paused && model.player.state.value.let { it == PlayerState.Playing || it == PlayerState.Paused }) {
            model.player.togglePause()
        }
        if (System.currentTimeMillis() < settleUntil) return
        val expected = project(s)
        val cur = model.player.positionMs() / 1000.0
        if (abs(cur - expected) > 2) {
            model.player.seekTo((expected * 1000).toLong())
            settleUntil = System.currentTimeMillis() + 4000
        }
    }

    /** Host position as of now, projected forward through the server clock. */
    private fun project(s: WatchState): Double {
        if (s.paused) return s.position
        val since = (System.currentTimeMillis() + offsetMs) - s.hostUpdatedMs
        return s.position + since.coerceAtLeast(0) / 1000.0
    }

    private fun absorb(s: WatchState) {
        last = s
        if (s.serverNowMs <= 0) return
        val sample = s.serverNowMs - System.currentTimeMillis()
        offsetMs = if (!offsetSeen) sample else (offsetMs * 0.8 + sample * 0.2).toLong()
        offsetSeen = true
    }
}

/** Room banner: code + guests; the host's Start/End, the guest's Leave. Shown over everything. */
@Composable
fun WatchBanner(model: AppModel, modifier: Modifier) {
    val w = model.watch
    val code = w.code ?: return
    Row(
        modifier.padding(12.dp).widthIn(max = 560.dp).clip(RoundedCornerShape(16.dp))
            .background(Z.bg.copy(alpha = 0.94f)).padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(Icons.Rounded.Groups, null, tint = Z.focus, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f, fill = false)) {
            Text(if (w.isHost) "WATCH TOGETHER · share this code" else "WATCH TOGETHER", color = Z.textMuted,
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(code, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 22.sp,
                    color = Z.focus, letterSpacing = 4.sp)
                val who = when {
                    w.isHost && w.state == "lobby" -> if (w.guests == 0) "Waiting for guests…" else "${w.guests} joined"
                    w.isHost -> "${w.guests} watching with you"
                    w.state == "lobby" -> "Waiting for the host to start…"
                    else -> "Following the host"
                }
                Text(who, color = Z.text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 12.dp))
            }
        }
        if (w.isHost && w.state == "lobby") BannerButton("Start", primary = true) { w.start() }
        BannerButton(if (w.isHost) "End" else "Leave", primary = false) { w.leave() }
    }
}

@Composable
internal fun BannerButton(label: String, primary: Boolean, onClick: () -> Unit) {
    Text(label, color = Color.White, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
            .background(if (primary) Z.accentGradient else androidx.compose.ui.graphics.SolidColor(Z.surfaceHigh))
            .clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp))
}

/** Settings row content: type a friend's code to join their room. */
@Composable
fun WatchJoinField(model: AppModel, onJoined: () -> Unit = {}) {
    var input by androidx.compose.runtime.remember { mutableStateOf("") }
    var busy by androidx.compose.runtime.remember { mutableStateOf(false) }
    Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.material3.OutlinedTextField(input, { input = it.filter(Char::isLetter).uppercase().take(4) },
            singleLine = true, label = { Text("Room code") }, modifier = Modifier.weight(1f),
            colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(focusedBorderColor = Z.focus, unfocusedBorderColor = Z.surfaceHigh))
        androidx.compose.foundation.layout.Spacer(Modifier.size(10.dp))
        BannerButton(if (busy) "Joining…" else "Join", primary = input.length == 4) {
            if (input.length == 4 && !busy) {
                busy = true
                model.watch.join(input) { err -> busy = false; model.error = err ?: "Joined room $input"; if (err == null) onJoined() }
            }
        }
    }
}
