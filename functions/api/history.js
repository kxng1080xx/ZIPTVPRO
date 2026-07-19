/**
 * Watch history backup (PC + APK + TV). Cross-origin — the apps load from
 * file://, the capacitor:// scheme, or the web build, so CORS is open. Scoped
 * to a single device_id; it never exposes another device's history.
 *
 * Cloudflare Pages Functions port of api/history.js (Vercel) — see that
 * file's header comment for the full action list and companion-list caveat;
 * logic is unchanged, only the (req, res) -> (request, env) / Response
 * plumbing differs.
 */
import { sb, supabaseConfigured } from '../_supabase.js';
import { json, preflight, readJson, errorResponse } from '../_util.js';

const MAX_ENTRIES_PER_CALL = 50;   // a device only ever backs up a handful at once
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost({ request, env }) {
  if (!supabaseConfigured(env)) return json({ error: 'Server not configured.' }, 500);

  try {
    const b = await readJson(request);
    const action = String(b.action || '').trim();

    switch (action) {
      case 'record': return await record(env, b);
      case 'list':   return await list(env, b);
      case 'delete': return await remove(env, b);
      case 'companion-list': return await companionList(env, b);
      default:       return json({ error: 'Unknown action' }, 400);
    }
  } catch (err) {
    return errorResponse(err);
  }
}

/* ------------------------------------------------------------------ actions */

async function record(env, b) {
  const device = deviceId(b.device_id);
  if (!device) return json({ error: 'Valid device_id required' }, 400);

  const playlistId = playlist(b.playlist_id);
  const raw = Array.isArray(b.entries) ? b.entries : (b.entry ? [b.entry] : []);
  if (!raw.length) return json({ error: 'entries required' }, 400);

  const rows = raw
    .slice(0, MAX_ENTRIES_PER_CALL)
    .map((e) => sanitize(e, device, playlistId))
    .filter(Boolean);

  if (!rows.length) return json({ error: 'No valid entries' }, 400);

  // Upsert on the natural key so a resume overwrites the previous position.
  await sb(env, '/watch_history?on_conflict=device_id,playlist_id,item_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: rows
  });

  return json({ ok: true, count: rows.length });
}

async function list(env, b) {
  const device = deviceId(b.device_id);
  if (!device) return json({ error: 'Valid device_id required' }, 400);

  let query = `/watch_history?device_id=eq.${encodeURIComponent(device)}`;
  if (b.playlist_id != null) {
    query += `&playlist_id=eq.${encodeURIComponent(playlist(b.playlist_id))}`;
  }
  if (b.type && ['movie', 'series', 'live'].includes(String(b.type))) {
    query += `&type=eq.${encodeURIComponent(String(b.type))}`;
  }
  const limit = clampInt(b.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  query += `&order=last_watched.desc&limit=${limit}`;
  query += '&select=item_id,playlist_id,type,name,logo,backdrop,series_id,series_name,season,episode,position,duration,completed,last_watched';

  const rows = await sb(env, query);
  return json({ entries: Array.isArray(rows) ? rows : [] });
}

async function remove(env, b) {
  const device = deviceId(b.device_id);
  if (!device) return json({ error: 'Valid device_id required' }, 400);
  const itemId = str(b.item_id, 128);
  if (!itemId) return json({ error: 'item_id required' }, 400);

  let query = `/watch_history?device_id=eq.${encodeURIComponent(device)}&item_id=eq.${encodeURIComponent(itemId)}`;
  if (b.playlist_id != null) {
    query += `&playlist_id=eq.${encodeURIComponent(playlist(b.playlist_id))}`;
  }
  await sb(env, query, { method: 'DELETE', prefer: 'return=minimal' });
  return json({ ok: true });
}

// Return the paired companion's history so the caller can merge it into its
// local Continue Watching. Requires a MUTUAL devices.companion_device link.
// playlist_id is not filterable here — playlist ids are local to each device —
// so the caller matches on item ids (same provider ⇒ same stream ids).
async function companionList(env, b) {
  const device = deviceId(b.device_id);
  if (!device) return json({ error: 'Valid device_id required' }, 400);

  const rows = await sb(env, `/devices?device_id=eq.${encodeURIComponent(device)}&select=companion_device`);
  const comp = rows && rows[0] && rows[0].companion_device;
  if (!comp) return json({ companion: null, entries: [] });

  const cRows = await sb(env, `/devices?device_id=eq.${encodeURIComponent(comp)}&select=device_id,companion_device`);
  const c = cRows && cRows[0];
  if (!c || c.companion_device !== device) return json({ companion: null, entries: [] });

  const limit = clampInt(b.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const entries = await sb(env,
    `/watch_history?device_id=eq.${encodeURIComponent(comp)}` +
    `&order=last_watched.desc&limit=${limit}` +
    '&select=item_id,playlist_id,type,name,logo,backdrop,series_id,series_name,season,episode,position,duration,completed,last_watched'
  );
  return json({ companion: comp, entries: Array.isArray(entries) ? entries : [] });
}

/* ------------------------------------------------------------------ helpers */

// Map a client Continue Watching item to a table row. Returns null if it has no
// usable id, so junk never reaches the DB.
function sanitize(e, device, playlistId) {
  if (!e || typeof e !== 'object') return null;
  const itemId = str(e.id ?? e.item_id, 128);
  if (!itemId) return null;

  const type = ['movie', 'series', 'live'].includes(String(e.type)) ? String(e.type) : 'movie';
  return {
    device_id: device,
    playlist_id: playlistId,
    item_id: itemId,
    type,
    name: str(e.name, 512),
    logo: str(e.logo, 1024),
    backdrop: str(e.backdrop, 1024),
    series_id: str(e.seriesId ?? e.series_id, 128) || null,
    series_name: str(e.seriesName ?? e.series_name, 512) || null,
    season: clampInt(e.season, null, 0, 100000),
    episode: clampInt(e.episode, null, 0, 100000),
    position: clampNum(e.position, 0),
    duration: clampNum(e.duration, 0),
    completed: e.completed === true,
    last_watched: toIso(e.lastWatched)
  };
}

function deviceId(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(s) ? s : null;
}

// Playlist id is a free-form local identifier; keep it short and default to ''
// so the unique key and every query stay consistent with the NOT NULL column.
function playlist(v) {
  return str(v, 256);
}

function str(v, max) {
  if (v == null) return '';
  return String(v).slice(0, max);
}

function clampNum(v, fallback) {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : fallback;
}

function clampInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toIso(v) {
  const n = Number(v);
  // Client stores lastWatched as an epoch-ms number; fall back to now.
  const d = isFinite(n) && n > 0 ? new Date(n) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
