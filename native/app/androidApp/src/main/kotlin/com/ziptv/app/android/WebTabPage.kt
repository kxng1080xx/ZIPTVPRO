package com.ziptv.app.android

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.viewinterop.AndroidView
import com.ziptv.app.WebControls
import com.ziptv.core.AdBlock
import com.ziptv.core.WebTab

/** A web tab: WebView + ad blocker. On TV the remote drives it with a cursor or by jumping between links. */
@Composable
fun WebTabPage(tab: WebTab, adblock: AdBlock?, controls: WebControls, tv: Boolean, modifier: Modifier) {
    var cursor by remember { mutableStateOf<Offset?>(null) }
    Box(modifier) {
        AndroidView(
            factory = { ctx ->
                TvWebView(ctx, tv, controls, adblock) { cursor = it }.apply {
                    loadUrl(tab.url)
                    if (tv) post { requestFocus() }
                }
            },
            modifier = Modifier.fillMaxSize(),
            onRelease = { it.destroy() },
        )
        val at = cursor
        if (tv && controls.nav == "cursor" && at != null) Canvas(Modifier.fillMaxSize()) {
            drawCircle(Color.Black.copy(alpha = 0.35f), 16f, at)
            drawCircle(Color.White, 12f, at)
            drawCircle(Color(0xFF38BDF8), 12f, at, style = Stroke(4f))
        }
    }
}

@SuppressLint("SetJavaScriptEnabled", "ViewConstructor")
private class TvWebView(
    ctx: Context,
    private val tv: Boolean,
    private val controls: WebControls,
    private val adblock: AdBlock?,
    private val onCursor: (Offset?) -> Unit,
) : WebView(ctx) {
    @Volatile private var pageUrl = ""
    private var cx = -1f
    private var cy = -1f

    init {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.setSupportMultipleWindows(false) // links that open a new window open here
        controls.back = { if (canGoBack()) goBack() }
        controls.forward = { if (canGoForward()) goForward() }
        controls.reload = { reload() }
        webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) { controls.title = title.orEmpty() }
        }
        webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { pageUrl = url }

            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val a = adblock ?: return null
                if (req.isForMainFrame) return null
                val url = req.url.toString()
                return if (a.shouldBlock(url, pageUrl, kindOf(url))) WebResourceResponse("text/plain", "utf-8", "".byteInputStream()) else null
            }

            override fun onPageFinished(view: WebView, url: String) {
                adblock?.hideCss(url)?.takeIf { it.isNotEmpty() }?.let { css ->
                    evaluateJavascript("(function(){var s=document.createElement('style');s.textContent=${jsString(css)};document.documentElement.appendChild(s)})()", null)
                }
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                controls.url = url
                controls.canGoBack = canGoBack()
            }
        }
    }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
        super.onSizeChanged(w, h, ow, oh)
        if (cx < 0) { cx = w / 2f; cy = h / 2f }
        cx = cx.coerceIn(0f, w.toFloat()); cy = cy.coerceIn(0f, h.toFloat())
        if (tv) onCursor(Offset(cx, cy))
    }

    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (!tv) return super.dispatchKeyEvent(e)
        if (e.keyCode == KeyEvent.KEYCODE_MENU) {
            if (e.action == KeyEvent.ACTION_UP) controls.nav = if (controls.nav == "cursor") "focus" else "cursor"
            return true
        }
        val dir = when (e.keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> "left"; KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
            KeyEvent.KEYCODE_DPAD_UP -> "up"; KeyEvent.KEYCODE_DPAD_DOWN -> "down"
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "ok"
            else -> return super.dispatchKeyEvent(e)
        }
        return if (controls.nav == "cursor") cursorKey(dir, e) else focusKey(dir, e)
    }

    // -------- cursor mode: arrows move a pointer (faster when held), OK taps under it, edges scroll
    private fun cursorKey(dir: String, e: KeyEvent): Boolean {
        if (dir == "ok") {
            when (e.action) {
                KeyEvent.ACTION_DOWN -> if (e.repeatCount == 0) touch(MotionEvent.ACTION_DOWN, cx, cy)
                KeyEvent.ACTION_UP -> touch(MotionEvent.ACTION_UP, cx, cy)
            }
            return true
        }
        if (e.action != KeyEvent.ACTION_DOWN) return true
        val step = resources.displayMetrics.density * (10 + minOf(e.repeatCount, 15) * 3)
        val margin = resources.displayMetrics.density * 24
        when (dir) {
            "left" -> { if (cx <= 0f) return false; cx -= step } // at the edge: let the app's rail take focus
            "right" -> cx += step
            "up" -> if (cy <= margin) scrollPage(-step * 2) else cy -= step
            "down" -> if (cy >= height - margin) scrollPage(step * 2) else cy += step
        }
        cx = cx.coerceIn(0f, width.toFloat()); cy = cy.coerceIn(0f, height.toFloat())
        onCursor(Offset(cx, cy))
        return true
    }

    private fun scrollPage(px: Float) {
        val css = px / resources.displayMetrics.density
        evaluateJavascript("window.scrollBy(0,$css)", null)
    }

    private fun touch(action: Int, x: Float, y: Float) {
        val t = SystemClock.uptimeMillis()
        val ev = MotionEvent.obtain(t, t, action, x, y, 0)
        ev.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
        dispatchTouchEvent(ev)
        ev.recycle()
    }

    // -------- focus mode: arrows jump to the nearest link/button that way, OK taps it
    private fun focusKey(dir: String, e: KeyEvent): Boolean {
        if (e.action != KeyEvent.ACTION_DOWN) return true
        evaluateJavascript("$SPATIAL_NAV;window.__zipNav('$dir')") { r ->
            val res = r?.trim('"').orEmpty()
            if (dir == "ok" && res.startsWith("[")) {
                // [x, y, innerWidth] in CSS px: tap there for real, so inputs open the keyboard too.
                val p = res.trim('[', ']').replace("\\", "").split(',').mapNotNull { it.trim().toFloatOrNull() }
                if (p.size == 3 && p[2] > 0) {
                    val scale = width / p[2]
                    touch(MotionEvent.ACTION_DOWN, p[0] * scale, p[1] * scale)
                    touch(MotionEvent.ACTION_UP, p[0] * scale, p[1] * scale)
                }
            }
        }
        return true
    }
}

private fun kindOf(url: String): String {
    val path = url.substringBefore('?').substringBefore('#').lowercase()
    return when {
        path.endsWith(".js") -> "script"
        path.endsWith(".css") -> "stylesheet"
        listOf(".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico").any { path.endsWith(it) } -> "image"
        listOf(".woff", ".woff2", ".ttf", ".otf").any { path.endsWith(it) } -> "font"
        listOf(".mp4", ".m3u8", ".ts", ".webm", ".mp3").any { path.endsWith(it) } -> "media"
        else -> "other"
    }
}

private fun jsString(s: String) = "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'"

/**
 * Focus mode, injected on demand: keeps a highlighted element and moves to the nearest focusable one in the
 * pressed direction (up/down scroll when nothing is that way). 'ok' returns the element's centre to tap.
 */
private val SPATIAL_NAV = """
(function(){if(window.__zipNav)return;var cur=null,st=document.createElement('style');
st.textContent='.__zipf{outline:3px solid #38bdf8!important;outline-offset:2px!important}';document.documentElement.appendChild(st);
function vis(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2&&getComputedStyle(e).visibility!='hidden'}
function all(){return [].filter.call(document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[tabindex]:not([tabindex="-1"]),[onclick],summary'),vis)}
function set(e){if(cur)cur.classList.remove('__zipf');cur=e;e.classList.add('__zipf');e.scrollIntoView({block:'nearest',inline:'nearest'})}
window.__zipNav=function(d){
if(!cur||!document.contains(cur)||!vis(cur)){var c=all().filter(function(e){var r=e.getBoundingClientRect();return r.top>=0&&r.top<innerHeight});
if(c.length){set(c[0]);return 'moved'}if(d=='up'||d=='down'){scrollBy(0,(d=='up'?-1:1)*innerHeight*0.6);return 'scrolled'}return 'edge'}
if(d=='ok'){var q=cur.getBoundingClientRect();return '['+(q.left+q.width/2)+','+(q.top+q.height/2)+','+innerWidth+']'}
var a=cur.getBoundingClientRect(),ax=a.left+a.width/2,ay=a.top+a.height/2,best=null,bs=1e9;
all().forEach(function(e){if(e==cur||cur.contains(e)||e.contains(cur))return;var r=e.getBoundingClientRect(),dx=r.left+r.width/2-ax,dy=r.top+r.height/2-ay,m,c;
if(d=='left'){if(r.right>a.left+1)return;m=-dx;c=Math.abs(dy)}else if(d=='right'){if(r.left<a.right-1)return;m=dx;c=Math.abs(dy)}
else if(d=='up'){if(r.bottom>a.top+1)return;m=-dy;c=Math.abs(dx)}else{if(r.top<a.bottom-1)return;m=dy;c=Math.abs(dx)}
if(m+c*2<bs){bs=m+c*2;best=e}});
if(best){set(best);return 'moved'}if(d=='up'||d=='down'){scrollBy(0,(d=='up'?-1:1)*innerHeight*0.6);return 'scrolled'}return 'edge'}})()
""".trimIndent().replace("\n", "")
