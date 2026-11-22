package com.ziptv.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import com.ziptv.core.WebTab

/** What the toolbar needs from the platform's page. The platform sets the actions and keeps the state current. */
class WebControls(nav: String) {
    var back: () -> Unit = {}
    var forward: () -> Unit = {}
    var reload: () -> Unit = {}
    var canGoBack by mutableStateOf(false)
    var title by mutableStateOf("")
    var url by mutableStateOf("")
    /** TV remote: "cursor" or "focus"; the remote's Menu key flips it. */
    var nav by mutableStateOf(nav)
}

fun faviconUrl(url: String): String? =
    runCatching { java.net.URI(url).host }.getOrNull()?.let { "https://www.google.com/s2/favicons?domain=$it&sz=64" }

@Composable
fun WebTabIcon(tab: WebTab, modifier: Modifier = Modifier.size(24.dp)) {
    var failed by remember(tab.url) { mutableStateOf(false) }
    val src = faviconUrl(tab.url)
    if (src == null || failed) Icon(Icons.Rounded.Language, null, modifier, tint = Z.textMuted)
    else AsyncImage(src, null, modifier.clip(RoundedCornerShape(6.dp)), onError = { failed = true })
}

@Composable
fun WebScreen(model: AppModel) {
    val tab = model.webTab ?: return
    // One page per tab; switching tabs starts that site fresh.
    val controls = remember(tab.id, tab.url) { WebControls(tab.nav) }
    model.platform.BackHandler(enabled = controls.canGoBack && !model.fullscreen) { controls.back() }
    Column(Modifier.fillMaxSize()) {
        // TV: the remote drives the page itself (Back = page back, Menu = cursor/focus).
        if (model.platform.device != DeviceClass.Tv) Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ToolButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", controls.back)
            ToolButton(Icons.AutoMirrored.Rounded.ArrowForward, "Forward", controls.forward)
            ToolButton(Icons.Rounded.Refresh, "Reload", controls.reload)
            WebTabIcon(tab, Modifier.padding(start = 8.dp, end = 10.dp).size(20.dp))
            Text(controls.title.ifBlank { tab.name }, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            ToolButton(Icons.AutoMirrored.Rounded.OpenInNew, "Open in browser") {
                model.platform.openUrl(controls.url.ifBlank { tab.url })
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            model.platform.WebPage(tab, model.adblock, model.adblockOn, controls, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun ToolButton(icon: ImageVector, label: String, onClick: () -> Unit) =
    Icon(icon, label, Modifier.focusRing(RoundedCornerShape(50)).clip(RoundedCornerShape(50))
        .clickable(onClick = onClick).background(androidx.compose.ui.graphics.Color.Transparent).padding(8.dp), tint = Z.text)
