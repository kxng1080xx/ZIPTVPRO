package com.ziptv.app

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * LazyRow with < > buttons on PC, where a mouse wheel can't scroll sideways.
 * Touch swipes and TV remotes move focus, so they get a plain LazyRow.
 */
@Composable
fun ScrollRow(
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
    horizontalArrangement: Arrangement.Horizontal = Arrangement.Start,
    content: LazyListScope.() -> Unit,
) {
    val state = rememberLazyListState()
    if (LocalDevice.current != DeviceClass.Desktop) {
        LazyRow(modifier, state, contentPadding, horizontalArrangement = horizontalArrangement, content = content)
        return
    }
    val scope = rememberCoroutineScope()
    fun page(dir: Int) = scope.launch { state.animateScrollBy(dir * state.layoutInfo.viewportSize.width * 0.8f) }
    Box(modifier) {
        LazyRow(state = state, contentPadding = contentPadding, horizontalArrangement = horizontalArrangement, content = content)
        AnimatedVisibility(state.canScrollBackward, Modifier.align(Alignment.CenterStart).padding(start = 6.dp), enter = fadeIn(), exit = fadeOut()) {
            Arrow(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, "Scroll left") { page(-1) }
        }
        AnimatedVisibility(state.canScrollForward, Modifier.align(Alignment.CenterEnd).padding(end = 6.dp), enter = fadeIn(), exit = fadeOut()) {
            Arrow(Icons.AutoMirrored.Rounded.KeyboardArrowRight, "Scroll right") { page(1) }
        }
    }
}

@Composable
private fun Arrow(icon: ImageVector, label: String, onClick: () -> Unit) =
    Box(Modifier.size(40.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.7f)).clickable(onClick = onClick),
        contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = Color.White, modifier = Modifier.size(28.dp))
    }
