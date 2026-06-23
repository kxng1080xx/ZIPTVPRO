package com.iptv.player.zero;

import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;

/**
 * Native VOD + live playback via libVLC. The WebView <video> can't decode the
 * E-AC3/AC3 audio, HEVC (incl. Main10/10-bit) video, or MKV container that this
 * provider's premium content uses; ExoPlayer's hardware path also fails on
 * HEVC Main10 with NO_EXCEEDS_CAPABILITIES on many devices. libVLC decodes it
 * all (hardware when possible, software otherwise) — the same engine IPTV
 * Smarters uses for problem streams.
 *
 * Compositing: a VLCVideoLayout is inserted BEHIND the Capacitor WebView and the
 * WebView is made transparent so the HTML controls float over the native video.
 * player.js drives it via the bridge, with the browser <video> as fallback.
 */
@CapacitorPlugin(name = "NativeVideo")
public class NativeVideoPlugin extends Plugin {

    private LibVLC libVLC;
    private MediaPlayer player;
    private VLCVideoLayout videoLayout;
    private FrameLayout backing;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean readyFired = false;
    private long lengthMs = 0;

    private static final String UA = "VLC/3.0.20";

    // Forward a coarse libVLC lifecycle state to JS so the player UI (and the
    // person device-testing) can see exactly where playback is — "opening",
    // "buffering:NN", "playing", "vout:N", "stopped", "error" — instead of a
    // generic spinner that can't tell a buffer loop from a failed open.
    private void emitState(String state) {
        JSObject d = new JSObject();
        d.put("state", state);
        notifyListeners("state", d);
    }

    private void ensurePlayer() {
        if (player != null) return;

        ArrayList<String> opts = new ArrayList<>();
        opts.add("--http-user-agent=" + UA);
        opts.add("--network-caching=1500");
        opts.add("--no-drop-late-frames");
        opts.add("--no-skip-frames");
        libVLC = new LibVLC(getContext(), opts);
        player = new MediaPlayer(libVLC);

        videoLayout = new VLCVideoLayout(getContext());
        videoLayout.setBackgroundColor(Color.BLACK); // letterbox bars inside the box

        // The whole WebView/page is made transparent so the boxed video can show
        // through it. That would otherwise expose a black window everywhere outside
        // the video, so we paint a full-screen backing in the app's base colour
        // (--bg-darkest #070a13) behind the WebView to supply the normal background.
        backing = new FrameLayout(getContext());
        backing.setBackgroundColor(0xFF070A13);

        // The video surface lives INSIDE the backing, positioned/sized to the HTML
        // player box via setRect(). Until the first rect arrives it fills the screen.
        backing.addView(videoLayout, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // Insert the backing behind the WebView; make the WebView transparent so the
        // HTML controls float over the native video.
        WebView web = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) web.getParent();
        parent.addView(backing, 0, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.TRANSPARENT);

        // useTextureView=true: render into a TextureView, not a SurfaceView. A
        // SurfaceView lives in its own window layer behind the app window, so a
        // hardware-accelerated WebView on top rarely composites as truly
        // transparent → black video with working audio (exactly what we hit). A
        // TextureView is an ordinary view in the hierarchy and alpha-blends under
        // the transparent WebView, so the HTML controls float over visible video.
        player.attachViews(videoLayout, null, false, true);

        player.setEventListener((MediaPlayer.Event event) -> {
            switch (event.type) {
                case MediaPlayer.Event.Opening:
                    emitState("opening");
                    break;
                case MediaPlayer.Event.Playing:
                    lengthMs = player.getLength();
                    emitState("playing");
                    if (!readyFired) {
                        readyFired = true;
                        JSObject d = new JSObject();
                        d.put("duration", lengthMs / 1000.0);
                        notifyListeners("ready", d);
                    }
                    break;
                case MediaPlayer.Event.Vout: {
                    // Number of video outputs > 0 confirms a frame is actually being
                    // rendered to the surface (distinguishes "decoding video" from
                    // "audio-only / black surface" — key for the behind-WebView compositing).
                    JSObject d = new JSObject();
                    d.put("count", event.getVoutCount());
                    notifyListeners("vout", d);
                    emitState("vout:" + event.getVoutCount());
                    break;
                }
                case MediaPlayer.Event.LengthChanged:
                    lengthMs = event.getLengthChanged();
                    break;
                case MediaPlayer.Event.TimeChanged: {
                    JSObject d = new JSObject();
                    d.put("currentTime", event.getTimeChanged() / 1000.0);
                    d.put("duration", lengthMs / 1000.0);
                    notifyListeners("timeupdate", d);
                    break;
                }
                case MediaPlayer.Event.Buffering: {
                    JSObject d = new JSObject();
                    float pct = event.getBuffering();
                    d.put("percent", pct);
                    notifyListeners("buffering", d);
                    emitState("buffering:" + Math.round(pct));
                    break;
                }
                case MediaPlayer.Event.Stopped:
                    emitState("stopped");
                    break;
                case MediaPlayer.Event.EndReached:
                    emitState("ended");
                    notifyListeners("ended", new JSObject());
                    break;
                case MediaPlayer.Event.EncounteredError: {
                    emitState("error");
                    JSObject d = new JSObject();
                    d.put("message", "libVLC EncounteredError (could not open/decode the stream)");
                    notifyListeners("error", d);
                    break;
                }
            }
        });
    }

    @PluginMethod
    public void load(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("missing url"); return; }
        final boolean isLive = Boolean.TRUE.equals(call.getBoolean("isLive", false));
        final double startAt = call.getDouble("startAt", 0.0);
        ui.post(() -> {
            try {
                ensurePlayer();
                readyFired = false;
                lengthMs = 0;
                Media media = new Media(libVLC, android.net.Uri.parse(url));
                media.addOption(":http-user-agent=" + UA);
                if (isLive) media.addOption(":network-caching=2500");
                player.setMedia(media);
                media.release();
                if (backing != null) backing.setVisibility(View.VISIBLE);
                if (videoLayout != null) videoLayout.setVisibility(View.VISIBLE);
                player.play();
                if (!isLive && startAt > 0) {
                    // Seek once playback has begun (position is fractional 0..1).
                    ui.postDelayed(() -> {
                        if (player != null && lengthMs > 0) {
                            player.setPosition((float) ((startAt * 1000.0) / lengthMs));
                        }
                    }, 800);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject("native load failed: " + e.getMessage());
            }
        });
    }

    // Position/size the video surface to the HTML player box. Coordinates are in
    // physical device pixels (CSS px × devicePixelRatio), origin = top-left of the
    // WebView. w<=0 or h<=0 means full-screen (used for fullscreen playback).
    @PluginMethod
    public void setRect(final PluginCall call) {
        final int x = call.getInt("x", 0);
        final int y = call.getInt("y", 0);
        final int w = call.getInt("w", 0);
        final int h = call.getInt("h", 0);
        ui.post(() -> {
            if (videoLayout != null) {
                if (w <= 0 || h <= 0) {
                    // Player box not on screen (e.g. browsing the catalog while audio
                    // keeps playing) → hide the surface so video can't bleed behind
                    // other UI. Audio continues; a real rect re-shows it.
                    videoLayout.setVisibility(View.GONE);
                } else {
                    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(w, h);
                    // Allow negative margins so the surface scrolls up/off with the
                    // player box (clamping to 0 pinned it to the top edge instead of
                    // letting it scroll with the list). Clipped to the parent bounds.
                    lp.leftMargin = x;
                    lp.topMargin = y;
                    videoLayout.setLayoutParams(lp);
                    videoLayout.setVisibility(View.VISIBLE);
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void play(final PluginCall call) {
        ui.post(() -> { if (player != null) player.play(); call.resolve(); });
    }

    @PluginMethod
    public void pause(final PluginCall call) {
        ui.post(() -> { if (player != null) player.pause(); call.resolve(); });
    }

    @PluginMethod
    public void seek(final PluginCall call) {
        final double pos = call.getDouble("position", 0.0);
        ui.post(() -> {
            if (player != null && lengthMs > 0) player.setPosition((float) ((pos * 1000.0) / lengthMs));
            call.resolve();
        });
    }

    @PluginMethod
    public void setVolume(final PluginCall call) {
        final double v = call.getDouble("volume", 1.0);
        ui.post(() -> { if (player != null) player.setVolume((int) Math.round(v * 100)); call.resolve(); });
    }

    @PluginMethod
    public void stop(final PluginCall call) {
        ui.post(() -> {
            if (player != null) { try { player.stop(); } catch (Exception e) {} }
            if (videoLayout != null) videoLayout.setVisibility(View.GONE);
            if (backing != null) backing.setVisibility(View.GONE);
            call.resolve();
        });
    }

    @PluginMethod
    public void getAudioTracks(final PluginCall call) {
        ui.post(() -> {
            JSArray arr = new JSArray();
            if (player != null) {
                try {
                    MediaPlayer.TrackDescription[] tracks = player.getAudioTracks();
                    int current = player.getAudioTrack();
                    if (tracks != null) {
                        for (MediaPlayer.TrackDescription t : tracks) {
                            if (t.id < 0) continue; // -1 = "Disable"
                            JSObject o = new JSObject();
                            o.put("id", String.valueOf(t.id));
                            o.put("label", t.name);
                            o.put("active", t.id == current);
                            arr.put(o);
                        }
                    }
                } catch (Exception e) {}
            }
            JSObject ret = new JSObject();
            ret.put("tracks", arr);
            call.resolve(ret);
        });
    }

    @Override
    protected void handleOnDestroy() {
        ui.post(() -> {
            try {
                if (player != null) { player.stop(); player.detachViews(); player.release(); player = null; }
                if (libVLC != null) { libVLC.release(); libVLC = null; }
            } catch (Exception e) {}
        });
    }
}
