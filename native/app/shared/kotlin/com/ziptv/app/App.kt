package com.ziptv.app

import coil3.request.crossfade

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith

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
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.Tv
import androidx.compose.material.icons.rounded.Public
import androidx.compose.runtime.collectAsState
import androidx.compose.material.icons.rounded.VideoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
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

/** Logo/poster hosts (Wikimedia, imgur) refuse anonymous "okhttp" clients, so identify the app. */
private const val IMAGE_UA = "ZIPTVPro/10 (+https://github.com/kxng1080xx/ZIPTVPRO)"

@Composable
fun App(model: AppModel) {
    coil3.compose.setSingletonImageLoaderFactory { ctx ->
        coil3.ImageLoader.Builder(ctx).crossfade(true).components { // images fade in
            add(coil3.network.okhttp.OkHttpNetworkFetcherFactory(callFactory = {
                okhttp3.OkHttpClient.Builder()
                    .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("User-Agent", IMAGE_UA).build()) }
                    .build()
            }))
        }.build()
    }
    ZipTheme(model.platform.device) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Z.bg).padding(model.platform.cutoutPadding())) {
            // TV and desktop always get the wide layout; touch decides by width (tablets/landscape).
            val wide = model.platform.device != DeviceClass.Touch || maxWidth >= 720.dp
            val logoTransform = androidx.compose.runtime.remember { model.platform.logoTransformation() }
            CompositionLocalProvider(LocalWide provides wide, LocalLogoTransform provides logoTransform) {
                AnimatedContent(model.screen, contentKey = { it::class }, // sync progress text doesn't re-animate
                    transitionSpec = { fadeIn(tween(260)) togetherWith fadeOut(tween(160)) }) { s ->
                    when (s) {
                        Screen.Welcome -> WelcomeScreen(model)
                        Screen.Loading -> LoadingScreen()
                        is Screen.Syncing -> SyncingScreen(s.message)
                        Screen.Main -> MainScaffold(model, wide)
                    }
                }
                // Exits stay short: the video surface can only be in one place at a time.
                AnimatedVisibility(miniPlayerVisible(model, wide),
                    Modifier.align(Alignment.BottomEnd).padding(bottom = if (wide) 0.dp else 80.dp), // portrait: above the tab bar
                    enter = slideInVertically(tween(260)) { it / 3 } + fadeIn(tween(260)), exit = fadeOut(tween(90))) {
                    MiniPlayer(model, Modifier)
                }
                AnimatedVisibility(model.fullscreen && model.nowPlaying != null,
                    enter = fadeIn(tween(220)) + scaleIn(tween(260), initialScale = 0.94f), exit = fadeOut(tween(90))) {
                    PlayerScreen(model)
                }
                val screenFull = model.fullscreen && model.nowPlaying != null
                androidx.compose.runtime.LaunchedEffect(screenFull) { model.platform.setScreenFullscreen(screenFull) }
                ReminderBanner(model, Modifier.align(Alignment.TopCenter))
                WatchBanner(model, Modifier.align(Alignment.TopCenter)) // over the player too
                CastBanner(model, Modifier.align(Alignment.BottomCenter).padding(bottom = if (LocalWide.current) 0.dp else 80.dp))
                UpdateBanner(model, Modifier.align(Alignment.BottomStart))
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
private fun LoadingScreen() {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Wordmark(30)
        Spacer(Modifier.height(36.dp))
        androidx.compose.material3.LinearProgressIndicator(
            Modifier.widthIn(max = 420.dp).fillMaxWidth(0.8f).height(6.dp).clip(RoundedCornerShape(3.dp)),
            color = Z.focus, trackColor = Z.surfaceHigh)
        Spacer(Modifier.height(12.dp))
        Text("Loading your playlist…", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun SyncingScreen(message: String) {
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Wordmark(30)
        Spacer(Modifier.height(36.dp))
        // Step-based progress: the core reports each list it downloads. Big lists get a bigger
        // share, and the bar creeps toward the step's end while one downloads (never sits still).
        val label = message.removePrefix("Retrying ").substringBefore(" (")
        val i = SYNC_STEPS.indexOfFirst { it.first == label }.coerceAtLeast(0)
        val from = SYNC_STEPS[i].second
        val to = SYNC_STEPS.getOrNull(i + 1)?.second ?: 1f
        var target by androidx.compose.runtime.remember { androidx.compose.runtime.mutableFloatStateOf(0f) }
        androidx.compose.runtime.LaunchedEffect(i) {
            target = maxOf(target, from)
            while (true) { kotlinx.coroutines.delay(250); target += (to - 0.01f - target) * 0.06f }
        }
        val shown by androidx.compose.animation.core.animateFloatAsState(target, androidx.compose.animation.core.tween(400), label = "sync")
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth(0.8f)) {
            Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)).background(Z.surfaceHigh)) {
                Box(Modifier.fillMaxWidth(shown).fillMaxHeight().clip(RoundedCornerShape(3.dp)).background(Z.accentGradient))
            }
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth()) {
                val steps = if (label == "Playlist" || SYNC_STEPS[i].third) 2 else 8
                val n = if (steps == 2) (if (label == "Saving") 2 else 1) else i + 1
                Text("Step $n of $steps · $message", Modifier.weight(1f), color = Z.textMuted,
                    style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                Text("${(shown * 100).toInt()}%", color = Z.text, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

/** (core progress label, where it starts on the bar, M3U-only step). Lists weigh more than categories. */
private val SYNC_STEPS = listOf(
    Triple("Connecting", 0.0f, false),
    Triple("Live categories", 0.04f, false),
    Triple("Live channels", 0.08f, false),
    Triple("Movie categories", 0.34f, false),
    Triple("Movies", 0.38f, false),
    Triple("Series categories", 0.68f, false),
    Triple("Series", 0.72f, false),
    Triple("Saving", 0.95f, false),
    Triple("Playlist", 0.05f, true),
)

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
        // Rail: icons only, widens with labels on mouse hover / D-pad focus. It floats over the page
        // (content keeps the narrow width as padding), so opening it never reflows the screen.
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().padding(start = RAIL_NARROW)) {
                Header(model, wide = true)
                Box(Modifier.weight(1f)) { TabContent(model) }
            }
            SideRail(model, tabs)
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

private val RAIL_NARROW = 84.dp
private val RAIL_WIDE = 220.dp

@Composable
private fun SideRail(model: AppModel, tabs: List<TabItem>) {
    var hover by remember { mutableStateOf(false) }
    var focused by remember { mutableStateOf(false) }
    // Focus opens it only on TV (D-pad). On PC a click leaves focus on the item, which kept it stuck open.
    val open = hover || (focused && LocalDevice.current == DeviceClass.Tv)
    val w by androidx.compose.animation.core.animateDpAsState(if (open) RAIL_WIDE else RAIL_NARROW,
        tween(220, easing = androidx.compose.animation.core.FastOutSlowInEasing), label = "rail")
    Column(
        Modifier.fillMaxHeight().width(w)
            .shadow(if (open) 24.dp else 0.dp)
            .background(Z.surface)
            .onFocusChanged { focused = it.hasFocus }
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val e = awaitPointerEvent()
                        if (e.type == PointerEventType.Enter) hover = true else if (e.type == PointerEventType.Exit) hover = false
                    }
                }
            }
            .padding(horizontal = 14.dp, vertical = 18.dp),
    ) {
        Box(Modifier.height(36.dp).padding(start = 6.dp), contentAlignment = Alignment.CenterStart) {
            if (open) Wordmark(15)
            else Text("Z", color = Z.focus, fontSize = 22.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.padding(start = 10.dp))
        }
        Spacer(Modifier.height(16.dp))
        // Scrolls when the screen is too short for every tab (TV, landscape tablets).
        Column(Modifier.weight(1f).verticalScroll(androidx.compose.foundation.rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            tabs.filter { it.tab != Tab.Settings }.forEach { RailItem(model, it, open) }
        }
        tabs.firstOrNull { it.tab == Tab.Settings }?.let { RailItem(model, it, open) } // pinned to the bottom
    }
}

@Composable
private fun RailItem(model: AppModel, t: TabItem, open: Boolean) {
    val selected = model.tab == t.tab
    Row(
        Modifier.fillMaxWidth().height(48.dp).focusRing(RoundedCornerShape(50), lift = 1f).clip(RoundedCornerShape(50))
            .background(if (selected) Z.accent else Color.Transparent)
            .clickable { model.tab = t.tab }.padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(t.icon, t.label, tint = if (selected) Z.text else Z.textMuted)
        AnimatedVisibility(open, enter = fadeIn(tween(180, delayMillis = 60)), exit = fadeOut(tween(80))) {
            Text(t.label, Modifier.padding(start = 16.dp), color = if (selected) Z.text else Z.textMuted,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1, softWrap = false)
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
        // v9's header TV link: the address to type into a Smart TV's browser (re-read each minute: Wi-Fi can change).
        if (wide) remember(now / 60_000) { model.lan.tvUrl() }?.let { TvLink(it) }
        // One click to "Watch away from home": starts the link and shows its QR.
        model.platform.tunnel?.let { t ->
            val tunnelUrl by t.url.collectAsState()
            var sharing by remember { mutableStateOf(false) }
            Icon(Icons.Rounded.Public, "Watch away from home", tint = if (tunnelUrl.isNullOrEmpty()) Z.text else Z.focus,
                modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
                    .clickable { if (tunnelUrl == null) t.start(model.lan.port().toInt()); sharing = true }.padding(8.dp))
            Spacer(Modifier.width(4.dp))
            if (sharing) ShareDialog(model, t) { sharing = false }
        }
        // v9's header icon: the guest's way into a friend's Watch Together room.
        var joining by remember { mutableStateOf(false) }
        Icon(Icons.Rounded.Groups, "Watch Together", Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
            .clickable { joining = true }.padding(8.dp))
        Spacer(Modifier.width(8.dp))
        if (joining) androidx.compose.ui.window.Dialog(onDismissRequest = { joining = false }) {
            Column(Modifier.widthIn(max = 420.dp).clip(RoundedCornerShape(16.dp)).background(Z.surface)) {
                Text("Watch Together", Modifier.padding(start = 16.dp, top = 16.dp), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                Text("Enter your friend's room code. To start a room, open ⋯ while watching a movie.", color = Z.textMuted,
                    style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(16.dp))
                WatchJoinField(model) { joining = false }
            }
        }
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

/** "TV  10.0.0.5:8790/tv" pill; click copies the full link. */
@Composable
private fun TvLink(url: String) {
    val clip = androidx.compose.ui.platform.LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1500); copied = false } }
    Row(
        Modifier.padding(end = 12.dp).focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50)).background(Z.surface)
            .clickable { clip.setText(androidx.compose.ui.text.AnnotatedString(url)); copied = true }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.Tv, null, tint = Z.focus,
            modifier = Modifier.padding(end = 8.dp).height(18.dp).width(18.dp))
        Text(if (copied) "Copied" else url.removePrefix("http://"), style = MaterialTheme.typography.labelLarge, maxLines = 1)
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
    AnimatedContent(model.tab, transitionSpec = {
        (fadeIn(tween(240)) + slideInVertically(tween(240)) { it / 40 }) togetherWith fadeOut(tween(70))
    }) { tab -> when (tab) {
        Tab.Home -> HomeScreen(model)
        Tab.Live -> LiveScreen(model)
        Tab.Movies -> MoviesScreen(model)
        Tab.Series -> SeriesScreen(model)
        Tab.Search -> SearchScreen(model)
        Tab.Settings -> SettingsScreen(model)
    } }
}

@Composable
private fun UpdateBanner(model: AppModel, modifier: Modifier) {
    val u = model.update ?: return
    Row(
        modifier.padding(16.dp).widthIn(max = 520.dp).clip(RoundedCornerShape(14.dp)).background(Z.surfaceHigh).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        var progress by remember { mutableStateOf<Float?>(null) }
        Column(Modifier.weight(1f)) {
            Text("ZIPTV Pro ${u.version} is available", fontWeight = FontWeight.Bold)
            val p = progress
            if (p == null) Text("You have ${model.platform.appVersion}", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
            else {
                Text("Downloading… ${(p * 100).toInt()}%", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
                androidx.compose.material3.LinearProgressIndicator(progress = { p }, color = Z.focus, trackColor = Z.surface,
                    modifier = Modifier.padding(top = 6.dp).fillMaxWidth())
            }
        }
        TextButton(onClick = {
            if (progress != null) return@TextButton
            if (!model.platform.inAppUpdate) { if (!model.platform.openUrl(u.url)) model.error = "Couldn't open the download"; return@TextButton }
            // v9's built-in downloader: no browser needed (Fire TV has none that installs APKs).
            progress = 0f
            model.scope.launch {
                val err = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    model.platform.downloadAndInstall(u.url) { f -> progress = f }
                }
                progress = null
                err?.let { model.error = it }
            }
        }, modifier = Modifier.focusRing()) {
            Text(if (progress == null) "Update" else "…", color = Z.focus)
        }
        TextButton(onClick = { model.update = null }, modifier = Modifier.focusRing()) { Text("Later", color = Z.textMuted) }
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
