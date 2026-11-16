package com.ziptv.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.window.WindowDraggableArea
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.OpenInFull
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.ApplicationScope
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.WindowPosition
import androidx.compose.ui.window.rememberWindowState
import com.ziptv.app.AppModel
import com.ziptv.app.PlayerState
import com.ziptv.app.PlayerStatus
import com.ziptv.app.ZipTheme

/**
 * Real picture-in-picture on Windows: a small borderless window that stays on top of every other
 * app (the main window is minimized meanwhile). Drag it anywhere; hover for back / pause / close.
 */
@Composable
fun ApplicationScope.PipWindow(model: AppModel, onBackToApp: () -> Unit) {
    val screen = java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment().maximumWindowBounds // work area, scaled px = dp
    val w = 480; val h = 270
    val state = rememberWindowState(
        size = DpSize(w.dp, h.dp),
        position = WindowPosition((screen.x + screen.width - w - 24).dp, (screen.y + screen.height - h - 24).dp),
    )
    Window(onCloseRequest = { model.stop() }, state = state, title = "ZIPTV Pro", undecorated = true,
        alwaysOnTop = true, resizable = true) {
        ZipTheme(model.platform.device) {
            var hover by remember { mutableStateOf(false) }
            Box(Modifier.fillMaxSize().background(Color.Black).pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val e = awaitPointerEvent()
                        if (e.type == PointerEventType.Enter) hover = true else if (e.type == PointerEventType.Exit) hover = false
                    }
                }
            }) {
                // Drag anywhere on the picture to move the window.
                WindowDraggableArea(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize()) {
                        model.player.Surface(Modifier.fillMaxSize())
                        PlayerStatus(model, compact = true)
                    }
                }
                if (hover) {
                    val playing by model.player.state.collectAsState()
                    Row(Modifier.align(Alignment.TopEnd).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        PipButton(Icons.Rounded.OpenInFull, "Back to ZIPTV Pro", onBackToApp)
                        PipButton(if (playing == PlayerState.Paused) Icons.Rounded.PlayArrow else Icons.Rounded.Pause,
                            "Play or pause") { model.player.togglePause() }
                        PipButton(Icons.Rounded.Close, "Close") { model.stop() }
                    }
                }
            }
        }
    }
}

@Composable
private fun PipButton(icon: ImageVector, label: String, onClick: () -> Unit) =
    Box(Modifier.size(34.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.6f)).clickable(onClick = onClick),
        contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = Color.White, modifier = Modifier.size(20.dp))
    }
