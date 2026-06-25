# ZIPTV Pro v4.5.5

Casting control polish and a phone screen-sleep fix.

## 🐛 Fixes

- **Phone screen no longer sleeps during playback (Android).** Playback now holds an activity-level wake lock (`FLAG_KEEP_SCREEN_ON`), which covers both the native libVLC surface and the WebView `<video>` fallback. The screen is released when playback stops, and while casting (the TV is playing, so the phone can sleep).
- **Seek bar now controls the movie while casting (Electron).** Dragging the bar previously did nothing because the seek was skipped whenever the receiver didn't report a track duration (common on DLNA, e.g. the Fire TV app). The movie's duration is now captured from the local player at cast time and used as the scale, so seeking works regardless; device-reported duration still takes over when available.
- **Cast seek bar now advances.** Position is estimated each second while playing and snapped to the receiver's reported position whenever it provides one, so the bar progresses instead of sitting at 0:00.

## ✨ Features

- **Cast button is highlighted while casting** — it turns cyan with a subtle background so it's clear a cast is active.

## ♻️ Internal

- `NativeVideoPlugin` gains `keepAwake` / `allowSleep` plugin methods (UI-thread window-flag toggles); exposed via `native-player.js` `setScreenAwake()` and driven by the player on play/stop and cast handoff.
- Cast position/duration tracking in `cast.js`: `castKnownDuration` (local fallback), `castPosition` estimator, and `castDuration` (device-preferred), feeding the reused `#player-controls` seek bar.

## 📦 Build / upgrade notes

This release spans both targets — build each, then publish:

- `npm run electron:dist` (Windows `latest.exe`, bumps version)
- `NO_BUMP=true npm run apk` (Android `app.apk`, keeps the same version)
- `npm run release` (uploads both to the GitHub release; needs `GH_TOKEN`)

The Android wake-lock fix ships in the APK; the cast seek/button changes ship in both.

## Files changed

- `android/app/src/main/java/com/iptv/player/zero/NativeVideoPlugin.java` — keepAwake/allowSleep
- `src/components/native-player.js` — `setScreenAwake()`
- `src/components/player.js` — wake lock on play/stop/cast; (cast control routing)
- `src/components/cast.js` — cast seek duration fallback + position estimator
- `src/style.css` — cast button highlight while casting
