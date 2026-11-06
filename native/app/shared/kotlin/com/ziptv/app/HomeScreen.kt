package com.ziptv.app

import androidx.compose.foundation.background
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
    val companion: List<WatchProgress> = emptyList(),
    val recent: List<Channel> = emptyList(),
    val favChannels: List<Channel> = emptyList(),
    val newMovies: List<Movie> = emptyList(),
    val newSeries: List<Series> = emptyList(),
)

/** v9 home: pick up where you left off, recent + favorite channels, recently added. */
@Composable
fun HomeScreen(model: AppModel) {
    val lib = model.library ?: return
    val user = model.user ?: return
    val d by produceState(HomeData(), lib, user, model.catalogVersion, model.userVersion) {
        value = withContext(Dispatchers.IO) {
            HomeData(
                cont = user.continueWatching(),
                recent = lib.channelsByIds(user.recent()),
                favChannels = lib.channelsByIds(user.favorites(ContentKind.LIVE)),
                newMovies = if (model.isHiddenTab(Tab.Movies)) emptyList() else lib.recentlyAddedMovies(30u),
                newSeries = if (model.isHiddenTab(Tab.Series)) emptyList() else lib.recentlyAddedSeries(30u),
            )
        }
        // The paired device's history (PC <-> phone hand-off) arrives later; never blocks the page.
        val companion = withContext(Dispatchers.IO) { runCatching { model.cloud.companionHistory(20u) }.getOrDefault(emptyList()) }
        value = value.copy(companion = companion.filter { c -> value.cont.none { it.key == c.key } })
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
        if (d.companion.isNotEmpty()) item { ProgressRow("From your other device", d.companion, model) }
        item { RecordingsRow(model) }
        if (d.recent.isNotEmpty()) item { ChannelRow("Recently watched channels", d.recent, model) }
        if (d.favChannels.isNotEmpty()) item { ChannelRow("Favorite channels", d.favChannels, model) }
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

/** Streaming-style hero: backdrop, title, time left, Resume / Details / My list. Live-only users get the channel. */
@Composable
private fun Hero(model: AppModel, d: HomeData) {
    val cont = d.cont.firstOrNull()
    val ch = d.recent.firstOrNull()
    if (cont == null && ch == null) return
    val preferVod = cont != null && (ch == null || System.currentTimeMillis() / 1000 - cont.updatedAt < 6 * 3600)
    val wide = LocalWide.current
    val backdrop = if (preferVod) rememberBackdrop(model, cont!!) else null
    Box(Modifier.fillMaxWidth().height(if (wide) 430.dp else 300.dp)) {
        if (backdrop != null) AsyncImage(backdrop, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        // Fade the art into the page: left for the text, bottom into the rows.
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Z.bg.copy(alpha = 0.95f), Z.bg.copy(alpha = 0.55f), Color.Transparent))))
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 1f to Z.bg)))
        Column(Modifier.align(Alignment.BottomStart).padding(start = 32.dp, end = 32.dp, bottom = 28.dp).widthIn(max = 620.dp)) {
            if (preferVod) {
                val c = cont!!
                val kindLabel = if (c.kind == ContentKind.MOVIE) "Movie" else "Series"
                Text("CONTINUE WATCHING · $kindLabel", color = Z.focus, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(8.dp))
                Text(c.title.substringBefore(" · "), style = MaterialTheme.typography.headlineMedium.copy(fontSize = if (wide) 44.sp else 30.sp),
                    fontWeight = FontWeight.ExtraBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(6.dp))
                val left = ((c.durationMs - c.positionMs) / 60_000).coerceAtLeast(1)
                val ep = c.title.substringAfter(" · ", "")
                Text(listOf("$left min left", ep, c.subtitle).filter { it.isNotBlank() && it != "Movie" }.distinct().joinToString(" · "),
                    color = Z.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(10.dp))
                Box(Modifier.width(220.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(Z.surfaceHigh)) {
                    Box(Modifier.fillMaxWidth((c.positionMs.toFloat() / c.durationMs.coerceAtLeast(1)).coerceIn(0f, 1f))
                        .fillMaxHeight().background(Z.accentGradient))
                }
                Spacer(Modifier.height(18.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
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
            } else {
                LiveBadge()
                Spacer(Modifier.height(10.dp))
                val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
                val greeting = when (hour) { in 5..11 -> "GOOD MORNING"; in 12..16 -> "GOOD AFTERNOON"; else -> "GOOD EVENING" }
                Text("$greeting — PICK UP WHERE YOU LEFT OFF", color = Z.focus, style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(8.dp))
                Text(ch!!.name, style = MaterialTheme.typography.headlineMedium.copy(fontSize = if (wide) 44.sp else 30.sp),
                    fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(18.dp))
                HeroButton(Icons.Rounded.PlayArrow, "Watch Live", primary = true) { model.playChannel(ch, d.recent, full = true) }
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
private fun HeroButton(icon: ImageVector?, label: String, primary: Boolean, ghost: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
            .background(when {
                primary -> Z.accentGradient
                ghost -> SolidColor(Color.Transparent)
                else -> SolidColor(Color.White.copy(alpha = 0.12f))
            })
            .clickable(onClick = onClick).padding(horizontal = 22.dp, vertical = 11.dp),
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
                    com.ziptv.core.RecordingStatus.FAILED -> "Failed"
                }
                Column(
                    Modifier.width(240.dp).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp)).background(Z.surface)
                        .combinedClickable(
                            onClick = { if (r.status == com.ziptv.core.RecordingStatus.DONE || r.status == com.ziptv.core.RecordingStatus.RECORDING) model.playRecording(r) },
                            onLongClick = { model.deleteRecording(r) },
                        ).padding(14.dp),
                ) {
                    Text(r.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(r.channel, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(status, color = if (r.status == com.ziptv.core.RecordingStatus.RECORDING) Z.live else Z.textMuted,
                        style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 6.dp))
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
            Column(Modifier.width(270.dp).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp)).clickable { model.resume(p) }) {
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
                    ChannelLogo(ch.logo, Modifier.fillMaxSize(0.62f))
                    Box(Modifier.align(Alignment.TopStart).padding(8.dp)) { LiveBadge() }
                }
                Text(ch.name, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun PosterRow(title: String, items: List<Triple<String, String?, Any>>, ratings: List<Float>, width: Dp = 140.dp, onOpen: (Any) -> Unit) {
    RowTitle(title)
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
