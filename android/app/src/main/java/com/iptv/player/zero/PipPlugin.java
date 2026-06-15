package com.iptv.player.zero;

import android.app.AppOpsManager;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
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
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                    call.reject("Picture-in-Picture mode requires Android 8.0 (Oreo) or higher.");
                    return;
                }

                // PiP is enabled by default for apps that declare
                // android:supportsPictureInPicture, so attempt it directly and use the
                // return value to decide what to do. (A pre-check via AppOpsManager is
                // unreliable: many devices report MODE_DEFAULT rather than MODE_ALLOWED,
                // which would falsely block a perfectly working PiP.)
                try {
                    PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder();
                    // 16:9 ratio for streaming video player window
                    builder.setAspectRatio(new Rational(16, 9));
                    boolean entered = getActivity().enterPictureInPictureMode(builder.build());
                    JSObject ret = new JSObject();
                    ret.put("success", entered);
                    // Only surface needsPermission when the OS actually refused to enter.
                    ret.put("needsPermission", !entered);
                    call.resolve(ret);
                } catch (Exception e) {
                    // Thrown when the special "Picture-in-picture" access is turned off
                    // for this app. Tell JS so it can route the user to the settings toggle.
                    JSObject ret = new JSObject();
                    ret.put("success", false);
                    ret.put("needsPermission", true);
                    call.resolve(ret);
                }
            }
        });
    }

    @PluginMethod
    public void isPiPAllowed(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O);
        ret.put("allowed", isPipAllowed());
        call.resolve(ret);
    }

    @PluginMethod
    public void openPiPSettings(PluginCall call) {
        getBridge().executeOnMainThread(new Runnable() {
            @Override
            public void run() {
                String pkg = getActivity().getPackageName();
                // Preferred: the dedicated Picture-in-picture settings screen.
                // Note: this framework action has no public Settings constant, so use the literal.
                try {
                    Intent intent = new Intent("android.settings.PICTURE_IN_PICTURE_SETTINGS",
                            Uri.fromParts("package", pkg, null));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(intent);
                    call.resolve();
                    return;
                } catch (Exception ignored) { }
                // Fallback: this app's details page.
                try {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", pkg, null));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(intent);
                    call.resolve();
                } catch (Exception e) {
                    call.reject("Could not open settings: " + e.getMessage());
                }
            }
        });
    }

    private boolean isPipAllowed() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            AppOpsManager aom = (AppOpsManager) getContext().getSystemService(Context.APP_OPS_SERVICE);
            if (aom == null) return true;
            int mode;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                mode = aom.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE,
                        Process.myUid(), getContext().getPackageName());
            } else {
                mode = aom.checkOpNoThrow(AppOpsManager.OPSTR_PICTURE_IN_PICTURE,
                        Process.myUid(), getContext().getPackageName());
            }
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            // If we can't determine it, don't block the attempt.
            return true;
        }
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
