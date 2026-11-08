# ZIPTV v10 — handoff log (updated 2026-11-06, end of session 2)

v10 = full native rebuild for **speed + reliability** with **one unified UI** that
adapts to the device (TV/projector, phone/tablet, Windows PC) — no mode switching,
no second interface. Must reach **feature parity with v9** (tracker: `PARITY.md`)
before it replaces the Electron/Capacitor app. Look & feel follows v9's tokens
(navy bg, blue→cyan accent, sky-blue focus ring, red LIVE).

## Layout
```
native/
  core/                Rust crate `ziptv_core` (uniffi → Kotlin package com.ziptv.core)
    src/lib.rs         Provider: login, sync (sequential, 3x retry, non-JSON = failure),
                       catalog cache, categories/channels/movies/series, search, URLs
                       (live/movie/episode/catch-up), episodes, EPG (external first),
                       lookups by id, recently-added
    src/xtream.rs      HTTP client (ureq; read_to_string — into_string caps at 10 MB)
    src/epg.rs         external guide (epg-data branch) + provider EPG, base64 rule
    src/names.rs       channel-name cleanup + logo/EPG keys (ports of v9 JS)
    src/user.rs        UserStore: favorites, pins, recent, continue-watching, reminders, settings
    src/cloud.rs       Cloud: device code, heartbeat (admin playlists, expiry, VPN cfg),
                       add/remove/remove-all playlists, pair/unpair, history mirror.
                       Cloudflare Pages ONLY (user: "scratch Vercel completely")
    src/tmdb.rs        TMDB lookup (title cleaning, best_match by exact title + votes), disk cache
    src/update.rs      check_update: newest v10+ GitHub release + platform asset
    src/recorder.rs    DVR: records live TS to file, reconnects, schedules (wired into the UI)
    src/m3u.rs         plain-M3U parser (group-title, tvg-logo, tvg-id; VOD by extension)
    build.sh           tests + desktop DLL + Kotlin bindings + Android .so (4 ABIs incl. x86)
                       FAST=1 = dev build (no LTO, no tests, arm64 only; ABIS="x86" for the TV
                       emulator) ~16 s vs ~6 min. Optimized builds run on GitHub (below).
    examples/smoke.rs  live test: cargo run --release --example smoke -- <server> <user> <pass> [--sync]
  app/                 Gradle 8.14.3, AGP 8.13, Kotlin 2.4.20, CMP 1.12.2
    shared/kotlin/     ONE UI for all devices (both apps compile it via srcDir, no KMP module)
      com/ziptv/core/ziptv_core.kt   generated bindings (regenerate with core/build.sh)
      com/ziptv/app/   App (rail/bottom bar + header search), Home (hero/backdrops/rows),
                       Live (categories/channels/preview/guide), GuideScreen (full grid),
                       VodScreens (movies/series/details/search), PlayerScreen (fullscreen),
                       PlayerControls (shared control row + More menu + vertical volume),
                       MiniPlayer (cable-style corner player / desktop PiP), Meta (TMDB About),
                       AccountScreens (activation code, playlists, settings), Categories,
                       LogoContrast (dark-logo whitening), Theme (v9 tokens, focusRing), Platform
    androidApp/        MainActivity (device detection, PiP, immersive), VlcPlayer (libVLC 3.6.5)
    desktopApp/        Main (single instance :47613, fullscreen window, Esc=back), VlcjPlayer
                       (vlcj → Skia bitmap so controls draw over video), LogoContrast adapter
  PARITY.md            feature checklist vs v9
```

## Build / run
- Core: `bash native/core/build.sh` (or `--skip-android` for fast PC iteration — then the
  Android .so are STALE; run the full build before any APK). Needs Rust (`~/.cargo/bin`),
  NDK 27.2 at `%LOCALAPPDATA%/Android/Sdk/ndk/27.2.12479018`, cargo-ndk.
- PC: `cd native/app && ./gradlew.bat :desktopApp:run` (uses the VLC installed on the PC).
  Data dir `~/.ziptv10` (playlists.tsv, catalog-*.json, user-*.json, tmdb.json, device_code).
  BEFORE relaunching, kill every instance by command line (`com.ziptv.desktop.MainKt`) —
  the app is single-instance, a stale copy swallows the new launch.
- APK: `./gradlew.bat :androidApp:assembleDebug` → install with adb
  (`C:/Program Files (x86)/Android/android-sdk/platform-tools/adb.exe`; in Git Bash set
  `MSYS_NO_PATHCONV=1`). Seed a test playlist: push playlists.tsv and copy it into
  `files/` via `run-as com.ziptv.app`.
- TMDB token is read from the repo `.env` (`TMDB_TOKEN`) at build time.
- Fire TV (Stick 4K `AFTMM`, Fire OS 6.7 = API 25, 32-bit armeabi-v7a) over Wi-Fi adb
  (192.168.0.26:5555): plain `adb install` drops the link. Build a one-ABI APK
  (`-Pziptv.abis=armeabi-v7a`, ~42 MB), push it in 4 MB `split` chunks (retry each), `cat`
  them on the device, then `nohup pm install -r` and read the log.
- Phone over wireless adb: adb is `%LOCALAPPDATA%/Android/Sdk/platform-tools/adb.exe`; the port
  changes — reconnect with `adb mdns services` + `adb connect <ip:port>` (needs sandbox off).
- PC installer: `./gradlew.bat :desktopApp:createDistributable` (or `packageMsi`) — bundles the
  trimmed VLC. Uses JDK 26's jpackage (JBR has none); override with JPACKAGE_JDK.
- Release: GitHub Actions `.github/workflows/native-release.yml` (manual) builds optimized
  core + APK + MSI and publishes `v<ziptv.version>` with `--latest=false` (v9 keeps "latest").
  Needs repo secrets ANDROID_DEBUG_KEYSTORE (base64 ~/.android/debug.keystore) and TMDB_TOKEN —
  NOT set yet; the workflow has never been run.

## Build gotchas (all solved, keep them)
- gradle.properties: `org.gradle.java.home=C:/Program Files/Android/Android Studio/jbr`
  (system JDK 26 breaks Gradle 8.14; forward slashes).
- Android: compileSdk 36 + buildToolsVersion 36.0.0 from the Program Files SDK
  (`native/app/local.properties`); Compose BOM pinned 2025.06.00, Coil 3.2.0,
  activity-compose 1.10.1 (newer need AGP 9.1 / compileSdk 37). Desktop uses newest CMP.
- uniffi names must not clash with Kotlin: no `Library`, no `Companion`, no error field `message`
  (errors are `flat_error`).
- Generating bindings on Linux: the release profile strips the `.so`, and uniffi-bindgen then
  silently writes nothing. Build an unstripped copy (`CARGO_PROFILE_RELEASE_STRIP=false cargo
  build --release --lib --target-dir target/unstripped`) and point `--library` at it.
- User's TV emulator is 32-bit **x86** Android 36 → core builds `-t x86` too.
- TV density 0.9x; rail scrolls. Text outside a Surface needs LocalContentColor (set in theme).

## Done (35+ parity items ✅, see PARITY.md)
Login + activation code + admin playlists/expiry/hidden tabs & categories; fast sync with
retry/keep-old; catalog cache; channel cleanup; iptv-org logos; dark-logo whitening;
external EPG; full guide grid; catch-up (fixed v9's missing `stream=`); reminders; sleep
timer; favorites; pinned categories; recent; continue watching + resume (10s saves, cloud
mirror, companion hand-off row); category sort; quality badges; TMDB About/cast/trailer;
Home hero (backdrop, Resume/Details/My list), recently added rows; header search;
fullscreen player (10s auto-hide, NOW/NEXT inline with buttons, top-left 4-channel panel,
zapping, ±10s/seek, Go Live, vertical volume, More menu: audio/subs, deinterlace, sleep,
stop; PiP button on the bar); mini player (cable-style, also desktop PiP); whole-screen
fullscreen (PC window / Android immersive); single instance (PC); remove-all playlists.

## Left to do (in suggested order)
1. ~~DVR UI~~ DONE: More → "Record this channel" (until the show ends), long-press a guide
   row to schedule, Home "Recordings" row (tap = play, long-press = stop/delete).
   Not yet verified end-to-end on a real channel.
2. ~~Update check~~ DONE (core `check_update`, banner with Download; only tags >= v10,
   picks .msi/.exe for PC, .apk for Android). Left: silent install, and v10 releases must
   attach those assets (MSI from `:desktopApp:packageMsi`, APK).
3. ~~Bundle VLC with the PC installer~~ DONE: `prepareVlc` copies a trimmed VLC (playback
   plugins only, ~100 MB) from VLC_DIR / Program Files into app resources; VlcjPlayer points
   jna.library.path at it (`~/.ziptv10/vlc.log` says which VLC loaded; ZIPTV_SYSTEM_VLC=1 forces
   the installed one). Packaging needs a JDK with jpackage (JPACKAGE_JDK, default JDK 26).
4. ~~M3U playlists~~ DONE (core tests incl. an end-to-end local-server test): a playlist with an
   empty username is a plain M3U (server = playlist URL). Provider.sync downloads + `m3u::parse`,
   entries keep their own URL (`Catalog.urls`), login only probes the first bytes, EPG = external
   guide only. Add-playlist form saves non-get.php links as M3U. Not yet tried with a real
   provider M3U on a device.
5. ~~Stalker portal playlists~~ SKIPPED (user decision, 2026-11-06: not needed in v10).
6. ~~Built-in VPN~~ SKIPPED (user decision, 2026-11-06).
7. ~~Watch Together~~ DONE (user, 2026-11-08).
8. ~~Chromecast~~ DONE in 10.0.2 (e1f1939: mDNS + CASTV2, live via proxied HLS).
9. ~~Online subtitle search~~ SKIPPED (user, 2026-11-06).
10. ~~Muted trailer preview on poster dwell~~ SKIPPED (user, 2026-11-06).
11. ~~Share tunnel~~ DONE in 10.1.0 (PC): Settings > Network > "Watch away from home" runs a
    cloudflared quick tunnel (desktopApp CloudflaredTunnel, binary downloaded to ~/.ziptv10/bin on
    first use) to the LAN server. Tunnel visitors (cf-ray / cf-connecting-ip headers) need the
    per-launch share token: `?stk=` -> cookie + redirect (LanServer.guard, test in lan.rs).
    Not yet tried through Cloudflare for real. The /tv page is TV-first; phones get it as-is.
12. Short-cycle provider resilience in the in-app player: the LAN server already has v9's PTS
    splice / byte-resume (core/src/stream.rs); playing through it would give the app the same.
13. ~~Release plumbing~~ DONE (see "Release" below).

## Open bugs / to verify
- ~~Black movies/episodes on PC~~ FIXED: GPU decoding never reached the frame callback;
  VlcjPlayer now plays with `:avcodec-hw=none` (ZIPTV_HW_DECODE=1 to re-enable).
- DVR "Failed" recordings: cause = one-stream plans (player held the only connection; recorder
  got refused → 0-byte files). FIXED for "Record this channel" (checks login max_connections,
  stops playback first). FIXED for scheduled recordings too (2026-11-08): AppModel's 15 s tick
  stops playback ~20 s before a schedule starts on one-stream plans (also schedules made on the
  TV web page, and guide schedules of a show already on air). The recorder retries ~1 min, so
  the tick is early enough. `Recording.error` now says why one failed ("provider refused…",
  "app was closed…"; never the URL) and the Home row shows it. Not device-tested yet.
  Still open: "Record" pressed on the TV web page while the PC plays on a one-stream plan.
- Verify every screen with the D-pad on the TV emulator (only Home/rail checked so far).
- Phone layout not yet tested on an emulator (phone AVD `ZIPTV_Phone` exists but booted black).
- v10 was merged into `main` on 2026-11-08 (b123db2); `main` and `v10-native` are kept in sync.

## Session 2 (2026-11-06) — what changed, for context
Settings redone as v9 sections (Account & Playlists / Playback / Network / Application; phones:
list → section). Native animations (tab/screen crossfade, player zoom, mini slide, list items,
shimmer skeletons for posters/episodes/TMDB info, image fade-in). Phone Live redesign: player on
top + one panel (categories → channels, back), landscape = player + panel side by side; reopens
on the last category (setting `live_cat`, per playlist). Movies/Series have NO categories now
(search + Home "My list" rows). Auto-next episode with Up next card (PlayerState.Ended). Slim
seek bar inside the control row. Guide: time ruler + now line, no chips, Guide button hidden
on "All channels". Phone menus are bottom sheets. Mini player: phone size 220 dp, shows in
portrait above the tab bar; TVs/sticks never use system PiP (in-app mini instead).
Android fixes: crash closing fullscreen (double attachViews) and black video after moving
between views (VlcPlayer.attach: video track off → swap views → on). Cozi guide (EPG lookup
tries with/without a trailing "tv"). PC: preview no longer huge on big windows; black VOD fixed
(CPU decode); VLC bundled. All on branch `v10-native` (last pushed commits listed by `git log`).

## Release 10.0 (v10 REPLACES v9 — user decision 2026-11-06)
- Android: applicationId = v9's `com.iptv.player.zero`, same debug signing key as v9
  (SHA-256 f9e791a5…), versionCode 100000 > v9's 224 → installs over v9 as an update.
- Windows: per-user EXE installer (`packageExe`, perUserInstall, fixed `upgradeUuid` — never
  change it). First packaged v10 run silently runs v9's `Uninstall ZIPTV Pro.exe /currentuser /S`
  (found via HKCU Uninstall "ZIPTV Pro 9."), once (`~/.ziptv10/v9-removed`).
- Release assets are named `app.apk` and `latest.exe` because ziptvpro.pages.dev/app.apk and
  /latest.exe 302 to `releases/latest/download/<name>` — v9's updaters follow those links.
- Workflow `.github/workflows/native-release.yml` PUBLISHES the release as latest (notes:
  native/RELEASE_NOTES.md) and pushes the root package.json version to `main` itself (so
  version.json updates). It uses the RELEASE_TOKEN secret (fine-grained PAT, contents +
  workflows write): GITHUB_TOKEN started getting HTTP 403 on release creation (Nov 2026).
- To move v9 Android users: v9 shows its update prompt when `ziptvpro.pages.dev/version.json`
  has a higher version. That file is generated from the root package.json at Pages deploy, so
  set root package.json version to 10.0.0 on main and redeploy Pages AFTER publishing.
- v9 device codes ARE kept (core/src/v9.rs reads v9's localStorage leveldb on first run);
  favorites/history start fresh.
- Secrets needed (set by the user; agent writes to secret stores are blocked):
  ANDROID_DEBUG_KEYSTORE, TMDB_TOKEN.
