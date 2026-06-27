// Flixify (flixify.com) source — server-side auth.
//
// Ported from the Kodi addon's PIN/device flow. Auth is COOKIE-SESSION, not a
// bearer token: generate a PIN -> user enters it on the website -> we poll
// until the server hands back `pip`/`session` cookies, which authorise every
// later request. We keep the cookie jar here (Electron desktop / server mode)
// so there's one jar and no browser CORS to fight.
//
// ponytail: desktop/server only for now. Android (no server) would need a
// native HTTP+cookie path — add that when Android is in scope.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same data dir convention as cache.js. ponytail: 3 dup lines beat exporting it.
const DATA_DIR = process.env.ELECTRON_RUNNING === 'true'
  ? path.join(os.homedir(), '.ziptv_pro_data')
  : path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'flixify.json');

const BASE = 'https://flx-srv.com/kodi/api';
const PIN_GENERATE_URL = `${BASE}/pin/generate`;
const PIN_LOGIN_URL = `${BASE}/pin/login`;
const LOGGED_IN_URL = `${BASE}/api/logged_in`;
// Where the user types the PIN. The addon just says "your account page"; this is
// the best-known entry. Surfaced to the client so it's easy to correct later.
const VERIFY_URL = 'https://flixify.com';
const USER_AGENT = 'PP-base Kodi plugin 2.1.17';

// Only these cookies matter; `pip`+`session` are the auth pair (see addon's
// cookie_store.cookies_to_auth), `profile_id` selects the Netflix-style profile.
const AUTH_COOKIES = ['pip', 'session', 'profile_id'];

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return { pin_id: null, user_id: null, cookies: {} }; }
}

function writeStore(s) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) { /* best-effort */ }
}

// Parse the name=value off each Set-Cookie line, keep only the auth cookies.
// Exported for the self-check.
export function pickAuthCookies(setCookieList, into = {}) {
  for (const line of (setCookieList || [])) {
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (AUTH_COOKIES.includes(name) && value) into[name] = value;
  }
  return into;
}

function cookieHeader(cookies) {
  return Object.entries(cookies || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// One outbound call: attaches stored cookies, captures any Set-Cookie, mirrors
// the addon's cache-buster + headers.
async function flxRequest(url, { params, post, store } = {}) {
  const s = store || readStore();
  const qs = new URLSearchParams(params || {});
  qs.set('_', String(Date.now()));           // cache-buster, like the addon
  const full = url + (url.includes('?') ? '&' : '?') + qs.toString();

  const headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/json' };
  const ck = cookieHeader(s.cookies);
  if (ck) headers['Cookie'] = ck;

  const opts = { headers, redirect: 'manual' };
  if (post !== undefined) {
    opts.method = 'POST';
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(post || {}).toString();
  }
  const res = await fetch(full, opts);
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : [];
  if (setCookies.length) {
    s.cookies = pickAuthCookies(setCookies, s.cookies || {});
    writeStore(s);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data, store: s };
}

// Step 1: get a PIN to show the user.
export async function generatePin() {
  const s = readStore();
  const { status, data } = await flxRequest(PIN_GENERATE_URL, { store: s });
  if (status !== 200 || !data || !data.id) {
    throw new Error(`PIN generate failed (${status})`);
  }
  s.pin_id = String(data.id);
  writeStore(s);
  return { pin: String(data.pin), pin_id: s.pin_id, verify_url: VERIFY_URL };
}

// Step 2: poll. Returns 'waiting' | 'success' | 'error'. On success the auth
// cookies have already been captured by flxRequest.
export async function checkPin() {
  const s = readStore();
  if (!s.pin_id) return { state: 'error', error: 'No pending PIN' };
  const { status, data } = await flxRequest(PIN_LOGIN_URL, {
    params: { pin_id: s.pin_id }, store: s,
  });
  if (status !== 200 || !data) return { state: 'error', error: `HTTP ${status}` };
  if (data.user_id) { s.user_id = String(data.user_id); writeStore(s); }
  return { state: data.state === 'success' ? 'success' : 'waiting' };
}

// Auth check: need the cookie pair, then confirm the server still honours it.
export async function isLoggedIn() {
  const s = readStore();
  if (!s.cookies || !s.cookies.pip || !s.cookies.session) return false;
  try {
    const { status, data } = await flxRequest(LOGGED_IN_URL, { store: s });
    if (status === 302 || status === 401) return false;
    if (data && typeof data === 'object' && ('logged_in' in data || 'loggedIn' in data)) {
      return !!(data.logged_in ?? data.loggedIn);
    }
    return status === 200;
  } catch {
    return false;
  }
}

export function logout() {
  writeStore({ pin_id: null, user_id: null, cookies: {} });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Content browsing + playback resolve (Pass 2)
// ---------------------------------------------------------------------------

const HOME_PATH = '/api/kodi/home';

// asset_host prefixes every poster/subtitle path; fetched once, then cached.
async function ensureAssetHost(s) {
  if (s.asset_host) return s.asset_host;
  const { data } = await flxRequest(`${BASE}/api/site_settings`, { store: s });
  if (data && data.asset_host) { s.asset_host = data.asset_host; writeStore(s); }
  return s.asset_host;
}

// Ported from utils.get_item_poster / get_item_fanart.
function posterUrl(item, host, mrootPoster) {
  const img = item.images;
  if (!img) return null;
  if (item.type === 'tvepisode' && img.preview) return 'https://' + host + img.preview;
  if (img.poster) return 'https://' + host + img.poster;
  if (mrootPoster) return mrootPoster;
  if (img.preview_large) return 'https://' + host + img.preview_large;
  return null;
}
function fanartUrl(item, host) {
  const img = item.images;
  if (img && img.preview_large) return 'https://' + host + img.preview_large;
  return null;
}

function normalizeItem(item, host, mrootPoster) {
  return {
    id: item.id,
    type: item.type,
    title: item.title || item.name || '',
    url: item.url || null,
    slug: item.slug || null,
    poster: posterUrl(item, host, mrootPoster),
    fanart: fanartUrl(item, host),
    year: item.year || null,
    rating: item.rating || null,
    duration: item.duration || null,
    plot: item.description || '',
    seq: item.seq, parent_seq: item.parent_seq,
  };
}

// One generic browse call — mirrors the addon's `apiGet(API_URL + url)` for
// home / lists / item grids / tvshow seasons / tvseason episodes. The client
// reads `kind` to decide how to render and navigate.
export async function browse(pathStr, { page = 1, q = '' } = {}) {
  const s = readStore();
  const host = await ensureAssetHost(s);
  const params = {
    postersize: 'poster-big',
    previewsizes: '{"preview_large":"preview_large"}',
    add_mroot_title: 1,
    p: page,
  };
  if (q) params.q = q;

  const { status, data } = await flxRequest(BASE + pathStr, { params, store: s });
  if (status === 402) return { kind: 'free_limit' };
  if (status !== 200 || !data) return { kind: 'error', error: `HTTP ${status}` };

  if (Array.isArray(data.seasons)) {
    const mroot = data.item ? posterUrl(data.item, host) : null;
    return { kind: 'items', items: data.seasons.map(i => normalizeItem(i, host, mroot)) };
  }
  if (Array.isArray(data.episodes)) {
    return { kind: 'items', items: data.episodes.map(i => normalizeItem(i, host)) };
  }
  if (Array.isArray(data.items)) {
    const first = data.items[0];
    if (first && first.act) {
      // Menu rows (home / nested lists).
      const rows = data.items
        .filter(i => i.act)
        .map(i => ({ act: i.act, title: i.title, url: i.url, color: i.color || null }));
      return { kind: 'lists', items: rows };
    }
    return {
      kind: 'items',
      items: data.items.map(i => normalizeItem(i, host)),
      page: data.page, total: data.total, items_per_page: data.items_per_page,
    };
  }
  return { kind: 'items', items: [] };
}

export function homePath() { return HOME_PATH; }

// Resolve an item to a playable stream URL (the setResolvedUrl equivalent).
export async function resolve(pathStr, quality) {
  const s = readStore();
  const host = await ensureAssetHost(s);
  const { status, data } = await flxRequest(BASE + pathStr, {
    params: { skip_redirect: 1, sub: 1, no_media: 1, no_subs: 1 }, store: s,
  });
  if (status === 402) return { error: 'free_limit' };
  if (status !== 200 || !data || !data.item) return { error: `HTTP ${status}` };

  const item = data.item;
  let media = item.media;
  let subtitles = item.subtitles;
  if (item.type === 'movie' || item.type === 'tvepisode') {
    const ml = await flxRequest(`${BASE}/media/links/${item.id}`, { store: s });
    if (ml.data && ml.data.media) media = ml.data.media;
    const sb = await flxRequest(`${BASE}/media/subs/${item.id}`, { store: s });
    if (sb.data && sb.data.subtitles) subtitles = sb.data.subtitles;
  }
  if (!media || Object.keys(media).length === 0) {
    return { error: 'unavailable' };
  }

  // media is { "2160": url, "1080": url, ... }. Honor the user's quality pref
  // (Auto = highest; 1080p/720p = that tier or the next lower one available).
  const rawUrl = pickQuality(media, quality);
  s.lastStream = { id: item.id, url: rawUrl };   // remembered for casting
  writeStore(s);

  // Route through the app's stream proxy: the browser's hls.js/mpegts.js/<video>
  // can't fetch Flixify's CDN cross-origin (the Kodi player never hit CORS). The
  // proxy fetches server-side (no CORS), forwards Range for seeking, and rewrites
  // HLS playlists so segments are proxied too.
  const streamUrl = '/api/proxy?url=' + encodeURIComponent(rawUrl);

  const subs = [];
  if (subtitles && subtitles.eng) {
    for (const sub of subtitles.eng) {
      subs.push('/api/proxy?url=' + encodeURIComponent('https://' + host + sub.url + '?_=/filename.vtt'));
    }
  }
  let resumeTime = 0;
  try { const pos = await watchedPositions([item.id], s); resumeTime = pos[item.id] || 0; } catch (e) {}

  return { streamUrl, rawUrl, title: item.title, subtitles: subs, type: item.type, id: item.id, resumeTime };
}

// --- Profiles (Netflix-style; cookie `profile_id` selects the active one) ----
export async function profiles() {
  const s = readStore();
  const host = await ensureAssetHost(s);
  const { status, data } = await flxRequest(`${BASE}/account/profiles`, { store: s });
  const selected = !!(s.cookies && s.cookies.profile_id);
  if (status !== 200 || !data || !Array.isArray(data.items)) {
    return { items: [], count: 0, selected };
  }
  const items = data.items.map(p => {
    // ponytail: avatar key unconfirmed in the API — try the common ones, else
    // the client shows initials. Adjust once we see a real response.
    let avatar = p.avatar || p.image || p.icon || null;
    if (avatar && !/^https?:\/\//.test(avatar) && host) avatar = 'https://' + host + avatar;
    return { id: p.id, name: p.name, avatar };
  });
  s.profiles_count = items.length; writeStore(s);
  return { items, count: items.length, selected };
}

export async function selectProfile(id) {
  const s = readStore();
  const { status } = await flxRequest(`${BASE}/account/profiles/set/${encodeURIComponent(id)}`, { store: s });
  return { ok: status === 200 };
}

// Choose a stream URL for the requested quality from the {quality: url} map.
function pickQuality(media, quality) {
  const tiers = Object.keys(media)
    .map(k => [parseInt(k, 10) || 0, media[k]])
    .sort((a, b) => b[0] - a[0]);              // highest first
  if (!tiers.length) return null;
  const target = parseInt(quality, 10);
  if (!quality || quality === 'auto' || !target) return tiers[0][1];
  for (const [n, url] of tiers) if (n <= target) return url;   // that tier or lower
  return tiers[tiers.length - 1][1];           // nothing <= target → lowest
}

// Resolved stream URL for a previously-played item (used by the cast endpoint).
// Re-resolves on a cache miss (e.g. server restarted) for movies.
export async function castUrl(id) {
  const s = readStore();
  if (s.lastStream && String(s.lastStream.id) === String(id)) return s.lastStream.url;
  const r = await resolve('/movies/' + id);
  return r && r.rawUrl ? r.rawUrl : null;
}

// --- Watch progress (read for resume, write while playing) -------------------
// Read resume positions for one or more ids: POST /api/watched {ids}.
export async function watchedPositions(ids, store) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length === 0) return {};
  const s = store || readStore();
  const { status, data } = await flxRequest(`${BASE}/api/watched`, {
    post: { ids: list.join(',') }, store: s,
  });
  const out = {};
  if (status === 200 && data && typeof data === 'object') {
    for (const id of Object.keys(data)) {
      const r = data[id] && data[id].resume;
      if (r && (r.position || r.position === 0)) out[id] = r.position;
    }
  }
  return out;
}

// Report progress: POST /account/watched/seen/<id>?pos&user_id&delta_sec[&cw][&completed]
export async function reportProgress(id, { pos = 0, delta = 0, cw = false, completed = false } = {}) {
  const s = readStore();
  if (!id || !s.user_id) return { ok: false, reason: 'no user_id' };
  const params = {
    pos: Math.round(pos * 100) / 100,
    user_id: s.user_id,
    delta_sec: Math.round(delta * 100) / 100,
  };
  if (cw) params.cw = 1;
  if (completed) params.completed = 1;
  const { status } = await flxRequest(`${BASE}/account/watched/seen/${encodeURIComponent(id)}`, {
    params, post: {}, store: s,
  });
  return { ok: status === 200 };
}

// ponytail: one runnable check — the cookie parser is the only non-trivial bit
// (everything else is HTTP plumbing). Run: `node server/flixify.js --selfcheck`.
if (process.argv.includes('--selfcheck')) {
  const out = pickAuthCookies([
    'session=abc123; Path=/; HttpOnly; Secure',
    'pip=deadbeef; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
    'profile_id=7; Path=/',
    'ignore_me=nope; Path=/',
  ]);
  const ok = out.session === 'abc123' && out.pip === 'deadbeef'
    && out.profile_id === '7' && !('ignore_me' in out);
  const hdr = cookieHeader(out);
  const hdrOk = hdr.includes('session=abc123') && hdr.includes('pip=deadbeef');
  console.log('pickAuthCookies:', out);
  console.log('cookieHeader:', hdr);
  if (!ok || !hdrOk) { console.error('SELFCHECK FAILED'); process.exit(1); }
  console.log('SELFCHECK OK');
}
