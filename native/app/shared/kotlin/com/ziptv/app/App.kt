package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.LiveTv
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.VideoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Wide = side rail + multi-pane screens. Compact = bottom bar + single pane. */
val LocalWide = compositionLocalOf { true }

private data class TabItem(val tab: Tab, val label: String, val icon: ImageVector)

private val allTabs = listOf(
    TabItem(Tab.Home, "Home", Icons.Rounded.Home),
    TabItem(Tab.Live, "Live TV", Icons.Rounded.LiveTv),
    TabItem(Tab.Movies, "Movies", Icons.Rounded.Movie),
    TabItem(Tab.Series, "Series", Icons.Rounded.VideoLibrary),
    TabItem(Tab.Search, "Search", Icons.Rounded.Search),
    TabItem(Tab.Settings, "Settings", Icons.Rounded.Settings),
)

@Composable
fun App(model: AppModel) {
    ZipTheme(model.platform.device) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Z.bg)) {
            // TV and desktop always get the wide layout; touch decides by width (tablets/landscape).
            val wide = model.platform.device != DeviceClass.Touch || maxWidth >= 720.dp
            val logoTransform = androidx.compose.runtime.remember { model.platform.logoTransformation() }
            CompositionLocalProvider(LocalWide provides wide, LocalLogoTransform provides logoTransform) {
                when (val s = model.screen) {
                    Screen.Welcome -> WelcomeScreen(model)
                    is Screen.Syncing -> SyncingScreen(s.message)
                    Screen.Main -> MainScaffold(model, wide)
                }
                if (miniPlayerVisible(model, wide)) MiniPlayer(model, Modifier.align(Alignment.BottomEnd))
                if (model.fullscreen && model.nowPlaying != null) PlayerScreen(model)
                val screenFull = model.fullscreen && model.nowPlaying != null
                androidx.compose.runtime.LaunchedEffect(screenFull) { model.platform.setScreenFullscreen(screenFull) }
                ReminderBanner(model, Modifier.align(Alignment.TopCenter))
                model.error?.let { msg ->
                    LaunchedEffect(msg) { delay(5000); model.error = null }
                    Snackbar(Modifier.align(Alignment.BottomCenter).padding(24.dp).widthIn(max = 560.dp)) { Text(msg) }
                }
            }
        }
    }
}

@Composable
fun Wordmark(size: Int = 22) {
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = Z.text)) { append("ZIPTV ") }
            withStyle(SpanStyle(color = Z.focus)) { append("PRO") }
        },
        fontSize = size.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.5.sp,
    )
}

@Composable
private fun SyncingScreen(message: String) {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Wordmark(30)
        Spacer(Modifier.height(32.dp))
        CircularProgressIndicator(color = Z.focus)
        Spacer(Modifier.height(20.dp))
        Text(message, color = Z.textMuted, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun MainScaffold(model: AppModel, wide: Boolean) {
    model.platform.BackHandler(enabled = model.tab != Tab.Home && !model.fullscreen) { model.tab = Tab.Home }
    // Admin can hide whole tabs for a playlist (v9 "pre-add visibility").
    val tabs = allTabs.filter { !model.isHiddenTab(it.tab) && it.tab != Tab.Search } // search lives in the header
    // Leaving Live TV keeps playing: wide layouts show the mini player; compact (phones) stop.
    androidx.compose.runtime.LaunchedEffect(model.tab) {
        if (!wide && model.tab != Tab.Live && !model.fullscreen && model.nowPlaying != null) model.stop()
    }
    if (wide) {
        Row(Modifier.fillMaxSize()) {
            NavigationRail(
                containerColor = Z.surface,
                header = { Box(Modifier.padding(vertical = 20.dp)) { Wordmark(15) } },
                modifier = Modifier.fillMaxHeight().width(108.dp),
            ) {
                // Scrolls when the screen is too short for every tab (TV, landscape tablets).
                Column(Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState())) {
                tabs.forEach { t ->
                    NavigationRailItem(
                        selected = model.tab == t.tab,
                        onClick = { model.tab = t.tab },
                        icon = { Icon(t.icon, contentDescription = null) },
                        label = { Text(t.label) },
                        colors = NavigationRailItemDefaults.colors(
                            selectedIconColor = Z.text, selectedTextColor = Z.text,
                            indicatorColor = Z.accent, unselectedIconColor = Z.textMuted, unselectedTextColor = Z.textMuted,
                        ),
                        modifier = Modifier.padding(vertical = 4.dp).focusRing(lift = 1f),
                    )
                }
                }
            }
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Header(model, wide = true)
                Box(Modifier.weight(1f)) { TabContent(model) }
            }
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            Header(model, wide = false)
            Box(Modifier.weight(1f)) { TabContent(model) }
            NavigationBar(containerColor = Z.surface) {
                tabs.forEach { BottomItem(model, it) }
            }
        }
    }
}

/** v9's header: playlist on the left, search + clock on the right. */
@Composable
private fun Header(model: AppModel, wide: Boolean) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(15_000); now = System.currentTimeMillis() } }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!wide) { Wordmark(17); Spacer(Modifier.width(12.dp)) }
        Text(model.active?.name ?: "", Modifier.weight(1f), color = Z.textMuted, maxLines = 1,
            overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
        if (wide) {
            HeaderSearch(model, Modifier.width(380.dp))
            Spacer(Modifier.width(20.dp))
        } else {
            Icon(Icons.Rounded.Search, "Search", Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
                .clickable { model.tab = Tab.Search }.padding(8.dp))
            Spacer(Modifier.width(8.dp))
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(now)), fontWeight = FontWeight.Bold)
            if (wide) Text(SimpleDateFormat("MMMM d, yyyy", Locale.getDefault()).format(Date(now)),
                color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
        }
    }
}

/** v9's header search pill: always visible, top right, where people look for it. */
@Composable
private fun HeaderSearch(model: AppModel, modifier: Modifier) {
    androidx.compose.foundation.text.BasicTextField(
        value = model.searchQuery,
        onValueChange = { model.searchQuery = it; if (it.isNotEmpty()) model.tab = Tab.Search },
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = Z.text),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(Z.focus),
        modifier = modifier.focusRing(RoundedCornerShape(50), lift = 1f),
        decorationBox = { inner ->
            Row(
                Modifier.clip(RoundedCornerShape(50)).background(Z.surface).padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Search, null, tint = Z.textMuted)
                Spacer(Modifier.width(10.dp))
                Box(Modifier.weight(1f)) {
                    if (model.searchQuery.isEmpty()) Text("Search live, movies & series…", color = Z.textMuted)
                    inner()
                }
            }
        },
    )
}

@Composable
private fun RowScope.BottomItem(model: AppModel, t: TabItem) {
    NavigationBarItem(
        selected = model.tab == t.tab,
        onClick = { model.tab = t.tab },
        icon = { Icon(t.icon, contentDescription = null) },
        label = { Text(t.label) },
        colors = NavigationBarItemDefaults.colors(
            selectedIconColor = Z.text, selectedTextColor = Z.text, indicatorColor = Z.accent,
            unselectedIconColor = Z.textMuted, unselectedTextColor = Z.textMuted,
        ),
    )
}

@Composable
private fun TabContent(model: AppModel) {
    when (model.tab) {
        Tab.Home -> HomeScreen(model)
        Tab.Live -> LiveScreen(model)
        Tab.Movies -> MoviesScreen(model)
        Tab.Series -> SeriesScreen(model)
        Tab.Search -> SearchScreen(model)
        Tab.Settings -> SettingsScreen(model)
    }
}

@Composable
private fun ReminderBanner(model: AppModel, modifier: Modifier) {
    val r = model.dueReminder ?: return
    val lib = model.library
    Row(
        modifier.padding(16.dp).widthIn(max = 620.dp).clip(RoundedCornerShape(14.dp)).background(Z.surfaceHigh).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.NotificationsActive, null, tint = Z.focus)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(r.title, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Starting now on ${r.channelName}", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
        }
        TextButton(onClick = {
            lib?.channelsByIds(listOf(r.streamId))?.firstOrNull()?.let { model.playChannel(it, listOf(it), full = true) }
            model.dueReminder = null
        }, modifier = Modifier.focusRing()) { Text("Watch", color = Z.focus) }
        TextButton(onClick = { model.dueReminder = null }, modifier = Modifier.focusRing()) { Text("Dismiss", color = Z.textMuted) }
    }
}
