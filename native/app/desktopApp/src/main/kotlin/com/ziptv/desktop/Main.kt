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
    override val appVersion = "10.0.0"
    override val dataDir: String = File(System.getProperty("user.home"), ".ziptv10").apply { mkdirs() }.path
    override fun logoIndexJson(): String? =
        DesktopPlatform::class.java.getResourceAsStream("/channel-logos.json")?.bufferedReader()?.use { it.readText() }
    override fun createPlayer(): VideoPlayer = VlcjPlayer()
    override fun setScreenFullscreen(on: Boolean) { wantFullscreen.value = on }
    override fun logoTransformation() = LogoContrast()
    override fun tmdbToken(): String =
        DesktopPlatform::class.java.getResourceAsStream("/tmdb.token")?.bufferedReader()?.use { it.readText().trim() } ?: ""
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

fun main() {
    if (!claimSingleInstance()) return
    app()
}

private fun app() = application {
    val model = remember { AppModel(DesktopPlatform(), MainScope()).also { it.start() } }
    val windowState = rememberWindowState(width = 1440.dp, height = 900.dp)
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
        androidx.compose.runtime.LaunchedEffect(full) {
            windowState.placement = if (full) androidx.compose.ui.window.WindowPlacement.Fullscreen
                else androidx.compose.ui.window.WindowPlacement.Floating
        }
        val poke by bringToFront.collectAsState()
        androidx.compose.runtime.LaunchedEffect(poke) {
            if (poke > 0) { windowState.isMinimized = false; window.toFront(); window.requestFocus() }
        }
        App(model)
    }
}
