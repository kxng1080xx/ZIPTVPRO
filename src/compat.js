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

// Array.prototype.at is Chromium 92+ (e.g. web-tabs uses .at(-1)).
if (!Array.prototype.at) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, 'at', {
    value: function (n) {
      n = Math.trunc(n) || 0;
      if (n < 0) n += this.length;
      return (n < 0 || n >= this.length) ? undefined : this[n];
    },
    writable: true, configurable: true
  });
}

// ---------------------------------------------------------------------------
// Early global error capture. Installed here (before any other module runs) so
// even a crash during app boot is recorded. The last error is kept in
// localStorage and piggybacked on the device heartbeat (cloud-sync.js), so a
// silently-broken device shows WHAT broke in the admin panel instead of just
// never appearing. Capture is best-effort and must never throw itself.
// ---------------------------------------------------------------------------
const ERROR_KEY = 'ziptv_last_error';

function recordError(msg) {
  try {
    if (!msg) return;
    const s = String(msg).slice(0, 300);
    // Noise filter: network blips are expected and already handled elsewhere.
    if (/Failed to fetch|NetworkError|Load failed|AbortError|timed? ?out/i.test(s)) return;
    localStorage.setItem(ERROR_KEY, JSON.stringify({ message: s, at: new Date().toISOString() }));
  } catch (e) { /* never throw from the error handler */ }
}

window.addEventListener('error', (e) => {
  recordError(e && e.message ? `${e.message} (${e.filename || '?'}:${e.lineno || '?'})` : e);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  recordError(r && r.message ? r.message : r);
});

/** Last captured error ({ message, at }) or null. Cleared once reported. */
export function readLastError() {
  try { return JSON.parse(localStorage.getItem(ERROR_KEY) || 'null'); } catch (e) { return null; }
}

export function clearLastError() {
  try { localStorage.removeItem(ERROR_KEY); } catch (e) {}
}
