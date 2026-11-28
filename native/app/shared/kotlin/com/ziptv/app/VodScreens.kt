package com.ziptv.app

import androidx.compose.runtime.remember
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
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.layout
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
        androidx.compose.runtime.key(m.streamId) { MovieDetail(model, m) { model.openMovie = null } } // new movie = back to the top
        return
    }
    model.openPerson?.let { c ->
        model.platform.BackHandler(enabled = !model.fullscreen) { model.openPerson = null }
        ActorScreen(model, c) { model.openPerson = null }
        return
    }
    model.openList?.let { name ->
        model.platform.BackHandler(enabled = !model.fullscreen) { model.openList = null }
        MovieListScreen(model, name) { model.openList = null }
        return
    }
    var show by rememberSaveable { mutableStateOf(0) }  // index into SHOW
    var genre by rememberSaveable { mutableStateOf(0) } // 0 = all genres, else MOVIE_GENRES[genre - 1]
    val filtered = show != 0 || genre != 0
    CatalogScreen(model, ContentKind.MOVIE, key = show to genre, newestFirst = !filtered,
        load = { cat ->
            val lib = model.library ?: return@CatalogScreen emptyList()
            if (filtered) return@CatalogScreen Extras.discoverMovies(lib, SHOW[show], MOVIE_GENRES.getOrNull(genre - 1), model::isHiddenCategory)
                .map { Poster(it.streamId, it.name, it.poster, it.rating, it.year, it) }
            val list = when (cat) {
                CAT_FAV -> lib.moviesByIds(model.user?.favorites(ContentKind.MOVIE) ?: emptyList())
                CAT_ALL -> lib.distinctMovies(lib.movies(null).filter { !model.isHiddenCategory(it.categoryId) })
                else -> lib.movies(cat)
            }
            list.map { Poster(it.streamId, it.name, it.poster, it.rating, it.year, it) }
        },
        extra = { if (filtered) emptyList() else model.library?.let { lib -> Extras.movies(lib).map { Poster(it.streamId, it.name, it.poster, it.rating, it.year, it) } }.orEmpty() },
        onOpen = { model.openMovie = it.item as Movie },
        header = {
            Column {
                FilterBar(show, genre, MOVIE_GENRES, { show = it; if (SHOW[it] == "Recently added") genre = 0 }, { genre = it })
                if (!filtered) { MovieListsShelf(model); CategoryRows(model, ContentKind.MOVIE); AllTitle("All movies") }
            }
        })
}

@Composable
fun SeriesScreen(model: AppModel) {
    model.openSeries?.let { s ->
        model.platform.BackHandler(enabled = !model.fullscreen) { model.openSeries = null }
        EpisodesScreen(model, s) { model.openSeries = null }
        return
    }
    var show by rememberSaveable { mutableStateOf(0) }
    var genre by rememberSaveable { mutableStateOf(0) }
    val filtered = show != 0 || genre != 0
    CatalogScreen(model, ContentKind.SERIES, key = show to genre, newestFirst = !filtered,
        load = { cat ->
            val lib = model.library ?: return@CatalogScreen emptyList()
            if (filtered) return@CatalogScreen Extras.discoverSeries(lib, SHOW[show], SERIES_GENRES.getOrNull(genre - 1), model::isHiddenCategory)
                .map { Poster(it.seriesId, it.name, it.cover, it.rating, it.year, it) }
            val list = when (cat) {
                CAT_FAV -> lib.seriesByIds(model.user?.favorites(ContentKind.SERIES) ?: emptyList())
                CAT_ALL -> lib.distinctSeries(lib.series(null).filter { !model.isHiddenCategory(it.categoryId) })
                else -> lib.series(cat)
            }
            list.map { Poster(it.seriesId, it.name, it.cover, it.rating, it.year, it) }
        },
        extra = { if (filtered) emptyList() else model.library?.let { lib -> Extras.series(lib).map { Poster(it.seriesId, it.name, it.cover, it.rating, it.year, it) } }.orEmpty() },
        onOpen = { model.openSeries = it.item as Series },
        header = {
            Column {
                FilterBar(show, genre, SERIES_GENRES, { show = it; if (SHOW[it] == "Recently added") genre = 0 }, { genre = it })
                if (!filtered) { CategoryRows(model, ContentKind.SERIES); AllTitle("All series") }
            }
        })
}

private val YEAR = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)

/** The Movies / Series filter: what to show, then a genre (Cinemeta's genre names). */
private val SHOW = listOf("All", "Popular", "New releases", "Recently added")
private val MOVIE_GENRES = listOf("Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy",
    "History", "Horror", "Music", "Mystery", "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western")
private val SERIES_GENRES = listOf("Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary", "Drama", "Family", "Fantasy",
    "History", "Horror", "Mystery", "Reality-TV", "Romance", "Sci-Fi", "Talk-Show", "Thriller", "War", "Western")

@Composable
private fun FilterBar(show: Int, genre: Int, genres: List<String>, onShow: (Int) -> Unit, onGenre: (Int) -> Unit) {
    Row(Modifier.padding(start = 8.dp, top = 4.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        FilterDropdown(SHOW, show, onShow)
        if (SHOW[show] != "Recently added") FilterDropdown(listOf("All genres") + genres, genre, onGenre) // the provider's list has no genres
    }
}

/** A pill with a menu, like the season picker (D-pad: OK opens, arrows move, Back closes). */
@Composable
private fun FilterDropdown(options: List<String>, selected: Int, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp)).background(Z.surfaceHigh)
                .clickable { open = true }.padding(start = 16.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(options[selected], style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Icon(Icons.Rounded.ExpandMore, null, tint = Z.textMuted, modifier = Modifier.padding(start = 6.dp).size(20.dp))
        }
        DropdownMenu(open, { open = false }, containerColor = Z.surfaceHigh, shape = RoundedCornerShape(14.dp),
            modifier = Modifier.heightIn(max = 420.dp)) {
            options.forEachIndexed { i, name ->
                DropdownMenuItem(
                    text = { Text(name, fontWeight = if (i == selected) FontWeight.SemiBold else FontWeight.Normal, color = if (i == selected) Z.focus else Z.text) },
                    onClick = { open = false; onPick(i) },
                    modifier = Modifier.focusRing(RoundedCornerShape(10.dp)),
                )
            }
        }
    }
}

/** Category rows like CinemaOS: popular and new first, then genres (Cinemeta catalogs, merged with the playlist). */
private val MOVIE_ROWS = listOf("Popular" to listOf("top"), "New releases" to listOf("year/genre=$YEAR", "year/genre=${YEAR - 1}")) +
    listOf("Action", "Comedy", "Drama", "Thriller", "Horror", "Sci-Fi", "Animation", "Family", "Romance", "Crime", "Documentary")
        .map { it to listOf("top/genre=$it") }
private val SERIES_ROWS = listOf("Popular" to listOf("top"), "New releases" to listOf("year/genre=$YEAR", "year/genre=${YEAR - 1}")) +
    listOf("Drama", "Comedy", "Crime", "Action", "Sci-Fi", "Animation", "Mystery", "Reality-TV", "Documentary", "Family")
        .map { it to listOf("top/genre=$it") }

@Composable
private fun CategoryRows(model: AppModel, kind: ContentKind) {
    val lib = model.library ?: return
    val movie = kind == ContentKind.MOVIE
    val rows = if (movie) MOVIE_ROWS else SERIES_ROWS
    Column(Modifier.padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        rows.forEachIndexed { i, (title, paths) ->
            CategoryRow(model, lib, movie, title, paths)
            if (i == 1) RecentlyAddedRow(model, lib, movie) // the provider's newest, after Popular + New releases
        }
    }
}

@Composable
private fun CategoryRow(model: AppModel, lib: com.ziptv.core.Provider, movie: Boolean, title: String, paths: List<String>) {
    val items by produceState(emptyList<Poster>(), lib, model.catalogVersion, title) {
        value = runCatching {
            if (movie) Extras.movieRow(lib, paths, model::isHiddenCategory).map { Poster(it.streamId, it.name, it.poster, it.rating, it.year, it) }
            else Extras.seriesRow(lib, paths, model::isHiddenCategory).map { Poster(it.seriesId, it.name, it.cover, it.rating, it.year, it) }
        }.getOrDefault(emptyList())
    }
    PosterRowOf(model, title, items)
}

@Composable
private fun RecentlyAddedRow(model: AppModel, lib: com.ziptv.core.Provider, movie: Boolean) {
    val items by produceState(emptyList<Poster>(), lib, model.catalogVersion) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                if (movie) lib.recentlyAddedMovies(40u).filter { !model.isHiddenCategory(it.categoryId) }.map { Poster(it.streamId, it.name, it.poster, it.rating, it.year, it) }
                else lib.recentlyAddedSeries(40u).filter { !model.isHiddenCategory(it.categoryId) }.map { Poster(it.seriesId, it.name, it.cover, it.rating, it.year, it) }
            }.getOrDefault(emptyList())
        }
    }
    PosterRowOf(model, "Recently added", items)
}

@Composable
private fun PosterRowOf(model: AppModel, title: String, items: List<Poster>) {
    if (items.isEmpty()) return
    PosterRow(title, items.map { Triple(it.title, it.image, it.item) }, ratings = items.map { it.rating }) { item ->
        when (item) { is Movie -> model.openMovie = item; is Series -> model.openSeries = item }
    }
}

@Composable
private fun AllTitle(title: String) =
    Text(title, Modifier.padding(start = 20.dp, top = 14.dp, bottom = 4.dp), style = MaterialTheme.typography.titleLarge)

/** One entry per film/show: providers list "Dune" and "Dune 4K" separately (the details page picks the copy).
 *  ponytail: a copy with no year groups with the first same-named one of any year; fine for real catalogs. */
private fun com.ziptv.core.Provider.distinctMovies(list: List<Movie>): List<Movie> {
    val same = matchTitles(ContentKind.MOVIE, list.map { com.ziptv.core.RelatedTitle(it.name, it.year) })
    val seen = HashSet<String>()
    return list.filterIndexed { i, m -> seen.add(same.getOrNull(i) ?: m.streamId) }
}

private fun com.ziptv.core.Provider.distinctSeries(list: List<Series>): List<Series> {
    val same = matchTitles(ContentKind.SERIES, list.map { com.ziptv.core.RelatedTitle(it.name, it.year) })
    val seen = HashSet<String>()
    return list.filterIndexed { i, s -> seen.add(same.getOrNull(i) ?: s.seriesId) }
}

@Composable
private fun CatalogScreen(model: AppModel, kind: ContentKind, load: suspend (String) -> List<Poster>, onOpen: (Poster) -> Unit,
                          extra: suspend () -> List<Poster> = { emptyList() }, header: (@Composable () -> Unit)? = null,
                          key: Any? = null, newestFirst: Boolean = true) {
    // ponytail: no category browsing for movies/series — everything in one grid, search finds the rest.
    val own by produceState<List<Poster>?>(null, model.library, kind, model.catalogVersion, key) {
        value = null // a new filter: skeleton until its titles arrive
        value = withContext(Dispatchers.IO) { runCatching { load(CAT_ALL) }.getOrDefault(emptyList()) }
    }
    // Titles the playlist doesn't have (built-in sources), after its own once they arrive.
    val more by produceState(emptyList<Poster>(), model.library, kind, model.catalogVersion, key) {
        value = runCatching { extra() }.getOrDefault(emptyList())
    }
    // Newest first (the provider's own order buries this year's releases under old ones); a filter keeps its own order.
    val posters = own?.let { (it + more).distinctBy { p -> p.id }.let { l -> if (newestFirst) l.sortedByDescending { p -> p.year?.take(4)?.toIntOrNull() ?: 0 } else l } }
    PosterGrid(posters, Modifier.fillMaxSize().padding(horizontal = if (LocalWide.current) 16.dp else 6.dp), onOpen, header)
}

@Composable
private fun PosterGrid(items: List<Poster>?, modifier: Modifier, onOpen: (Poster) -> Unit, header: (@Composable () -> Unit)? = null) {
    val min = if (LocalDevice.current == DeviceClass.Touch && !LocalWide.current) 110.dp else 150.dp
    androidx.compose.animation.Crossfade(items == null, modifier, label = "posters") { loading ->
        if (loading) PosterSkeleton(min) else PosterGridLoaded(items.orEmpty(), min, onOpen, header)
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
private fun PosterGridLoaded(items: List<Poster>, min: androidx.compose.ui.unit.Dp, onOpen: (Poster) -> Unit, header: (@Composable () -> Unit)? = null) {
    if (items.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("Nothing here yet", color = Z.textMuted) }
        return
    }
    LazyVerticalGrid(
        GridCells.Adaptive(min), Modifier.fillMaxSize(),
        contentPadding = PaddingValues(8.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        // Full-width block above the posters that scrolls away with them (Movies: your playlists).
        if (header != null) item(key = "header", span = { androidx.compose.foundation.lazy.grid.GridItemSpan(maxLineSpan) }) { header() }
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
    // Shimmer until the artwork arrives; the movie icon only when there's no (working) artwork.
    var state by remember(image) { mutableStateOf(if (image.isNullOrBlank()) 2 else 0) } // 0 loading, 1 loaded, 2 none
    Box(modifier.aspectRatio(2f / 3f).clip(RoundedCornerShape(12.dp))
        .background(if (state == 0) shimmerBrush() else SolidColor(Z.surfaceHigh)), contentAlignment = Alignment.Center) {
        if (state == 2) Icon(Icons.Rounded.Movie, null, tint = Z.textMuted, modifier = Modifier.size(36.dp))
        if (!image.isNullOrBlank()) AsyncImage(image, contentDescription = title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize(),
            onSuccess = { state = 1 }, onError = { state = 2 })
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
    val ext = Extras.isExt(m.streamId)
    // Every copy the playlist has of this film ("Dune", "Dune 4K"): 4K screens play the 4K one, others the regular one.
    val versions by produceState(listOf(m), m.streamId, model.catalogVersion) {
        if (!ext) value = withContext(Dispatchers.IO) { runCatching { lib.movieVersions(m.streamId) }.getOrDefault(emptyList()) }.ifEmpty { listOf(m) }
    }
    val is4k = { v: Movie -> qualityBadge(v.name) == "4K" }
    val started = model.userVersion.let { versions.firstOrNull { model.user?.progress("movie:${it.streamId}") != null } }
    val pick = started ?: if (model.platform.screen4k) versions.firstOrNull(is4k) ?: m else versions.firstOrNull { !is4k(it) } ?: m
    // Also asks the built-in sources now: the badge shows if one has it in 4K, and Play reuses what they found.
    val sources4k by produceState(false, m.streamId) {
        val search = runCatching { model.sourceSearch(model.moviePlayable(lib, m).source!!) }.getOrNull() ?: return@produceState
        search.found.collect { links -> if (links.any { it.is4k }) value = true } // the first source with 4K is enough
    }
    val has4k = versions.any(is4k) || sources4k
    val resume = model.userVersion.let { model.user?.progress("movie:${pick.streamId}") }
    val fav = model.userVersion.let { model.isFavorite(ContentKind.MOVIE, m.streamId) }
    fun play(fromStart: Boolean) {
        if (fromStart) model.user?.removeProgress("movie:${pick.streamId}")
        model.play(model.moviePlayable(lib, pick), true)
    }
    Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    DetailBackdrop(model, ContentKind.MOVIE, m.name, m.year, m.poster)
    Row(Modifier.fillMaxWidth().padding(24.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
        if (LocalWide.current) PosterImage(m.poster, m.name, m.rating, Modifier.width(260.dp))
        Column(Modifier.weight(1f).widthIn(max = 720.dp)) {
            IconAction(Icons.Rounded.ArrowBack, "Back", onClick = onBack)
            Text(m.name, style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(listOfNotNull(m.year, if (m.rating > 0) "★ %.1f".format(m.rating) else null).joinToString(" · "), color = Z.textMuted)
                if (has4k) Text("4K", Modifier.clip(RoundedCornerShape(6.dp)).background(Z.accentGradient).padding(horizontal = 8.dp, vertical = 2.dp),
                    color = Color.White, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
            }
            Spacer(Modifier.height(20.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (resume != null) {
                    PillButton(Icons.Rounded.PlayArrow, "Resume ${hms(resume.positionMs)}", true) { play(false) }
                    PillButton(Icons.Rounded.Replay, "Start over", false) { play(true) }
                } else {
                    PillButton(Icons.Rounded.PlayArrow, "Play", true) { play(false) }
                }
                if (!ext) { // favorites and movie playlists hold the playlist's own movies
                    IconAction(if (fav) Icons.Rounded.Star else Icons.Rounded.StarBorder, if (fav) "Remove favorite" else "Add favorite",
                        if (fav) Z.gold else Z.textMuted) { model.toggleFavorite(ContentKind.MOVIE, m.streamId) }
                    var picking by remember { mutableStateOf(false) }
                    IconAction(Icons.AutoMirrored.Rounded.PlaylistAdd, "Add to a playlist") { picking = true }
                    if (picking) AddToListDialog(model, m) { picking = false }
                }
            }
            MetaSection(model, ContentKind.MOVIE, m.name, m.year)
            SimilarMovies(model, m)
        }
    }
    }
}

/** Same collection first (every X-Men film), then TMDB's recommendations; only what this playlist has. */
@Composable
private fun SimilarMovies(model: AppModel, m: Movie) {
    val lib = model.library ?: return
    val similar by produceState(emptyList<Movie>(), m.streamId, model.catalogVersion) {
        value = withContext(Dispatchers.IO) {
            runCatching { model.tmdb.lookup(ContentKind.MOVIE, m.name, m.year) }.getOrNull()
                ?.let { lib.similarMovies(it.related, m.streamId) }.orEmpty()
        }
    }
    if (similar.isEmpty()) return
    Text("SIMILAR MOVIES", Modifier.padding(top = 24.dp, bottom = 10.dp), color = Z.textMuted, style = MaterialTheme.typography.labelLarge)
    ScrollRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        items(similar.size) { i ->
            val s = similar[i]
            Box(Modifier.width(150.dp)) { PosterCard(s.name, s.poster, s.rating, s.year) { model.openMovie = s } }
        }
    }
}

/** Pick which of your movie playlists this movie is in, or start a new one with it. */
@Composable
private fun AddToListDialog(model: AppModel, m: Movie, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.widthIn(max = 420.dp).clip(RoundedCornerShape(16.dp)).background(Z.surface).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Add to a playlist", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text("Movies in a playlist play back to back, in the order you add them.", color = Z.textMuted,
                style = MaterialTheme.typography.bodyMedium)
            model.movieLists().forEach { (list, ids) ->
                val inIt = m.streamId in ids
                Row(Modifier.fillMaxWidth().focusRing(RoundedCornerShape(10.dp)).clip(RoundedCornerShape(10.dp))
                    .clickable { model.toggleInList(list, m.streamId) }.padding(horizontal = 10.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (inIt) Icons.Rounded.CheckCircle else Icons.Rounded.RadioButtonUnchecked, null,
                        tint = if (inIt) Z.focus else Z.textMuted)
                    Text(list, Modifier.weight(1f).padding(start = 12.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${ids.size}", color = Z.textMuted, style = MaterialTheme.typography.labelLarge)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, Modifier.weight(1f).okOpensKeyboard(), singleLine = true, keyboardOptions = tvKeyboard(),
                    placeholder = { Text("New playlist, e.g. Transformers") })
                TextButton(onClick = { model.toggleInList(name, m.streamId); name = "" }, enabled = name.isNotBlank()) { Text("Create") }
            }
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.End)) { Text("Done") }
        }
    }
}

/**
 * Full-bleed artwork behind the title: TMDB backdrop, else a poster, fading into the page.
 * Same TMDB lookup as MetaSection (cached in the core, so no second request once loaded).
 */
@Composable
private fun DetailBackdrop(model: AppModel, kind: ContentKind, title: String, year: String?, fallback: String?, modifier: Modifier = Modifier) {
    val meta by produceState<com.ziptv.core.Meta?>(null, kind, title) {
        value = withContext(Dispatchers.IO) { runCatching { model.tmdb.lookup(kind, title, year) }.getOrNull() }
    }
    val image = meta?.backdrop ?: meta?.poster ?: fallback
    if (image.isNullOrBlank()) return
    Box(modifier.fillMaxWidth().height(if (LocalWide.current) 420.dp else 340.dp)) {
        AsyncImage(image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop,
            alignment = Alignment.TopCenter, alpha = 0.5f)
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(
            0f to Z.bg.copy(alpha = 0.55f), 0.45f to Z.bg.copy(alpha = 0.35f), 1f to Z.bg)))
    }
}

@Composable
private fun EpisodesScreen(model: AppModel, series: Series, onBack: () -> Unit) {
    val lib = model.library ?: return
    val episodes by produceState<List<Episode>?>(null, series.seriesId) {
        value = withContext(Dispatchers.IO) { runCatching { model.episodes(lib, series.seriesId, series.name, series.year) }.getOrDefault(emptyList()) }
    }
    val fav = model.userVersion.let { model.isFavorite(ContentKind.SERIES, series.seriesId) }
    var season by rememberSaveable(series.seriesId) { mutableStateOf<Int?>(null) }
    LaunchedEffect(episodes) {
        val eps = episodes ?: return@LaunchedEffect
        if (season == null) season = eps.filter { model.user?.progress("episode:${it.id}") != null }
            .maxByOrNull { model.user?.progress("episode:${it.id}")?.updatedAt ?: 0 }?.season?.toInt() ?: eps.minOfOrNull { it.season.toInt() }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
          Box {
            // Bleed past the list's 20dp padding so the artwork reaches the screen edges.
            DetailBackdrop(model, ContentKind.SERIES, series.name, series.year, series.cover,
                Modifier.layout { m, c ->
                    val e = 20.dp.roundToPx()
                    val p = m.measure(c.copy(minWidth = c.maxWidth + 2 * e, maxWidth = c.maxWidth + 2 * e))
                    layout(c.maxWidth, p.height - e) { p.place(-e, -e) }
                })
          Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconAction(Icons.Rounded.ArrowBack, "Back", onClick = onBack)
                Text(series.name, Modifier.weight(1f), style = MaterialTheme.typography.headlineMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (!Extras.isExt(series.seriesId)) IconAction(if (fav) Icons.Rounded.Star else Icons.Rounded.StarBorder,
                    if (fav) "Remove favorite" else "Add favorite", if (fav) Z.gold else Z.textMuted) { model.toggleFavorite(ContentKind.SERIES, series.seriesId) }
            }
            MetaSection(model, ContentKind.SERIES, series.name, series.year)
          }
          }
        }
        val eps = episodes
        when {
            eps == null -> items(6) { EpisodeSkeleton() }
            eps.isEmpty() -> item { Text("No episodes found", color = Z.textMuted) }
            else -> {
                val seasons = eps.groupBy { it.season.toInt() }.toSortedMap()
                // Never look up null: a TreeMap throws on it, and season is null on the first frame
                // (the LaunchedEffect above picks it after this composes) — that crashed every series.
                val current = season ?: seasons.firstKey()
                val shown = seasons[current] ?: seasons.values.first()
                item(key = "seasons") {
                    SeasonPicker(seasons.keys.toList(), current, shown.size) { season = it }
                }
                items(shown, key = { it.id }) { e -> EpisodeRow(model, series, e, Modifier.animateItem()) }
            }
        }
    }
}

/** "Season 2 ▾  ·  10 episodes": one season at a time instead of every season stacked. */
@Composable
private fun SeasonPicker(seasons: List<Int>, current: Int, count: Int, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Row(Modifier.padding(top = 16.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box {
            Row(
                Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50)).background(Z.surfaceHigh)
                    .clickable(enabled = seasons.size > 1) { open = true }.padding(start = 18.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Season $current", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                if (seasons.size > 1) Icon(Icons.Rounded.ExpandMore, null, tint = Z.textMuted, modifier = Modifier.padding(start = 6.dp).size(20.dp))
            }
            DropdownMenu(open, { open = false }, containerColor = Z.surfaceHigh, shape = RoundedCornerShape(14.dp)) {
                seasons.forEach { n ->
                    DropdownMenuItem(
                        text = { Text("Season $n", fontWeight = if (n == current) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (n == current) Z.focus else Z.text) },
                        onClick = { open = false; onPick(n) },
                        modifier = Modifier.focusRing(RoundedCornerShape(10.dp)),
                    )
                }
            }
        }
        Text("$count episodes", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(start = 14.dp))
    }
}

/** Providers repeat the show and code in every title ("Insecure - S01E03 - Racist as F**k"). Keep the episode's own name. */
private fun episodeTitle(raw: String, show: String, number: Int): String {
    var t = raw.trim()
    if (t.startsWith(show, ignoreCase = true)) t = t.substring(show.length)
    t = t.replace(Regex("""^[\s\-:|.]*S\d{1,3}\s*E\d{1,4}[\s\-:|.]*""", RegexOption.IGNORE_CASE), "").trim(' ', '-', ':', '|', '.')
    return t.ifBlank { "Episode $number" }
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
private fun EpisodeRow(model: AppModel, series: Series, e: Episode, modifier: Modifier = Modifier) {
    val lib = model.library ?: return
    val prog = model.userVersion.let { model.user?.progress("episode:${e.id}") }
    val title = episodeTitle(e.title, series.name, e.number.toInt())
    val wide = LocalWide.current
    val done = prog != null && prog.durationMs > 0 && prog.positionMs > prog.durationMs * 0.92
    Row(
        modifier.fillMaxWidth().focusRing(RoundedCornerShape(14.dp), lift = 1.01f)
            .clip(RoundedCornerShape(14.dp)).background(Z.surface)
            .clickable {
                model.play(model.episodePlayable(lib, series.name, series.seriesId, series.year, series.cover, e, title), full = true)
            }
            .padding(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 16:9 still with the watched bar along its bottom edge.
        Box(Modifier.width(if (wide) 220.dp else 132.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(10.dp)).background(Z.surfaceHigh)) {
            (e.image ?: series.cover)?.let {
                AsyncImage(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            }
            Box(Modifier.align(Alignment.Center).size(if (wide) 40.dp else 32.dp).clip(RoundedCornerShape(50))
                .background(Color.Black.copy(alpha = 0.55f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.PlayArrow, null, tint = Color.White, modifier = Modifier.size(if (wide) 24.dp else 20.dp))
            }
            if (prog != null && prog.durationMs > 0) Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color.Black.copy(alpha = 0.5f))) {
                Box(Modifier.fillMaxWidth((prog.positionMs.toFloat() / prog.durationMs).coerceIn(0.03f, 1f)).fillMaxHeight().background(Z.accentGradient))
            }
        }
        Column(Modifier.weight(1f).padding(start = 16.dp, end = 6.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val meta = listOfNotNull(
                "E${e.number}",
                e.durationSecs.toInt().takeIf { it > 0 }?.let { "${(it + 30) / 60} min" },
                when {
                    done -> "Watched"
                    prog != null && prog.durationMs > 0 -> "${((prog.durationMs - prog.positionMs) / 60_000).coerceAtLeast(1)} min left"
                    else -> null
                },
            ).joinToString("  ·  ")
            Text(meta, color = if (prog != null && !done) Z.focus else Z.textMuted, style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(top = 2.dp))
            if (e.plot.isNotBlank()) Text(e.plot, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium,
                maxLines = if (wide) 2 else 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
fun SearchScreen(model: AppModel) {
    val lib = model.library ?: return
    val query = model.searchQuery
    val results by produceState(SearchResults(emptyList(), emptyList(), emptyList()), query, model.catalogVersion) {
        delay(200) // debounce typing
        value = withContext(Dispatchers.IO) { lib.search(query, 40u).let { r -> r.copy(movies = lib.distinctMovies(r.movies), series = lib.distinctSeries(r.series)) } }
    }
    val extra by produceState(emptyList<Movie>() to emptyList<Series>(), query, model.catalogVersion) {
        value = emptyList<Movie>() to emptyList()
        if (query.trim().length < 2) return@produceState
        delay(500) // network: wait for typing to settle
        value = runCatching { Extras.search(lib, query) }.getOrDefault(emptyList<Movie>() to emptyList())
    }
    val movies = results.movies + extra.first
    val series = results.series + extra.second
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        // Wide layouts type in the header pill; compact gets the field at the top of this page.
        if (!LocalWide.current || LocalShort.current) {
            OutlinedTextField(
                query, { model.searchQuery = it }, singleLine = true, placeholder = { Text("Search live, movies & series…") },
                colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Z.focus, unfocusedBorderColor = Z.surfaceHigh),
                keyboardOptions = tvKeyboard(),
                modifier = Modifier.fillMaxWidth().okOpensKeyboard(),
            )
            Spacer(Modifier.height(16.dp))
        }
        if (query.isEmpty()) Text("Type to search channels, movies and series", color = Z.textMuted)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (results.channels.isNotEmpty()) item { Section("Channels") }
            items(results.channels, key = { "c" + it.streamId }) { ch ->
                ResultRow(ch.name, "Live", ch.logo) { model.playChannel(ch, results.channels, full = true) }
            }
            if (movies.isNotEmpty() && !model.isHiddenTab(Tab.Movies)) {
                item { Section("Movies") }
                items(movies, key = { "m" + it.streamId }) { m ->
                    ResultRow(m.name, m.year ?: "Movie", m.poster) { model.openMovie = m; model.tab = Tab.Movies }
                }
            }
            if (series.isNotEmpty() && !model.isHiddenTab(Tab.Series)) {
                item { Section("Series") }
                items(series, key = { "s" + it.seriesId }) { s ->
                    ResultRow(s.name, s.year ?: "Series", s.cover) { model.openSeries = s; model.tab = Tab.Series }
                }
            }
            if (query.length >= 2 && results.channels.isEmpty() && movies.isEmpty() && series.isEmpty()) {
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
