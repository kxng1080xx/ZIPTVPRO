package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ChevronLeft
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.ziptv.core.Channel
import com.ziptv.core.ContentKind
import com.ziptv.core.Programme
import com.ziptv.core.Reminder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val WINDOW = 3 * 3600L

/**
 * Full guide: channels down, a 3-hour window across, paged an hour at a time.
 * Paging (not free scrolling) keeps it predictable with a remote.
 */
@Composable
fun GuideScreen(model: AppModel) {
    val categoryId = model.liveCategory // the category you were browsing; change it on the Live page
    val channels by produceState(emptyList<Channel>(), model.library, model.catalogVersion, categoryId) {
        value = withContext(Dispatchers.IO) { loadChannels(model, categoryId) }
    }
    val nowSec = System.currentTimeMillis() / 1000
    var from by remember { mutableLongStateOf(nowSec - nowSec % 1800 - 1800) }
    val to = from + WINDOW

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconAction(Icons.Rounded.ArrowBack, "Back to channels") { model.showGuide = false }
            Text("TV guide", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            IconAction(Icons.Rounded.ChevronLeft, "Earlier") { from -= 3600 }
            Text(clock(from) + " – " + clock(to), color = Z.textMuted, style = MaterialTheme.typography.labelLarge)
            IconAction(Icons.Rounded.ChevronRight, "Later") { from += 3600 }
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val labelW = if (LocalWide.current) 200.dp else 120.dp
            val gridW = maxWidth - labelW
            LazyColumn(contentPadding = PaddingValues(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(channels, key = { it.streamId }) { ch ->
                    GuideRow(model, ch, from, to, labelW, gridW)
                }
            }
        }
    }
}

@Composable
private fun GuideRow(model: AppModel, ch: Channel, from: Long, to: Long, labelW: androidx.compose.ui.unit.Dp, gridW: androidx.compose.ui.unit.Dp) {
    val lib = model.library ?: return
    val guide by produceState(emptyList<Programme>(), ch.streamId) {
        value = withContext(Dispatchers.IO) { runCatching { lib.epg(ch.streamId) }.getOrDefault(emptyList()) }
    }
    val nowSec = System.currentTimeMillis() / 1000
    Row(Modifier.height(64.dp)) {
        Row(
            Modifier.width(labelW).fillMaxHeight().focusRing(RoundedCornerShape(10.dp), lift = 1.01f).clip(RoundedCornerShape(10.dp))
                .background(Z.surface).clickable { model.playChannel(ch, listOf(ch), full = true) }.padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ChannelLogo(ch.logo, Modifier.size(44.dp), ch.altLogo)
            Spacer(Modifier.width(8.dp))
            Text(ch.name, style = MaterialTheme.typography.labelLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.width(gridW).fillMaxHeight().padding(start = 6.dp)) {
            val inWindow = guide.filter { it.end > from && it.start < to }
            if (inWindow.isEmpty()) {
                Box(Modifier.fillMaxSize().clip(RoundedCornerShape(10.dp)).background(Z.surface), contentAlignment = Alignment.CenterStart) {
                    Text("No guide information", Modifier.padding(horizontal = 12.dp), color = Z.textMuted)
                }
            }
            inWindow.forEach { p ->
                val s = maxOf(p.start, from); val e = minOf(p.end, to)
                val x = gridW * ((s - from).toFloat() / WINDOW)
                val w = gridW * ((e - s).toFloat() / WINDOW)
                val isNow = p.start <= nowSec && p.end > nowSec
                val past = p.end <= nowSec
                Box(
                    Modifier.offset(x = x).width(w - 4.dp).fillMaxHeight()
                        .focusRing(RoundedCornerShape(10.dp), lift = 1.02f).clip(RoundedCornerShape(10.dp))
                        .background(if (isNow) Z.activeTint else SolidColor(Z.surface))
                        .clickable {
                            when {
                                isNow -> model.playChannel(ch, listOf(ch), full = true)
                                past && ch.archiveDays > 0u -> model.playCatchup(ch, p.title, p.start, p.end)
                                !past -> model.addReminder(Reminder(ch.streamId, ch.name, p.title, p.start))
                            }
                        }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                ) {
                    Column {
                        Text(p.title, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (past) Z.textMuted else Z.text)
                        Text(clock(p.start), color = if (isNow) Z.focus else Z.textMuted, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}
