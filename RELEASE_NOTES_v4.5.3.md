# ZIPTV Pro v4.5.3

Casting reliability overhaul, new on-TV playback controls, and shutdown cleanup.

## 🐛 Fixes

- **Casting works again across all receivers (Samsung DLNA, Fire TV DLNA, eShare).**
  The Electron cast manager was handing receivers an unreachable IP when virtual
  network adapters (Hyper-V `vEthernet`, WSL, Docker, VPNs) were present — a
  regression introduced alongside the native player / codecs work. It now filters
  out virtual/VPN adapters and ranks real LAN ranges, matching the server's IP
  selection, and prefers the receiver's own /24 subnet.
- **Cast menu no longer opens behind the video in fullscreen.** The device picker
  is now mounted into the active fullscreen element instead of `document.body`, so
  it renders above the player.
- **Stray `ffmpeg.exe` left running after closing the app is now cleaned up.** All
  ffmpeg children spawned by the transcode/probe endpoints are tracked and
  force-killed on quit (Windows process-tree kill via `taskkill /T /F`), with
  cleanup hooked to every shutdown path.

## ✨ Features

- **On-TV playback controls** added to the "Playing on TV" overlay:
  - Play / Pause
  - Previous / Next (channel for live, episode for series; hidden for single movies)
  - Volume slider + mute
  - Seek bar for VOD (movies/series), with elapsed/total time
- **Live casting to eShare-type renderers** now uses HLS instead of raw MPEG-TS,
  which those apps can't sustain (gated to eShare so the Samsung/Fire TV TS path
  is untouched).
- **Continue Watching now groups series.** Each show shows a single card for its
  most recently watched episode instead of one card per episode. Display-only —
  every episode's progress is still saved, and resuming opens the right episode.

## ♻️ Internal

- **`electron/cast-manager.cjs` rewritten from scratch** — clean structure, named
  DLNA flag constants, and idempotent renderer shims, while preserving the exact
  Samsung compatibility behavior verbatim:
  - `PrepareForConnection → ENOACTION` shim (fixes UPnP 701/704)
  - `DLNA.ORG_FLAGS=ED10…` + `MPEG_TS_NA_ISO` live profile, byte-seek for VOD
    (fixes UPnP 716)
- New `cast:control` **`volume`** action and a new **`cast:status`** IPC. Status
  reads DLNA position via `AVTransport GetPositionInfo` (parsing `H:MM:SS`
  `RelTime`/`TrackDuration`) and Chromecast position via `.status()`, powering the
  VOD seek bar.
- Server `dlnaProfile` / `/cast` route now serve live `.m3u8` with the correct
  `application/x-mpegurl` content type for eShare HLS.
- `electronCast` preload bridge extended with `status`.

## 📦 Build / upgrade notes

- Existing installs will auto-update (version increment from 4.5.0).
- One-time per machine: if casting still buffers, allow the app's server port
  through Windows Firewall (inbound TCP, preferred port `56789`):
  `netsh advfirewall firewall add rule name="ZIPTV Pro" dir=in action=allow protocol=TCP localport=56789`

## Files changed

- `electron/cast-manager.cjs` — full rewrite (IP selection, volume, status, DLNA position)
- `electron/preload.cjs` — `cast:status` bridge
- `main.electron.cjs` — kill child processes on quit
- `server/index.js` — eShare live HLS profile; ffmpeg child tracking + cleanup
- `src/components/cast.js` — overlay controls, eShare HLS, fullscreen picker mount
- `src/main.js` — Continue Watching series grouping
- `index.html` — cast overlay control markup
- `src/style.css` — cast control styling
