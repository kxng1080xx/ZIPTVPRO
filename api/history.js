/**
 * Watch history backup (PC + APK + TV). Cross-origin — the apps load from
 * file://, the capacitor:// scheme, or the web build, so CORS is open. Scoped
 * to a single device_id; it never exposes another device's history.
 *
 *   POST /api/history  { action, device_id, ... }
 *
 *     record { device_id, playlist_id, entries: [ {...} ] }  -> { ok, count }
 *     list   { device_id, playlist_id?, type?, limit? }      -> { entries: [...] }
 *     delete { device_id, playlist_id?, item_id }            -> { ok }
 *
 * This is a BACKUP of the client's local Continue Watching store (localStorage,
 * see xtream-api.js). localStorage stays the source of truth; these rows exist
 * so a future feature (cross-device resume / full history) has the data. Writes
 * are upserts on (device_id, playlist_id, item_id) — replaying a title just
 * moves its position forward instead of piling up duplicates.
 *
 * Uses the SERVICE ROLE key (see _supabase.js). The table has RLS on with no
 * public policy, so the only way in or out is through this endpoint.
 */
import { sb, supabaseConfigured } from './_supabase.js';

const MAX_ENTRIES_PER_CALL = 50;   // a device only ever backs up a handful at once
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseConfigured()) return res.status(500).json({ error: 'Server not configured.' });

  try {
    const b = await readBody(req);
    const action = String(b.action || '').trim();

    switch (action) {
      case 'record': return await record(req, res, b);
      case 'list':   return await list(req, res, b);
      case 'delete': return await remove(req, res, b);
      default:       return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
}

/* ------------------------------------------------------------------ actions */

async function record(req, res, b) {
  const device = deviceId(b.device_id);
  if (!device) return res.status(400).json({ error: 'Valid device_id required' });

  const playlistId = playlist(b.playlist_id);
  const raw = Array.isArray(b.entries) ? b.entries : (b.entry ? [b.entry] : []);
  if (!raw.length) return res.status(400).json({ error: 'entries required' });

  const rows = raw
    .slice(0, MAX_ENTRIES_PER_CALL)
    .map((e) => sanitize(e, device, playlistId))
    .filter(Boolean);

  if (!rows.length) return res.status(400).json({ error: 'No valid entries' });

  // Upsert on the natural key so a resume overwrites the previous position.
  await sb('/watch_history?on_conflict=device_id,playlist_id,item_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: rows
  });

  return res.status(200).json({ ok: true, count: rows.length });
}

async function list(req, res, b) {
  const device = deviceId(b.device_id);
  if (!device) return res.status(400).json({ error: 'Valid device_id required' });

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

  const rows = await sb(query);
  return res.status(200).json({ entries: Array.isArray(rows) ? rows : [] });
}

async function remove(req, res, b) {
  const device = deviceId(b.device_id);
  if (!device) return res.status(400).json({ error: 'Valid device_id required' });
  const itemId = str(b.item_id, 128);
  if (!itemId) return res.status(400).json({ error: 'item_id required' });

  let query = `/watch_history?device_id=eq.${encodeURIComponent(device)}&item_id=eq.${encodeURIComponent(itemId)}`;
  if (b.playlist_id != null) {
    query += `&playlist_id=eq.${encodeURIComponent(playlist(b.playlist_id))}`;
  }
  await sb(query, { method: 'DELETE', prefer: 'return=minimal' });
  return res.status(200).json({ ok: true });
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

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}
