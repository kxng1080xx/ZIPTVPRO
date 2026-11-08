package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.PlaylistAdd
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Movie
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.ziptv.core.Movie
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** Each playlist's movies, in play order (ids the catalog no longer has are skipped). */
@Composable
private fun rememberLists(model: AppModel): List<Pair<String, List<Movie>>> {
    val lists = model.movieLists()
    val lib = model.library ?: return emptyList()
    val v by produceState(emptyList<Pair<String, List<Movie>>>(), lists, lib, model.catalogVersion) {
        value = withContext(Dispatchers.IO) {
            lists.map { (name, ids) -> name to lib.moviesByIds(ids).associateBy { it.streamId }.let { by -> ids.mapNotNull { by[it] } } }
        }
    }
    return v
}

/**
 * Top of the Movies tab: your movie playlists as poster-collage cards (open = the list, ▶ = play all).
 * With none yet, one line saying how to make one, since the button lives on a movie's page.
 */
@Composable
fun MovieListsShelf(model: AppModel) {
    val lists = rememberLists(model)
    val pad = if (LocalWide.current) 8.dp else 4.dp
    if (model.movieLists().isEmpty()) {
        Row(Modifier.padding(start = pad, end = pad, top = 8.dp, bottom = 4.dp).clip(RoundedCornerShape(12.dp)).background(Z.surface)
            .padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Rounded.PlaylistAdd, null, tint = Z.focus)
            Text("Plan a movie marathon: open any movie and tap the playlist button to add it. Playlists play back to back.",
                Modifier.padding(start = 12.dp), color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
        }
        return
    }
    Column(Modifier.padding(top = 4.dp, bottom = 10.dp)) {
        Text("Your playlists", Modifier.padding(start = pad, bottom = 10.dp), style = MaterialTheme.typography.titleLarge)
        LazyRow(contentPadding = PaddingValues(horizontal = pad), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            items(lists, key = { it.first }) { (name, movies) ->
                Column(Modifier.width(if (LocalWide.current) 300.dp else 240.dp).focusRing(RoundedCornerShape(14.dp))
                    .clip(RoundedCornerShape(14.dp)).clickable { model.openList = name }) {
                    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(14.dp)).background(Z.surfaceHigh)) {
                        Collage(movies)
                        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Z.bg.copy(alpha = 0.9f))))
                        Text("${movies.size} ${if (movies.size == 1) "movie" else "movies"}", Modifier.align(Alignment.BottomStart).padding(12.dp),
                            style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                        Box(Modifier.align(Alignment.BottomEnd).padding(10.dp).size(40.dp).focusRing(CircleShape).clip(CircleShape)
                            .background(Z.accentGradient).clickable { model.playList(name) }, contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.PlayArrow, "Play $name", tint = Color.White)
                        }
                    }
                    Text(name, Modifier.padding(top = 8.dp, start = 2.dp), style = MaterialTheme.typography.titleMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Text("All movies", Modifier.padding(start = pad, top = 20.dp), style = MaterialTheme.typography.titleLarge)
    }
}

/** Up to four posters side by side, like a box set. */
@Composable
private fun Collage(movies: List<Movie>) {
    val art = movies.mapNotNull { it.poster?.takeIf(String::isNotBlank) }.take(4)
    if (art.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Movie, null, tint = Z.textMuted) }
        return
    }
    Row(Modifier.fillMaxSize()) {
        art.forEach { AsyncImage(it, null, Modifier.weight(1f).fillMaxSize(), contentScale = ContentScale.Crop) }
    }
}

/** One playlist: play order you can change, play from any movie, remove, delete. */
@Composable
fun MovieListScreen(model: AppModel, name: String, onBack: () -> Unit) {
    val movies = rememberLists(model).firstOrNull { it.first == name }?.second ?: emptyList()
    val wide = LocalWide.current
    var sure by remember { mutableStateOf(false) }
    LaunchedEffect(sure) { if (sure) { delay(3_000); sure = false } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = if (wide) 28.dp else 14.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Column(Modifier.padding(bottom = 12.dp)) {
                IconAction(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onClick = onBack)
                Box(Modifier.fillMaxWidth().widthIn(max = 720.dp).height(if (wide) 180.dp else 130.dp).clip(RoundedCornerShape(16.dp))
                    .background(Z.surfaceHigh)) {
                    Collage(movies)
                    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Z.bg.copy(alpha = 0.92f), Z.bg.copy(alpha = 0.4f)))))
                    Column(Modifier.align(Alignment.BottomStart).padding(18.dp)) {
                        Text("PLAYLIST · ${movies.size} ${if (movies.size == 1) "MOVIE" else "MOVIES"}", color = Z.focus,
                            style = MaterialTheme.typography.labelLarge)
                        Text(name, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.ExtraBold,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Pill(Icons.Rounded.PlayArrow, "Play all", primary = true) { model.playList(name) }
                    Pill(Icons.Rounded.Delete, if (sure) "Tap again to delete" else "Delete playlist", primary = false) {
                        if (sure) model.deleteList(name) else sure = true
                    }
                }
                Text("Plays top to bottom. Each movie picks up where you left it.", Modifier.padding(top = 10.dp),
                    color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
            }
        }
        itemsIndexed(movies, key = { _, m -> m.streamId }) { i, m ->
            Row(Modifier.animateItem().fillMaxWidth().widthIn(max = 720.dp).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp))
                .background(Z.surface).clickable { model.playList(name, i) }.padding(10.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("${i + 1}", Modifier.width(28.dp), color = Z.textMuted, style = MaterialTheme.typography.titleMedium)
                Box(Modifier.width(48.dp).aspectRatio(2f / 3f).clip(RoundedCornerShape(6.dp)).background(Z.surfaceHigh)) {
                    m.poster?.let { AsyncImage(it, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                }
                Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                    Text(m.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val left = model.userVersion.let { model.user?.progress("movie:${m.streamId}") }
                        ?.let { ((it.durationMs - it.positionMs) / 60_000).coerceAtLeast(1) }
                    Text(listOfNotNull(m.year, left?.let { "$it min left" }).joinToString(" · "), color = Z.textMuted,
                        style = MaterialTheme.typography.bodyMedium)
                }
                if (i > 0) IconAction(Icons.Rounded.KeyboardArrowUp, "Move up", Z.textMuted) { model.moveInList(name, i, -1) }
                if (i < movies.lastIndex) IconAction(Icons.Rounded.KeyboardArrowDown, "Move down", Z.textMuted) { model.moveInList(name, i, 1) }
                IconAction(Icons.Rounded.Close, "Remove from playlist", Z.textMuted) { model.toggleInList(name, m.streamId) }
            }
        }
    }
}

@Composable
private fun Pill(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, primary: Boolean, onClick: () -> Unit) =
    Row(Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
        .background(if (primary) Z.accentGradient else androidx.compose.ui.graphics.SolidColor(Z.surfaceHigh))
        .clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = Color.White, modifier = Modifier.size(20.dp))
        Text(label, Modifier.padding(start = 8.dp), color = Color.White, fontWeight = FontWeight.SemiBold)
    }
