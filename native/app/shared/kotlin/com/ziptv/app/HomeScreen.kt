package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.animation.core.tween
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.togetherWith
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.ziptv.core.Channel
import com.ziptv.core.ContentKind
import com.ziptv.core.Movie
import com.ziptv.core.Series
import com.ziptv.core.WatchProgress
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class HomeData(
    val cont: List<WatchProgress> = emptyList(),
    val recent: List<Channel> = emptyList(),
    val favChannels: List<Channel> = emptyList(),
    val newMovies: List<Movie> = emptyList(),
    val newSeries: List<Series> = emptyList(),
    val favMovies: List<Movie> = emptyList(),
    val favSeries: List<Series> = emptyList(),
    val topMovies: List<Movie> = emptyList(),
    val topSeries: List<Series> = emptyList(),
    val lists: List<Pair<String, List<Movie>>> = emptyList(),
)

/** v9 home: pick up where you left off, recent + favorite channels, recently added. */
@Composable
fun HomeScreen(model: AppModel) {
    val lib = model.library ?: return
    val user = model.user ?: return
    val d by produceState(HomeData(), lib, user, model.catalogVersion, model.userVersion) {
        val listIds = model.movieLists()
        value = withContext(Dispatchers.IO) {
            HomeData(
                cont = user.continueWatching(),
                recent = lib.channelsByIds(user.recent()),
                favChannels = lib.channelsByIds(user.favorites(ContentKind.LIVE)),
                newMovies = if (model.isHiddenTab(Tab.Movies)) emptyList() else lib.recentlyAddedMovies(30u),
                newSeries = if (model.isHiddenTab(Tab.Series)) emptyList() else lib.recentlyAddedSeries(30u),
                // Movies/Series have no categories any more, so favorites ("My list") live here.
                favMovies = lib.moviesByIds(user.favorites(ContentKind.MOVIE)),
                favSeries = lib.seriesByIds(user.favorites(ContentKind.SERIES)),
                // ponytail: provider ratings, 10.0 is usually a placeholder so it's cut; TMDB-backed ranking if this proves noisy.
                topMovies = if (model.isHiddenTab(Tab.Movies)) emptyList() else lib.movies(null).filter { it.rating in 7f..9.7f }
                    .sortedWith(compareByDescending<Movie> { it.rating }.thenByDescending { it.added }).take(30),
                lists = listIds.map { (name, ids) -> name to lib.moviesByIds(ids).associateBy { it.streamId }.let { by -> ids.mapNotNull { by[it] } } }
                    .filter { it.second.isNotEmpty() },
                topSeries = if (model.isHiddenTab(Tab.Series)) emptyList() else lib.series(null).filter { it.rating in 7f..9.7f }
                    .sortedWith(compareByDescending<Series> { it.rating }.thenByDescending { it.added }).take(30),
            )
        }
        // The paired device's history (PC <-> phone hand-off) arrives later; never blocks the page.
        // Paired: one Continue Watching for both devices; the same title keeps whichever was watched last.
        // Re-checked every minute while Home is open, so the other device's viewing shows up.
        val local = value.cont
        while (true) {
            val companion = withContext(Dispatchers.IO) { runCatching { model.cloud.companionHistory(20u) }.getOrDefault(emptyList()) }
            if (companion.isNotEmpty()) value = value.copy(cont = (local + companion)
                .groupBy { it.key }.values.map { same -> same.maxBy { it.updatedAt } }
                .sortedByDescending { it.updatedAt })
            kotlinx.coroutines.delay(60_000)
        }
    }
    val empty = d.cont.isEmpty() && d.recent.isEmpty() && d.favChannels.isEmpty() && d.newMovies.isEmpty() && d.newSeries.isEmpty()
    if (empty) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("Start watching and your channels and shows will show up here", color = Z.textMuted)
        }
        return
    }
    LazyColumn(contentPadding = PaddingValues(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
        item { Hero(model, d) }
        if (d.cont.isNotEmpty()) item { ProgressRow("Continue watching", d.cont, model) }
        // Your playlists: tap a movie = play the list from there; Play all = from the top.
        d.lists.forEach { (name, movies) ->
            item(key = "list:$name") {
                PosterRow(name, movies.indices.map { Triple(movies[it].name, movies[it].poster, it) }, ratings = movies.map { it.rating },
                    actions = {
                        HeroButton(Icons.Rounded.PlayArrow, "Play all", primary = true) { model.playList(name) }
                        // Second tap confirms; resets after 3 s.
                        var sure by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
                        androidx.compose.runtime.LaunchedEffect(sure) { if (sure) { kotlinx.coroutines.delay(3_000); sure = false } }
                        HeroButton(Icons.Rounded.Delete, if (sure) "Tap again to delete" else "Delete", primary = false, ghost = !sure) {
                            if (sure) model.deleteList(name) else sure = true
                        }
                    }) { i -> model.playList(name, i as Int) }
            }
        }
        item { RecordingsRow(model) }
        if (d.recent.isNotEmpty()) item { ChannelRow("Recently watched channels", d.recent, model) }
        if (d.favChannels.isNotEmpty()) item { ChannelRow("Favorite channels", d.favChannels, model) }
        if (d.favMovies.isNotEmpty()) item {
            PosterRow("My list · Movies", d.favMovies.map { Triple(it.name, it.poster, it) }, ratings = d.favMovies.map { it.rating }) { m ->
                model.tab = Tab.Movies; model.openMovie = m as Movie
            }
        }
        if (d.favSeries.isNotEmpty()) item {
            PosterRow("My list · Series", d.favSeries.map { Triple(it.name, it.cover, it) }, ratings = d.favSeries.map { it.rating }) { s ->
                model.tab = Tab.Series; model.openSeries = s as Series
            }
        }
        if (d.newMovies.isNotEmpty()) item {
            PosterRow("Recently added · Movies", d.newMovies.map { Triple(it.name, it.poster, it) }, ratings = d.newMovies.map { it.rating }) { m ->
                model.tab = Tab.Movies; model.openMovie = m as Movie
            }
        }
        if (d.newSeries.isNotEmpty()) item {
            PosterRow("Recently added · Series", d.newSeries.map { Triple(it.name, it.cover, it) }, ratings = d.newSeries.map { it.rating }) { s ->
                model.tab = Tab.Series; model.openSeries = s as Series
            }
        }
        if (d.topMovies.isNotEmpty()) item {
            PosterRow("Top rated · Movies", d.topMovies.map { Triple(it.name, it.poster, it) }, ratings = d.topMovies.map { it.rating }) { m ->
                model.tab = Tab.Movies; model.openMovie = m as Movie
            }
        }
        if (d.topSeries.isNotEmpty()) item {
            PosterRow("Top rated · Series", d.topSeries.map { Triple(it.name, it.cover, it) }, ratings = d.topSeries.map { it.rating }) { s ->
                model.tab = Tab.Series; model.openSeries = s as Series
            }
        }
    }
}

/** Backdrop art for a movie/episode from TMDB (cached by the core); falls back to the poster. */
@Composable
private fun rememberBackdrop(model: AppModel, p: WatchProgress): String? {
    val art by produceState(p.image, p.key) {
        val kind = if (p.kind == ContentKind.MOVIE) ContentKind.MOVIE else ContentKind.SERIES
        val title = p.title.substringBefore(" · ")
        value = withContext(Dispatchers.IO) { runCatching { model.tmdb.lookup(kind, title, null) }.getOrNull() }?.backdrop ?: p.image
    }
    return art
}

private sealed interface Slide {
    data class Vod(val p: WatchProgress) : Slide
    data class Live(val ch: Channel) : Slide
}

/**
 * Streaming-style spotlight: the last few things you were watching (backdrop, time left, Resume / Details /
 * My list) plus your last channel, crossfading every 5 s. Stops rotating while it has focus (D-pad / mouse).
 */
@Composable
private fun Hero(model: AppModel, d: HomeData) {
    val slides = androidx.compose.runtime.remember(d.cont, d.recent) {
        val live = d.recent.firstOrNull()?.let { Slide.Live(it) }
        val cont = d.cont.firstOrNull()
        val liveFirst = live != null && (cont == null || System.currentTimeMillis() / 1000 - cont.updatedAt > 6 * 3600)
        listOfNotNull(live.takeIf { liveFirst }) + d.cont.take(5).map { Slide.Vod(it) } + listOfNotNull(live.takeIf { !liveFirst })
    }
    if (slides.isEmpty()) return
    var i by androidx.compose.runtime.remember(slides) { androidx.compose.runtime.mutableIntStateOf(0) }
    var held by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(slides, held, i) {
        if (!held && slides.size > 1) { kotlinx.coroutines.delay(5_000); i = (i + 1) % slides.size }
    }
    // Every slide's backdrop resolved and downloaded up front: a slide never changes art mid-transition (was the "jump").
    val arts = slides.map { s -> androidx.compose.runtime.key(s) { if (s is Slide.Vod) rememberBackdrop(model, s.p) else null } }
    val ctx = coil3.compose.LocalPlatformContext.current
    androidx.compose.runtime.LaunchedEffect(arts) {
        val loader = coil3.SingletonImageLoader.get(ctx)
        arts.filterNotNull().forEach { loader.enqueue(coil3.request.ImageRequest.Builder(ctx).data(it).build()) }
    }
    val wide = LocalWide.current
    Box(Modifier.fillMaxWidth().height(if (wide) 440.dp else 360.dp).clipToBounds() // zoom + slide stay inside
        .onFocusChanged { held = it.hasFocus }
        .pointerInput(Unit) {
            awaitPointerEventScope {
                while (true) {
                    val e = awaitPointerEvent()
                    if (e.type == PointerEventType.Enter) held = true else if (e.type == PointerEventType.Exit) held = false
                }
            }
        }) {
        // Outgoing drifts left and fades while the next comes in from the right.
        androidx.compose.animation.AnimatedContent(i.coerceIn(slides.indices), label = "hero", transitionSpec = {
            val ease = tween<Float>(650, easing = androidx.compose.animation.core.FastOutSlowInEasing)
            val move = tween<androidx.compose.ui.unit.IntOffset>(650, easing = androidx.compose.animation.core.FastOutSlowInEasing)
            (androidx.compose.animation.fadeIn(ease) + androidx.compose.animation.slideInHorizontally(move) { it / 12 }) togetherWith
                (androidx.compose.animation.fadeOut(ease) + androidx.compose.animation.slideOutHorizontally(move) { -it / 12 })
        }) { k ->
            when (val s = slides[k]) {
                is Slide.Vod -> VodSlide(model, s.p, arts[k])
                is Slide.Live -> LiveSlide(model, s.ch, d.recent)
            }
        }
        if (slides.size > 1) Row(Modifier.align(Alignment.BottomEnd).padding(end = if (wide) 32.dp else 20.dp, bottom = if (wide) 34.dp else 20.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            slides.indices.forEach { k ->
                val w by androidx.compose.animation.core.animateDpAsState(if (k == i) 22.dp else 8.dp, tween(300), label = "dot")
                Box(Modifier.width(w).height(8.dp).clip(RoundedCornerShape(50))
                    .background(if (k == i) Z.focus else Color.White.copy(alpha = 0.3f)).clickable { i = k })
            }
        }
    }
}

/** Fade the art into the page: left for the text, bottom into the rows. */
@Composable
private fun HeroScrims() {
    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Z.bg.copy(alpha = 0.95f), Z.bg.copy(alpha = 0.55f), Color.Transparent))))
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Z.bg)))
}

@Composable
private fun HeroText(content: @Composable () -> Unit) {
    val wide = LocalWide.current
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.align(Alignment.BottomStart).padding(start = if (wide) 32.dp else 20.dp, end = if (wide) 120.dp else 20.dp,
            bottom = if (wide) 28.dp else 40.dp).widthIn(max = 620.dp)) { content() }
    }
}

/** Live has no artwork: an accent glow and the channel logo fill the space instead of a black box. */
@Composable
private fun LiveSlide(model: AppModel, ch: Channel, recent: List<Channel>) {
    val wide = LocalWide.current
    val now = rememberNow(model, ch)
    Box(Modifier.fillMaxSize().drawBehind {
        drawRect(Brush.radialGradient(listOf(Z.accent.copy(alpha = 0.38f), Color(0xFF06B6D4).copy(alpha = 0.10f), Color.Transparent),
            center = Offset(size.width * 0.78f, size.height * 0.42f), radius = size.height * 1.1f))
    }) {
        Box(Modifier.align(if (wide) Alignment.CenterEnd else Alignment.TopEnd)
            .padding(end = if (wide) 72.dp else 20.dp, top = if (wide) 0.dp else 24.dp)
            .size(if (wide) 220.dp else 110.dp).clip(RoundedCornerShape(28.dp)).background(Color.White.copy(alpha = 0.06f)),
            contentAlignment = Alignment.Center) {
            ChannelLogo(ch.logo, Modifier.fillMaxSize(0.7f), ch.altLogo)
        }
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.6f to Color.Transparent, 1f to Z.bg)))
        HeroText {
            LiveBadge()
            Spacer(Modifier.height(10.dp))
            val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
            val greeting = when (hour) { in 5..11 -> "GOOD MORNING"; in 12..16 -> "GOOD AFTERNOON"; else -> "GOOD EVENING" }
            Text("$greeting · BACK TO YOUR CHANNEL", color = Z.focus, style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(8.dp))
            Text(ch.name, style = MaterialTheme.typography.headlineMedium.copy(fontSize = if (wide) 44.sp else 30.sp),
                fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            now?.let { p ->
                val t = System.currentTimeMillis() / 1000
                Spacer(Modifier.height(6.dp))
                Text(p.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${clock(p.start)} – ${clock(p.end)} · ${((p.end - t) / 60).coerceAtLeast(1)} min left",
                    color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(10.dp))
                ProgressBar((t - p.start).toFloat() / (p.end - p.start).coerceAtLeast(1))
            }
            Spacer(Modifier.height(18.dp))
            HeroButton(Icons.Rounded.PlayArrow, "Watch Live", primary = true) { model.playChannel(ch, recent, full = true) }
        }
    }
}

@Composable
private fun ProgressBar(frac: Float) =
    Box(Modifier.width(220.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(Z.surfaceHigh)) {
        Box(Modifier.fillMaxWidth(frac.coerceIn(0f, 1f)).fillMaxHeight().background(Z.accentGradient))
    }

@Composable
private fun VodSlide(model: AppModel, c: WatchProgress, backdrop: String?) {
    val wide = LocalWide.current
    // Slow push-in on the art while the slide is up (Ken Burns), so the hero never sits still.
    val zoom = androidx.compose.runtime.remember { androidx.compose.animation.core.Animatable(1f) }
    androidx.compose.runtime.LaunchedEffect(Unit) { zoom.animateTo(1.06f, tween(4_000, easing = androidx.compose.animation.core.LinearEasing)) }
    Box(Modifier.fillMaxSize()) {
        if (!backdrop.isNullOrBlank()) AsyncImage(backdrop, null, Modifier.fillMaxSize()
            .graphicsLayer { scaleX = zoom.value; scaleY = zoom.value }, contentScale = ContentScale.Crop)
        HeroScrims()
        HeroText {
            run {
                val kindLabel = if (c.kind == ContentKind.MOVIE) "Movie" else "Series"
                Text("CONTINUE WATCHING · $kindLabel", color = Z.focus, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(8.dp))
                Text(c.title.substringBefore(" · "), style = MaterialTheme.typography.headlineMedium.copy(fontSize = if (wide) 44.sp else 30.sp),
                    fontWeight = FontWeight.ExtraBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(6.dp))
                val left = ((c.durationMs - c.positionMs) / 60_000).coerceAtLeast(1)
                val ep = c.title.substringAfter(" · ", "")
                Text(listOf("$left min left", ep, cleanEpisodeTitle(c.subtitle, c.title.substringBefore(" · ")))
                    .filter { it.isNotBlank() && it != "Movie" }.distinct().joinToString(" · "),
                    color = Z.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                ProgressBar(c.positionMs.toFloat() / c.durationMs.coerceAtLeast(1))
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(if (wide) 12.dp else 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    HeroButton(Icons.Rounded.PlayArrow, "Resume", primary = true) { model.resume(c) }
                    HeroButton(null, "Details", primary = false) { openDetails(model, c) }
                    val favKind = if (c.kind == ContentKind.MOVIE) ContentKind.MOVIE else ContentKind.SERIES
                    val favId = if (c.kind == ContentKind.MOVIE) c.streamId else c.seriesId
                    if (favId != null) {
                        val inList = model.userVersion.let { model.isFavorite(favKind, favId) }
                        HeroButton(if (inList) Icons.Rounded.Check else Icons.Rounded.Add, "My list", primary = false, ghost = true) {
                            model.toggleFavorite(favKind, favId)
                        }
                    }
                }
            }
        }
    }
}

/** Details page for a continue-watching entry (movie detail or the series' episodes). */
private fun openDetails(model: AppModel, p: WatchProgress) {
    val lib = model.library ?: return
    if (p.kind == ContentKind.MOVIE) {
        lib.moviesByIds(listOf(p.streamId)).firstOrNull()?.let { model.openMovie = it; model.tab = Tab.Movies }
    } else {
        p.seriesId?.let { id -> lib.seriesByIds(listOf(id)).firstOrNull()?.let { model.openSeries = it; model.tab = Tab.Series } }
    }
}

@Composable
/** "Euphoria - S01E06 - The Next Episode" -> "The Next Episode" (providers repeat the show + code). */
fun cleanEpisodeTitle(raw: String, series: String): String {
    var t = raw.trim()
    if (series.isNotBlank() && t.startsWith(series, ignoreCase = true)) t = t.substring(series.length)
    t = t.replace(Regex("""^[\s\-–—:|]*S\d{1,2}\s*E\d{1,3}[\s\-–—:|]*""", RegexOption.IGNORE_CASE), "")
    return t.trim().trimStart('-', '–', '—', ':', '|').trim()
}

@Composable
private fun HeroButton(icon: ImageVector?, label: String, primary: Boolean, ghost: Boolean = false, onClick: () -> Unit) {
    val compact = !LocalWide.current
    Row(
        Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
            .background(when {
                primary -> Z.accentGradient
                ghost -> SolidColor(Color.Transparent)
                else -> SolidColor(Color.White.copy(alpha = 0.12f))
            })
            .clickable(onClick = onClick).padding(horizontal = if (compact) 14.dp else 22.dp, vertical = if (compact) 9.dp else 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) { Icon(icon, null, tint = Color.White, modifier = Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)) }
        Text(label, color = Color.White, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun LiveBadge() = Text("LIVE", color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.typography.labelMedium,
    fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Z.live).padding(horizontal = 8.dp, vertical = 2.dp))

/** v9's Recordings: DVR captures, newest first. Tap = play, long-press = stop/delete. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun RecordingsRow(model: AppModel) {
    var tick by androidx.compose.runtime.remember { androidx.compose.runtime.mutableIntStateOf(0) }
    val list = androidx.compose.runtime.remember(model.recordingsVersion, tick) { model.recorder.list() }
    val active = list.any { it.status == com.ziptv.core.RecordingStatus.RECORDING || it.status == com.ziptv.core.RecordingStatus.SCHEDULED }
    androidx.compose.runtime.LaunchedEffect(active, tick) { if (active) { kotlinx.coroutines.delay(5000); tick++ } }
    if (list.isEmpty()) return
    Column {
        RowTitle("Recordings")
        LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            items(list, key = { it.id }) { r ->
                val status = when (r.status) {
                    com.ziptv.core.RecordingStatus.RECORDING -> "● REC · ${r.bytes.toLong() / (1 shl 20)} MB"
                    com.ziptv.core.RecordingStatus.SCHEDULED -> "Scheduled · ${clock(r.start)}"
                    com.ziptv.core.RecordingStatus.DONE -> "${r.bytes.toLong() / (1 shl 20)} MB"
                    com.ziptv.core.RecordingStatus.FAILED -> r.error?.let { "Failed · $it" } ?: "Failed"
                }
                Column(
                    Modifier.animateItem().width(240.dp).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp)).background(Z.surface)
                        .combinedClickable(
                            onClick = { if (r.status == com.ziptv.core.RecordingStatus.DONE || r.status == com.ziptv.core.RecordingStatus.RECORDING) model.playRecording(r) },
                            onLongClick = { model.deleteRecording(r) },
                        ).padding(14.dp),
                ) {
                    Text(r.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(r.channel, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(status, color = if (r.status == com.ziptv.core.RecordingStatus.RECORDING) Z.live else Z.textMuted,
                        style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun RowTitle(title: String) =
    Text(title, Modifier.padding(horizontal = 20.dp, vertical = 6.dp), style = MaterialTheme.typography.titleLarge)

@Composable
private fun ProgressRow(title: String, items: List<WatchProgress>, model: AppModel) {
    RowTitle(title)
    LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items(items, key = { it.key }) { p ->
            val art = rememberBackdrop(model, p)
            Column(Modifier.animateItem().width(270.dp).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp)).clickable { model.resume(p) }) {
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Z.surfaceHigh),
                    contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Movie, null, tint = Z.textMuted)
                    if (!art.isNullOrBlank()) AsyncImage(art, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    val frac = if (p.durationMs > 0) (p.positionMs.toFloat() / p.durationMs).coerceIn(0f, 1f) else 0f
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Z.bg.copy(alpha = 0.6f))) {
                        Box(Modifier.fillMaxWidth(frac).fillMaxHeight().background(Z.accentGradient))
                    }
                }
                Text(p.title.substringBefore(" · "), Modifier.padding(top = 8.dp), style = MaterialTheme.typography.titleMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                val left = ((p.durationMs - p.positionMs) / 60_000).coerceAtLeast(1)
                Text(listOf(p.title.substringAfter(" · ", ""), "$left min left").filter { it.isNotBlank() }.joinToString(" · "),
                    color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun ChannelRow(title: String, channels: List<Channel>, model: AppModel) {
    RowTitle(title)
    LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items(channels, key = { it.streamId }) { ch ->
            Column(Modifier.width(210.dp).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp))
                .clickable { model.playChannel(ch, channels, full = true) }) {
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(12.dp)).background(Z.surfaceHigh),
                    contentAlignment = Alignment.Center) {
                    ChannelLogo(ch.logo, Modifier.fillMaxSize(0.62f), ch.altLogo)
                    Box(Modifier.align(Alignment.TopStart).padding(8.dp)) { LiveBadge() }
                }
                Text(ch.name, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun PosterRow(title: String, items: List<Triple<String, String?, Any>>, ratings: List<Float>, width: Dp = 140.dp,
                      actions: (@Composable () -> Unit)? = null, onOpen: (Any) -> Unit) {
    if (actions == null) RowTitle(title)
    else Row(Modifier.padding(end = 20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.weight(1f, fill = false)) { RowTitle(title) }
        actions()
    }
    LazyRow(contentPadding = PaddingValues(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items(items.size) { i ->
            val (name, image, item) = items[i]
            Column(Modifier.width(width).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp)).clickable { onOpen(item) }) {
                Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).background(Z.surfaceHigh), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Movie, null, tint = Z.textMuted)
                    if (!image.isNullOrBlank()) AsyncImage(image, name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                }
                Text(name, Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                if (ratings[i] > 0f) Text("★ %.1f".format(ratings[i]), color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}
