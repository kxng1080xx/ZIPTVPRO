package com.ziptv.app

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Apps
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.DeleteSweep
import androidx.compose.material.icons.rounded.Devices
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PlayCircle
import androidx.compose.material.icons.rounded.PlaylistPlay
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.SortByAlpha
import androidx.compose.material.icons.rounded.SystemUpdate
import androidx.compose.material.icons.rounded.Wifi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class Section(val title: String, val icon: ImageVector) {
    Account("Account & Playlists", Icons.Rounded.Person),
    Playback("Playback", Icons.Rounded.PlayCircle),
    Network("Network", Icons.Rounded.Wifi),
    Application("Application", Icons.Rounded.Apps),
}

/** v9 layout: sections on the left, cards on the right. Phones: section list, tap to open. */
@Composable
fun SettingsScreen(model: AppModel) {
    val wide = LocalWide.current
    var section by remember { mutableStateOf<Section?>(if (wide) Section.Account else null) }
    if (wide && section == null) section = Section.Account
    model.platform.BackHandler(enabled = !wide && section != null) { section = null }

    if (wide) {
        Row(Modifier.fillMaxSize()) {
            Column(Modifier.width(240.dp).fillMaxHeight().padding(horizontal = 12.dp)) {
                Text("Settings", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(start = 8.dp, top = 8.dp, bottom = 16.dp))
                Section.entries.forEach { s ->
                    val on = s == section
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp).focusRing(RoundedCornerShape(12.dp), lift = 1.01f)
                            .clip(RoundedCornerShape(12.dp)).background(if (on) Z.activeTint else SolidColor(Color.Transparent))
                            .clickable { section = s }.padding(horizontal = 12.dp, vertical = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(s.icon, null, tint = if (on) Z.focus else Z.textMuted, modifier = Modifier.size(20.dp))
                        Text(s.title, Modifier.padding(start = 12.dp), fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (on) Z.text else Z.textMuted)
                    }
                }
            }
            Box(Modifier.width(1.dp).fillMaxHeight().background(Z.outline))
            AnimatedContent(section, transitionSpec = {
                (fadeIn() + slideInHorizontally { it / 12 }) togetherWith fadeOut()
            }, modifier = Modifier.weight(1f)) { s -> s?.let { SectionPage(model, it, back = null) } }
        }
    } else {
        AnimatedContent(section, transitionSpec = {
            if (targetState != null) (fadeIn() + slideInHorizontally { it / 4 }) togetherWith fadeOut()
            else fadeIn() togetherWith (fadeOut() + slideOutHorizontally { it / 4 })
        }) { s ->
            if (s == null) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 14.dp)) {
                    Text("Settings", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
                    Card {
                        Section.entries.forEachIndexed { i, sec ->
                            if (i > 0) Divider()
                            SettingRow(sec.icon, sec.title, null, onClick = { section = sec }) {
                                Icon(Icons.Rounded.ChevronRight, null, tint = Z.textMuted)
                            }
                        }
                    }
                }
            } else SectionPage(model, s, back = { section = null })
        }
    }
}

@Composable
private fun SectionPage(model: AppModel, s: Section, back: (() -> Unit)?) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = if (back == null) 28.dp else 14.dp).padding(bottom = 32.dp).widthIn(max = 760.dp),
    ) {
        Row(Modifier.padding(top = 8.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            back?.let { IconAction(Icons.Rounded.ArrowBack, "Back", onClick = it) }
            Text(s.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
        }
        when (s) {
            Section.Account -> AccountSection(model)
            Section.Playback -> PlaybackSection(model)
            Section.Network -> NetworkSection(model)
            Section.Application -> ApplicationSection(model)
        }
    }
}

@Composable
private fun AccountSection(model: AppModel) {
    var adding by remember { mutableStateOf(false) }
    var confirmRemoveAll by remember { mutableStateOf(false) }
    Group("Playlists") {
        model.playlists.forEachIndexed { i, p ->
            if (i > 0) Divider()
            val isActive = model.active?.id == p.id
            SettingRow(Icons.Rounded.PlaylistPlay, p.name, if (isActive) "Playing from this playlist" else "Tap to switch",
                onClick = { if (!isActive) model.open(p) }) {
                if (isActive) Icon(Icons.Rounded.CheckCircle, "Active", tint = Z.focus, modifier = Modifier.size(22.dp))
                IconAction(Icons.Rounded.Delete, "Remove ${p.name}", Z.textMuted) { model.remove(p) }
            }
        }
        if (model.playlists.isNotEmpty()) Divider()
        SettingRow(Icons.Rounded.Add, if (adding) "Cancel" else "Add playlist", "Xtream Codes login or M3U link", onClick = { adding = !adding })
        AnimatedVisibility(adding, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Box(Modifier.padding(16.dp)) { PlaylistForm(model) { adding = false } }
        }
    }
    Group("Sync & cache") {
        SettingRow(Icons.Rounded.Refresh, "Refresh all lists", "Download channels, movies and series again",
            onClick = { model.sync(background = false) })
    }
    CompanionGroup(model)
    Group("Watch Together") {
        SettingRow(Icons.Rounded.Devices, "Join a friend's room", "Same provider · start one from ⋯ while watching a movie")
        WatchJoinField(model)
    }
    if (model.playlists.isNotEmpty()) Group(null) {
        SettingRow(Icons.Rounded.DeleteSweep, "Remove all playlists", "From this device and the server", tint = Z.live,
            onClick = { confirmRemoveAll = !confirmRemoveAll })
        AnimatedVisibility(confirmRemoveAll, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("This can't be undone.", Modifier.weight(1f), color = Z.textMuted)
                Chip("Cancel", false) { confirmRemoveAll = false }
                Text("Remove all", color = Color.White, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50)).background(Z.live)
                        .clickable {
                            confirmRemoveAll = false
                            model.removeAll { err -> model.error = err?.let { "Could not reach the server: $it" } ?: "All playlists removed" }
                        }.padding(horizontal = 16.dp, vertical = 10.dp))
            }
        }
    }
}

@Composable
private fun CompanionGroup(model: AppModel) {
    var pairCode by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Group("Companion device") {
        val companion = model.device?.companion
        if (companion != null) {
            SettingRow(Icons.Rounded.Devices, "Paired with ${companion.label ?: companion.deviceId}",
                "Continue watching across PC & mobile") {
                IconAction(Icons.Rounded.LinkOff, "Unpair", Z.textMuted) {
                    scope.launch {
                        val err = withContext(Dispatchers.IO) { runCatching { model.cloud.unpair() }.exceptionOrNull()?.message }
                        model.error = err ?: "Unpaired"
                    }
                }
            }
        } else {
            SettingRow(Icons.Rounded.Devices, "Pair a phone and a PC", "Continue watching across PC & mobile")
            Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(pairCode, { pairCode = it.uppercase().take(8) }, singleLine = true,
                    label = { Text("Other device's code") },
                    colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Z.focus, unfocusedBorderColor = Z.surfaceHigh),
                    modifier = Modifier.weight(1f))
                Spacer(Modifier.width(10.dp))
                Chip("Pair", pairCode.length >= 4) {
                    if (pairCode.length >= 4) scope.launch {
                        val r = withContext(Dispatchers.IO) { runCatching { model.cloud.pair(pairCode) } }
                        model.error = r.fold({ "Paired with ${it.label ?: it.deviceId}" }, { it.message ?: "Pairing failed" })
                    }
                }
            }
        }
    }
}

@Composable
private fun PlaybackSection(model: AppModel) {
    Group(null) {
        val deint = model.userVersion.let { model.user?.setting("deinterlace") == "1" }
        SettingRow(Icons.Rounded.Bolt, "Deinterlace (60fps)", "Smoother sports and news on interlaced channels",
            onClick = { model.toggleDeinterlace() }) {
            Switch(checked = deint, onCheckedChange = { model.toggleDeinterlace() },
                colors = SwitchDefaults.colors(checkedTrackColor = Z.accent, checkedThumbColor = Color.White))
        }
    }
}

@Composable
private fun NetworkSection(model: AppModel) {
    val d = model.device
    Group("Cloud") {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBadge(Icons.Rounded.Cloud)
            Column(Modifier.weight(1f).padding(start = 14.dp)) {
                Text("Device code", color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
                Text(model.cloud.deviceCode(), fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold,
                    fontSize = 22.sp, color = Z.focus, letterSpacing = 3.sp)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(d?.status?.replaceFirstChar { it.uppercase() } ?: "Offline", fontWeight = FontWeight.SemiBold,
                    color = if (d == null) Z.live else Z.text)
                d?.expiresAt?.let { Text("Expires ${it.take(10)}", color = Z.textMuted, style = MaterialTheme.typography.labelMedium) }
            }
        }
    }
    Text("Enter this code on the ZIPTV Pro website to send playlists to this device.", color = Z.textMuted,
        style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 6.dp, vertical = 10.dp))
}

@Composable
private fun ApplicationSection(model: AppModel) {
    var checking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Group("Categories") {
        val az = model.userVersion.let { model.user?.setting("cat_sort") == "az" }
        SettingRow(Icons.Rounded.SortByAlpha, "Category order", if (az) "A – Z" else "Provider order") {
            Chip("Provider", !az) { model.setSetting("cat_sort", null) }
            Spacer(Modifier.width(6.dp))
            Chip("A – Z", az) { model.setSetting("cat_sort", "az") }
        }
    }
    Text("Long-press a category to pin it, a channel to favorite it, a show in the guide to record it.",
        color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(horizontal = 6.dp, vertical = 10.dp))
    Group("About") {
        SettingRow(Icons.Rounded.SystemUpdate, if (checking) "Checking…" else "Check for updates",
            model.update?.let { "Version ${it.version} is available" } ?: "You're on ${model.platform.appVersion}",
            onClick = {
                if (!checking) {
                    checking = true
                    scope.launch {
                        val u = withContext(Dispatchers.IO) {
                            runCatching { com.ziptv.core.checkUpdate(model.platform.appVersion, model.platform.cloudPlatform) }.getOrNull()
                        }
                        checking = false
                        model.update = u
                        if (u == null) model.error = "ZIPTV Pro is up to date"
                    }
                }
            })
        Divider()
        SettingRow(Icons.Rounded.Info, "ZIPTV Pro ${model.platform.appVersion}", "${model.platform.device.name} layout")
    }
}

@Composable
private fun Group(title: String?, content: @Composable () -> Unit) {
    if (title != null) Text(title.uppercase(), color = Z.textMuted, style = MaterialTheme.typography.labelMedium,
        modifier = Modifier.padding(start = 6.dp, top = 18.dp, bottom = 8.dp))
    else Spacer(Modifier.height(14.dp))
    Card(content)
}

@Composable
private fun Card(content: @Composable () -> Unit) =
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Z.surface).animateContentSize()) { content() }

@Composable
private fun Divider() = Box(Modifier.fillMaxWidth().padding(start = 64.dp).height(1.dp).background(Z.outline))

@Composable
private fun IconBadge(icon: ImageVector, tint: Color = Z.focus) {
    Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(tint.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun SettingRow(
    icon: ImageVector, title: String, subtitle: String?, tint: Color = Z.focus,
    onClick: (() -> Unit)? = null, trailing: @Composable () -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.focusRing(RoundedCornerShape(12.dp), lift = 1f).clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBadge(icon, tint)
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, color = if (tint == Z.live) Z.live else Z.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            subtitle?.let { Text(it, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) { trailing() }
    }
}
