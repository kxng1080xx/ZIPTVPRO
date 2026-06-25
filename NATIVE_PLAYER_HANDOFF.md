# Handoff — Native/Desktop Player (uncommitted, needs build + device test)

_Last updated 2026-06-23. Everything below is in the working tree, NOT committed or released._

## Two-Claude workflow
- **Cowork-Claude** edits code; it CANNOT build reliably (the Linux mount NUL-pads files).
- **You (Claude-in-VS-Code)** build, install, and device-test, then append findings at the bottom.
- ⚠️ Both edit `src/components/player.js` + `src/style.css` — **re-read from disk before editing.**

---

## Current state (what works)
- **Android (APK):** native libVLC player WORKS — E-AC3 audio + HEVC Main10 video + behind-WebView
  compositing all confirmed on device. Boxed-by-default, fullscreen is an explicit toggle,
  landscape-only fullscreen, no browser Fullscreen API on native. This is DONE; don't touch unless
  testing regressions.
- **Desktop (Electron):** normal framed window with native OS min/max/close (the mpv embed was
  reverted — see history). Premium VOD now plays via **server-side ffmpeg transcode** (below).
- **Web:** unchanged, uses the browser `<video>`/hls.js/mpegts.js chain.

---

## What changed this session (uncommitted)

### 1. Electron mpv embed REVERTED
Reverted to pre-mpv (`ebac97c`). The mpv embed needed a `transparent:true` + `setParentWindow`
window, which removed the native frame and broke the window controls. Files restored/cleaned:
`main.electron.cjs`, `electron/preload.cjs`, `src/main.js`, `index.html`, `src/style.css`,
`package.json`, `src/components/native-player.js`. Android untouched.
- `extraResources/mpv.*` (~280MB) is now unused — safe to delete.

### 2. Desktop premium-VOD = ffmpeg transcode (the chosen approach)
Stock Electron 42 HW-decodes HEVC video but NOT E-AC3 audio, so premium VOD (MKV/HEVC Main10 +
E-AC3) plays silent/not at all. We transcode it server-side and feed the existing `<video>`.
- `server/index.js`: `GET /api/transcode?url=<target>&mode=audio|full&start=N` — spawns ffmpeg,
  pipes fragmented MP4. `mode=audio` (default) = copy HEVC video + E-AC3→AAC (cheap; needs GPU
  HEVC decode). `mode=full` = also re-encode video→H.264 (any GPU). `findFfmpeg()` resolves the
  bundled binary (`<resources>/bin`) or PATH; ffmpeg is killed on client disconnect.
- `src/components/player.js`: desktop-only fallback. After the browser VOD chain is exhausted and
  `_isElectron()`, it tries transcode `audio`, then `full` (`_playViaTranscode` /
  `_buildTranscodeUrl`). Web/Android never call it.
- `scripts/fetch-ffmpeg.mjs` + `package.json`: `npm run fetch:ffmpeg` downloads a static Windows
  ffmpeg into `extraResources/`; `build.extraResources` bundles `ffmpeg*`→`<resources>/bin`;
  `electron:dist` runs the fetch first.

### 3. `electron-codecs/` = NOT the path (kept as documented fallback only)
A custom Electron-with-codecs compile. Rejected: ~120GB download/build. Ignore unless the
transcode approach proves insufficient. Don't build it.

---

## ▶ YOUR NEXT STEPS (build + test)

### A. Desktop EXE + transcode test
```
npm run electron:dist
```
(auto-runs `fetch:ffmpeg` → bump → vite build → electron-builder; minutes, no Chromium compile)

Test checklist — report PASS/FAIL:
- [ ] App launches; window has working native min/max/close (no missing controls).
- [ ] Cheap mp4 VOD plays normally (no transcode).
- [ ] Live TV plays normally.
- [ ] **Premium VOD** (e.g. HotD S03E01, MKV/HEVC Main10 + E-AC3): browser chain fails, console
      logs `Falling back to server transcode (audio)`, then **video + AUDIO play in-app**.
- [ ] If video is black but audio plays → GPU can't HW-decode HEVC10; confirm it escalates to
      `(full)` and plays. Report which tier worked + any startup lag.
- [ ] Stop/back returns to catalog, ffmpeg process exits (check Task Manager — no orphan ffmpeg).

If transcode fails to start: confirm `extraResources/ffmpeg.exe` exists after build, and check the
server console for `[transcode] ffmpeg error`.

### B. Android regression sanity (only if you changed shared files)
```
npm run apk
```
Live/series/movie play; portrait docked, landscape boxed, fullscreen toggle landscape-only.

---

## Known TODOs (after playback confirmed)
- ~~**Seeking on transcoded VOD**~~ **DONE 2026-06-23** (VS-Code-Claude) — see "Seekable transcode" below.
- **`electron:dist` `latest.exe` is broken**: the `copy /Y "ZIPTV-Pro-Setup-*.exe" latest.exe` wildcard
  matches ALL 18 old installers → `latest.exe` is 6KB junk. Use the versioned
  `dist-electron/ZIPTV-Pro-Setup-<ver>.exe` instead. Fix the copy step to target the newest only.
- Delete unused `extraResources/mpv.*` (~280MB).
- Version bump + single release (APK + EXE) once desktop transcode + Android both verified.
  Keep `package.json` version in sync with `android/app/build.gradle` versionName/versionCode.

## Build commands
- Web: `npm run build`
- EXE: `npm run electron:dist` (needs `asar:false` — already set; ESM server can't load from asar)
- APK: `npm run apk`

## Gotchas
- Electron must keep `asar:false` (in-process ESM server can't import from asar → black screen).
- Hosted domain is `ziptvpro-nu.vercel.app`.

## Seekable transcode (2026-06-23, VS-Code-Claude — in 4.2.9 build)
Desktop transcode CONFIRMED working: HotD S3E1 plays HD video+audio via the `audio` tier. But the
piped fMP4 has no real total duration (the seek bar grew with playback and couldn't scrub). Fixed:
- `server/index.js`: new `GET /api/probe?url=` runs the bundled `ffmpeg -i <url>` and parses
  `Duration: HH:MM:SS` from stderr → `{ duration }` (seconds). No ffprobe needed.
- `src/components/player.js`: transcode state `_transcodeActive/_transcodeOffset/_transcodeDuration/`
  `_transcodeMode`. `_totalDuration()`/`_currentTime()` feed the seek bar (real probed length +
  offset-adjusted time). Scrub on a transcoded stream → `_seekTranscode(T)` re-requests
  `/api/transcode?...&start=T` (server `-ss`) and tracks the new base offset. `_playViaTranscode`
  probes duration once (best-effort) and clears `pendingSeek` so resume isn't double-applied. State
  reset in `loadStream()` + `stop()`. Web/Android paths unaffected (`_transcodeActive` stays false).
NEXT: device-test the 4.2.9 EXE — confirm the bar shows the real episode length, scrub jumps (expect
a ~1-3s re-buffer per seek, by design), resume position still works. Each scrub = a fresh ffmpeg.

---
## Device test log (append dated PASS/FAIL notes below)
