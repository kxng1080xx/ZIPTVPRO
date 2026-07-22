/**
 * Runtime compatibility shims for old system WebViews (Fire TV sticks, older
 * Android). Imported FIRST in main.js so every other module sees the patched
 * globals.
 *
 * AbortSignal.timeout() is Chromium 103+ (mid-2022). Amazon's Fire OS WebView
 * often predates that, and every cloud/API call in the app passes
 * AbortSignal.timeout(...) — without this shim those devices throw a TypeError
 * before the request is even sent, so the device code never registers and
 * playlists never sync (8.4.x Fire TV activation bug).
 */
if (typeof AbortSignal !== 'undefined' &&
    typeof AbortController !== 'undefined' &&
    typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = function (ms) {
    const ctrl = new AbortController();
    setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms);
    return ctrl.signal;
  };
}
