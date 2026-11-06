package com.ziptv.app

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ziptv.core.ContentKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

const val CAT_ALL = "\u0000all"
const val CAT_FAV = "\u0000fav"
const val CAT_RECENT = "\u0000recent"

data class CatEntry(val id: String, val name: String, val count: UInt?, val pinned: Boolean = false, val icon: ImageVector? = null)

/** Category list for a tab: specials, pinned first, then sorted; admin-hidden removed. */
@Composable
fun rememberCategories(model: AppModel, kind: ContentKind): List<CatEntry> {
    val lib = model.library ?: return emptyList()
    val user = model.user ?: return emptyList()
    val list by produceState(emptyList<CatEntry>(), lib, user, kind, model.catalogVersion, model.userVersion, model.active) {
        value = withContext(Dispatchers.IO) {
            val pinned = user.pinned(kind).toSet()
            val sortAz = user.setting("cat_sort") == "az"
            val cats = lib.categories(kind).filter { !model.isHiddenCategory(it.id) }
                .map { CatEntry(it.id, it.name, it.count, it.id in pinned) }
                .let { if (sortAz) it.sortedBy { c -> c.name.lowercase() } else it }
            val specials = buildList {
                add(CatEntry(CAT_ALL, if (kind == ContentKind.LIVE) "All channels" else "All", null))
                add(CatEntry(CAT_FAV, "Favorites", user.favorites(kind).size.toUInt(), icon = Icons.Rounded.Star))
                if (kind == ContentKind.LIVE) add(CatEntry(CAT_RECENT, "Recently watched", user.recent().size.toUInt(), icon = Icons.Rounded.History))
            }
            specials + cats.filter { it.pinned } + cats.filterNot { it.pinned }
        }
    }
    return list
}

@Composable
fun CategoryColumn(model: AppModel, kind: ContentKind, entries: List<CatEntry>, selectedId: String, modifier: Modifier, onSelect: (String) -> Unit) {
    LazyColumn(modifier.clip(RoundedCornerShape(16.dp)).background(Z.surface), contentPadding = PaddingValues(8.dp)) {
        items(entries, key = { it.id }) { c ->
            androidx.compose.foundation.layout.Box(Modifier.animateItem()) { // pinning slides the row to the top
                CategoryRow(c, selectedId == c.id, onClick = { onSelect(c.id) },
                    onLongClick = { if (!c.id.startsWith('\u0000')) model.togglePin(kind, c.id) })
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CategoryRow(c: CatEntry, selected: Boolean, onClick: () -> Unit, onLongClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp)
            .focusRing(RoundedCornerShape(10.dp), lift = 1.02f)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) Z.activeTint else androidx.compose.ui.graphics.SolidColor(Color.Transparent))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val icon = c.icon ?: if (c.pinned) Icons.Rounded.PushPin else null
        if (icon != null) {
            Icon(icon, null, tint = if (c.icon == Icons.Rounded.Star) Z.gold else Z.focus, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(c.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (selected) Z.text else Z.textMuted, style = MaterialTheme.typography.labelLarge)
        c.count?.let { Text(it.toString(), color = if (selected) Color(0xFF9FC0FF) else Z.textMuted, style = MaterialTheme.typography.labelMedium) }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CategoryChips(model: AppModel, kind: ContentKind, entries: List<CatEntry>, selectedId: String, onSelect: (String) -> Unit) {
    LazyRow(contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(entries, key = { it.id }) { c ->
            val sel = c.id == selectedId
            Text(
                c.name, maxLines = 1, // pinned ones are already first
                color = if (sel) Color.White else Z.textMuted,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.animateItem().focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
                    .background(if (sel) Z.accentGradient else androidx.compose.ui.graphics.SolidColor(Z.surfaceHigh))
                    .combinedClickable(onClick = { onSelect(c.id) },
                        onLongClick = { if (!c.id.startsWith('\u0000')) model.togglePin(kind, c.id) })
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}
