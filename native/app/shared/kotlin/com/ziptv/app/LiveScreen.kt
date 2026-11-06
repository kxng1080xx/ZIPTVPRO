package com.ziptv.app

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CalendarViewWeek
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.LiveTv
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.NotificationsActive
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
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
import coil3.request.transformations
import com.ziptv.core.Channel
import com.ziptv.core.ContentKind
import com.ziptv.core.Programme
import com.ziptv.core.Reminder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Channels for a category entry (specials included), hidden categories removed. */
fun loadChannels(model: AppModel, categoryId: String): List<Channel> {
    val lib = model.library ?: return emptyList()
    val user = model.user ?: return emptyList()
    return when (categoryId) {
        CAT_FAV -> lib.channelsByIds(user.favorites(ContentKind.LIVE))
        CAT_RECENT -> lib.channelsByIds(user.recent())
        CAT_ALL -> lib.channels(null).filter { !model.isHiddenCategory(it.categoryId) }
        else -> lib.channels(categoryId)
    }
}

@Composable
fun LiveScreen(model: AppModel) {
    if (model.showGuide) {
        model.platform.BackHandler(enabled = !model.fullscreen) { model.showGuide = false }
        GuideScreen(model)
        return
    }
    val wide = LocalWide.current
    var categoryId by rememberSaveable { mutableStateOf(CAT_ALL) }
    val categories = rememberCategories(model, ContentKind.LIVE)
    val channels by produceState(emptyList<Channel>(), model.library, model.catalogVersion, categoryId,
        if (categoryId.startsWith('\u0000')) model.userVersion else 0) {
        value = withContext(Dispatchers.IO) { loadChannels(model, categoryId) }
    }
    var selected by remember { mutableStateOf<Channel?>(null) }

    fun choose(ch: Channel) {
        val already = model.nowPlaying?.live == true && model.nowPlaying?.streamId == ch.streamId
        selected = ch
        // Wide: first press previews, second press goes fullscreen. Compact: straight to fullscreen.
        model.playChannel(ch, channels, full = !wide || already)
    }

    if (wide) {
        Row(Modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            // Narrow lists, wide player (v9 proportions).
            CategoryColumn(model, ContentKind.LIVE, categories, categoryId, Modifier.width(200.dp).fillMaxHeight()) { categoryId = it }
            Column(Modifier.width(320.dp).fillMaxHeight()) {
                GuideButton(model)
                ChannelList(model, channels, selected, Modifier.weight(1f), ::choose)
            }
            // Started elsewhere (Home, mini player)? Show the playing channel's info anyway.
            val shown = selected ?: model.nowPlaying?.takeIf { it.live }?.let { p -> model.zapList.firstOrNull { it.streamId == p.streamId } }
            PreviewPane(model, shown, Modifier.weight(1f).fillMaxHeight())
        }
    } else {
        Column(Modifier.fillMaxSize()) {
            CategoryChips(model, ContentKind.LIVE, categories, categoryId) { categoryId = it }
            ChannelList(model, channels, selected, Modifier.weight(1f), ::choose)
        }
    }
}

@Composable
private fun GuideButton(model: AppModel) {
    Row(
        Modifier.padding(start = 8.dp, bottom = 8.dp).focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
            .background(Z.surfaceHigh).clickable { model.showGuide = true }.padding(horizontal = 16.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Rounded.CalendarViewWeek, null, tint = Z.focus, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Show full guide", style = MaterialTheme.typography.labelLarge)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChannelList(model: AppModel, channels: List<Channel>, selected: Channel?, modifier: Modifier, onChoose: (Channel) -> Unit) {
    if (channels.isEmpty()) {
        Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { Text("No channels here", color = Z.textMuted) }
        return
    }
    LazyColumn(modifier, contentPadding = PaddingValues(vertical = 4.dp, horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(channels, key = { it.streamId }) { ch ->
            val now = rememberNow(model, ch)
            val fav = model.userVersion.let { model.isFavorite(ContentKind.LIVE, ch.streamId) }
            val isSel = selected?.streamId == ch.streamId
            Row(
                Modifier.fillMaxWidth()
                    .focusRing(RoundedCornerShape(14.dp), lift = 1.02f)
                    .clip(RoundedCornerShape(14.dp))
                    .background(if (isSel) Z.activeTint else SolidColor(Z.surface))
                    // Long-press = favorite (touch, remote OK-hold, mouse hold).
                    .combinedClickable(onClick = { onChoose(ch) }, onLongClick = { model.toggleFavorite(ContentKind.LIVE, ch.streamId) })
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ChannelLogo(ch.logo, Modifier.size(40.dp))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(ch.name, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelLarge,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        qualityBadge(ch.rawName)?.let { Badge(it) }
                        if (ch.archiveDays > 0u) Icon(Icons.Rounded.History, "Catch-up", tint = Z.textMuted,
                            modifier = Modifier.padding(start = 6.dp).size(14.dp))
                    }
                    Text(now?.title ?: " ", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (fav) Icon(Icons.Rounded.Star, "Favorite", tint = Z.gold, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
fun Badge(text: String) {
    Text(text, Modifier.padding(start = 8.dp).clip(RoundedCornerShape(5.dp)).background(Z.surfaceHigh)
        .padding(horizontal = 6.dp, vertical = 1.dp), color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
}

@Composable
fun ChannelLogo(url: String?, modifier: Modifier) {
    Box(modifier.clip(RoundedCornerShape(10.dp)).background(Z.surfaceHigh), contentAlignment = Alignment.Center) {
        if (url.isNullOrBlank()) Icon(Icons.Rounded.LiveTv, null, tint = Z.textMuted)
        else {
            val t = LocalLogoTransform.current
            val ctx = coil3.compose.LocalPlatformContext.current
            val req = androidx.compose.runtime.remember(url, t) {
                coil3.request.ImageRequest.Builder(ctx).data(url).apply { if (t != null) transformations(t) }.build()
            }
            AsyncImage(req, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.padding(6.dp).fillMaxSize())
        }
    }
}

@Composable
private fun PreviewPane(model: AppModel, channel: Channel?, modifier: Modifier) {
    val lib = model.library ?: return
    val guide by produceState(emptyList<Programme>(), channel?.streamId) {
        value = channel?.let { withContext(Dispatchers.IO) { lib.epg(it.streamId) } } ?: emptyList()
    }
    Column(modifier.clip(RoundedCornerShape(16.dp)).background(Z.surface)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black)) {
            // Only one surface at a time: with PiP the mini player owns the video.
            if (model.nowPlaying != null && !model.fullscreen && !model.pip) model.player.Surface(Modifier.fillMaxSize())
            else Text("Pick a channel", Modifier.align(Alignment.Center), color = Z.textMuted)
            val playing = model.nowPlaying
            // Same controls as fullscreen (v9): NOW/NEXT, Go Live, Volume, More (⋯), Fullscreen.
            if (playing != null && !model.fullscreen && !model.pip) PlayerChrome(model, playing, inFullscreen = false)
        }
        if (channel == null) return@Column
        Row(Modifier.padding(start = 18.dp, end = 8.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(channel.name, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val fav = model.userVersion.let { model.isFavorite(ContentKind.LIVE, channel.streamId) }
            IconAction(if (fav) Icons.Rounded.Star else Icons.Rounded.StarBorder, if (fav) "Remove favorite" else "Add favorite",
                if (fav) Z.gold else Z.textMuted) { model.toggleFavorite(ContentKind.LIVE, channel.streamId) }
        }
        GuideList(model, channel, guide, Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 8.dp))
    }
}

/**
 * The channel's schedule. Past shows on catch-up channels replay; upcoming
 * shows toggle a reminder; the current one plays live.
 */
@Composable
fun GuideList(model: AppModel, channel: Channel, guide: List<Programme>, modifier: Modifier) {
    val nowSec = System.currentTimeMillis() / 1000
    val archiveFrom = nowSec - channel.archiveDays.toLong() * 86_400
    val shown = guide.filter { it.end > minOf(nowSec, if (channel.archiveDays > 0u) archiveFrom else nowSec) }
        .takeLast(48).let { all -> all.dropWhile { channel.archiveDays == 0u && it.end <= nowSec } }
    Column(modifier) {
        if (shown.isEmpty()) Text("No guide information", Modifier.padding(8.dp), color = Z.textMuted)
        shown.forEach { p ->
            val isNow = p.start <= nowSec && p.end > nowSec
            val past = p.end <= nowSec
            val reminded = model.userVersion.let { model.hasReminder(channel.streamId, p.start) }
            Row(
                Modifier.fillMaxWidth().focusRing(RoundedCornerShape(10.dp), lift = 1.01f).clip(RoundedCornerShape(10.dp))
                    .background(if (isNow) Z.activeTint else SolidColor(Color.Transparent))
                    // Long-press an upcoming (or current) show = record it.
                    .combinedClickable(onLongClick = { if (!past) model.recordProgramme(channel, p.title, p.start, p.end) }) {
                        when {
                            isNow -> model.playChannel(channel, listOf(channel), full = true)
                            past -> model.playCatchup(channel, p.title, p.start, p.end)
                            reminded -> model.removeReminder(Reminder(channel.streamId, channel.name, p.title, p.start))
                            else -> model.addReminder(Reminder(channel.streamId, channel.name, p.title, p.start))
                        }
                    }
                    .padding(horizontal = 8.dp, vertical = 8.dp),
            ) {
                Text(clock(p.start), Modifier.width(76.dp), color = if (isNow) Z.focus else Z.textMuted,
                    style = MaterialTheme.typography.labelLarge)
                Column(Modifier.weight(1f)) {
                    Text(p.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        fontWeight = if (isNow) FontWeight.SemiBold else FontWeight.Normal, color = if (past) Z.textMuted else Z.text)
                    if (isNow && p.description.isNotBlank()) {
                        Text(p.description, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, maxLines = 4)
                    }
                }
                when {
                    past -> Icon(Icons.Rounded.History, "Watch from start", tint = Z.textMuted, modifier = Modifier.size(18.dp))
                    !isNow -> Icon(if (reminded) Icons.Rounded.NotificationsActive else Icons.Rounded.Notifications,
                        if (reminded) "Reminder set" else "Remind me", tint = if (reminded) Z.focus else Z.textMuted, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
fun IconAction(icon: ImageVector, label: String, tint: Color = Z.text, onClick: () -> Unit) {
    Icon(icon, label, tint = tint, modifier = Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
        .clickable(onClick = onClick).padding(10.dp))
}

private val guideLimiter = Semaphore(4)

/** "Now on" for one row; the core caches per channel, so scrolling back is free. */
@Composable
fun rememberNow(model: AppModel, ch: Channel): Programme? {
    val lib = model.library ?: return null
    val p by produceState<Programme?>(null, ch.streamId) {
        value = guideLimiter.withPermit {
            withContext(Dispatchers.IO) {
                val t = System.currentTimeMillis() / 1000
                runCatching { lib.epg(ch.streamId) }.getOrDefault(emptyList()).firstOrNull { it.start <= t && it.end > t }
            }
        }
    }
    return p
}

private val clockFmt = SimpleDateFormat("h:mm a", Locale.getDefault())
fun clock(epochSec: Long): String = clockFmt.format(Date(epochSec * 1000))
