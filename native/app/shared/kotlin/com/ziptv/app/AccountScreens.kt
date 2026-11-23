package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** First run / no playlists: activate with the device code (admin panel), or sign in manually. */
@Composable
fun WelcomeScreen(model: AppModel) {
    var manual by remember { mutableStateOf(false) }
    val d = model.device
    model.platform.BackHandler(enabled = manual) { manual = false }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.widthIn(max = 520.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Wordmark(30)
            Spacer(Modifier.height(24.dp))
            if (d?.expired == true) {
                Text("Your subscription has expired", style = MaterialTheme.typography.titleLarge, color = Z.live)
                if (d.notice.isNotBlank()) Text(d.notice, color = Z.textMuted, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp))
                Spacer(Modifier.height(20.dp))
            }
            if (!manual) {
                Text("DEVICE ACTIVATION", color = Z.textMuted, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(12.dp))
                Text(model.cloud.deviceCode(), fontSize = 46.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace,
                    letterSpacing = 8.sp, color = Z.focus)
                Spacer(Modifier.height(10.dp))
                Text("Give this code to your provider. Your playlist appears here automatically once it's added.",
                    color = Z.textMuted, textAlign = TextAlign.Center)
                Spacer(Modifier.height(28.dp))
                OutlinedButton(onClick = { manual = true }, modifier = Modifier.focusRing()) { Text("Enter playlist details instead") }
            } else {
                PlaylistForm(model, onAdded = {})
                Spacer(Modifier.height(12.dp))
                OutlinedButton(onClick = { manual = false }, modifier = Modifier.focusRing()) { Text("Back to device activation") }
            }
        }
    }
}

@Composable
fun PlaylistForm(model: AppModel, onAdded: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var autoName by remember { mutableStateOf("") }
    var m3u by remember { mutableStateOf("") }
    var server by remember { mutableStateOf("") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Step 2 (after the login checks out): the provider's categories, ticked = synced.
    var cats by remember { mutableStateOf<List<com.ziptv.core.Category>?>(null) }
    var hidden by remember { mutableStateOf(setOf<String>()) }

    val plainM3u = m3u.trim().let { it.startsWith("http", ignoreCase = true) && parseM3uUrl(it) == null }
    fun build(): Playlist {
        val link = m3u.trim()
        // A plain M3U (not an Xtream get.php link) is saved as-is: empty username = M3U in the core.
        return if (plainM3u) Playlist(name.ifBlank { hostPort(link) }, link, "", "")
            else Playlist(name.ifBlank { hostPort(server) }, server.trim(), user.trim(), pass)
    }
    fun save() {
        busy = true; error = null
        model.add(build().copy(hiddenCategories = hidden.toList())) { err -> busy = false; error = err; if (err == null) onAdded() }
    }
    cats?.let { list ->
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            CategoryPicker(list, hidden) { hidden = it }
            error?.let { Text(it, color = Z.live, style = MaterialTheme.typography.bodyMedium) }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { cats = null }, modifier = Modifier.height(52.dp).focusRing()) { Text("Back") }
                Button(
                    onClick = { save() },
                    enabled = !busy && hidden.size < list.size,
                    colors = ButtonDefaults.buttonColors(containerColor = Z.accent),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.weight(1f).height(52.dp).focusRing(),
                ) { Text(if (busy) "Adding…" else "Add playlist") }
            }
        }
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Field("M3U link (Xtream links fill the fields below)", m3u, KeyboardType.Uri) {
            m3u = it
            parseM3uUrl(it.trim())?.let { (h, u, p) ->
                server = h; user = u; pass = p
                if (name.isBlank() || name == autoName) { name = hostPort(h); autoName = name } // unless one was typed
            }
        }
        Field("Playlist name", name) { name = it }
        Field("Server (host and port)", server, KeyboardType.Uri) { server = it }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.weight(1f)) { Field("Username", user) { user = it } }
            Box(Modifier.weight(1f)) { Field("Password", pass, KeyboardType.Password, secret = true) { pass = it } }
        }
        error?.let { Text(it, color = Z.live, style = MaterialTheme.typography.bodyMedium) }
        Button(
            onClick = {
                busy = true; error = null
                model.checkPlaylist(build()) { list, err ->
                    busy = false
                    when {
                        err != null -> error = err
                        list.isEmpty() -> save() // nothing to choose
                        else -> { cats = list; hidden = emptySet() }
                    }
                }
            },
            enabled = !busy && (plainM3u || (server.isNotBlank() && user.isNotBlank() && pass.isNotBlank())),
            colors = ButtonDefaults.buttonColors(containerColor = Z.accent),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp).focusRing(),
        ) { Text(if (busy) "Checking…" else "Connect playlist") }
    }
}

@Composable
private fun CategoryPicker(cats: List<com.ziptv.core.Category>, hidden: Set<String>, onChange: (Set<String>) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Choose categories", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        for ((kind, label) in listOf(com.ziptv.core.ContentKind.LIVE to "Live TV", com.ziptv.core.ContentKind.MOVIE to "Movies",
            com.ziptv.core.ContentKind.SERIES to "Series")) {
            val group = cats.filter { it.kind == kind }
            if (group.isEmpty()) continue
            var open by remember { mutableStateOf(false) }
            val on = group.count { it.id !in hidden }
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Z.surfaceHigh).focusRing(RoundedCornerShape(10.dp))
                    .clickable { open = !open }.padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(label, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
                Text("$on of ${group.size}", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
                androidx.compose.material3.TextButton(
                    onClick = { onChange(if (on == group.size) hidden + group.map { it.id } else hidden - group.map { it.id }.toSet()) },
                    modifier = Modifier.focusRing(),
                ) { Text(if (on == group.size) "None" else "All", color = Z.focus) }
                Icon(if (open) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore,
                    if (open) "Collapse" else "Expand", tint = Z.textMuted)
            }
            if (open) for (c in group) Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).focusRing(RoundedCornerShape(8.dp))
                    .clickable { onChange(if (c.id in hidden) hidden - c.id else hidden + c.id) }.padding(start = 6.dp, end = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                androidx.compose.material3.Checkbox(c.id !in hidden, onCheckedChange = null,
                    colors = androidx.compose.material3.CheckboxDefaults.colors(checkedColor = Z.accent))
                Text(c.name, Modifier.padding(vertical = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Settings: rename a playlist and change which categories it shows. */
@Composable
fun PlaylistEditor(model: AppModel, p: Playlist, onDone: () -> Unit) {
    var name by remember(p.id) { mutableStateOf(p.name) }
    var hidden by remember(p.id) { mutableStateOf(p.hiddenCategories.toSet()) }
    var cats by remember(p.id) { mutableStateOf<List<com.ziptv.core.Category>?>(null) }
    var failed by remember(p.id) { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(p.id) { model.categoriesOf(p) { cats = it; failed = it == null } }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Field("Playlist name", name) { name = it }
        val list = cats
        when {
            failed -> Text("Couldn't load the categories", color = Z.live, style = MaterialTheme.typography.bodyMedium)
            list == null -> Text("Loading categories…", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
            list.isNotEmpty() -> CategoryPicker(list, hidden) { hidden = it }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onDone, modifier = Modifier.height(52.dp).focusRing()) { Text("Cancel") }
            Button(
                onClick = {
                    // Ids no longer offered by the provider are dropped; unknown list = keep the old choice.
                    val keep = list?.let { l -> hidden.filter { h -> l.any { it.id == h } } } ?: p.hiddenCategories
                    model.editPlaylist(p, name.trim(), keep); onDone()
                },
                enabled = list == null || failed || hidden.size < list.size,
                colors = ButtonDefaults.buttonColors(containerColor = Z.accent),
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.weight(1f).height(52.dp).focusRing(),
            ) { Text("Save") }
        }
    }
}

/** Default playlist name: the server's host and port. */
private fun hostPort(url: String) = url.trim().substringAfter("://").substringBefore('/')

@Composable
private fun Field(label: String, value: String, keyboard: KeyboardType = KeyboardType.Text, secret: Boolean = false, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value, onValueChange = onChange, label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard, autoCorrectEnabled = false),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Z.focus, unfocusedBorderColor = Z.surfaceHigh),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
fun Chip(label: String, selected: Boolean, onClick: () -> Unit) {
    Text(
        label, maxLines = 1,
        color = if (selected) androidx.compose.ui.graphics.Color.White else Z.textMuted,
        style = MaterialTheme.typography.labelLarge,
        modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
            .background(if (selected) Z.accentGradient else androidx.compose.ui.graphics.SolidColor(Z.surfaceHigh))
            .clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
    )
}
