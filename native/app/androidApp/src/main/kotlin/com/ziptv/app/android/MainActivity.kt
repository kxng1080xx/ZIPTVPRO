package com.ziptv.app.android

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.displayCutout
import androidx.lifecycle.lifecycleScope
import com.ziptv.app.App
import com.ziptv.app.AppModel
import com.ziptv.app.DeviceClass
import com.ziptv.app.Platform
import com.ziptv.app.VideoPlayer

class MainActivity : ComponentActivity() {
    private lateinit var model: AppModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Full-screen app: draw edge to edge (incl. the camera cut-out area; the UI pads for it)
        // and keep the system bars hidden. Swiping from an edge shows them briefly.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        hideSystemBars()
        model = AppModel(AndroidPlatform(this), lifecycleScope)
        model.start()
        setContent { App(model) }
    }

    private fun hideSystemBars() {
        val c = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
        c.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
    }

    // The system re-shows bars after dialogs, the keyboard, returning from another app…
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    // Home while watching fullscreen -> PiP (like YouTube) instead of stopping.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (model.nowPlaying != null && model.fullscreen) model.platform.enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        model.inSystemPip = isInPictureInPictureMode
        if (isInPictureInPictureMode) model.fullscreen = true
    }

    override fun onStop() {
        super.onStop()
        // PiP keeps playing; a real background (home without PiP, app switch) stops.
        if (!isChangingConfigurations && !(android.os.Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode)) model.stop()
    }

    override fun onDestroy() {
        super.onDestroy()
        model.player.release()
    }
}

/**
 * TV = the system says so, OR the device has the TV feature, OR it has no
 * touchscreen at all (projectors, Android boxes, sticks). Decided once.
 */
fun detectDevice(ctx: Context): DeviceClass {
    val ui = ctx.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
    val pm = ctx.packageManager
    val tv = ui.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
        pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
        !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN)
    return if (tv) DeviceClass.Tv else DeviceClass.Touch
}

class AndroidPlatform(private val activity: ComponentActivity) : Platform {
    override val device = detectDevice(activity)
    override val cloudPlatform = "apk"
    override val appVersion: String =
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "10"

    override fun setScreenFullscreen(on: Boolean) {
        // Phones: fullscreen video turns landscape, like any video app (TVs are already landscape).
        if (device == DeviceClass.Touch) {
            activity.requestedOrientation = if (on) android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    override fun enterPip(): Boolean {
        if (android.os.Build.VERSION.SDK_INT < 26 ||
            !activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false
        return activity.enterPictureInPictureMode(
            android.app.PictureInPictureParams.Builder().setAspectRatio(android.util.Rational(16, 9)).build()
        )
    }
    override fun tmdbToken(): String =
        runCatching { activity.assets.open("tmdb.token").bufferedReader().use { it.readText().trim() } }.getOrDefault("")

    override fun openUrl(url: String): Boolean = runCatching {
        activity.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url)))
    }.isSuccess

    override val dataDir: String = activity.filesDir.path
    override fun logoIndexJson(): String? =
        runCatching { activity.assets.open("channel-logos.json").bufferedReader().use { it.readText() } }.getOrNull()
    override fun createPlayer(): VideoPlayer = VlcPlayer(activity)
    override fun logoTransformation() = LogoContrast()

    @Composable
    override fun cutoutPadding() = androidx.compose.foundation.layout.WindowInsets.displayCutout.asPaddingValues()

    @Composable
    override fun BackHandler(enabled: Boolean, onBack: () -> Unit) =
        androidx.activity.compose.BackHandler(enabled, onBack)
}
