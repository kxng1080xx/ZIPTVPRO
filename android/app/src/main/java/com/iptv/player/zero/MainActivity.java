package com.iptv.player.zero;

import android.app.PictureInPictureParams;
import android.content.res.Configuration;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    public boolean isPlaybackActive = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must register BEFORE super.onCreate(): BridgeActivity builds the bridge
        // during super.onCreate(), so a plugin registered afterwards never makes it
        // into the bridge and its JS calls silently no-op.
        registerPlugin(PipPlugin.class);
        registerPlugin(ApkInstallerPlugin.class);
        registerPlugin(CastPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (isPlaybackActive) {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                try {
                    PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
                    builder.setAspectRatio(new android.util.Rational(16, 9));
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                        builder.setAutoEnterEnabled(true);
                    }
                    enterPictureInPictureMode(builder.build());
                } catch (Exception e) {
                    // ignore
                }
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        
        PluginHandle handle = bridge.getPlugin("PipPlugin");
        if (handle != null) {
            PipPlugin plugin = (PipPlugin) handle.getInstance();
            if (plugin != null) {
                plugin.triggerPipEvent(isInPictureInPictureMode);
            }
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            hideSystemUI();
        }
    }

    private void hideSystemUI() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            android.view.Window window = getWindow();
            if (window != null) {
                android.view.WindowInsetsController controller = window.getInsetsController();
                if (controller != null) {
                    controller.hide(android.view.WindowInsets.Type.statusBars() | android.view.WindowInsets.Type.navigationBars());
                    controller.setSystemBarsBehavior(android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            }
        } else {
            android.view.View decorView = getWindow().getDecorView();
            int uiOptions = android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                          | android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                          | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                          | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                          | android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                          | android.view.View.SYSTEM_UI_FLAG_FULLSCREEN;
            decorView.setSystemUiVisibility(uiOptions);
        }
    }
}
