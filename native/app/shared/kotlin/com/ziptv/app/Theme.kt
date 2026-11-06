package com.ziptv.app

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** v9's tokens (src/style.css --rd-*), so v10 looks like the app users know. */
object Z {
    val bg = Color(0xFF090B11)            // --rd-bg-base
    val surface = Color(0xFF0F1218)       // --rd-glass-panel over bg
    val surfaceHigh = Color(0xFF181C25)   // hover / selected rows
    val outline = Color(0x12FFFFFF)       // --rd-hairline
    val text = Color(0xFFF3F4F6)          // --text-primary
    val textMuted = Color(0xFF9CA3AF)     // --text-secondary
    val accent = Color(0xFF3B82F6)        // --rd-accent-solid
    val accent2 = Color(0xFF06B6D4)       // gradient end (cyan)
    val accentGradient = androidx.compose.ui.graphics.Brush.linearGradient(listOf(Color(0xFF3B82F6), Color(0xFF06B6D4)))
    val activeTint = androidx.compose.ui.graphics.Brush.horizontalGradient(listOf(Color(0x3338BDF8), Color(0x0D38BDF8)))
    val activeBorder = Color(0x4738BDF8)  // --rd-active-border
    val focus = Color(0xFF38BDF8)         // --rd-focus
    val live = Color(0xFFEF4444)          // --accent-red
    val gold = Color(0xFFEAB308)
}

val LocalDevice = staticCompositionLocalOf { DeviceClass.Desktop }
val LocalLogoTransform = staticCompositionLocalOf<coil3.transform.Transformation?> { null }

private val type = Typography(
    headlineMedium = TextStyle(fontSize = 26.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun ZipTheme(device: DeviceClass, content: @Composable () -> Unit) {
    val base = LocalDensity.current
    // Android TV already maps 1080p to a 960dp-wide "10-foot" canvas; an extra zoom
    // (tried 1.12x) made posters huge and pushed the rail off-screen. Slightly denser instead.
    val density = if (device == DeviceClass.Tv) Density(base.density * 0.9f, base.fontScale) else base
    // LocalContentColor: Text outside a Material Surface would otherwise default to black.
    CompositionLocalProvider(
        LocalDevice provides device,
        LocalDensity provides density,
        androidx.compose.material3.LocalContentColor provides Z.text,
    ) {
        MaterialTheme(
            colorScheme = darkColorScheme(
                primary = Z.accent, onPrimary = Color.White,
                background = Z.bg, onBackground = Z.text,
                surface = Z.surface, onSurface = Z.text,
                surfaceVariant = Z.surfaceHigh, onSurfaceVariant = Z.textMuted,
                outline = Z.outline, error = Z.live,
            ),
            typography = type,
            content = content,
        )
    }
}

/**
 * Focus = the only cursor on a TV, so it must be unmistakable: v9's sky-blue ring + slight lift.
 * On touch it never shows (nothing gains focus without a keyboard).
 * Put it BEFORE clickable/focusable in the chain so it observes that element.
 */
fun Modifier.focusRing(shape: Shape = RoundedCornerShape(12.dp), lift: Float = 1.04f): Modifier = composed {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) lift else 1f, tween(140), label = "focusScale")
    this
        .onFocusChanged { focused = it.isFocused || it.hasFocus }
        .graphicsLayer { scaleX = scale; scaleY = scale }
        .border(if (focused) 3.dp else 0.dp, if (focused) Z.focus else Color.Transparent, shape)
}
