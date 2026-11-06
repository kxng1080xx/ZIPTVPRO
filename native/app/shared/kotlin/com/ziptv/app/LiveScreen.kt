package com.ziptv.app

import androidx.compose.foundation.layout.widthIn

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
import androidx.compose.foundation.layout.height
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
import androidx.compose.material.icons.rounded.ArrowBack
import androidx.compose.animation.togetherWith
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
    // Phone panel mode; declared before the guide's early return so Back from the guide keeps it.
    // Reopened on a saved category: show its channels.
    var showChannels by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(model.liveCategory != CAT_ALL) }
    if (model.showGuide) {
        model.platform.BackHandler(enabled = !model.fullscreen) { model.showGuide = false }
        GuideScreen(model)
        return
    }
    val wide = LocalWide.current
    var categoryId by model::liveCategory // shared with the full guide
    val categories = rememberCategories(model, ContentKind.LIVE)
    val channels by produceState(emptyList<Channel>(), model.library, model.catalogVersion, categoryId,
        if (categoryId.startsWith('\u0000')) model.userVersion else 0) {
        value = withContext(Dispatchers.IO) { loadChannels(model, categoryId) }
    }
    var selected by remember { mutableStateOf<Channel?>(null) }

    fun choose(ch: Channel) {
        val already = model.nowPlaying?.live == true && model.nowPlaying?.streamId == ch.streamId
        selected = ch
        // First press plays in the page's player, pressing the playing channel again goes fullscreen.
        model.playChannel(ch, channels, full = already)
    }

    val phone = model.platform.device == DeviceClass.Touch
    if (phone) model.platform.BackHandler(enabled = showChannels && !model.fullscreen) { showChannels = false }
    if (wide && !phone) {
        Row(Modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, bottom = 16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            // Narrow lists, wide player (v9 proportions).
            CategoryColumn(model, ContentKind.LIVE, categories, categoryId, Modifier.width(200.dp).fillMaxHeight()) { categoryId = it }
            // List and preview share the rest, so a big window doesn't make the video huge.
            Column(Modifier.weight(1f).widthIn(min = 320.dp).fillMaxHeight()) {
                if (categoryId != CAT_ALL) GuideButton(model) // the guide shows one category, so pick one first
                ChannelList(model, channels, selected, Modifier.weight(1f), ::choose)
            }
            // Started elsewhere (Home, mini player)? Show the playing channel's info anyway.
            val shown = selected ?: model.nowPlaying?.takeIf { it.live }?.let { p -> model.zapList.firstOrNull { it.streamId == p.streamId } }
            PreviewPane(model, shown, Modifier.weight(1.25f).fillMaxHeight())
        }
    } else {
        // Phones: the page's player plus one panel (categories, then that category's channels):
        // below the player in portrait, beside it in landscape.
        val playingId = model.nowPlaying?.takeIf { it.live }?.streamId
        val panel = @Composable { m: Modifier ->
            LivePanel(model, categories, categoryId, channels, selected ?: channels.firstOrNull { it.streamId == playingId },
                showChannels, { showChannels = it }, { categoryId = it }, ::choose, m)
        }
        if (wide) Row(Modifier.fillMaxSize().padding(end = 8.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                InlinePlayer(model, Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)))
            }
            panel(Modifier.width(340.dp).fillMaxHeight())
        } else Column(Modifier.fillMaxSize()) {
            InlinePlayer(model, Modifier.fillMaxWidth())
            panel(Modifier.weight(1f).fillMaxWidth())
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
                ChannelLogo(ch.logo, Modifier.size(40.dp), ch.altLogo)
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

private val WIKI_THUMB = Regex("""(upload\.wikimedia\.org/.+/thumb/.+/)\d+px-""")

/** Wikimedia rejects non-standard thumbnail widths ("Use thumbnail sizes listed…"); ask for 500px. */
fun fixLogoUrl(url: String): String = WIKI_THUMB.replace(url) { it.groupValues[1] + "500px-" }

/** Channel logo; when the provider's link is dead it falls back to the iptv-org logo ([alt]). */
@Composable
fun ChannelLogo(url: String?, modifier: Modifier, alt: String? = null) {
    var failed by remember(url) { mutableStateOf(false) }
    val src = (if (failed || url.isNullOrBlank()) alt else url)?.takeIf { it.isNotBlank() }
    Box(modifier.clip(RoundedCornerShape(10.dp)).background(Z.surfaceHigh), contentAlignment = Alignment.Center) {
        if (src == null) Icon(Icons.Rounded.LiveTv, null, tint = Z.textMuted)
        else {
            val t = LocalLogoTransform.current
            val ctx = coil3.compose.LocalPlatformContext.current
            val req = remember(src, t) {
                coil3.request.ImageRequest.Builder(ctx).data(fixLogoUrl(src)).apply { if (t != null) transformations(t) }.build()
            }
            AsyncImage(req, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.padding(6.dp).fillMaxSize(),
                onError = { if (src == url && !alt.isNullOrBlank() && alt != url) failed = true })
        }
    }
}

@Composable
private fun LivePanel(
    model: AppModel, categories: List<CatEntry>, categoryId: String, channels: List<Channel>, current: Channel?,
    showChannels: Boolean, setShowChannels: (Boolean) -> Unit, pick: (String) -> Unit, choose: (Channel) -> Unit, modifier: Modifier,
) {
    androidx.compose.animation.AnimatedContent(showChannels, modifier, transitionSpec = {
        val dir = if (targetState) 1 else -1
        (androidx.compose.animation.fadeIn() + androidx.compose.animation.slideInHorizontally { dir * it / 3 }) togetherWith
            (androidx.compose.animation.fadeOut() + androidx.compose.animation.slideOutHorizontally { -dir * it / 3 })
    }, label = "livePanel") { channelsMode ->
        Column(Modifier.fillMaxSize()) {
            if (channelsMode) {
                Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconAction(Icons.Rounded.ArrowBack, "Back to categories") { setShowChannels(false) }
                    Text(categories.firstOrNull { it.id == categoryId }?.name ?: "Channels", Modifier.weight(1f),
                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (categoryId != CAT_ALL) IconAction(Icons.Rounded.CalendarViewWeek, "Full guide") { model.showGuide = true }
                }
                ChannelList(model, channels, current, Modifier.weight(1f).padding(horizontal = 6.dp), choose)
            } else {
                Text("Categories", Modifier.padding(start = 16.dp, top = 12.dp, bottom = 6.dp),
                    style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                CategoryColumn(model, ContentKind.LIVE, categories, categoryId, Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp)) {
                    pick(it); setShowChannels(true)
                }
            }
        }
    }
}

/** The page's own player (phone Live): video + the same controls as the preview pane. */
@Composable
private fun InlinePlayer(model: AppModel, modifier: Modifier) {
    Box(modifier.aspectRatio(16f / 9f).background(Color.Black)) {
        val playing = model.nowPlaying
        if (playing != null && !model.fullscreen && !model.pip) {
            model.player.Surface(Modifier.fillMaxSize())
            PlayerChrome(model, playing, inFullscreen = false)
        } else if (playing == null) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Rounded.LiveTv, null, tint = Z.textMuted, modifier = Modifier.size(36.dp))
                Spacer(Modifier.height(6.dp))
                Text("Pick a channel to watch", color = Z.textMuted, style = MaterialTheme.typography.bodyMedium)
            }
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
 * The channel's schedule as a timeline: the current show as a card with a
 * progress bar; then upcoming shows on a rail with start time and length.
 * Past shows on catch-up channels replay; upcoming ones toggle a reminder
 * (long-press = record); the current one plays live.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun GuideList(model: AppModel, channel: Channel, guide: List<Programme>, modifier: Modifier) {
    val nowSec = System.currentTimeMillis() / 1000
    val archiveFrom = nowSec - channel.archiveDays.toLong() * 86_400
    // Start at the show on now (plus one earlier show on catch-up channels); a whole
    // morning of past shows on top made the guide look wrong. Older catch-up: full guide.
    val nowIdx = guide.indexOfFirst { it.end > nowSec }.let { if (it < 0) guide.size else it }
    val from = if (channel.archiveDays > 0u) (nowIdx - 1).coerceAtLeast(0) else nowIdx
    val shown = guide.drop(from).filter { it.end > archiveFrom }.take(40)
    val dayFmt = SimpleDateFormat("EEEE, MMM d", Locale.getDefault())
    Column(modifier) {
        if (shown.isEmpty()) Text("No guide information", Modifier.padding(8.dp), color = Z.textMuted)
        var lastDay = dayFmt.format(Date(nowSec * 1000))
        shown.forEach { p ->
            val isNow = p.start <= nowSec && p.end > nowSec
            val past = p.end <= nowSec
            val day = dayFmt.format(Date(p.start * 1000))
            if (day != lastDay) {
                lastDay = day
                Text(day.uppercase(), Modifier.padding(start = 70.dp, top = 12.dp, bottom = 4.dp), color = Z.textMuted,
                    style = MaterialTheme.typography.labelMedium)
            }
            val reminded = model.userVersion.let { model.hasReminder(channel.streamId, p.start) }
            val onClick = {
                when {
                    isNow -> model.playChannel(channel, listOf(channel), full = true)
                    past -> model.playCatchup(channel, p.title, p.start, p.end)
                    reminded -> model.removeReminder(Reminder(channel.streamId, channel.name, p.title, p.start))
                    else -> model.addReminder(Reminder(channel.streamId, channel.name, p.title, p.start))
                }
            }
            val click = Modifier.focusRing(RoundedCornerShape(12.dp), lift = 1.01f).clip(RoundedCornerShape(12.dp))
                .combinedClickable(onLongClick = { if (!past) model.recordProgramme(channel, p.title, p.start, p.end) }, onClick = onClick)
            if (isNow) NowCard(p, nowSec, click) else TimelineRow(p, past, reminded, click)
        }
    }
}

@Composable
private fun NowCard(p: Programme, nowSec: Long, modifier: Modifier) {
    val frac = ((nowSec - p.start).toFloat() / (p.end - p.start).coerceAtLeast(1)).coerceIn(0f, 1f)
    Column(modifier.fillMaxWidth().background(Z.activeTint).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("NOW", color = Color.White, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold,
                modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(Z.accentGradient).padding(horizontal = 8.dp, vertical = 2.dp))
            Spacer(Modifier.width(10.dp))
            Text("${clock(p.start)} – ${clock(p.end)}", color = Z.focus, style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.weight(1f))
            Text("${((p.end - nowSec) / 60).coerceAtLeast(1)} min left", color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
        }
        Spacer(Modifier.height(8.dp))
        Text(p.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (p.description.isNotBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(p.description, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(10.dp))
        Box(Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)).background(Z.surfaceHigh)) {
            Box(Modifier.fillMaxWidth(frac).fillMaxHeight().background(Z.accentGradient))
        }
    }
}

@Composable
private fun TimelineRow(p: Programme, past: Boolean, reminded: Boolean, modifier: Modifier) {
    Row(modifier.fillMaxWidth().height(androidx.compose.foundation.layout.IntrinsicSize.Min).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(clock(p.start), Modifier.width(58.dp), color = Z.textMuted, style = MaterialTheme.typography.labelLarge)
        // The rail: a thin line with a dot per show.
        Box(Modifier.width(16.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(Z.surfaceHigh))
            Box(Modifier.size(8.dp).clip(RoundedCornerShape(50)).background(if (reminded) Z.focus else Z.textMuted.copy(alpha = 0.6f)))
        }
        Column(Modifier.weight(1f).padding(horizontal = 10.dp, vertical = 10.dp)) {
            Text(p.title, color = if (past) Z.textMuted else Z.text, style = MaterialTheme.typography.bodyLarge,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${((p.end - p.start) / 60).coerceAtLeast(1)} min" + if (past) " · watch from start" else "",
                color = Z.textMuted, style = MaterialTheme.typography.labelMedium)
        }
        when {
            past -> Icon(Icons.Rounded.History, "Watch from start", tint = Z.textMuted, modifier = Modifier.size(18.dp))
            else -> Icon(if (reminded) Icons.Rounded.NotificationsActive else Icons.Rounded.Notifications,
                if (reminded) "Reminder set" else "Remind me", tint = if (reminded) Z.focus else Z.textMuted.copy(alpha = 0.6f),
                modifier = Modifier.size(18.dp))
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
