package com.ziptv.app

import androidx.compose.animation.core.animateFloat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Replay
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.ziptv.core.ContentKind
import com.ziptv.core.Episode
import com.ziptv.core.Movie
import com.ziptv.core.SearchResults
import com.ziptv.core.Series
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** Poster data shared by movies and series; `item` is the Movie or Series itself. */
private data class Poster(val id: String, val title: String, val image: String?, val rating: Float, val year: String?, val item: Any)

@Composable
fun MoviesScreen(model: AppModel) {
    model.openMovie?.let { m ->
        model.platform.BackHandler(enabled = !model.fullscreen) { model.openMovie = null }
        MovieDetail(model, m) { model.openMovie = null }
        return
    }
    CatalogScreen(model, ContentKind.MOVIE,
        load = { cat ->
            val lib = model.library ?: return@CatalogScreen emptyList()
            val list = when (cat) {
                CAT_FAV -> lib.moviesByIds(model.user?.favorites(ContentKind.MOVIE) ?: emptyList())
                CAT_ALL -> lib.movies(null).filter { !model.isHiddenCategory(it.categoryId) }
                else -> lib.movies(cat)
            }
            list.map { Poster(it.streamId, it.name, it.poster, it.rating, it.year, it) }
        },
        onOpen = { model.openMovie = it.item as Movie })
}

@Composable
fun SeriesScreen(model: AppModel) {
    model.openSeries?.let { s ->
        model.platform.BackHandler(enabled = !model.fullscreen) { model.openSeries = null }
        EpisodesScreen(model, s) { model.openSeries = null }
        return
    }
    CatalogScreen(model, ContentKind.SERIES,
        load = { cat ->
            val lib = model.library ?: return@CatalogScreen emptyList()
            val list = when (cat) {
                CAT_FAV -> lib.seriesByIds(model.user?.favorites(ContentKind.SERIES) ?: emptyList())
                CAT_ALL -> lib.series(null).filter { !model.isHiddenCategory(it.categoryId) }
                else -> lib.series(cat)
            }
            list.map { Poster(it.seriesId, it.name, it.cover, it.rating, it.year, it) }
        },
        onOpen = { model.openSeries = it.item as Series })
}

@Composable
private fun CatalogScreen(model: AppModel, kind: ContentKind, load: (String) -> List<Poster>, onOpen: (Poster) -> Unit) {
    // ponytail: no category browsing for movies/series — everything in one grid, search finds the rest.
    val posters by produceState<List<Poster>?>(null, model.library, kind, model.catalogVersion) {
        value = withContext(Dispatchers.IO) { load(CAT_ALL) }
    }
    PosterGrid(posters, Modifier.fillMaxSize().padding(horizontal = if (LocalWide.current) 16.dp else 6.dp), onOpen)
}

@Composable
private fun PosterGrid(items: List<Poster>?, modifier: Modifier, onOpen: (Poster) -> Unit) {
    val min = if (LocalDevice.current == DeviceClass.Touch && !LocalWide.current) 110.dp else 150.dp
    androidx.compose.animation.Crossfade(items == null, modifier, label = "posters") { loading ->
        if (loading) PosterSkeleton(min) else PosterGridLoaded(items.orEmpty(), min, onOpen)
    }
}

/** Grey poster shapes with a moving shine while the catalog loads. */
@Composable
private fun PosterSkeleton(min: androidx.compose.ui.unit.Dp) {
    val shine = shimmerBrush()
    LazyVerticalGrid(GridCells.Adaptive(min), Modifier.fillMaxSize(), contentPadding = PaddingValues(8.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(18.dp),
        userScrollEnabled = false) {
        items(24) {
            Column {
                Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).clip(RoundedCornerShape(12.dp)).background(shine))
                Box(Modifier.padding(top = 10.dp).fillMaxWidth(0.8f).height(12.dp).clip(RoundedCornerShape(6.dp)).background(shine))
                Box(Modifier.padding(top = 6.dp).fillMaxWidth(0.35f).height(10.dp).clip(RoundedCornerShape(5.dp)).background(shine))
            }
        }
    }
}

@Composable
fun shimmerBrush(): androidx.compose.ui.graphics.Brush {
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "shimmer")
    val x by t.animateFloat(-600f, 1600f, androidx.compose.animation.core.infiniteRepeatable(
        androidx.compose.animation.core.tween(1300, easing = androidx.compose.animation.core.LinearEasing)), label = "x")
    return androidx.compose.ui.graphics.Brush.linearGradient(
        listOf(Z.surface, Z.surfaceHigh, Color(0xFF232836), Z.surfaceHigh, Z.surface),
        start = androidx.compose.ui.geometry.Offset(x, 0f), end = androidx.compose.ui.geometry.Offset(x + 600f, 300f),
    )
}

@Composable
private fun PosterGridLoaded(items: List<Poster>, min: androidx.compose.ui.unit.Dp, onOpen: (Poster) -> Unit) {
    if (items.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Nothing here yet", color = Z.textMuted) }
        return
    }
    LazyVerticalGrid(
        GridCells.Adaptive(min), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(8.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        items(items, key = { it.id }) { p -> PosterCard(p.title, p.image, p.rating, p.year) { onOpen(p) } }
    }
}

@Composable
fun PosterCard(title: String, image: String?, rating: Float, year: String?, onClick: () -> Unit) {
    Column(Modifier.focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick)) {
        PosterImage(image, title, rating, Modifier.fillMaxWidth())
        Text(title, Modifier.padding(top = 8.dp, start = 2.dp, end = 2.dp), style = MaterialTheme.typography.labelLarge,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        year?.let { Text(it, Modifier.padding(horizontal = 2.dp), color = Z.textMuted, style = MaterialTheme.typography.labelMedium) }
    }
}

@Composable
private fun PosterImage(image: String?, title: String, rating: Float, modifier: Modifier) {
    Box(modifier.aspectRatio(2f / 3f).clip(RoundedCornerShape(12.dp)).background(Z.surfaceHigh), contentAlignment = Alignment.Center) {
        Icon(Icons.Rounded.Movie, null, tint = Z.textMuted, modifier = Modifier.size(36.dp))
        if (!image.isNullOrBlank()) AsyncImage(image, contentDescription = title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        if (rating > 0f) {
            Row(
                Modifier.align(Alignment.TopEnd).padding(6.dp).clip(RoundedCornerShape(8.dp))
                    .background(Z.bg.copy(alpha = 0.75f)).padding(horizontal = 6.dp, vertical = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.Star, null, tint = Z.gold, modifier = Modifier.size(12.dp))
                Spacer(Modifier.width(3.dp))
                Text("%.1f".format(rating), style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@Composable
private fun PillButton(icon: ImageVector, label: String, primary: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp))
            .background(if (primary) Z.accentGradient else SolidColor(Z.surfaceHigh))
            .clickable(onClick = onClick).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = Color.White, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Text(label, color = Color.White, fontWeight = FontWeight.SemiBold)
    }
}

fun hms(ms: Long): String {
    val s = ms / 1000
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

@Composable
private fun MovieDetail(model: AppModel, m: Movie, onBack: () -> Unit) {
    val lib = model.library ?: return
    val resume = model.userVersion.let { model.user?.progress("movie:${m.streamId}") }
    val fav = model.userVersion.let { model.isFavorite(ContentKind.MOVIE, m.streamId) }
    fun play(fromStart: Boolean) {
        if (fromStart) model.user?.removeProgress("movie:${m.streamId}")
        model.play(Playable(m.name, m.year ?: "Movie", lib.movieUrl(m.streamId, m.extension), PlayKind.Movie, m.streamId, m.poster, m.extension), true)
    }
    Row(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
        if (LocalWide.current) PosterImage(m.poster, m.name, m.rating, Modifier.width(260.dp))
        Column(Modifier.weight(1f).widthIn(max = 720.dp)) {
            IconAction(Icons.Rounded.ArrowBack, "Back", onClick = onBack)
            Text(m.name, style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(6.dp))
            Text(listOfNotNull(m.year, if (m.rating > 0) "★ %.1f".format(m.rating) else null).joinToString(" · "), color = Z.textMuted)
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (resume != null) {
                    PillButton(Icons.Rounded.PlayArrow, "Resume ${hms(resume.positionMs)}", true) { play(false) }
                    PillButton(Icons.Rounded.Replay, "Start over", false) { play(true) }
                } else {
                    PillButton(Icons.Rounded.PlayArrow, "Play", true) { play(false) }
                }
                IconAction(if (fav) Icons.Rounded.Star else Icons.Rounded.StarBorder, if (fav) "Remove favorite" else "Add favorite",
                    if (fav) Z.gold else Z.textMuted) { model.toggleFavorite(ContentKind.MOVIE, m.streamId) }
            }
            MetaSection(model, ContentKind.MOVIE, m.name, m.year)
        }
    }
}

@Composable
private fun EpisodesScreen(model: AppModel, series: Series, onBack: () -> Unit) {
    val lib = model.library ?: return
    val episodes by produceState<List<Episode>?>(null, series.seriesId) {
        value = withContext(Dispatchers.IO) { runCatching { lib.episodes(series.seriesId) }.getOrDefault(emptyList()) }
    }
    val fav = model.userVersion.let { model.isFavorite(ContentKind.SERIES, series.seriesId) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconAction(Icons.Rounded.ArrowBack, "Back", onClick = onBack)
                Text(series.name, Modifier.weight(1f), style = MaterialTheme.typography.headlineMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconAction(if (fav) Icons.Rounded.Star else Icons.Rounded.StarBorder, if (fav) "Remove favorite" else "Add favorite",
                    if (fav) Z.gold else Z.textMuted) { model.toggleFavorite(ContentKind.SERIES, series.seriesId) }
            }
            MetaSection(model, ContentKind.SERIES, series.name, series.year)
        }
        val eps = episodes
        when {
            eps == null -> items(6) { EpisodeSkeleton() }
            eps.isEmpty() -> item { Text("No episodes found", color = Z.textMuted) }
            else -> eps.groupBy { it.season }.forEach { (season, list) ->
                item(key = "s$season") {
                    Text("Season $season", Modifier.padding(top = 12.dp, bottom = 4.dp), style = MaterialTheme.typography.titleLarge)
                }
                items(list, key = { it.id }) { e -> EpisodeRow(model, series, e) }
            }
        }
    }
}

@Composable
private fun EpisodeSkeleton() {
    val shine = shimmerBrush()
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Z.surface).padding(14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(24.dp, 16.dp).clip(RoundedCornerShape(4.dp)).background(shine))
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Box(Modifier.fillMaxWidth(0.55f).height(14.dp).clip(RoundedCornerShape(6.dp)).background(shine))
            Box(Modifier.padding(top = 8.dp).fillMaxWidth(0.85f).height(10.dp).clip(RoundedCornerShape(5.dp)).background(shine))
        }
    }
}

@Composable
private fun EpisodeRow(model: AppModel, series: Series, e: Episode) {
    val lib = model.library ?: return
    val prog = model.userVersion.let { model.user?.progress("episode:${e.id}") }
    Row(
        Modifier.fillMaxWidth().focusRing(RoundedCornerShape(12.dp), lift = 1.01f)
            .clip(RoundedCornerShape(12.dp)).background(Z.surface)
            .clickable {
                model.play(Playable("${series.name} · S${e.season}E${e.number}", e.title.ifBlank { "Episode ${e.number}" },
                    lib.episodeUrl(e.id, e.extension), PlayKind.Episode, e.id, e.image ?: series.cover, e.extension, series.seriesId), full = true)
            }
            .padding(14.dp),
    ) {
        Text("${e.number}", Modifier.width(36.dp), color = Z.focus, style = MaterialTheme.typography.titleMedium)
        Column(Modifier.weight(1f)) {
            Text(e.title.ifBlank { "Episode ${e.number}" }, style = MaterialTheme.typography.titleMedium, maxLines = 1,
                overflow = TextOverflow.Ellipsis)
            if (e.plot.isNotBlank()) Text(e.plot, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
            if (prog != null && prog.durationMs > 0) {
                Spacer(Modifier.height(6.dp))
                Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(Z.surfaceHigh)) {
                    Box(Modifier.fillMaxWidth((prog.positionMs.toFloat() / prog.durationMs).coerceIn(0f, 1f)).fillMaxHeight().background(Z.accentGradient))
                }
            }
        }
    }
}

@Composable
fun SearchScreen(model: AppModel) {
    val lib = model.library ?: return
    val query = model.searchQuery
    val results by produceState(SearchResults(emptyList(), emptyList(), emptyList()), query, model.catalogVersion) {
        delay(200) // debounce typing
        value = withContext(Dispatchers.IO) { lib.search(query, 40u) }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        // Wide layouts type in the header pill; compact gets the field at the top of this page.
        if (!LocalWide.current) {
            OutlinedTextField(
                query, { model.searchQuery = it }, singleLine = true, placeholder = { Text("Search live, movies & series…") },
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Z.focus, unfocusedBorderColor = Z.surfaceHigh),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(16.dp))
        }
        if (query.isEmpty()) Text("Type to search channels, movies and series", color = Z.textMuted)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (results.channels.isNotEmpty()) item { Section("Channels") }
            items(results.channels, key = { "c" + it.streamId }) { ch ->
                ResultRow(ch.name, "Live", ch.logo) { model.playChannel(ch, results.channels, full = true) }
            }
            if (results.movies.isNotEmpty() && !model.isHiddenTab(Tab.Movies)) {
                item { Section("Movies") }
                items(results.movies, key = { "m" + it.streamId }) { m ->
                    ResultRow(m.name, m.year ?: "Movie", m.poster) { model.openMovie = m; model.tab = Tab.Movies }
                }
            }
            if (results.series.isNotEmpty() && !model.isHiddenTab(Tab.Series)) {
                item { Section("Series") }
                items(results.series, key = { "s" + it.seriesId }) { s ->
                    ResultRow(s.name, s.year ?: "Series", s.cover) { model.openSeries = s; model.tab = Tab.Series }
                }
            }
            if (query.length >= 2 && results.channels.isEmpty() && results.movies.isEmpty() && results.series.isEmpty()) {
                item { Text("No results for “$query”", color = Z.textMuted) }
            }
        }
    }
}

@Composable
private fun Section(title: String) =
    Text(title, Modifier.padding(top = 12.dp, bottom = 4.dp), style = MaterialTheme.typography.titleLarge)

@Composable
private fun ResultRow(title: String, subtitle: String, image: String?, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().focusRing(RoundedCornerShape(12.dp), lift = 1.01f).clip(RoundedCornerShape(12.dp))
            .background(Z.surface).clickable(onClick = onClick).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ChannelLogo(image, Modifier.size(48.dp))
        Spacer(Modifier.width(14.dp))
        Column {
            Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(subtitle, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
