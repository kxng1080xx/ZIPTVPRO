# ZIPTV Pro v4.5.3

Casting reliability overhaul, casting now uses the normal player controls, Continue Watching cleanup, and proper shutdown of background processes.

## 🐛 Fixes

- **Casting works again across all receivers (Samsung DLNA, Fire TV DLNA, eShare).**
  The Electron cast manager was handing receivers an unreachable IP whenever
  virtual network adapters (Hyper-V `vEthernet`, WSL, Docker, VPNs) were present —
  a regression introduced alongside the native-player/codecs work. It now filters
  out virtual/VPN adapters and ranks real LAN ranges (matching the server), and
  prefers the receiver's own /24 subnet.
- **Cast device picker no longer opens behind the video in fullscreen.** It now
  mounts into the active fullscreen element instead of `document.body`.
- **Seek bar while casting shows total time and tracks progress.** Position now
  comes from the DLNA renderer's `AVTransport GetPositionInfo` (it previously
  relied on a Chromecast-only status call that DLNA devices don't provide).
- **No more stray `ffmpeg.exe` left running after closing the app.** Every ffmpeg
  child (transcode + duration probe) is tracked and force-killed on quit (Windows
  process-tree kill via `taskkill /T /F`), hooked to every shutdown path.

## ✨ Features

- **Casting now uses the normal on-screen player controls.** Instead of a separate
  control card, the regular player bar stays on screen over a "Playing on TV"
  backdrop and drives the receiver directly:
  - Play / Pause
  - Seek bar (VOD; hidden for live), with elapsed/total time
  - Volume slider + mute
  - Previous / Next (channel for live, episode for series)
  - Stop (ends the cast)
- **Live casting to eShare-type renderers** now uses HLS instead of raw MPEG-TS,
  which those apps can't sustain — gated to eShare so the Samsung/Fire TV TS path
  is untouched.
- **Continue Watching groups series.** Each show shows a single card for its most
  recently watched episode instead of one card per episode. Display-only — all
  episode progress is still saved and resuming opens the correct episode.

## ♻️ Internal

- **`electron/cast-manager.cjs` rewritten** — cleaner structure with named DLNA
  flag constants and idempotent renderer shims, preserving the exact Samsung
  compatibility behavior verbatim:
  - `PrepareForConnection → ENOACTION` shim (fixes UPnP 701/704)
  - `DLNA.ORG_FLAGS=ED10…` + `MPEG_TS_NA_ISO` live profile; byte-seek for VOD
    (fixes UPnP 716)
- New `cast:control` **`volume`** action and **`cast:status`** IPC. Status reads
  DLNA position via `AVTransport GetPositionInfo` (parsing `H:MM:SS`) and
  Chromecast via `.status()`.
- New `window.castControls` API; the player's existing control handlers route
  play/pause, seek, volume, mute, and stop to the active cast (guarded so local
  playback is unaffected when not casting).
- Server `dlnaProfile` / `/cast` route serve live `.m3u8` with the correct
  `application/x-mpegurl` content type for eShare HLS.
- `electronCast` preload bridge extended with `status`.

## 📦 Build / upgrade notes

- Existing installs auto-update from the previous release.
- One-time per machine: if casting still buffers, allow the app's server port
  through Windows Firewall (inbound TCP, preferred port `56789`):
  `netsh advfirewall firewall add rule name="ZIPTV Pro" dir=in action=allow protocol=TCP localport=56789`

## Files changed

- `electron/cast-manager.cjs` — IP selection, volume action, status (DLNA position)
- `electron/preload.cjs` — `cast:status` bridge
- `main.electron.cjs` — kill child processes on quit
- `server/index.js` — eShare live HLS profile; ffmpeg child tracking + cleanup
- `src/components/cast.js` — `castControls` API, bar-driven status poll, fullscreen picker mount, eShare HLS
- `src/components/player.js` — route player-bar controls to cast; `body.casting`
- `src/main.js` — Continue Watching series grouping
- `index.html` — cast overlay reduced to backdrop
- `src/style.css` — backdrop below the control bar; bar kept visible while casting
