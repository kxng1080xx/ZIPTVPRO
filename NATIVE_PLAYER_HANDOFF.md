# Native Player — Handoff (in progress, NOT committed/shipped)

_Last updated 2026-06-23. Working in the repo; nothing below is committed or released yet._

---
## ▶ CLAUDE-IN-VS-CODE — START HERE (build + test the latest changes)

Two-Claude workflow: **Cowork-Claude edits the code** (it can't build reliably — the Linux
mount truncates files), **you (VS-Code-Claude) build, install, and device-test**, then report
findings back into this file (append a dated note) so Cowork-Claude can iterate.

**1. Build & install (uncommitted changes are already in the working tree):**
```
npm run build && npx cap sync android && cd android && ./gradlew assembleDebug
```
Output: `android/app/build/outputs/apk/debug/app-debug.apk`. Install on the device/emulator.

**2. What changed since the last APK (player rebuild — see "REBUILD v2" + v3/v4/v5 below):**
- Version bumped to `4.2.0` (minor version bump for feature addition).
- Native player is BOXED by default, fullscreen is an explicit toggle, NO browser Fullscreen API. Files touched: `src/components/player.js`, `src/components/tv-navigation.js`, `src/style.css`, `index.html`.
- Landscape playback auto-enters fullscreen when starting play or when rotating to landscape while playing.
- Toggling fullscreen in landscape transitions between immersive fullscreen and boxed landscape, without forcing rotation.
- Toggling fullscreen in portrait rotates to landscape and enters fullscreen.
- Exiting fullscreen in landscape returns to boxed landscape, unlocking orientation so you can physically rotate back to portrait.
- TV Remote Back/Backspace/Escape keys inside `tv-navigation.js` now correctly exit native fullscreen (`player-fs`) by calling the player's `exitFullscreen` method.

**3. Device test checklist — report PASS/FAIL for each (append results below):**
- [ ] Live: tap channel → plays boxed; portrait = docked, landscape = player box + channel list.
- [ ] Series: episode list shows with NO player box while browsing; tap episode → plays
      (portrait video pinned at top + episodes below; landscape auto-enters fullscreen).
- [ ] Movie: tap → plays.
- [ ] Fullscreen button → immersive (landscape); exit → back to boxed, NOT portrait.
- [ ] Portrait is NEVER fullscreen; fullscreen button in portrait rotates to landscape.
- [ ] Rotate landscape↔portrait while playing: no chrome bleed, no gray placeholder, no black.
- [ ] Back/stop → returns to catalog, audio stops, no video bleeding behind the list.
- [ ] On-screen debug HUD (top-left: native/vout/t/rect) is still present — note its values if
      anything misbehaves; it's TEMP and gets removed before ship.

**4. If something's wrong:** screenshot + the HUD's `rect:`/`dbg:` lines + whether you tapped vs
rotated, and append it under a new "device test #N" note at the bottom. Cowork-Claude will fix.

**5. Still TODO after this works:**
- Strip the debug HUD + "Native: trying…" toasts + dead code (`_rotateForFs`, old rect heuristics);
- APK slim (per-ABI);
- Electron embed;
- Single release (APK + EXE).
---

## Goal
Play streams the browser `<video>` / mpegts.js / hls.js can't decode. Confirmed via
Xtream `get_vod_info` probe that premium VOD (e.g. **House of the Dragon S3E1**) is:
**MKV container + HEVC Main10 (10-bit, `hvc1.2.4.L120.90`) video + E-AC3 5.1 audio**.
Browser stack → video plays silent or not at all. This was ALSO the real cause of the
earlier "series won't play on APK" issue (not provider-side). IPTV Smarters works
because it uses a native player. Cheap VOD is mp4+aac and plays fine (red herring).

## Locked decisions (from the user)
- Native-primary with **automatic browser fallback** (never regress working playback).
- Cover **VOD + live**.
- PC (Electron) engine = **embedded mpv / libVLC**.
- **Ship once** (build everything, then a single release). Added constraint: don't ship
  blind — device-test first.

## Why libVLC (not ExoPlayer)
First built an ExoPlayer/Media3 plugin. On-device it engaged but **hard-failed the
video**: `MediaCodecVideoRenderer error … video/hevc … format_supported=NO_EXCEEDS_CAPABILITIES`
— the device HW decoder can't do HEVC Main10, and ExoPlayer aborts audio too. Switched
Android to **libVLC** (`org.videolan.android:libvlc-all:3.6.5`), which software-decodes
anything — same engine as Smarters' VLC mode.

## What's built (Android — compiles, APK assembles)
- `android/app/src/main/java/com/iptv/player/zero/NativeVideoPlugin.java` — Capacitor
  plugin `NativeVideo` using libVLC `MediaPlayer` + `VLCVideoLayout` inserted BEHIND the
  WebView (WebView set transparent) for compositing. Methods: load/play/pause/seek/
  setVolume/stop/getAudioTracks. Events: ready/timeupdate/buffering/ended/error. UA `VLC/3.0.20`.
- `android/app/src/main/java/com/iptv/player/zero/MainActivity.java` — `registerPlugin(NativeVideoPlugin.class)`.
- `android/app/build.gradle` — libvlc-all dep + `ndk { abiFilters 'arm64-v8a','armeabi-v7a' }`.
  APK is now **~96.7 MB** (libVLC native libs) — slim later via per-ABI splits.
- `src/components/native-player.js` — JS bridge. Android plugin wired; Electron path
  (`window.appHost.nativeVideo`) stubbed for later.
- `src/components/player.js` — `_beginPlayback()` tries native first, falls back to
  `_startPlayback()`. Helpers `_onNativeTime` / `_onNativeError` / `_setPlayPauseIcon`.
  togglePlay / seek / volume / stop / stopLocalPlayback routed to native when `_nativeActive`.
  ⚠️ Contains **TEMPORARY diagnostic toasts** ("Native: trying…", "Native failed: …") —
  REMOVE before final ship.
- `src/style.css` — `body.native-video-active` makes app/player background transparent and
  hides `#main-video-player` so the native surface shows through. ⚠️ Compositing is
  UNVERIFIED on device.

## Device test #1 result (2026-06-23): "Loading Stream…" forever
On HotD S03E01 the spinner never resolved. Toast showed **"Native: trying android…"**
but **no** "Native failed" toast and **no** picture — i.e. libVLC engaged, `Playing`
(→ ready) never fired, and it didn't cleanly error. Classic signs of either a
**buffer loop** (10-bit HEVC software-decode can't sustain real-time, or stream
underruns) or a **failed open** that didn't raise EncounteredError — the old code
couldn't tell these apart (generic spinner) and, on the native timeout, silently
fell back to the browser `<video>` path, which can't decode MKV/HEVC either → eternal spin.

## Diagnostics + resilience added this round (uncommitted)
- `NativeVideoPlugin.java`: emits a `state` event for each libVLC transition
  (`opening` / `buffering:NN` / `playing` / `vout:N` / `stopped` / `error`), a `vout`
  event (count>0 = video actually rendering — also confirms behind-WebView compositing),
  and `buffering` now carries `percent`. Error message is more specific.
- `native-player.js`: `nativePlay()` resolves on `ready`; inactivity timeout (15s) is
  **reset by any opening/buffering/vout/state event** (so a slow-but-alive decode isn't
  killed), capped by a 60s absolute deadline. Reject carries `{ sawLife, lastState }`.
- `player.js`: spinner now shows the real native state ("Opening stream…",
  "Buffering NN%…"). New `_startNativeStallWatch()` errors out if a committed native
  stream makes no time progress for 25s. **No more silent browser dump for VOD**: if
  libVLC opened it (`sawLife`) but failed, we show a clear error instead of handing an
  undecodable MKV to the browser. Browser VOD fallback chain got a per-stage watchdog
  (`_armVodWatchdog`, 12s) so it can never hang the spinner either.
- ⚠️ Diagnostic toasts still present (by design this cycle) — remove before final ship.

## Device test #2 result (2026-06-23): AUDIO WORKS, video BLACK
libVLC decoded both **E-AC3 audio AND HEVC Main10 video** (playback sustains) — the
headline codec problem is solved. Remaining issue is **compositing only**: the video
surface wasn't visible under the WebView. Root cause: VLCVideoLayout was using a
**SurfaceView** (`attachViews(..., useTextureView=false)`), which lives in a separate
window layer behind the app window and does not reliably composite under a
hardware-accelerated, transparent WebView → black picture with working audio.

**Fix applied (uncommitted):** switched to **TextureView** (`attachViews(videoLayout,
null, false, true)`). A TextureView is an ordinary view in the hierarchy and alpha-blends
correctly beneath the transparent WebView, so the HTML controls float over visible video.

## Device test #3 result (2026-06-23): STILL black w/ audio (TextureView too) + controls stuck
TextureView didn't fix it. Since BOTH SurfaceView (#2) and TextureView (#3) give
black-with-audio, surface type isn't the deciding factor — it's either (a) libVLC is
producing no video output, or (b) it is and an opaque layer/window is covering it.
Also found a real UI bug: player controls never auto-hid, so the video couldn't even be
seen behind them.

## Changes this round (uncommitted)
- Controls auto-hide fixed: `hideControls()` bailed whenever the `<video>` was paused,
  but during native playback that element is always paused (libVLC plays, not it).
  Now treats active+unpaused native as playing. Auto-hide timer is kicked when native
  starts, and a `touchstart` handler toggles controls (mouse events don't fire on touch).
- **TEMP on-screen debug HUD** (top-left, `#native-debug-hud`): shows `native:<state>`,
  `vout:<count>`, `t:<secs>`. **This is the key diagnostic** — see next step.

## Device test #8 (2026-06-23): fullscreen video ✓ but APP CHROME bleeds over it — NEEDS FIX
HUD `native:vout1 vout:1 t:33s` (playing fine). Screenshot shows the video filling the
screen BUT the **header + Series catalog + categories sidebar are drawn ON TOP of the
fullscreen video** — i.e. you can see the catalog UI over the playing surface. Root cause is
the behind-everything surface + global transparency: `body.native-video-active` transparentizes
the whole ancestor chain app-wide, and the rect-sync sized the surface to full-screen, so the
native layer shows through EVERY transparent region — including the catalog chrome that should
not be visible during fullscreen playback (and shouldn't show video behind it when browsing).

Root cause (cowork): the test #7 fix made the `:fullscreen ::backdrop` transparent so the
video shows — but a transparent backdrop ALSO reveals the whole app page (header/sidebar/
catalog) sitting behind the fullscreened player, which then composites over the full-screen
video surface.

FIX APPLIED (cowork, uncommitted — Claude-in-VS-Code please rebuild):
- CSS (`style.css`): added `body.native-video-active.native-fullscreen #app-container
  { visibility:hidden }` + re-show `:fullscreen`/`:-webkit-full-screen` and their subtree.
  Hides the chrome behind the fullscreen video; `visibility` (not display) keeps layout so
  the player box rect still resolves.
- JS (`player.js`): on `fullscreenchange`, toggles `body.native-fullscreen` (only when
  `_nativeActive`). Cleared on stop / native error.
- Surface-hide when player not on screen: `setRect` with w/h<=0 now sets the VLC surface
  `GONE` (was: full-screen); the rect-sync loop sends a zero rect when `#video-container`
  has no on-screen area (e.g. browsing catalog while audio plays) so video can't bleed
  behind other UI. A real rect re-shows it.
NEXT: Claude-in-VS-Code rebuilds + device-tests fullscreen (chrome gone, video full-screen)
and catalog-while-playing (no video bleed).

## Device test #13 (2026-06-23): ROTATION NOT ENTERING FULLSCREEN — under investigation
APK rebuilt from latest (web build ✓ → cap sync ✓ → assembleDebug ✓, 98 MB) and copied to
repo root as `ZIPTV-Pro-nativetest.apk` (existing native-test naming). Stray `.tmp` files
(NativeVideoPlugin.java.tmp…, player.js.tmp…) deleted.

SYMPTOM (Live, screenshot): device/content is LANDSCAPE (sidebar + channel list rendered
sideways) and libVLC is playing fine — HUD `native:vout1 vout:1 t:7s rect:57,237,1230,689`
— BUT the video stays BOXED with all app chrome visible. i.e. `body.player-fs` was NOT
applied on rotation, so no immersive fullscreen. Note the content looked rotated 90° inside
a portrait-shaped phone frame, consistent with a `ScreenOrientation.lock('landscape')` while
the device is physically portrait (WebView rotates content; viewport becomes landscape).

WHERE TO LOOK (player.js):
- Orientation→fullscreen path: matchMedia('(orientation: landscape)') `change` listener
  (~L417-432) → `_applyFsForOrientation()` (~L1488). It sets player-fs only when
  `this.hasStream && this.isLandscape()` and bails early if `!Capacitor.isNativePlatform()
  || this._isTv()`.
- hasStream is set in loadStream (L503) ✓ and a stream is active (HUD), so the suspects are:
  1. **`_isTv()` true** — `_isTv()` = `body.classList.contains('tv-layout')`. If the emulator
     is being detected/forced as TV layout, `_applyFsForOrientation()` returns immediately and
     rotation never fullscreens. CHECK how `tv-layout` is set (style.css note: `?tv=true` on
     PC, plus some auto-detection) — verify it's NOT set on this phone build. This is the
     leading hypothesis given the layout in the shot.
  2. **matchMedia `change` not firing** in this WebView — legacy `addListener` fallback is
     wired (L431), but if neither fires on a locked-orientation rotation, player-fs is never
     re-evaluated. autoFullscreen() (L443) also calls `_applyFsForOrientation()` on play —
     confirm it runs for LIVE (not just VOD) and after the orientation settles.
  3. **isLandscape() reading portrait** — if matchMedia reports portrait despite the rotated
     content, `fs` stays false. Add the orientation/`isLandscape()` value to the debug HUD to
     confirm remotely.
NEXT (Claude-in-VS-Code): instrument the HUD with `tv:<0/1> ls:<0/1> fs:<0/1>` (=_isTv,
isLandscape, player-fs present), rebuild, rotate on Live, and report — that pins which of the
three it is. Most likely fix: ensure `tv-layout` isn't applied on the phone APK, and/or call
`_applyFsForOrientation()` from a real orientation/resize event (not only matchMedia).

## REBUILD v2 (2026-06-23): BOXED-default + fullscreen TOGGLE (final model)
Refined from fullscreen-first. NO browser Fullscreen API on native (gated by
Capacitor.isNativePlatform()); web/desktop/TV-browser keep the real API. body gets
`app-native` on the native build. Two surface states, both with the libVLC surface
rect-synced to #video-container:
- DEFAULT = BOXED: surface tracks the on-screen player box; chrome visible; existing
  responsive CSS sizes the box (portrait stacked / landscape side-by-side / TV grid).
- IMMERSIVE = `body.player-fs`: #app-container visibility:hidden, #video-container fixed
  inset:0 → surface full-screen. Toggled by the fullscreen button and rotate-to-landscape
  on phone (`autoFullscreen`/orientation listener via `_setPlayerFs`); portrait/back exits.
  TV never auto (remote toggle = TODO, see below).
Per content type:
- LIVE: always boxed (player + channel list); rotate→fullscreen. (Docked view kept — needed
  for live + TV.)
- VOD (series): browse = LIST ONLY (`body.app-native:not(.native-video-active)
  .series-player-wrapper{display:none}`); tap an episode → watch: PORTRAIT = YouTube layout
  (video sticky at top, episodes scroll below) / LANDSCAPE = fullscreen. stop()/back → list.
- VOD (movies): play via existing vod-mode (chrome hidden, full-area); rotate→fullscreen.
player.js: `_setPlayerFs(on)` toggles body.player-fs + forces rect re-sync; toggle/enter/exit/
autoFullscreen + orientation listener all branch native→player-fs vs web→Fullscreen API; rect
poll restored (boxes to #video-container; hides when offsetParent null unless player-fs).
Removed the nearFull/dbg heuristics and native-fullscreen class. Web build ✓ (vite).

v2 refinements (2026-06-23, uncommitted):
- Player box visibility now keyed to `body.player-session` (added in loadStream, removed in
  stop) instead of native-video-active — so the VOD box appears the instant you tap (with
  spinner during load), not only once libVLC is "ready". (Fixed "where is the player in
  portrait" = box was hidden during the load gap.)
- FULLSCREEN IS ORIENTATION-DERIVED: `player-fs` only ever set in LANDSCAPE (never portrait).
  `_applyFsForOrientation()` sets it from actual orientation on every change + on play; the
  fullscreen button calls `_rotateForFs()` which uses ScreenOrientation.lock to ROTATE the
  device (portrait→landscape enters, landscape→portrait exits) — the class follows the real
  orientation, so there's never a portrait fullscreen. CSS fullscreen block is ALSO wrapped
  in `@media (orientation: landscape)` as a belt-and-braces guard. stop() unlocks orientation.

v4 (2026-06-23): LANDSCAPE = BOXED by default (was wrongly force-fullscreen); TV exit-to-portrait fixed
User wants the landscape player BOX + channel list (desktop-style), video playing in the box —
NOT auto-fullscreen. And "no portrait on TV": exiting fullscreen was forcing portrait. Fixes:
- BOXED is now the default in ALL orientations. Fullscreen is ONLY the explicit toggle.
  `_applyFsForOrientation()` no longer forces fullscreen in landscape — it only enforces
  "portrait is never fullscreen" (rotating to portrait drops out of immersive to docked).
- `autoFullscreen()` on native is now a no-op → playback starts boxed (landscape box / portrait
  docked); user opts into fullscreen.
- Fullscreen toggle branches: TV → `_setFsDirect()` (pure CSS player-fs toggle, NO rotation,
  stays landscape). Phone/tablet → enter sets player-fs (+ locks landscape only if currently
  portrait); EXIT just `ScreenOrientation.unlock()` — NEVER locks portrait (that was the TV
  "exit goes portrait" bug). Works for landscape tablets too (exit stays landscape).
- `_rotateForFs` now unused (dead code, harmless) — prune later.
Net: portrait = docked; landscape = boxed player+list; fullscreen = button/remote toggle,
landscape-only (CSS @media guard); exit returns to boxed without forcing portrait.

v3 (2026-06-23): "not getting landscape view" — app stays portrait on rotate
HUD showed `rect: 57,237,1230,689` = a 16:9 box at top of a PORTRAIT viewport (docked, correct)
— so isLandscape() was false; the app never flipped to landscape, hence no fullscreen.
Hardened the rotation→fullscreen detection: added window `resize` + `orientationchange`
listeners and post-lock re-checks (120/400/800ms) that re-derive `_applyFsForOrientation()`,
since matchMedia 'change' is unreliable in Android WebViews. The fullscreen BUTTON forces
landscape via ScreenOrientation.lock (plugin 8.0.1 confirmed installed+synced); rotating the
DEVICE works only if device auto-rotate is on.
TEST NOTE for Claude-in-VS-Code: must build the LATEST src. To get landscape: TAP the
fullscreen button (forces rotation) — don't rely on rotating the emulator window; or rotate
the virtual device (ctrl+←/→) with auto-rotate ON. Confirm player-fs activates (surface goes
full-screen) only in landscape.

REMAINING for this phase:
- TV (Fire TV) remote → toggle fullscreen: tv-navigation.js still uses the Fullscreen API;
  on native it should call playerInstance.toggleFullscreen() (→ player-fs) instead. Not yet
  wired (user testing on phone first). Boxed-default already gives TV the docked view.
- Prune dead code: dbg HUD lines, old rect heuristics already gone; debug HUD (state/vout/
  time) + "Native: trying…" toasts still present — strip before ship.

## REBUILD v1 (2026-06-23): native player = FULLSCREEN-FIRST overlay, NO Fullscreen API
Decision (user): after recurring fullscreen/compositing bugs, rebuilt the player around the
native surface. Scope = NATIVE ANDROID ONLY (web/desktop/TV keep the Fullscreen-API player).
UX = fullscreen-first: tapping content takes over the screen; back button exits; rotation
just rotates (libVLC scales to the surface).

How it works now (all hung off `body.native-video-active`, which is ONLY set for Android
libVLC playback — so web/TV/desktop are untouched):
- CSS (`style.css`): `#app-container { visibility:hidden }` hides ALL app chrome during
  playback; `#video-container` becomes a fixed, transparent, FULL-SCREEN overlay (inset:0,
  z-index 9000) with only its controls visible. Ancestor chain gets transform/filter/
  backdrop-filter neutralized so the fixed overlay isn't trapped by a containing block.
  Back button forced visible (exit affordance); fullscreen button hidden (redundant).
- Surface: the libVLC layer is simply FULL-SCREEN (MATCH_PARENT) — NO rect-sync/boxing
  anymore (that was the fragile part). libVLC letterboxes in portrait against the #070A13
  backing; fills in landscape.
- player.js: removed the rect-sync call; gated the Fullscreen API OFF on native
  (`Capacitor.isNativePlatform()`) in toggleFullscreen/enterFullscreen/autoFullscreen and the
  orientation listener. Back button now falls back to stop() for live (no onExitVod).
- main.js: unchanged — autoFullscreen() no-ops on native; existing stop()/exit flows remove
  native-video-active and restore the chrome.
This eliminates the whole bug class at the source: no Fullscreen API (no backdrop, no gray
<video> placeholder, no stuck-fullscreen-on-nav), chrome hidden during playback (no bleed,
no scroll-over), surface always full-screen (no boxing/landscape confinement issues).
Web build verified (vite build ✓). Leftover dead code to prune later: _startRectSync/
_stopRectSync/_computeNativeRect, the rect/dbg HUD lines, native-fullscreen toggle.

NEXT (Claude-in-VS-Code): rebuild APK + test on native — play live/movie/series: full-screen
video + controls + back button; rotate (both orientations fill/letterbox correctly); back
returns to the catalog/list (chrome restored, audio stops); browse after exit = no bleed.

## Device test #12 (2026-06-23): scroll FIXED ✓; full-screen-while-browsing persists
Scroll-follow works now. But browsing the catalog still shows full-screen video, HUD still
`rect: 0,0,2833,1344` SENT (guard didn't hide it). That means either `document.fullscreenElement`
is set (stuck/stale fullscreen state → guard's `&& !fs` lets it through) or the box wasn't ≥98%
of viewport. Can't tell remotely → added a `dbg:` HUD line showing `fs<0/1> lo<0/1> boxWxH/vpWxH`
(fs=fullscreenElement set, lo=offsetParent laid-out). Also two proactive fixes: hide when
`offsetParent===null` (container in a display:none view), and loosened nearFull to 90%.
NEXT (Claude-in-VS-Code): rebuild, browse catalog while playing, report the `dbg:` line.
  - fs1 → app is stuck in Fullscreen API while browsing (need to exitFullscreen on nav, or
    drop the `&& !fs` allowance / hide when fullscreenElement set but player view not active).
  - lo0 → container hidden; the new offsetParent hide should already catch it.
  - box smaller than vp → threshold; already loosened to 90%.

## Device test #10 (2026-06-23): regressions found — gray <video> placeholder + landscape not confined
Three reports: (a) FULLSCREEN shows a gray play-button graphic over the video while audio
plays; (b) after EXIT fullscreen in LANDSCAPE the video is full-screen in the background,
chrome over it, not confined; (c) in landscape the video doesn't scroll with the list —
items scroll over a static full-screen video.

Diagnosis:
- (a) = the test #8 fix `:fullscreen * { visibility:visible !important }` accidentally
  re-showed the empty browser `<video>` (#main-video-player), whose Android-WebView
  placeholder (gray + play button) then painted over the native surface.
  FIX: `body.native-video-active #main-video-player { display:none !important }`
  (display, not visibility — WebView ignores visibility on the video overlay, and
  display:none can't be overridden by the :fullscreen * visibility rule).
- (b)+(c) = in LANDSCAPE the native surface is NOT being confined to #video-container —
  it's full-screen (portrait boxing works). Cause unknown remotely (rect computed wrong?
  native setRect not applied? rect-sync not running in this view?). ADDED the live rect to
  the debug HUD (`rect: x,y,w,h`) so the next build shows exactly what's sent.

HUD RESULTS (test #11): browsing catalog → `rect: 0,0,2833,1344` (FULL SCREEN); playback
scrolled → `rect: 735,-397,2005,1125` (boxed but NEGATIVE top). Two root causes found:
  1. SCROLL: plugin `setRect` clamped `Math.max(0, x/y)`, so a negative top (scrolled box)
     pinned the surface to the top edge → "doesn't scroll with the list." FIX: allow
     negative margins (removed the clamp; FrameLayout clips to parent).
  2. FULL-SCREEN BLEED while browsing: `#video-container` measures as the whole viewport in
     stray states (catalog browse / leftover fullscreen) → full-screen video behind UI.
     FIX: `_computeNativeRect()` returns `{hide:true}` when the box spans ~the whole viewport
     AND `document.fullscreenElement` is null; the rect-sync then sends a 0-rect → surface
     hidden (audio continues). Real fullscreen (fullscreenElement set) still shows full-screen.
Also: zero/!laid-out box → hide. Portrait unaffected (player box is wide but short → not
nearFull). Plugin `#main-video-player` now `display:none` (fixes the fullscreen gray
placeholder, test #10a).
NEXT (Claude-in-VS-Code): rebuild from latest + retest fullscreen (no gray placeholder),
landscape scroll (video scrolls with list), and browsing while playing (no full-screen bleed).

## Device test #9 (2026-06-23): fullscreen FIXED ✓ + new idle screen added
Fullscreen now shows clean full-screen video + controls, no chrome bleed (test #8 fix works).
CONFIRMED working as intended: shot 1 = true fullscreen; shot 2 = boxed inline after EXITING
fullscreen. Both correct — no landscape/fullscreen change needed. Native player is functionally
DONE on Android: E-AC3 audio ✓ HEVC Main10 ✓ compositing ✓ boxed inline ✓ fullscreen ✓
exit-to-box ✓ no-bleed ✓.

NEW (uncommitted) — modern idle/empty player state:
- `index.html`: `#player-idle` inside `#video-container` (glass placeholder — gradient play
  emblem w/ pulse, "Ready to stream", Live/Movies/Series hint pills, faint grid + equalizer,
  ZIPTV PRO wordmark). Uses lucide icons (play/tv/film/clapperboard).
- `style.css`: `.player-idle*` styles + keyframes (idlePulse/idleFloat/idleEq), z-index 12
  (above controls, below spinner z15), compact variant @max-width:900px. perf-lite neutralizes
  the animations (fine).
- `player.js`: caches `this.idleScreen`; `.hidden` added in `loadStream()` (stream starting),
  removed in `stop()` (back to idle). Shown by default on boot.

STILL TEMP (remove before ship): debug HUD (#native-debug-hud) + "Native: trying…" toasts.

## Device test #6 (2026-06-23): VIDEO VISIBLE! 🎉 (compositing works) — only FRAMING left
After transparentizing the full ancestor chain, native video RENDERS through the WebView
(Impractical Jokers visible, audio+video). Magenta never showed = real frames paint over
it. So: E-AC3 audio ✓, HEVC Main10 decode ✓, behind-WebView compositing ✓.

Remaining issue = FRAMING only. The VLCVideoLayout is full-screen (MATCH_PARENT), so the
16:9 video is letterboxed in the vertical centre of the portrait screen instead of filling
the player box, and because `.content-viewport`/`.view-panel` are now transparent the video
also bleeds behind the channel list (transparent gaps). This is the fundamental trait of a
behind-everything surface: to show it you must make HTML transparent, but then ALL
transparent areas reveal it.

USER CHOSE: BOXED INLINE. Implemented this round (uncommitted):
- Plugin: a full-screen `FrameLayout backing` (colour `#070A13` = --bg-darkest) is inserted
  behind the WebView; the `VLCVideoLayout` lives INSIDE it and is positioned/sized via a new
  `setRect({x,y,w,h})` method (physical px, origin = WebView top-left; w/h<=0 = full-screen).
  Magenta reverted to `Color.BLACK`. backing shown/hidden alongside the surface.
- JS: `nativeSetRect()` added to the bridge. `player.js` polls `#video-container`'s
  `getBoundingClientRect() × devicePixelRatio` every 200ms while native is active
  (`_startRectSync`/`_stopRectSync`) and pushes the rect on change — covers scroll, rotate,
  fullscreen (box fills viewport → full-screen rect) with one cheap loop.

RESULT: portrait boxed works. Fullscreen was BLACK → fixed this round:

## Device test #7 (2026-06-23): portrait boxed ✓, fullscreen black → fixed
Fullscreen uses the Fullscreen API on `#video-container`, which the browser promotes to the
top layer with an opaque black `::backdrop` that hid the native surface behind the WebView.
Fix (CSS): under `body.native-video-active`, make `:fullscreen` / `:-webkit-full-screen`
and their `::backdrop` transparent (+ border-radius:0). Also `player.js` resets
`_lastRectKey` on fullscreenchange so the surface rect re-syncs to the fullscreen bounds on
the next poll tick. (The rect poll already turns a viewport-filling box into a full-screen
rect, so the surface fills the screen; the backdrop was the only blocker.)

## Device test #5 (2026-06-23): wrapper transparent but box now NAVY (not video); live same
Clearing `.series-player-wrapper` revealed the NEXT opaque layer — flat navy = the
`<main class="content-viewport">` which has `background: var(--bg-darkest)`. It's an
ancestor of BOTH the live and series players and wasn't transparentized, so it painted
over the video everywhere. Confirmed the "peel one layer, see the next solid colour"
pattern: the video surface is fine (vout:1), it's a chain-of-opaque-ancestors problem.
Also found my earlier rule used `#app` but the real id is `#app-container` (never matched).

**Fix applied (uncommitted):** transparentize the FULL ancestor chain in `style.css`
under `body.native-video-active`: `#app-container, .app-layout, .content-viewport,
.view-panel, .live-top-row, .series-playback-container, .series-top-row` + the existing
player wrappers (also `background-image:none`). Covers live AND series/VOD.
**TEMP:** plugin sets the VLC `videoLayout` background to **MAGENTA** (was black) as a
litmus test — next build, any region behind transparent HTML that shows magenta proves
the surface composites through the WebView. Revert to `Color.BLACK` once confirmed.

NOTE: couldn't get a clean in-sandbox `vite build` of the final CSS — the Linux build
mount served a frozen/truncated cache of style.css (showed 6691 lines ending mid-word).
The real file is correct (verified) and the isolated CSS block parses clean; Windows build
is unaffected.

## Device test #4 (2026-06-23): HUD read `vout: 1`, `t: 25s` advancing → ROOT CAUSE FOUND
Video output exists and time advances — libVLC was decoding + rendering the whole time.
So the black picture was purely **an opaque HTML layer covering the video surface**.
Culprit: `.series-player-wrapper` in `style.css` has `background:#000` + a border and was
NOT in the `body.native-video-active` transparency list (the series view appends
`#video-container` into this wrapper). It painted solid black over the transparent WebView
region, hiding the TextureView behind it.

**Fix applied (uncommitted, CSS-only):** added `.series-player-wrapper` to the
`native-video-active` transparency list and cleared its border-color. TextureView stays.
Rebuild + reinstall → video should now be visible (esp. fullscreen) with audio + controls
that auto-hide.

⚠️ Known caveat to refine later: the VLCVideoLayout is full-screen (MATCH_PARENT), so
**inline/portrait** framing shows a slice of the fullscreen-scaled video through the box.
Fullscreen (rotate to landscape) is correctly framed. Proper inline framing needs the
native surface sized/positioned to the player-box bounds (and updated on resize/fullscreen)
— a follow-up, not blocking.

## (Earlier) Immediate next step — READ THE HUD
Rebuild + reinstall, play HotD S03E01, let it run a few seconds, and report the HUD:
- **`vout: 0` (stays zero)** → libVLC is NOT rendering video (audio-only output). The
  TextureView likely can't present libVLC's 10-bit software frames. Fix = go back to
  SurfaceView but give its internal SurfaceView `setZOrderMediaOverlay(true)` so it
  composites above the window base but below the transparent WebView; or force a
  presentable chroma. (Surface type, not transparency.)
- **`vout: 1+` (non-zero) but still black** → video IS being rendered; it's a
  compositing/transparency problem. Fix = make the WebView/window genuinely transparent
  (the SurfaceFlinger layer behind the WebView is opaque) and/or extend the
  `body.native-video-active { background: transparent }` layer list in `style.css`.
- **`t:` not advancing** → it's actually stalled (different problem).

This one HUD reading tells us which of the two remaining fixes to apply. Earlier
diagnostic states still apply:
1. "Buffering NN%…" that climbs then plays → was just slow buffering (raise caching).
2. "Buffering NN%…" stuck / oscillating, then the 25s stall error → device can't
   software-decode 10-bit HEVC in real time (need HW-decode tuning or lower res).
3. "Opening stream…" then the stall/"could not play" error → libVLC can't open the
   URL (network/UA/auth) — compare with what IPTV Smarters sends.
4. Picture + audio → fixed; if audio-only/black after "Starting video…" → compositing
   (surface/transparency) is the remaining issue.

## Still TODO
1. Confirm Android device test for v4.2.0.
2. Slim the APK (per-ABI splits / abiSplits).
3. Build **Electron mpv/libVLC embed** (`window.appHost.nativeVideo` IPC + native-window
   compositing in `main.electron.cjs` / preload) — NOT started, large piece.
4. Remove the diagnostic toasts in `player.js`.
5. Release (APK + EXE).

## REBUILD v6 (2026-06-23): debug HUD and diagnostic toasts removed + sidebar top pins scaled down further (30% total)
Final refinements before release:
- **Debug HUD Disabled**: Removed the `#native-debug-hud` overlay rendering entirely from `src/components/player.js`.
- **Diagnostic Toasts Silenced**: Silenced the `Native: trying android...` and `Native failed -> browser` toasts to ensure a clean user interface.
- **Top Pins Section Scale**: Scaled down the favorites/recordings/recently-viewed category sidebar card size by another 15% (for a total 30% reduction from the original scale) in landscape orientation to maximize viewport space.
- **VOD Stream Count and Sync speedups**: Playlist sync speedups (Dexie v2 schema + single atomic transaction + bulkAdd) have been verified and built into the app.

## REBUILD v7 (2026-06-23): sort button text simplified to symbols
- **Sort Button Label mapping**: Replaced long text sort labels on the main buttons with compact symbols to prevent UI overflowing:
  - `Default` / `Default Order` / `Recently Added` -> `—` (dash)
  - `Name (A-Z)` -> `A-Z`
  - `Name (Z-A)` -> `Z-A`
  - `Count` / `Count (High–Low)` -> `#`
  - `Rating` / `Most Viewed` -> `★`
  - The dropdown selections themselves still display the descriptive full text options.

## Build/test commands
- Web: `npm run build`
- APK: `npx cap sync android && cd android && ./gradlew assembleDebug` (output:
  `android/app/build/outputs/apk/debug/app-debug.apk`)
- EXE: `npx electron-builder` (note: `asar:false` is REQUIRED — the ESM server can't load
  from an asar archive, or the window goes black)

## Related gotchas
- Electron must keep `asar:false` (ESM in-process server can't import from asar → black screen).
- Hosted domain is `ziptvpro-nu.vercel.app` (old `ziptvpro.vercel.app` hit its traffic limit).
