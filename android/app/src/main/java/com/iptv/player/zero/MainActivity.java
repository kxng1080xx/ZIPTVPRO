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
}
