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

## Route 0 — Free test on your OWN device (no $99, before you commit)

Validate that the app + MobileVLCKit playback actually work on a real iPhone/iPad
**without paying** — using Xcode's free "personal team" signing.

**Still needs a Mac.** iOS apps can't be compiled or installed onto a device
without Xcode (macOS only). Free removes the $99 membership, not the Mac. A
rented *cloud* Mac won't work here — free-provisioning install needs the device
physically connected — so borrow a physical Mac in the same room as your phone.

**Limits of the free route:** the app **expires after 7 days** (re-run to
reinstall), max 3 sideloaded apps, your own devices only, **no TestFlight**.

Steps (on the borrowed Mac, ~15 min):
1. Install **Xcode** (Mac App Store, free). Open it once to finish setup.
2. Xcode → **Settings → Accounts → +** → sign in with any **free Apple ID**
   (no paid membership). This creates a "Personal Team".
3. Clone + prepare the app:
   ```bash
   git clone https://github.com/kxng1080xx/ZIPTVPRO.git && cd ZIPTVPRO
   npm ci && npm run build
   npx cap add ios && npx cap sync ios
   cd ios/App && pod install     # pulls MobileVLCKit
   open App.xcworkspace
   ```
4. In Xcode: select the **App** target → **Signing & Capabilities**:
   - **Team** → your Personal Team.
   - **Bundle Identifier** → change to something unique for the free test, e.g.
     `com.leon.ziptv.dev` (a free team can't reuse an id another team owns; the
     real `com.iptv.player.zero` is reserved for the paid TestFlight build).
5. Plug your iPhone/iPad in via USB, unlock it, tap **Trust** on the phone.
6. Pick your device in Xcode's run-target dropdown, press **▶ Run**.
7. First launch: on the phone, **Settings → General → VPN & Device Management**
   → tap your Apple ID → **Trust**. Reopen the app.
8. Test playback (especially non-HLS: MKV / HEVC / E-AC3 VOD) to confirm the VLC
   plugin works before you spend anything.

If it works, come back to Route A/B and pay the $99 to ship via TestFlight.

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
