package com.iptv.player.zero;

import android.os.Handler;
import android.os.Looper;

import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Google Cast (Chromecast / Android TV) sender for the phone app. Discovers Cast
 * routes via MediaRouter and loads media (HLS for live, MP4 for VOD) over a Cast
 * session. The receiver fetches the public provider URL directly, so no local
 * proxy is needed. No-ops where Google Play services / Cast is unavailable
 * (e.g. Amazon Fire TV).
 */
@CapacitorPlugin(name = "Cast")
public class CastPlugin extends Plugin {

    private CastContext castContext;
    private MediaRouter mediaRouter;
    private MediaRouteSelector routeSelector;
    private MediaRouter.Callback routeCallback;
    private final Map<String, MediaRouter.RouteInfo> routes = new LinkedHashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        main.post(() -> {
            try {
                castContext = CastContext.getSharedInstance(getContext().getApplicationContext());
                mediaRouter = MediaRouter.getInstance(getContext().getApplicationContext());
                routeSelector = new MediaRouteSelector.Builder()
                        .addControlCategory(CastMediaControlIntent.categoryForCast(
                                CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                        .build();
                routeCallback = new MediaRouter.Callback() {
                    @Override public void onRouteAdded(MediaRouter r, MediaRouter.RouteInfo info) { addRoute(info); }
                    @Override public void onRouteChanged(MediaRouter r, MediaRouter.RouteInfo info) { addRoute(info); }
                    @Override public void onRouteRemoved(MediaRouter r, MediaRouter.RouteInfo info) { removeRoute(info); }
                };
                startScan();
            } catch (Throwable t) {
                // Cast not available on this device — methods will simply find no routes.
            }
        });
    }

    private boolean isCastRoute(MediaRouter.RouteInfo info) {
        return info != null && !info.isDefault() && routeSelector != null && info.matchesSelector(routeSelector);
    }

    private void addRoute(MediaRouter.RouteInfo info) {
        if (isCastRoute(info)) { routes.put(info.getId(), info); emitDevices(); }
    }

    private void removeRoute(MediaRouter.RouteInfo info) {
        if (info != null && routes.remove(info.getId()) != null) emitDevices();
    }

    private void startScan() {
        if (mediaRouter == null || routeCallback == null) return;
        mediaRouter.addCallback(routeSelector, routeCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN);
        for (MediaRouter.RouteInfo info : mediaRouter.getRoutes()) addRoute(info);
    }

    private void emitDevices() {
        notifyListeners("devices", devicesPayload());
    }

    private JSObject devicesPayload() {
        JSArray arr = new JSArray();
        for (MediaRouter.RouteInfo info : routes.values()) {
            JSObject d = new JSObject();
            d.put("id", info.getId());
            d.put("name", info.getName());
            d.put("type", "chromecast");
            arr.put(d);
        }
        JSObject o = new JSObject();
        o.put("devices", arr);
        return o;
    }

    @PluginMethod
    public void list(PluginCall call) {
        main.post(() -> {
            startScan();
            call.resolve(devicesPayload());
        });
    }

    @PluginMethod
    public void play(final PluginCall call) {
        final String deviceId = call.getString("deviceId");
        final String url = call.getString("url");
        final String contentType = call.getString("contentType", "video/mp4");
        final String title = call.getString("title", "ZIPTV Pro");
        final boolean isLive = Boolean.TRUE.equals(call.getBoolean("isLive", false));
        if (url == null) { call.reject("Missing url"); return; }

        main.post(() -> {
            try {
                if (castContext == null) { call.reject("Cast unavailable on this device"); return; }
                final SessionManager sm = castContext.getSessionManager();
                CastSession current = sm.getCurrentCastSession();

                if (current != null && current.isConnected()) {
                    loadMedia(current, url, contentType, title, isLive);
                    call.resolve();
                    return;
                }

                sm.addSessionManagerListener(new SessionManagerListener<CastSession>() {
                    @Override public void onSessionStarted(CastSession session, String sessionId) {
                        sm.removeSessionManagerListener(this, CastSession.class);
                        loadMedia(session, url, contentType, title, isLive);
                        call.resolve();
                    }
                    @Override public void onSessionStartFailed(CastSession session, int error) {
                        sm.removeSessionManagerListener(this, CastSession.class);
                        call.reject("Cast session failed (" + error + ")");
                    }
                    @Override public void onSessionEnded(CastSession s, int e) {}
                    @Override public void onSessionEnding(CastSession s) {}
                    @Override public void onSessionResumeFailed(CastSession s, int e) {}
                    @Override public void onSessionResumed(CastSession s, boolean w) {}
                    @Override public void onSessionResuming(CastSession s, String id) {}
                    @Override public void onSessionStarting(CastSession s) {}
                    @Override public void onSessionSuspended(CastSession s, int r) {}
                }, CastSession.class);

                MediaRouter.RouteInfo route = routes.get(deviceId);
                if (route != null) {
                    mediaRouter.selectRoute(route);
                } else {
                    call.reject("Cast device not found (try rescanning)");
                }
            } catch (Exception e) {
                call.reject("Cast failed: " + e.getMessage());
            }
        });
    }

    private void loadMedia(CastSession session, String url, String contentType, String title, boolean isLive) {
        MediaMetadata meta = new MediaMetadata(MediaMetadata.MEDIA_TYPE_GENERIC);
        meta.putString(MediaMetadata.KEY_TITLE, title);
        MediaInfo info = new MediaInfo.Builder(url)
                .setStreamType(isLive ? MediaInfo.STREAM_TYPE_LIVE : MediaInfo.STREAM_TYPE_BUFFERED)
                .setContentType(contentType)
                .setMetadata(meta)
                .build();
        RemoteMediaClient rmc = session.getRemoteMediaClient();
        if (rmc != null) {
            rmc.load(new MediaLoadRequestData.Builder().setMediaInfo(info).setAutoplay(true).build());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            try {
                if (castContext != null) castContext.getSessionManager().endCurrentSession(true);
            } catch (Exception e) {}
            call.resolve();
        });
    }
}
