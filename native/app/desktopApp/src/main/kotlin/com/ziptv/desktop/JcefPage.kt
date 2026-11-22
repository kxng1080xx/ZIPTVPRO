package com.ziptv.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.awt.SwingPanel
import com.ziptv.app.WebControls
import com.ziptv.app.Z
import com.ziptv.core.AdBlock
import com.ziptv.core.WebTab
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.cef.CefApp
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefDisplayHandlerAdapter
import org.cef.handler.CefLifeSpanHandlerAdapter
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.handler.CefResourceRequestHandler
import org.cef.handler.CefResourceRequestHandlerAdapter
import org.cef.misc.BoolRef
import org.cef.network.CefRequest
import java.io.File

/**
 * Chromium for web tabs (JCEF). One CefApp per run, started the first time a tab opens; the bundled
 * natives unpack into the data folder once. Logins/cookies persist in jcef-cache.
 */
object Jcef {
    @Volatile private var app: CefApp? = null

    @Synchronized
    fun app(dataDir: String): CefApp = app ?: me.friwi.jcefmaven.CefAppBuilder().run {
        setInstallDir(File(dataDir, "jcef"))
        cefSettings.windowless_rendering_enabled = false
        cefSettings.cache_path = File(dataDir, "jcef-cache").absolutePath
        build()
    }.also { app = it }

    /** On exit: Chromium's processes otherwise outlive the app. */
    fun dispose() { runCatching { app?.dispose() } }
}

@Composable
fun JcefPage(dataDir: String, tab: WebTab, adblock: AdBlock?, controls: WebControls, modifier: Modifier) {
    val app by produceState<Result<CefApp>?>(null) { value = withContext(Dispatchers.IO) { runCatching { Jcef.app(dataDir) } } }
    val ready = app
    when {
        ready == null -> Box(modifier, contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Z.focus) }
        ready.isFailure -> Box(modifier, contentAlignment = Alignment.Center) {
            Text("Couldn't start the web view: ${ready.exceptionOrNull()?.message}", color = Z.textMuted)
        }
        else -> Browser(ready.getOrThrow(), tab, adblock, controls, modifier)
    }
}

@Composable
private fun Browser(app: CefApp, tab: WebTab, adblock: AdBlock?, controls: WebControls, modifier: Modifier) {
    val browser = remember(tab.id, tab.url, adblock) {
        val client = app.createClient()
        client.addDisplayHandler(object : CefDisplayHandlerAdapter() {
            override fun onTitleChange(b: CefBrowser, title: String?) { controls.title = title.orEmpty() }
            override fun onAddressChange(b: CefBrowser, f: CefFrame, url: String?) { if (f.isMain) controls.url = url.orEmpty() }
        })
        client.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(b: CefBrowser, loading: Boolean, back: Boolean, fwd: Boolean) { controls.canGoBack = back }
            override fun onLoadEnd(b: CefBrowser, f: CefFrame, status: Int) {
                if (!f.isMain) return
                val css = adblock?.hideCss(f.url).orEmpty()
                if (css.isNotEmpty()) f.executeJavaScript(
                    "(function(){var s=document.createElement('style');s.textContent=${jsString(css)};document.documentElement.appendChild(s)})()", f.url, 0)
            }
        })
        // New-window links open in this tab.
        client.addLifeSpanHandler(object : CefLifeSpanHandlerAdapter() {
            override fun onBeforePopup(b: CefBrowser, f: CefFrame, url: String?, name: String?): Boolean { url?.let { b.loadURL(it) }; return true }
        })
        if (adblock != null) client.addRequestHandler(object : CefRequestHandlerAdapter() {
            override fun getResourceRequestHandler(b: CefBrowser, f: CefFrame?, req: CefRequest, nav: Boolean, download: Boolean,
                initiator: String?, disable: BoolRef?): CefResourceRequestHandler = object : CefResourceRequestHandlerAdapter() {
                override fun onBeforeResourceLoad(b: CefBrowser, f: CefFrame?, r: CefRequest): Boolean {
                    if (r.resourceType == CefRequest.ResourceType.RT_MAIN_FRAME) return false
                    return adblock.shouldBlock(r.url, b.url ?: "", kindOf(r.resourceType)) // true cancels it
                }
            }
        })
        client.createBrowser(tab.url, false, false).also { b ->
            controls.back = { b.goBack() }
            controls.forward = { b.goForward() }
            controls.reload = { b.reload() }
        } to client
    }
    DisposableEffect(browser) { onDispose { browser.first.close(true); browser.second.dispose() } }
    SwingPanel(factory = { browser.first.uiComponent }, modifier = modifier)
}

private fun kindOf(t: CefRequest.ResourceType?) = when (t) {
    CefRequest.ResourceType.RT_SCRIPT -> "script"
    CefRequest.ResourceType.RT_STYLESHEET -> "stylesheet"
    CefRequest.ResourceType.RT_IMAGE, CefRequest.ResourceType.RT_FAVICON -> "image"
    CefRequest.ResourceType.RT_XHR -> "xmlhttprequest"
    CefRequest.ResourceType.RT_MEDIA -> "media"
    CefRequest.ResourceType.RT_FONT_RESOURCE -> "font"
    CefRequest.ResourceType.RT_SUB_FRAME -> "sub_frame"
    CefRequest.ResourceType.RT_PING -> "ping"
    else -> "other"
}

private fun jsString(s: String) = "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'"
