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
 * Both deployments serve the same API against the same Supabase, so every
 * request goes through cloudFetch(): try the preferred host, fail over to the
 * other on network errors OR non-JSON error replies (ISP/DNS filters block
 * *.pages.dev on some networks and answer with an HTML block page; Vercel bot
 * challenges from flagged IPs look the same). The host that worked is
 * remembered so a device behind a blocking network sticks to the one it can
 * actually reach.
 *
 * This module only does network + caching. Reconciliation (adding/removing
 * playlists, wiping on expiry, UI) lives in main.js so it can reuse the player's
 * existing playlist helpers.
 */

const CLOUD_BASES = [
  'https://ziptvpro.pages.dev',     // primary (Cloudflare Pages)
  'https://ziptvpro-nu.vercel.app'  // fallback (legacy Vercel deploy, same API + DB)
];
const BASE_KEY = 'ziptv_cloud_base';

let preferredBase = null;
try { preferredBase = localStorage.getItem(BASE_KEY) || null; } catch (e) {}
if (!CLOUD_BASES.includes(preferredBase)) preferredBase = null;

function baseOrder() {
  return preferredBase
    ? [preferredBase, ...CLOUD_BASES.filter((b) => b !== preferredBase)]
    : CLOUD_BASES;
}

function rememberBase(base) {
  if (preferredBase === base) return;
  preferredBase = base;
  try { localStorage.setItem(BASE_KEY, base); } catch (e) {}
}

/**
 * POST a JSON body to `path` on the first reachable cloud host. Returns the
 * raw Response (callers keep their own res.ok / res.json() handling). A fresh
 * timeout signal is created per attempt so a slow primary can't eat the
 * fallback's time budget. Throws only when every host failed.
 */
async function cloudFetch(path, body, { timeoutMs = 12000, keepalive = false } = {}) {
  let lastErr = null;
  for (const base of baseOrder()) {
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      // Non-JSON error reply = block/challenge page, not our API — next host.
      // Real API errors (4xx/5xx JSON) are answers and pass through.
      if (!res.ok && !/json/i.test(res.headers.get('content-type') || '')) {
        lastErr = new Error(`Cloud host error ${res.status} (${base})`);
        continue;
      }
      rememberBase(base);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Cloud API unreachable');
}
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
  const res = await cloudFetch('/api/device', {
    device_id: deviceCode,
    platform: detectPlatform(),
    app_version: appVersion || null
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

    cloudFetch('/api/history', {
      action: 'record',
      device_id: deviceCode,
      playlist_id: playlistId || '',
      entries: [item]
    }, { timeoutMs: 10000, keepalive: true }).catch(() => {});
  } catch (e) { /* backup is best-effort */ }
}

/** Remove a backed-up entry (mirrors removeWatchProgress). Best-effort. */
export function deleteWatchHistory(deviceCode, playlistId, itemId) {
  try {
    if (!deviceCode || itemId == null) return;
    lastBackupAt.delete(String(itemId));
    cloudFetch('/api/history', {
      action: 'delete',
      device_id: deviceCode,
      playlist_id: playlistId || '',
      item_id: String(itemId)
    }, { timeoutMs: 10000, keepalive: true }).catch(() => {});
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Companion device pairing (PC ↔ mobile Continue Watching hand-off).
// The server enforces the cross-platform rule and mutual linking; these are
// thin wrappers that throw a readable Error on failure so Settings can toast it.
// ---------------------------------------------------------------------------

/** Link this device with another device's code. Resolves to { device_id, platform, label }. */
export async function pairCompanion(deviceCode, companionCode) {
  const res = await cloudFetch('/api/device', { action: 'pair', device_id: deviceCode, companion_code: companionCode });
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
  const res = await cloudFetch('/api/device', { action: 'add_playlist', device_id: deviceCode, ...playlist });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Could not sync playlist to server (${res.status})`);
  return j.id;
}

/** Remove a device-added playlist from this device's cloud record. */
export async function removePlaylistFromCloud(deviceCode, remoteId) {
  const res = await cloudFetch('/api/device', { action: 'remove_playlist', device_id: deviceCode, playlist_id: remoteId });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Could not remove playlist from server (${res.status})`);
}

/** Remove the companion link (both sides). */
export async function unpairCompanion(deviceCode) {
  const res = await cloudFetch('/api/device', { action: 'unpair', device_id: deviceCode });
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
    const res = await cloudFetch('/api/history', { action: 'companion-list', device_id: deviceCode, limit });
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
    const res = await cloudFetch('/api/history', {
      action: 'list',
      device_id: deviceCode,
      playlist_id: opts.playlistId,
      type: opts.type,
      limit: opts.limit
    });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.entries) ? j.entries : [];
  } catch (e) {
    return [];
  }
}
