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

// ---------------------------------------------------------------------------
// Watch history backup (POST /api/history).
//
// A cloud MIRROR of the local Continue Watching store — localStorage stays the
// source of truth, these calls just push a copy to Supabase so a future feature
// (cross-device resume / full history) has the data. Everything here is
// best-effort and fire-and-forget: it never throws into the playback path and
// silently no-ops offline.
//
// saveWatchProgress fires ~every 8s during playback, so backups are throttled
// per item id to avoid hammering the endpoint; a flush on removal is exempt.
// ---------------------------------------------------------------------------
const HISTORY_THROTTLE_MS = 25000;
const lastBackupAt = new Map();   // item_id -> epoch ms of last successful send

/**
 * Back up one Continue Watching item. Pass force=true to bypass the throttle
 * (e.g. the final flush when playback stops).
 */
export function backupWatchHistory(deviceCode, playlistId, item, force = false) {
  try {
    if (!deviceCode || !item || item.id == null) return;
    const key = String(item.id);
    const now = Date.now();
    if (!force && now - (lastBackupAt.get(key) || 0) < HISTORY_THROTTLE_MS) return;
    lastBackupAt.set(key, now);

    fetch(`${CLOUD_BASE}/api/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,   // let the send survive a page/app close
      body: JSON.stringify({
        action: 'record',
        device_id: deviceCode,
        playlist_id: playlistId || '',
        entries: [item]
      }),
      signal: AbortSignal.timeout(10000)
    }).catch(() => {});
  } catch (e) { /* backup is best-effort */ }
}

/** Remove a backed-up entry (mirrors removeWatchProgress). Best-effort. */
export function deleteWatchHistory(deviceCode, playlistId, itemId) {
  try {
    if (!deviceCode || itemId == null) return;
    lastBackupAt.delete(String(itemId));
    fetch(`${CLOUD_BASE}/api/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        action: 'delete',
        device_id: deviceCode,
        playlist_id: playlistId || '',
        item_id: String(itemId)
      }),
      signal: AbortSignal.timeout(10000)
    }).catch(() => {});
  } catch (e) {}
}

/**
 * Pull this device's backed-up history (newest first) for the future feature.
 * Returns [] on any failure. Optional filters: { playlistId, type, limit }.
 */
export async function fetchWatchHistory(deviceCode, opts = {}) {
  try {
    if (!deviceCode) return [];
    const res = await fetch(`${CLOUD_BASE}/api/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'list',
        device_id: deviceCode,
        playlist_id: opts.playlistId,
        type: opts.type,
        limit: opts.limit
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.entries) ? j.entries : [];
  } catch (e) {
    return [];
  }
}
