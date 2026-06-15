package com.iptv.player.zero;

import android.app.PictureInPictureParams;
import android.os.Build;
import android.util.Rational;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PipPlugin")
public class PipPlugin extends Plugin {

    @PluginMethod
    public void enterPiP(PluginCall call) {
        getBridge().executeOnMainThread(new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    try {
                        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
                        // 16:9 ratio for streaming video player window
                        builder.setAspectRatio(new Rational(16, 9));
                        getActivity().enterPictureInPictureMode(builder.build());
                        JSObject ret = new JSObject();
                        ret.put("success", true);
                        call.resolve(ret);
                    } catch (Exception e) {
                        call.reject("Failed to enter Picture-in-Picture: " + e.getMessage());
                    }
                } else {
                    call.reject("Picture-in-Picture mode requires Android 8.0 (Oreo) or higher.");
                }
            }
        });
    }

    @PluginMethod
    public void setPlaybackState(PluginCall call) {
        final boolean active = call.getBoolean("active", false);
        getBridge().executeOnMainThread(new Runnable() {
            @Override
            public void run() {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
                        builder.setAspectRatio(new Rational(16, 9));
                        builder.setAutoEnterEnabled(active);
                        getActivity().setPictureInPictureParams(builder.build());
                    } catch (Exception e) {
                        // ignore
                    }
                }
                
                try {
                    MainActivity activity = (MainActivity) getActivity();
                    activity.isPlaybackActive = active;
                } catch (Exception e) {
                    // ignore
                }

                JSObject ret = new JSObject();
                ret.put("success", true);
                call.resolve(ret);
            }
        });
    }

    @PluginMethod
    public void isPiPSupported(PluginCall call) {
        JSObject ret = new JSObject();
        boolean supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
        ret.put("supported", supported);
        call.resolve(ret);
    }

    // Public helper to dispatch event to Javascript from outside this class
    public void triggerPipEvent(boolean isInPip) {
        JSObject data = new JSObject();
        data.put("isInPip", isInPip);
        notifyListeners("pipModeChanged", data);
    }
}
