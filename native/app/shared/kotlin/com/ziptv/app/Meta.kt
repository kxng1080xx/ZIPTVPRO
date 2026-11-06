package com.ziptv.app

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.SmartDisplay
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.ziptv.core.ContentKind
import com.ziptv.core.Meta
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** v9's "About" panel: plot, facts, cast and a trailer, from TMDB. Silent when TMDB has nothing. */
@Composable
fun MetaSection(model: AppModel, kind: ContentKind, title: String, year: String?) {
    val result by produceState<Pair<Boolean, Meta?>>(false to null, kind, title) { // (loaded, meta)
        value = true to withContext(Dispatchers.IO) { runCatching { model.tmdb.lookup(kind, title, year) }.getOrNull() }
    }
    if (!result.first) { MetaSkeleton(); return }
    val m = result.second ?: return
    Column(Modifier.padding(top = 20.dp)) {
        if (m.overview.isNotBlank()) {
            Label("PLOT SUMMARY")
            Text(m.overview, color = Z.text, style = MaterialTheme.typography.bodyLarge)
        }
        Spacer(Modifier.height(16.dp))
        Label("ABOUT")
        Fact("Genre", m.genres.joinToString(", "))
        Fact(if (kind == ContentKind.SERIES) "Created by" else "Director",
            (if (kind == ContentKind.SERIES) m.createdBy else m.director).joinToString(", "))
        Fact("Network", m.networks.joinToString(", "))
        Fact("Status", m.status)
        if (m.seasons > 0u) Fact("Seasons", "${m.seasons} seasons · ${m.episodes} episodes")
        if (m.runtime > 0u) Fact("Runtime", "${m.runtime} min")
        Fact("Released", m.releaseDate)
        if (m.rating > 0f) Fact("TMDB rating", "★ %.1f".format(m.rating))
        m.trailerKey?.let { key ->
            Row(
                Modifier.padding(top = 14.dp).focusRing(RoundedCornerShape(12.dp)).clip(RoundedCornerShape(12.dp))
                    .background(Z.surfaceHigh)
                    .clickable { if (!model.platform.openUrl("https://www.youtube.com/watch?v=$key")) model.error = "Couldn't open the trailer" }
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Rounded.SmartDisplay, null, tint = Z.live)
                Spacer(Modifier.width(8.dp))
                Text("Watch trailer", fontWeight = FontWeight.SemiBold)
            }
        }
        if (m.cast.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            Label("CAST")
            LazyRow(contentPadding = PaddingValues(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(m.cast) { c ->
                    Column(Modifier.width(84.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(64.dp).clip(CircleShape).background(Z.surfaceHigh), contentAlignment = Alignment.Center) {
                            Icon(Icons.Rounded.Person, null, tint = Z.textMuted)
                            c.profile?.let { AsyncImage(it, c.name, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                        }
                        Text(c.name, style = MaterialTheme.typography.labelMedium, textAlign = TextAlign.Center, maxLines = 2,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
                        Text(c.character, color = Z.textMuted, style = MaterialTheme.typography.labelMedium, maxLines = 1,
                            overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}

@Composable
private fun Label(text: String) =
    Text(text, color = Z.textMuted, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(bottom = 6.dp))

@Composable
private fun Fact(name: String, value: String) {
    if (value.isBlank()) return
    Row(Modifier.padding(vertical = 3.dp)) {
        Text(name, Modifier.width(120.dp), color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/** Placeholder lines + cast circles while TMDB loads. */
@Composable
private fun MetaSkeleton() {
    val shine = shimmerBrush()
    Column(Modifier.padding(top = 20.dp)) {
        listOf(0.9f, 0.95f, 0.7f).forEach { w ->
            Box(Modifier.padding(bottom = 8.dp).fillMaxWidth(w).height(12.dp).clip(RoundedCornerShape(6.dp)).background(shine))
        }
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            repeat(4) { Box(Modifier.size(72.dp).clip(RoundedCornerShape(50)).background(shine)) }
        }
    }
}
