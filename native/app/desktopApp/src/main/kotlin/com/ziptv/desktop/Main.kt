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
import java.io.File

/** Escape-to-go-back: the topmost enabled handler wins, like Android's back stack. */
private val backHandlers = mutableStateListOf<Pair<() -> Boolean, () -> Unit>>()

class DesktopPlatform : Platform {
    override val device = DeviceClass.Desktop
    override val cloudPlatform = "pc"
    override val appVersion = "10.1.0"
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
    override fun openUrl(url: String): Boolean =
        runCatching { java.awt.Desktop.getDesktop().browse(java.net.URI(url)) }.isSuccess

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

fun main(args: Array<String>) {
    if (!claimSingleInstance()) return
    Thread(::removeV9, "remove-v9").apply { isDaemon = true }.start()
    app(minimized = "--minimized" in args)
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

private fun app(minimized: Boolean) = application {
    val model = remember { AppModel(DesktopPlatform(), MainScope()).also { it.start() } }
    val windowState = rememberWindowState(width = 1440.dp, height = 900.dp)
    androidx.compose.runtime.LaunchedEffect(Unit) { if (minimized) windowState.isMinimized = true }
    Window(
        onCloseRequest = { model.player.release(); exitApplication() },
        title = "ZIPTV Pro",
        state = windowState,
        onPreviewKeyEvent = { e ->
            if (e.type == KeyEventType.KeyDown && e.key == Key.Escape) {
                backHandlers.lastOrNull { it.first() }?.second?.invoke()?.let { true } ?: false
            } else false
        },
    ) {
        val full by wantFullscreen.collectAsState()
        // Real fullscreen the way browsers do it on Windows: drop the caption/frame style,
        // cover the whole monitor (taskbar included), restore both on exit. Compose's
        // WindowPlacement.Fullscreen and AWT exclusive mode both left the title bar.
        androidx.compose.runtime.LaunchedEffect(full) { WindowsFullscreen.set(window, full) }
        val poke by bringToFront.collectAsState()
        androidx.compose.runtime.LaunchedEffect(poke) {
            if (poke > 0) { windowState.isMinimized = false; window.toFront(); window.requestFocus() }
        }
        App(model)
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
