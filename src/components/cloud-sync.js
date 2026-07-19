/**
 * Cloud sync client (ZIPTV Pro 5.0).
 *
 * Talks to the serverless device endpoint at https://ziptvpro.pages.dev/api/device
 * — an ABSOLUTE url on purpose: in the desktop (Electron) and APK (Capacitor)
 * builds the frontend is loaded locally, so a relative "/api/device" would hit
 * the bundled local server, not the cloud. The hosted web build also works with
 * the absolute url (same origin).
 *
 * Migrated from Vercel (ziptvpro-nu.vercel.app) to Cloudflare Pages
 * (ziptvpro.pages.dev) in 8.3.2 — device.js/history.js were ported as
 * Cloudflare Pages Functions (same routes, same Supabase backend), so older
 * installs still on Vercel keep working unchanged until this update reaches
 * them through the normal update-check flow.
 *
 * This module only does network + caching. Reconciliation (adding/removing
 * playlists, wiping on expiry, UI) lives in main.js so it can reuse the player's
 * existing playlist helpers.
 */

const CLOUD_BASE = 'https://ziptvpro.pages.dev';
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

// ---------------------------------------------------------------------------
// Companion device pairing (PC ↔ mobile Continue Watching hand-off).
// The server enforces the cross-platform rule and mutual linking; these are
// thin wrappers that throw a readable Error on failure so Settings can toast it.
// ---------------------------------------------------------------------------

/** Link this device with another device's code. Resolves to { device_id, platform, label }. */
export async function pairCompanion(deviceCode, companionCode) {
  const res = await fetch(`${CLOUD_BASE}/api/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pair', device_id: deviceCode, companion_code: companionCode }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Pairing failed (${res.status})`);
  return j.companion;
}

/**
 * Push a playlist added via the hidden manual-login form up to this device's
 * cloud record — the same table the admin dashboard writes to — so it (a)
 * shows up for the admin, (b) survives the heartbeat's reconcile (it's no
 * longer "missing from remote"), and (c) can be deleted from there too.
 * Returns the new row's id, or throws a readable Error on failure.
 */
export async function addPlaylistToCloud(deviceCode, playlist) {
  const res = await fetch(`${CLOUD_BASE}/api/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add_playlist', device_id: deviceCode, ...playlist }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Could not sync playlist to server (${res.status})`);
  return j.id;
}

/** Remove a device-added playlist from this device's cloud record. */
export async function removePlaylistFromCloud(deviceCode, remoteId) {
  const res = await fetch(`${CLOUD_BASE}/api/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove_playlist', device_id: deviceCode, playlist_id: remoteId }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Could not remove playlist from server (${res.status})`);
}

/** Remove the companion link (both sides). */
export async function unpairCompanion(deviceCode) {
  const res = await fetch(`${CLOUD_BASE}/api/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'unpair', device_id: deviceCode }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Unpair failed (${res.status})`);
}

/**
 * Pull the paired companion's history (newest first). Returns { companion, entries };
 * { companion: null, entries: [] } when unpaired or on any failure.
 */
export async function fetchCompanionHistory(deviceCode, limit) {
  try {
    if (!deviceCode) return { companion: null, entries: [] };
    const res = await fetch(`${CLOUD_BASE}/api/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'companion-list', device_id: deviceCode, limit }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return { companion: null, entries: [] };
    const j = await res.json();
    return { companion: j.companion || null, entries: Array.isArray(j.entries) ? j.entries : [] };
  } catch (e) {
    return { companion: null, entries: [] };
  }
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
