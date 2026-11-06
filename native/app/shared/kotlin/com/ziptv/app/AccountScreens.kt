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
    var m3u by remember { mutableStateOf("") }
    var server by remember { mutableStateOf("") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Field("Playlist name", name) { name = it }
        Field("M3U link (fills the fields below)", m3u, KeyboardType.Uri) {
            m3u = it
            parseM3uUrl(it.trim())?.let { (h, u, p) -> server = h; user = u; pass = p }
        }
        Field("Server (host and port)", server, KeyboardType.Uri) { server = it }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.weight(1f)) { Field("Username", user) { user = it } }
            Box(Modifier.weight(1f)) { Field("Password", pass, KeyboardType.Password, secret = true) { pass = it } }
        }
        error?.let { Text(it, color = Z.live, style = MaterialTheme.typography.bodyMedium) }
        Button(
            onClick = {
                busy = true; error = null
                val p = Playlist(name.ifBlank { server.substringAfter("://").substringBefore(':') }, server.trim(), user.trim(), pass)
                model.add(p) { err -> busy = false; error = err; if (err == null) onAdded() }
            },
            enabled = !busy && server.isNotBlank() && user.isNotBlank() && pass.isNotBlank(),
            colors = ButtonDefaults.buttonColors(containerColor = Z.accent),
            shape = RoundedCornerShape(12.dp),
            modifier = Modifier.fillMaxWidth().height(52.dp).focusRing(),
        ) { Text(if (busy) "Checking…" else "Connect playlist") }
    }
}

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
private fun SectionTitle(text: String) =
    Text(text, Modifier.padding(top = 28.dp, bottom = 10.dp), style = MaterialTheme.typography.titleLarge)

@Composable
fun SettingsScreen(model: AppModel) {
    var adding by remember { mutableStateOf(false) }
    var confirmRemoveAll by remember { mutableStateOf(false) }
    var pairCode by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val d = model.device
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp).padding(bottom = 32.dp).widthIn(max = 760.dp)) {
        SectionTitle("This device")
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Z.surface).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Device code", color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
                Text(model.cloud.deviceCode(), fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, fontSize = 22.sp, color = Z.focus)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(d?.status?.replaceFirstChar { it.uppercase() } ?: "Offline", fontWeight = FontWeight.SemiBold)
                d?.expiresAt?.let { Text("Expires ${it.take(10)}", color = Z.textMuted, style = MaterialTheme.typography.labelMedium) }
            }
        }

        SectionTitle("Playlists")
        model.playlists.forEach { p ->
            val isActive = model.active?.id == p.id
            Row(
                Modifier.fillMaxWidth().padding(vertical = 4.dp).focusRing(RoundedCornerShape(12.dp), lift = 1.01f)
                    .clip(RoundedCornerShape(12.dp)).background(if (isActive) Z.activeTint else androidx.compose.ui.graphics.SolidColor(Z.surface))
                    .clickable { if (!isActive) model.open(p) }.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(p.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${p.server.substringAfter("://")} · ${p.username}", color = Z.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (isActive) Icon(Icons.Rounded.CheckCircle, "Active", tint = Z.focus, modifier = Modifier.size(24.dp))
                IconAction(Icons.Rounded.Delete, "Remove ${p.name}", Z.textMuted) { model.remove(p) }
            }
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = { adding = !adding }, modifier = Modifier.focusRing()) { Text(if (adding) "Cancel" else "Add playlist") }
            OutlinedButton(onClick = { model.sync(background = false) }, modifier = Modifier.focusRing()) {
                Icon(Icons.Rounded.Refresh, null); Spacer(Modifier.size(8.dp)); Text("Refresh catalog")
            }
            if (model.playlists.isNotEmpty()) OutlinedButton(onClick = { confirmRemoveAll = true }, modifier = Modifier.focusRing()) {
                Text("Remove all playlists", color = Z.live)
            }
        }
        if (confirmRemoveAll) {
            Row(Modifier.padding(top = 12.dp).clip(RoundedCornerShape(12.dp)).background(Z.surfaceHigh).padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Remove every playlist from this device and the server?", Modifier.weight(1f))
                OutlinedButton(onClick = { confirmRemoveAll = false }, modifier = Modifier.focusRing()) { Text("Cancel") }
                Spacer(Modifier.size(8.dp))
                Button(onClick = {
                    confirmRemoveAll = false
                    model.removeAll { err -> model.error = err?.let { "Could not reach the server: $it" } ?: "All playlists removed" }
                }, colors = ButtonDefaults.buttonColors(containerColor = Z.live), modifier = Modifier.focusRing()) { Text("Remove all") }
            }
        }
        if (adding) {
            Spacer(Modifier.height(20.dp))
            PlaylistForm(model) { adding = false }
        }

        SectionTitle("Categories")
        val az = model.userVersion.let { model.user?.setting("cat_sort") == "az" }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Chip("Provider order", !az) { model.user?.setSetting("cat_sort", null); model.error = "Categories in provider order" }
            Chip("A – Z", az) { model.user?.setSetting("cat_sort", "az"); model.error = "Categories sorted A–Z" }
        }
        Text("Long-press a category to pin it to the top. Long-press a channel to favorite it.", color = Z.textMuted,
            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp))

        SectionTitle("Companion device")
        val companion = d?.companion
        if (companion != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Paired with ${companion.label ?: companion.deviceId} (${companion.platform})", Modifier.weight(1f))
                OutlinedButton(onClick = {
                    scope.launch {
                        val err = withContext(Dispatchers.IO) { runCatching { model.cloud.unpair() }.exceptionOrNull()?.message }
                        model.error = err ?: "Unpaired"
                    }
                }, modifier = Modifier.focusRing()) { Text("Unpair") }
            }
        } else {
            Text("Pair a phone with a PC so Continue Watching follows you between them.", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
            Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { Field("Other device's code", pairCode) { pairCode = it.uppercase().take(8) } }
                Spacer(Modifier.size(12.dp))
                OutlinedButton(onClick = {
                    scope.launch {
                        val r = withContext(Dispatchers.IO) { runCatching { model.cloud.pair(pairCode) } }
                        model.error = r.fold({ "Paired with ${it.label ?: it.deviceId}" }, { it.message ?: "Pairing failed" })
                    }
                }, enabled = pairCode.length >= 4, modifier = Modifier.focusRing()) { Text("Pair") }
            }
        }

        Spacer(Modifier.height(32.dp))
        Text("ZIPTV Pro ${model.platform.appVersion} · ${model.platform.device.name} layout", color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
    }
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
