# ZIPTV Pro on iOS / iPadOS — TestFlight setup

This scaffolds ZIPTV Pro for iPhone/iPad as a Capacitor app with a native
**MobileVLCKit** player (same VLC engine as the Android build), distributed via
**TestFlight**.

Everything here is authored on Windows, but **iOS builds require macOS** — use
the Codemagic pipeline (recommended, no Mac needed) or a Mac.

---

## What's already in the repo

| Piece | Where | Purpose |
|---|---|---|
| iOS platform dep | `@capacitor/ios` in `package.json` | Capacitor iOS support |
| iOS config | `capacitor.config.json` → `ios` block | UA, transparent bg, scheme |
| Native player plugin | `ios-native-video/` | MobileVLCKit, mirrors the Android `NativeVideo` plugin (`load/play/pause/seek/setRect/stop/getAudioTracks/…`, events `ready/state/vout/timeupdate/buffering/ended/error`) |
| Plugin wired in JS | `src/components/native-player.js` | now registers `NativeVideo` on `ios` too |
| CI → TestFlight | `codemagic.yaml` | builds + signs + uploads on macOS |

The `ios/` Xcode project itself is **not** committed — it's generated on macOS by
`npx cap add ios` (the CI does this automatically on first run).

---

## Playback: what works, and what needs VLC

- **HLS (`.m3u8`)** plays through WKWebView's `<video>` (AVPlayer) with **zero
  native code** — so a build works for HLS content even before MobileVLCKit is
  proven on-device.
- **Raw MPEG-TS, MKV, HEVC + E-AC3/AC3** can't go through WKWebView (no MSE, so
  `mpegts.js` can't run; AVPlayer won't do those containers/codecs). Those route
  to the `ios-native-video` MobileVLCKit plugin — same coverage as Android.

The JS bridge races native against the `<video>` fallback, so if the VLC plugin
misbehaves the stream degrades to AVPlayer rather than breaking.

> ⚠️ The Swift in `ios-native-video/` is authored on Windows and compiles on
> macOS. Expect to iterate on the video-behind-webview **compositing** and the
> `setRect` **frame math** on a real device — that part can't be verified from
> Windows.

---

## Route A — Codemagic (recommended, build from Windows)

1. **Apple Developer Program** — enroll ($99/yr) at developer.apple.com.
2. **Create the app record** in [App Store Connect](https://appstoreconnect.apple.com):
   My Apps → **+** → New App → bundle id **`com.iptv.player.zero`**. Note the
   numeric **Apple ID** shown under App Information.
3. **App Store Connect API key** — Users and Access → Integrations → App Store
   Connect API → generate a key with the **App Manager** role. Download the
   `.p8` (once only) and note the Key ID + Issuer ID.
4. **Codemagic** — sign in at codemagic.io with the GitHub repo, then:
   - Teams → Integrations → **App Store Connect** → add the key from step 3,
     name it exactly **`ZIPTV_ASC`** (matches `codemagic.yaml`).
   - Edit `codemagic.yaml`: set `APP_STORE_APPLE_ID` to the number from step 2,
     and set `beta_groups` to your TestFlight group name.
5. **TestFlight group** — App Store Connect → your app → TestFlight → create a
   group (e.g. **ZIPTV Testers**) matching `beta_groups`.
6. **Run** the `ios-testflight` workflow (push to `main`, or start it manually).
   First run auto-creates the signing cert + profile and uploads the build.
7. TestFlight processes the build (~5–15 min), then testers get the invite.

## Route B — local Mac (Xcode)

```bash
npm ci
npm run build
npx cap add ios          # first time only
npx cap sync ios
cd ios/App && pod install # pulls MobileVLCKit
open App.xcworkspace
```
In Xcode: select the **App** target → Signing & Capabilities → your Team →
bundle id `com.iptv.player.zero`. Then **Product → Archive** →
**Distribute App → App Store Connect → Upload** → TestFlight.

---

## After every code change (from Windows)

```bash
npm run build          # rebuild web assets
git commit && git push # Codemagic rebuilds + re-uploads to TestFlight
```
`npx cap sync ios` (run by CI) re-copies `dist/` into the iOS app and keeps the
MobileVLCKit pod wired.

---

## App Review reality (read before submitting publicly)

TestFlight has a lighter review than the App Store, but IPTV apps still draw
scrutiny under guidelines **5.2 (intellectual property)** and **4.3 (spam)**.
To reduce rejection risk:

- Frame ZIPTV as a **neutral player** — the user brings their own Xtream/M3U
  playlist. Don't bundle channels, logos, or anything that signals a specific
  paid service or piracy.
- In the TestFlight/App Review notes, state it's a generic media player for
  user-supplied playlists (the way VLC / nPlayer are described), and provide a
  demo playlist + login for the reviewer.
- **Never** ship this to customers via the Apple **Enterprise** program — that's
  for internal-org apps only and Apple revokes the certificate (killing every
  install at once) when used for public distribution.

TestFlight allows up to **10,000 external testers** via an invite link — a
practical channel for a known customer base without a full public App Store
listing.
