import Foundation
import Capacitor
import MobileVLCKit
import UIKit

/**
 * iOS mirror of the Android `NativeVideo` Capacitor plugin (libVLC). Uses
 * MobileVLCKit — the same VLC engine — so iPhone/iPad decode the E-AC3/AC3
 * audio, HEVC video, MKV containers, and raw MPEG-TS that WKWebView's <video>
 * (AVPlayer) and the JS players (mpegts.js needs MSE, which WKWebView lacks)
 * cannot handle.
 *
 * The JS side (src/components/native-player.js) registers this by the jsName
 * "NativeVideo" and races each call against a browser <video> fallback, so any
 * failure here degrades to HLS/AVPlayer rather than breaking playback.
 *
 * Method + event surface is kept byte-for-byte compatible with the Java plugin:
 *   methods : load, play, pause, seek, setVolume, setRect, stop,
 *             getAudioTracks, keepAwake, allowSleep, isTv
 *   events  : ready, state, vout, timeupdate, buffering, ended, error
 *
 * NOTE: authored on Windows; compiles on macOS (Xcode + `pod install` pulls
 * MobileVLCKit). Expect to iterate on the compositing/frame math on-device.
 */
@objc(NativeVideoPlugin)
public class NativeVideoPlugin: CAPPlugin, CAPBridgedPlugin, VLCMediaPlayerDelegate {
    public let identifier = "NativeVideoPlugin"
    public let jsName = "NativeVideo"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAudioTracks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "allowSleep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isTv", returnType: CAPPluginReturnPromise)
    ]

    private var player: VLCMediaPlayer?
    private var videoView: UIView?
    private var readyFired = false
    private var lengthMs: Int = 0
    private let ua = "VLC/3.0.20"   // match capacitor.config.json overrideUserAgent

    // MARK: - view setup ----------------------------------------------------

    /// Insert a UIView BEHIND the WKWebView. The web layer is made transparent so
    /// the HTML player chrome floats over the native video — same model as the
    /// Android TextureView-behind-transparent-WebView path.
    private func ensureVideoView() {
        if videoView != nil { return }
        guard let web = self.webView, let parent = web.superview else { return }
        let v = UIView(frame: web.frame)
        v.backgroundColor = .black
        v.isUserInteractionEnabled = false
        parent.insertSubview(v, belowSubview: web)
        // Make the web layer see-through so native video shows behind it.
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        videoView = v
    }

    private func ensurePlayer() {
        ensureVideoView()
        if player != nil { return }
        let p = VLCMediaPlayer()
        p.delegate = self
        p.drawable = videoView
        player = p
    }

    // MARK: - events (mirror Java payload shapes) ---------------------------

    private func emitState(_ s: String) {
        notifyListeners("state", data: ["state": s])
    }

    // MARK: - methods -------------------------------------------------------

    @objc func load(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("missing url"); return
        }
        let isLive = call.getBool("isLive", false)
        let startAt = call.getDouble("startAt", 0.0)

        DispatchQueue.main.async {
            self.ensurePlayer()
            self.videoView?.isHidden = false
            self.readyFired = false
            self.lengthMs = 0

            let media = VLCMedia(url: url)
            media.addOption(":http-user-agent=\(self.ua)")
            if !isLive {
                // VOD: resume the HTTP input in place on a dropped socket.
                media.addOption(":http-reconnect")
            } else {
                // Live: jitter buffer + tolerate broken PCR/PTS (IPTV TS streams).
                media.addOption(":network-caching=2500")
                media.addOption(":clock-jitter=0")
                media.addOption(":clock-synchro=0")
            }
            self.player?.media = media
            self.player?.play()

            if !isLive && startAt > 0 {
                // Seek once playback has begun (position is fractional 0..1).
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    if let p = self.player, self.lengthMs > 0 {
                        p.position = Float((startAt * 1000.0) / Double(self.lengthMs))
                    }
                }
            }
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.player?.play(); call.resolve() }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.player?.pause(); call.resolve() }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let position = call.getDouble("position", 0.0) // fractional 0..1
        DispatchQueue.main.async {
            self.player?.position = Float(position)
            call.resolve()
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let v = call.getDouble("volume", 1.0) // 0..1
        DispatchQueue.main.async {
            self.player?.audio?.volume = Int32(round(v * 100))
            call.resolve()
        }
    }

    /// Position/size the native video to the HTML player box. Coordinates arrive
    /// in physical device pixels (CSS px × devicePixelRatio); UIKit is in points,
    /// so divide by the screen scale. w<=0 or h<=0 means full-screen.
    @objc func setRect(_ call: CAPPluginCall) {
        let x = call.getInt("x", 0)
        let y = call.getInt("y", 0)
        let w = call.getInt("w", 0)
        let h = call.getInt("h", 0)
        DispatchQueue.main.async {
            guard let v = self.videoView, let web = self.webView else { call.resolve(); return }
            let scale = UIScreen.main.scale
            if w <= 0 || h <= 0 {
                v.frame = web.frame
            } else {
                v.frame = CGRect(x: CGFloat(x) / scale, y: CGFloat(y) / scale,
                                 width: CGFloat(w) / scale, height: CGFloat(h) / scale)
            }
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player?.stop()
            self.videoView?.isHidden = true
            // Restore the opaque web layer for non-playback screens.
            self.webView?.isOpaque = true
            call.resolve()
        }
    }

    @objc func getAudioTracks(_ call: CAPPluginCall) {
        var tracks: [[String: Any]] = []
        if let p = player {
            let names = p.audioTrackNames as? [Any] ?? []
            let ids = p.audioTrackIndexes as? [Any] ?? []
            for i in 0..<min(names.count, ids.count) {
                tracks.append([
                    "id": (ids[i] as? Int) ?? i,
                    "name": (names[i] as? String) ?? "Track \(i + 1)"
                ])
            }
        }
        call.resolve(["tracks": tracks])
    }

    @objc func keepAwake(_ call: CAPPluginCall) {
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true; call.resolve() }
    }

    @objc func allowSleep(_ call: CAPPluginCall) {
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false; call.resolve() }
    }

    /// iPhone/iPad are never the leanback "TV" layout (that path is Android
    /// TV / Fire TV only). tvOS would be a separate target.
    @objc func isTv(_ call: CAPPluginCall) {
        call.resolve(["tv": false])
    }

    // MARK: - VLCMediaPlayerDelegate ----------------------------------------

    public func mediaPlayerStateChanged(_ aNotification: Notification) {
        guard let p = player else { return }
        switch p.state {
        case .opening:
            emitState("opening")
        case .buffering:
            // MobileVLCKit doesn't surface a buffering % on this delegate; the JS
            // side only needs the event to keep the "alive" watchdog fed.
            notifyListeners("buffering", data: ["percent": 0])
            emitState("buffering")
        case .playing:
            lengthMs = Int(p.media?.length.intValue ?? 0)
            emitState("playing")
            if !readyFired {
                readyFired = true
                notifyListeners("ready", data: ["duration": Double(lengthMs) / 1000.0])
            }
            // A playing player with a video track ⇒ frames are on screen.
            if p.hasVideoOut {
                notifyListeners("vout", data: ["count": 1])
            }
        case .paused:
            emitState("paused")
        case .stopped:
            emitState("stopped")
        case .ended:
            emitState("ended")
            notifyListeners("ended", data: [:])
        case .error:
            emitState("error")
            notifyListeners("error", data: ["message": "MobileVLCKit error (could not open/decode the stream)"])
        default:
            break
        }
    }

    public func mediaPlayerTimeChanged(_ aNotification: Notification) {
        guard let p = player else { return }
        if lengthMs == 0 { lengthMs = Int(p.media?.length.intValue ?? 0) }
        let current = Double(p.time.intValue) / 1000.0
        notifyListeners("timeupdate", data: [
            "currentTime": current,
            "duration": Double(lengthMs) / 1000.0
        ])
    }
}
