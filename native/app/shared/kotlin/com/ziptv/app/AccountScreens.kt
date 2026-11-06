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
