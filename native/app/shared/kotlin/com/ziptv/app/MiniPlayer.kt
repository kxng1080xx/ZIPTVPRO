package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material.icons.rounded.OpenInFull
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Show the mini player? Wide layouts only, whenever playback continues but no other surface shows it. */
fun miniPlayerVisible(model: AppModel, wide: Boolean): Boolean =
    model.screen == Screen.Main && !model.fullscreen && model.nowPlaying != null &&
        (model.pip || !(model.tab == Tab.Live && !model.showGuide)) // the Live page has its own preview unless PiP was asked for

/**
 * Cable-box style: the channel keeps playing in a corner window while you browse
 * (Home, Movies, the full guide…). Click the video to go back to fullscreen.
 */
@Composable
fun MiniPlayer(model: AppModel, modifier: Modifier) {
    val item = model.nowPlaying ?: return
    val phone = model.platform.device == DeviceClass.Touch // landscape phone: a small corner window, not half the screen
    Column(
        modifier.padding(if (phone) 12.dp else 20.dp).width(if (phone) 220.dp else 380.dp).shadow(24.dp, RoundedCornerShape(16.dp))
            .clip(RoundedCornerShape(16.dp)).background(Z.surface),
    ) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black).clickable { model.pip = false; model.fullscreen = true }) {
            model.player.Surface(Modifier.fillMaxSize())
            if (item.live) Box(Modifier.align(Alignment.TopStart).padding(8.dp)) { LiveBadge() }
        }
        if (phone) Row(Modifier.padding(start = 10.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(item.title, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            IconAction(Icons.Rounded.Close, "Close player", Z.textMuted) { model.stop() }
        } else Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(item.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val now = if (item.live) model.zapList.firstOrNull { it.streamId == item.streamId }?.let { rememberNow(model, it) } else null
                Text(now?.title ?: item.subtitle, color = Z.textMuted, style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (item.live) {
                IconAction(Icons.Rounded.KeyboardArrowUp, "Previous channel") { model.zap(-1) }
                IconAction(Icons.Rounded.KeyboardArrowDown, "Next channel") { model.zap(1) }
            }
            IconAction(Icons.Rounded.OpenInFull, "Fullscreen") { model.pip = false; model.fullscreen = true }
            IconAction(Icons.Rounded.Close, "Close player", Z.textMuted) { model.stop() }
        }
    }
}
