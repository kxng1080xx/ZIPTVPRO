package com.ziptv.desktop

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import com.ziptv.app.App
import com.ziptv.app.AppModel
import com.ziptv.app.DeviceClass
import com.ziptv.app.Platform
import com.ziptv.app.VideoPlayer
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.flow.MutableStateFlow
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import com.ziptv.app.StartupScreen
import java.io.File

/** Escape-to-go-back: the topmost enabled handler wins, like Android's back stack. */
private val backHandlers = mutableStateListOf<Pair<() -> Boolean, () -> Unit>>()

class DesktopPlatform : Platform {
    override val device = DeviceClass.Desktop
    override val cloudPlatform = "pc"
    // Installed app: the installer's version (packageVersion = ziptv.version), so it can't go stale like 10.2.1/10.2.2 did.
    override val appVersion = System.getProperty("jpackage.app-version") ?: "dev"
    override val dataDir: String = File(System.getProperty("user.home"), ".ziptv10").apply { mkdirs() }.path
    override val tunnel = CloudflaredTunnel(File(dataDir, "bin"))
    override fun logoIndexJson(): String? =
        DesktopPlatform::class.java.getResourceAsStream("/channel-logos.json")?.bufferedReader()?.use { it.readText() }
    override fun createPlayer(): VideoPlayer = VlcjPlayer()
    override fun setScreenFullscreen(on: Boolean) { wantFullscreen.value = on }
    override fun logoTransformation() = LogoContrast()
    override fun tmdbToken(): String =
        DesktopPlatform::class.java.getResourceAsStream("/tmdb.token")?.bufferedReader()?.use { it.readText().trim() } ?: ""
    // Run at startup: HKCU Run entry; "--minimized" = Start minimized. Installed app only.
    private val runKey = """Software\Microsoft\Windows\CurrentVersion\Run"""
    override fun autostart(): Pair<Boolean, Boolean>? {
        System.getProperty("jpackage.app-path") ?: return null
        val v = runCatching {
            com.sun.jna.platform.win32.Advapi32Util.registryGetStringValue(com.sun.jna.platform.win32.WinReg.HKEY_CURRENT_USER, runKey, "ZIPTV Pro")
        }.getOrNull() ?: return false to false
        return true to v.contains("--minimized")
    }
    override fun setAutostart(on: Boolean, minimized: Boolean) {
        val exe = System.getProperty("jpackage.app-path") ?: return
        val hk = com.sun.jna.platform.win32.WinReg.HKEY_CURRENT_USER
        runCatching {
            if (on) com.sun.jna.platform.win32.Advapi32Util.registrySetStringValue(hk, runKey, "ZIPTV Pro",
                "\"$exe\"" + if (minimized) " --minimized" else "")
            else com.sun.jna.platform.win32.Advapi32Util.registryDeleteValue(hk, runKey, "ZIPTV Pro")
        }
    }
    override val ownPipWindow = true

    // Auto-update: download the installer here, then close, install with just a progress bar
    // (per-user MSI: no admin prompt) and reopen. Installed app only.
    override val inAppUpdate = System.getProperty("jpackage.app-path") != null
    override fun downloadAndInstall(url: String, progress: (Float) -> Unit): String? = runCatching {
        val app = System.getProperty("jpackage.app-path") ?: return "Updates install from the installed app"
        val dir = File(System.getProperty("java.io.tmpdir"), "ziptv-update").apply { mkdirs() }
        val exe = File(dir, "ZIPTV-Pro-setup.exe")
        val c = java.net.URI(url).toURL().openConnection().apply { connectTimeout = 15_000; readTimeout = 30_000 }
        val total = c.contentLengthLong
        c.getInputStream().use { inp ->
            exe.outputStream().use { out ->
                val buf = ByteArray(1 shl 16); var n = 0L
                while (true) {
                    val r = inp.read(buf); if (r < 0) break
                    out.write(buf, 0, r); n += r
                    if (total > 0) progress(n.toFloat() / total)
                }
            }
        }
        if (total > 0 && exe.length() != total) return "The download was cut off. Try again"
        // Waits for us to exit (files in use), installs (/passive: progress bar, no clicks), reopens the app.
        val script = File(dir, "update.cmd")
        script.writeText("@echo off\r\nping -n 4 127.0.0.1 >nul\r\nstart \"\" /wait \"${exe.path}\" /passive\r\nstart \"\" \"$app\"\r\nexit\r\n") // `start x.cmd` runs it under cmd /k: without exit the window stays open
        ProcessBuilder("cmd", "/c", "start", "", "/min", script.path).start()
        quitApp.value = true
        null
    }.getOrElse { "Couldn't download the update: ${it.message}" }

    override fun openUrl(url: String): Boolean =
        runCatching { java.awt.Desktop.getDesktop().browse(java.net.URI(url)) }.isSuccess

    @Composable
    override fun WebPage(tab: com.ziptv.core.WebTab, adblock: com.ziptv.core.AdBlock, blockAds: Boolean, controls: com.ziptv.app.WebControls,
        modifier: androidx.compose.ui.Modifier) = WebView2Page(dataDir, tab, adblock, blockAds, controls, modifier)

    @Composable
    override fun BackHandler(enabled: Boolean, onBack: () -> Unit) {
        val entry = remember(onBack) { Pair({ enabled }, onBack) }
        DisposableEffect(entry, enabled) {
            if (enabled) backHandlers.add(entry)
            onDispose { backHandlers.remove(entry) }
        }
    }
}

/**
 * One instance only: the first one owns a loopback port. A second launch pokes
 * that port (the running window comes to the front) and exits.
 */
private const val INSTANCE_PORT = 47613
private val bringToFront = MutableStateFlow(0)
private val wantFullscreen = MutableStateFlow(false)

private fun claimSingleInstance(): Boolean {
    val server = try {
        java.net.ServerSocket(INSTANCE_PORT, 4, java.net.InetAddress.getLoopbackAddress())
    } catch (e: java.io.IOException) {
        runCatching { java.net.Socket(java.net.InetAddress.getLoopbackAddress(), INSTANCE_PORT).use { it.getOutputStream().write(1) } }
        return false
    }
    Thread({
        while (true) runCatching { server.accept().use { bringToFront.value++ } }
    }, "single-instance").apply { isDaemon = true; start() }
    return true
}

/** Set by the updater: close so the installer can replace the app's files. */
private val quitApp = MutableStateFlow(false)

fun main(args: Array<String>) {
    if (!claimSingleInstance()) return
    Thread(::removeV9, "remove-v9").apply { isDaemon = true }.start()
    // Built off the UI thread (VLC, core, saved state: ~0.6 s) while Compose sets up the window.
    val model = java.util.concurrent.CompletableFuture.supplyAsync { AppModel(DesktopPlatform(), MainScope()) }
    app(minimized = "--minimized" in args, model)
    kotlin.system.exitProcess(0) // web tabs' WebView2 threads would otherwise keep the process alive
}

/**
 * v10 replaces v9 (Electron, per-user NSIS install). The MSI can't remove an NSIS app, so
 * the first v10 run on this PC (or account) runs v9's own silent uninstaller, once — otherwise
 * there are two "ZIPTV Pro"s in Start. Packaged runs only (dev runs have no resources dir).
 */
private fun removeV9() {
    if (System.getProperty("compose.application.resources.dir") == null) return
    val marker = java.io.File(System.getProperty("user.home"), ".ziptv10/v9-removed")
    if (marker.exists()) return
    runCatching {
        val out = ProcessBuilder("reg", "query", """HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall""", "/s", "/f", "ZIPTV Pro 9.")
            .redirectErrorStream(true).start().inputStream.bufferedReader().readText()
        // "    QuietUninstallString    REG_SZ    "C:\...\Uninstall ZIPTV Pro.exe" /currentuser /S"
        val cmd = Regex("""QuietUninstallString\s+REG_SZ\s+"([^"]+)"(.*)""").find(out) ?: return@runCatching
        val exe = cmd.groupValues[1]
        if (!exe.endsWith("Uninstall ZIPTV Pro.exe", ignoreCase = true)) return@runCatching // only v9's own uninstaller
        val args = cmd.groupValues[2].trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        ProcessBuilder(listOf(exe) + args).start().waitFor(120, java.util.concurrent.TimeUnit.SECONDS)
    }
    runCatching { marker.parentFile.mkdirs(); marker.writeText("done") }
}

private fun app(minimized: Boolean, pending: java.util.concurrent.CompletableFuture<AppModel>) = application(exitProcessOnExit = false) {
    var ready by remember { androidx.compose.runtime.mutableStateOf<AppModel?>(null) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        ready = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { pending.get() }.also { it.start() }
    }
    val windowState = rememberWindowState(width = 1440.dp, height = 900.dp)
    androidx.compose.runtime.LaunchedEffect(Unit) { if (minimized) windowState.isMinimized = true }
    Window(
        onCloseRequest = { ready?.player?.release(); exitApplication() },
        title = "ZIPTV Pro",
        state = windowState,
        onPreviewKeyEvent = { e ->
            if (e.type == KeyEventType.KeyDown && e.key == Key.Escape) {
                backHandlers.lastOrNull { it.first() }?.second?.invoke()?.let { true } ?: false
            } else false
        },
    ) {
        val model = ready ?: return@Window StartupScreen(DeviceClass.Desktop)
        val full by wantFullscreen.collectAsState()
        // Real fullscreen the way browsers do it on Windows: drop the caption/frame style,
        // cover the whole monitor (taskbar included), restore both on exit. Compose's
        // WindowPlacement.Fullscreen and AWT exclusive mode both left the title bar.
        // Never resize a minimized window: coming back from PiP asks for fullscreen while the window is
        // still being restored, and Skia's Direct3D surface crashed (null deref) rebuilding mid-restore.
        androidx.compose.runtime.LaunchedEffect(full, windowState.isMinimized) {
            if (windowState.isMinimized) return@LaunchedEffect
            var waited = 0
            while (waited < 1000 && !(window.isShowing && (window.extendedState and java.awt.Frame.ICONIFIED) == 0)) {
                kotlinx.coroutines.delay(25); waited += 25
            }
            kotlinx.coroutines.delay(100) // let the restore's own layout pass finish first
            WindowsFullscreen.set(window, full)
        }
        val quit by quitApp.collectAsState()
        androidx.compose.runtime.LaunchedEffect(quit) { if (quit) { model.player.release(); exitApplication() } }
        // PiP: the button minimizes this window and opens the floating one; minimizing while something
        // plays does the same (like leaving a video app on a phone); bringing this window back ends it.
        androidx.compose.runtime.LaunchedEffect(model.pip) { if (model.pip) windowState.isMinimized = true }
        androidx.compose.runtime.LaunchedEffect(windowState.isMinimized) {
            if (windowState.isMinimized && model.nowPlaying != null && !model.pip) { model.fullscreen = false; model.pip = true }
            else if (!windowState.isMinimized && model.pip) model.pip = false
        }
        val poke by bringToFront.collectAsState()
        androidx.compose.runtime.LaunchedEffect(poke) {
            if (poke > 0) { windowState.isMinimized = false; window.toFront(); window.requestFocus() }
        }
        App(model)
    }
    val model = ready ?: return@application
    if (model.pip && model.nowPlaying != null) PipWindow(model) {
        model.pip = false; model.fullscreen = true; windowState.isMinimized = false; bringToFront.value++
    }
}

/** Borderless fullscreen via Win32 window styles (JNA). No-op on other OSes. */
private object WindowsFullscreen {
    private interface User32 : com.sun.jna.Library {
        fun GetWindowLongW(hWnd: com.sun.jna.Pointer, index: Int): Int
        fun SetWindowLongW(hWnd: com.sun.jna.Pointer, index: Int, value: Int): Int
        fun SetWindowPos(hWnd: com.sun.jna.Pointer, after: com.sun.jna.Pointer?, x: Int, y: Int, cx: Int, cy: Int, flags: Int): Boolean
    }
    private const val GWL_STYLE = -16
    private const val FRAME = 0x00C00000 or 0x00040000 // WS_CAPTION | WS_THICKFRAME
    private const val SWP_FRAME_ONLY = 0x0020 or 0x0001 or 0x0002 or 0x0004 // FRAMECHANGED|NOSIZE|NOMOVE|NOZORDER
    private val user32 by lazy {
        if (System.getProperty("os.name").startsWith("Windows")) com.sun.jna.Native.load("user32", User32::class.java) else null
    }
    private var savedStyle = 0
    private var savedBounds: java.awt.Rectangle? = null

    fun set(window: java.awt.Window, on: Boolean) {
        val u = user32 ?: return
        val hwnd = com.sun.jna.Native.getWindowPointer(window) ?: return
        if (on && savedBounds == null) {
            savedBounds = window.bounds
            savedStyle = u.GetWindowLongW(hwnd, GWL_STYLE)
            u.SetWindowLongW(hwnd, GWL_STYLE, savedStyle and FRAME.inv())
            u.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_FRAME_ONLY)
            window.bounds = window.graphicsConfiguration.bounds // whole monitor (DPI handled by AWT)
        } else if (!on && savedBounds != null) {
            u.SetWindowLongW(hwnd, GWL_STYLE, savedStyle)
            u.SetWindowPos(hwnd, null, 0, 0, 0, 0, SWP_FRAME_ONLY)
            window.bounds = savedBounds
            savedBounds = null
        }
    }
}
