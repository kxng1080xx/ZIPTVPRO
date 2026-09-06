# Legacy Fire TV build (Fire OS 5 / Android 5.x)

A **separate** APK for the old Fire TV sticks the main app can't reach, shipped
alongside `app.apk` — not a replacement for it.

## Why a separate app is required (two walls)

Old Fire OS 5 sticks (Fire TV Stick 1st/2nd gen, Basic Edition — Android 5.1,
**API 22**) fail on **two** independent limits, and a legacy build must clear
both:

1. **Install floor.** The main APK is `minSdk 24` (Android 7.0), forced by
   `org.apache.cordova:framework:14.0.1`, which **Capacitor 8** bundles. Below
   API 24 the installer reports "problem parsing the package." A Gradle product
   flavor **cannot** lower this — the manifest merger takes the *highest* minSdk
   of all dependencies. Escaping it means leaving the Capacitor 8 stack.
2. **Runtime floor.** Fire OS 5's system WebView is **Chromium ~40 (2015)** —
   older than `src/compat.js` can shim (it predates native `async/await`, which
   the bundle uses everywhere). So the legacy build also needs an **ES5** web
   bundle, not just a lower minSdk.

Fire OS **6+** (Android 7.1 / API 25+) already runs the main `app.apk`, so the
legacy build only targets Fire OS 5 (Android 5.x). The download button detects
this by parsing `Android <major>` from the UA: `< 7` → `legacy.apk`.

## STEP 0 — De-risk before building anything native (do this first)

Before investing in a native shell, prove the UI can even run on Chromium ~40:

1. Produce an ES5 bundle: add `@vitejs/plugin-legacy` (targets `ie >= 11` /
   ES5 + core-js polyfills) and `npm run build:legacy`.
2. Host that `dist/` and open it on a **real Fire OS 5 stick** (Silk browser, or
   `adb`-load it) and watch for a white screen / console errors.
3. If it white-screens even after ES5 transpile, the effort needs rescoping
   (strip more features, or a cut-down "lite" UI) BEFORE any wrapper work.

This costs an afternoon and decides whether the rest is viable.

## STEP 1 — Legacy web build

- `@vitejs/plugin-legacy` for ES5 + polyfills.
- Drop features the old WebView / weak CPU can't do: MSE players
  (`mpegts.js`/`hls.js` need MSE the old WebView lacks) → rely on the native
  libVLC path only; likely no Cast, no heavy glass effects (force `perf-lite`).

## STEP 2 — Native shell (the architecture decision)

Target `minSdk 21`, keep **libVLC** (`org.videolan.android:libvlc-all` supports
API 17+). Two options:

- **A. Capacitor 6 fork** (cordova-android 12 → minSdk 22). Reuses the web UI's
  existing `window.Capacitor` plugin calls and the current native player /
  ApkInstaller plugins. Risk: Capacitor 6's own runtime JS may not be ES5 for
  Chromium 40; maintenance of a parallel Cap version.
- **B. Minimal WebView wrapper** (own Android Studio project, `minSdk 21`).
  Full control over *all* JS (everything transpiled to ES5), smallest runtime.
  Cost: reimplement the JS↔native bridge the web UI expects (playback,
  installer) instead of reusing Capacitor's.

**Recommendation:** decide after STEP 0. If the ES5 bundle runs, try **A** first
(more reuse); fall back to **B** if Capacitor 6's runtime won't load on
Chromium 40.

## STEP 3 — Distribution (download button already wired)

- Separate `applicationId` (e.g. `com.iptv.player.zero.legacy`) so it installs
  **beside** the main app without conflict.
- Release asset named `legacy.apk`; `/legacy.apk` redirect → GitHub latest
  release (added to `public/_redirects`).
- Download button routes `Android major < 7` → `legacy.apk` (done in
  `src/main.js`).
- **First-install surface:** a brand-new Fire OS 5 user can't run the app (or the
  pages.dev site, which *is* the app), so the in-app button can't reach them.
  They install via the Fire TV **Downloader** app using the short `legacy.apk`
  URL — give that URL directly in your onboarding for old sticks.
- The legacy app's own updater should check a legacy manifest (add `apkLegacy`
  to `version.json`) so it never offers itself the incompatible main APK.
