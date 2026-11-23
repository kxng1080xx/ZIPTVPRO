package com.ziptv.desktop

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.awt.SwingPanel
import com.sun.jna.Callback
import com.sun.jna.Library
import com.sun.jna.Native
import com.sun.jna.NativeLibrary
import com.sun.jna.ptr.PointerByReference
import com.ziptv.app.WebControls
import com.ziptv.app.Z
import com.ziptv.core.AdBlock
import com.ziptv.core.WebTab
import java.io.File

/**
 * PC web tabs on Edge WebView2 (part of Windows), through the small webview C library
 * (github.com/webview/webview, DLLs in resources/webview2). Plain Chromium (JCEF, 10.4.0) can't play
 * H.264/AAC, so streaming sites never found a playable source. Ads: all traffic goes through the core's
 * filtering proxy, since WebView2 can't be hooked per request from here.
 */
private interface WebviewLib : Library {
    fun webview_create(debug: Boolean, window: PointerByReference?): Long
    fun webview_navigate(w: Long, url: String)
    fun webview_set_size(w: Long, width: Int, height: Int, hints: Int)
    fun webview_run(w: Long)
    fun webview_destroy(w: Long)
    fun webview_terminate(w: Long)
    fun webview_eval(w: Long, js: String)
    fun webview_init(w: Long, js: String)
    fun webview_bind(w: Long, name: String, cb: BindCb, arg: Long)
    fun webview_return(w: Long, seq: Long, status: Boolean, result: String)
    fun webview_dispatch(w: Long, cb: DispatchCb, arg: Long)

    fun interface BindCb : Callback { fun callback(seq: Long, req: String, arg: Long) }
    fun interface DispatchCb : Callback { fun callback(w: Long, arg: Long) }
}

private interface Kernel32 : Library {
    fun SetEnvironmentVariableW(name: com.sun.jna.WString, value: com.sun.jna.WString): Boolean
}

private object WebView2 {
    private var lib: WebviewLib? = null

    /** Unpacks the DLLs, points WebView2 at our profile folder and ad-block proxy. Once per run. */
    @Synchronized
    fun lib(dataDir: String, adblock: AdBlock): WebviewLib = lib ?: run {
        jsonArgsSelfCheck()
        val dir = File(dataDir, "webview2").apply { mkdirs() }
        for (name in listOf("WebView2Loader.dll", "webview.dll")) {
            val out = File(dir, name)
            val res = WebView2::class.java.getResourceAsStream("/webview2/$name") ?: error("$name missing")
            res.use { r -> if (!out.exists() || out.length() != r.available().toLong()) out.outputStream().use { r.copyTo(it) } }
        }
        val port = adblock.startProxy().toInt()
        val k32 = Native.load("kernel32", Kernel32::class.java)
        // Read by WebView2 when its environment starts: logins/cookies kept here; traffic via the proxy.
        k32.SetEnvironmentVariableW(com.sun.jna.WString("WEBVIEW2_USER_DATA_FOLDER"), com.sun.jna.WString(File(dataDir, "webview2-profile").path))
        if (port > 0) k32.SetEnvironmentVariableW(com.sun.jna.WString("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"),
            com.sun.jna.WString("--proxy-server=http://127.0.0.1:$port --proxy-bypass-list=<-loopback>"))
        NativeLibrary.getInstance(File(dir, "WebView2Loader.dll").path) // so webview.dll finds it by name
        Native.load(File(dir, "webview.dll").path, WebviewLib::class.java).also { lib = it }
    }
}

/** Reports title/address/history to the toolbar, keeps new-window links in the tab, applies ad-slot CSS. */
private const val INIT_JS = """
(function(){
  window.open = function(u){ if (u) location.href = u; return null; };
  function rep(){ try { window.__zipState(document.title, location.href, history.length); } catch (e) {} }
  addEventListener('DOMContentLoaded', function(){
    rep();
    var t = document.querySelector('title');
    if (t) new MutationObserver(rep).observe(t, { childList: true, characterData: true, subtree: true });
    window.__zipCss(location.href).then(function(c){
      if (c) { var s = document.createElement('style'); s.textContent = c; document.documentElement.appendChild(s); }
    });
  });
  addEventListener('popstate', rep); addEventListener('hashchange', rep);
  document.addEventListener('fullscreenchange', function(){ try { window.__zipFull(document.fullscreenElement ? 1 : 0); } catch (e) {} });
})();
"""

private class WebViewCanvas(
    private val dataDir: String, private val tab: WebTab, private val adblock: AdBlock,
    private val controls: WebControls, private val onError: (String) -> Unit,
) : java.awt.Canvas() {
    @Volatile private var w = 0L
    private var lib: WebviewLib? = null
    private var started = false
    // JNA callbacks must stay referenced or they get collected while native code still calls them.
    private val stateCb = WebviewLib.BindCb { seq, req, _ ->
        val a = jsonArgs(req)
        controls.title = a.getOrNull(0).orEmpty()
        controls.url = a.getOrNull(1).orEmpty()
        controls.canGoBack = (a.getOrNull(2)?.toDoubleOrNull() ?: 1.0) > 1
        lib?.webview_return(w, seq, false, "null")
    }
    private val cssCb = WebviewLib.BindCb { seq, req, _ ->
        lib?.webview_return(w, seq, false, jsonString(adblock.hideCss(jsonArgs(req).getOrNull(0).orEmpty())))
    }
    private val fullCb = WebviewLib.BindCb { seq, req, _ ->
        controls.fullscreen = jsonArgs(req).getOrNull(0) == "1"
        lib?.webview_return(w, seq, false, "null")
    }
    private val pending = java.util.concurrent.ConcurrentLinkedQueue<(WebviewLib, Long) -> Unit>()
    private val drain = WebviewLib.DispatchCb { _, _ -> lib?.let { l -> while (true) { val f = pending.poll() ?: break; f(l, w) } } }

    /** Runs [f] on the webview's own thread (the C library is single-threaded). */
    fun post(f: (WebviewLib, Long) -> Unit) {
        pending.add(f)
        val l = lib ?: return
        if (w != 0L) l.webview_dispatch(w, drain, 0)
    }

    init {
        background = java.awt.Color.BLACK
        addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) = resizeToCanvas()
        })
    }

    private fun resizeToCanvas() {
        val s = java.awt.Toolkit.getDefaultToolkit().screenResolution / 96.0 // AWT sizes are in DIPs
        val (cw, ch) = (width * s).toInt() to (height * s).toInt()
        if (cw > 0 && ch > 0) post { l, h -> l.webview_set_size(h, cw, ch, 3 /* fixed */) }
    }

    override fun paint(g: java.awt.Graphics) {
        if (started) return
        started = true
        val hwnd = Native.getComponentPointer(this)
        Thread({
            try {
                val l = WebView2.lib(dataDir, adblock)
                val h = l.webview_create(false, PointerByReference(hwnd))
                if (h == 0L) { onError("Microsoft Edge WebView2 isn't installed on this PC"); return@Thread }
                lib = l; w = h
                l.webview_bind(h, "__zipState", stateCb, 0)
                l.webview_bind(h, "__zipCss", cssCb, 0)
                l.webview_bind(h, "__zipFull", fullCb, 0)
                l.webview_init(h, INIT_JS)
                l.webview_navigate(h, tab.url)
                resizeToCanvas()
                drain.callback(h, 0)
                l.webview_run(h)
                l.webview_destroy(h)
            } catch (e: Throwable) {
                onError("Couldn't open the page: ${e.message}")
            }
        }, "webview-${tab.id}").apply { isDaemon = true }.start()
    }

    fun close() = post { l, h -> l.webview_terminate(h) }
}

@Composable
fun WebView2Page(dataDir: String, tab: WebTab, adblock: AdBlock, blockAds: Boolean, controls: WebControls, modifier: Modifier) {
    var error by remember(tab.id) { mutableStateOf<String?>(null) }
    adblock.setEnabled(blockAds)
    val canvas = remember(tab.id, tab.url) {
        adblock.setAllowedHosts(listOfNotNull(runCatching { java.net.URI(tab.url).host }.getOrNull()))
        WebViewCanvas(dataDir, tab, adblock, controls) { error = it }.also { c ->
            controls.back = { c.post { l, h -> l.webview_eval(h, "history.back()") } }
            controls.forward = { c.post { l, h -> l.webview_eval(h, "history.forward()") } }
            controls.reload = { c.post { l, h -> l.webview_eval(h, "location.reload()") } }
            controls.exitFullscreen = { c.post { l, h -> l.webview_eval(h, "document.exitFullscreen && document.exitFullscreen()") } }
        }
    }
    DisposableEffect(canvas) { onDispose { canvas.close() } }
    val e = error
    if (e != null) Box(modifier, contentAlignment = Alignment.Center) { Text(e, color = Z.textMuted) }
    else SwingPanel(factory = { canvas }, modifier = modifier)
}

/** The bound functions' arguments: a flat JSON array of strings and numbers. */
private fun jsonArgs(json: String): List<String> {
    val out = mutableListOf<String>()
    var i = json.indexOf('[') + 1
    while (i in 1 until json.length) {
        val c = json[i]
        when {
            c == '"' -> {
                val sb = StringBuilder(); i++
                while (i < json.length && json[i] != '"') {
                    if (json[i] == '\\' && i + 1 < json.length) {
                        i++
                        when (val e = json[i]) {
                            'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r')
                            'u' -> { sb.append(json.substring(i + 1, minOf(i + 5, json.length)).toIntOrNull(16)?.toChar() ?: '?'); i += 4 }
                            else -> sb.append(e)
                        }
                    } else sb.append(json[i])
                    i++
                }
                out += sb.toString(); i++
            }
            c == '-' || c.isDigit() -> { val st = i; while (i < json.length && json[i] !in ",]") i++; out += json.substring(st, i).trim() }
            c == 'n' && json.startsWith("null", i) -> { out += ""; i += 4 }
            else -> i++
        }
    }
    return out
}

private fun jsonString(s: String): String = buildString {
    append('"')
    for (c in s) when {
        c == '"' -> append("\\\"")
        c == '\\' -> append("\\\\")
        c < ' ' -> append("\\u%04x".format(c.code))
        else -> append(c)
    }
    append('"')
}

internal fun jsonArgsSelfCheck() {
    check(jsonArgs("""["A \"b\"\nc","https://x.test/?q=1",3]""") == listOf("A \"b\"\nc", "https://x.test/?q=1", "3"))
    check(jsonString("a\"b\\c\n") == "\"a\\\"b\\\\c\\u000a\"")
}
