/**
 * Cloud sync client (ZIPTV Pro 5.0).
 *
 * Talks to the serverless device endpoint at https://ziptvpro-nu.vercel.app/api/device
 * — an ABSOLUTE url on purpose: in the desktop (Electron) and APK (Capacitor)
 * builds the frontend is loaded locally, so a relative "/api/device" would hit
 * the bundled local server, not the cloud. The hosted web build also works with
 * the absolute url (same origin).
 *
 * This module only does network + caching. Reconciliation (adding/removing
 * playlists, wiping on expiry, UI) lives in main.js so it can reuse the player's
 * existing playlist helpers.
 */

const CLOUD_BASE = 'https://ziptvpro-nu.vercel.app';
const STATE_KEY = 'ziptv_device_state';   // last good /api/device response
const CODE_KEY = 'ziptv_device_code';

export function getDeviceCode() {
  let code = localStorage.getItem(CODE_KEY);
  if (!code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable chars
    code = '';
    for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    localStorage.setItem(CODE_KEY, code);
  }
  return code;
}

export function detectPlatform() {
  try {
    if (/Electron/i.test(navigator.userAgent || '')) return 'pc';
    const C = window.Capacitor;
    if (C && (typeof C.isNativePlatform === 'function' ? C.isNativePlatform() : C.isNative)) return 'apk';
  } catch (e) {}
  return 'web';
}

/**
 * Hit the device endpoint. Returns the parsed state on success and caches it.
 * Throws on network/server error (caller falls back to the cached state).
 * State shape: { status, label, expires_at, expired, notice, playlists: [...] }
 */
export async function syncDevice(deviceCode, appVersion) {
  const res = await fetch(`${CLOUD_BASE}/api/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: deviceCode,
      platform: detectPlatform(),
      app_version: appVersion || null
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) {
    let msg = `Sync failed (${res.status})`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  const state = await res.json();
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...state, _cachedAt: Date.now() })); } catch (e) {}
  return state;
}

export function readCachedState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) { return null; }
}

export function clearCachedState() {
  try { localStorage.removeItem(STATE_KEY); } catch (e) {}
}

/** True when a state's expiry has passed (works offline from the cached state). */
export function isStateExpired(state) {
  return !!(state && state.expires_at && new Date(state.expires_at) < new Date());
}
