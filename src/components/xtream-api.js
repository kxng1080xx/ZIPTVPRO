/**
 * Frontend Client for interacting with the local IPTV Player Node.js backend API
 * or querying the IPTV server directly (using client-side IndexedDB cache).
 */
import { db } from './db.js';
import { getDeviceCode, backupWatchHistory, deleteWatchHistory } from './cloud-sync.js';

let isServerMode = false;
let epgMemoryCache = {};

/**
 * On a hosted HTTPS web build (e.g. Vercel) the browser blocks direct requests
 * to an HTTP Xtream provider (mixed content) and to any cross-origin server with
 * no CORS headers. In that case we route external requests through the bundled
 * serverless proxy at /api/proxy. In the native app (Capacitor) or local/HTTP
 * dev we fetch the provider directly, since those environments allow it.
 */
const USE_WEB_PROXY = (() => {
  try {
    const isCapacitor = !!(
      window.Capacitor &&
      (typeof window.Capacitor.isNativePlatform === 'function'
        ? window.Capacitor.isNativePlatform()
        : window.Capacitor.isNative)
    );
    return window.location.protocol === 'https:' && !isCapacitor;
  } catch (e) {
    return false;
  }
})();

// Wrap an absolute provider URL so it is fetched via the serverless proxy when needed.
function proxify(url) {
  return USE_WEB_PROXY ? `/api/proxy?url=${encodeURIComponent(url)}` : url;
}

// Wrap an <img> source. On the HTTPS web build, provider icons/posters served
// over plain HTTP are blocked as mixed content, so route them through the proxy.
// (https:// images render directly — <img> needs no CORS — so leave them alone.)
export function proxifyImage(url) {
  if (!url || typeof url !== 'string') return url || '';
  // Server mode (Electron desktop / local server): route every provider image
  // through the local proxy. Some providers 403 a plain browser User-Agent, so a
  // direct <img> silently fails — the proxy refetches with the VLC UA (and
  // follows redirects) so the logos render.
  if (isServerMode && /^https?:\/\//i.test(url)) {
    return `/api/proxy?url=${encodeURIComponent(url)}`;
  }
  // Hosted HTTPS web build: http images are blocked as mixed content.
  if (USE_WEB_PROXY && /^http:\/\//i.test(url)) {
    return `/api/proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

// Providers prefix live-channel names with country/package tags in wildly
// inconsistent shapes — "US: CNN", "USA : CNN", "[US] CNN", "|AR| beIN",
// "PM : CA TCM", "UK MOVIES: SKY COMEDY", "US Cozi", flag emoji… Strip those
// so every UI shows just the channel name. Runs a few passes because tags
// stack ("PM : CA TCM" → "CA TCM" → "TCM").
// NOTE: no "ID" (Investigation Discovery) or "AT" ("AT 5") — real channel
// names that would be eaten if treated as country codes.
const BARE_COUNTRY = /^(?:US|UK|GB|CA|AU|NZ|IE|AR|BR|MX|DE|FR|ES|IT|PT|NL|BE|CH|PL|TR|GR|RO|SE|NO|DK|FI|IN|PK|ZA|EG|SA|AE|QA|KW|IL|RU|UA|CZ|SK|HU|HR|RS|BG|PH|MY|SG|TH|VN|KR|JP|CN|HK|TW|CL|CO|PE|VE|EC|UY|PY|BO|CR|PA|DO|JM|TT)\s+(?=\S)/;
export function cleanChannelName(raw) {
  if (!raw) return raw || '';
  let s = String(raw);
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.trimStart();
    s = s.replace(/^[[({]\s*[^\])}]{1,12}\s*[\])}]\s*/, '');       // [US] (UK) {VIP}
    s = s.replace(/^\|[^|]{1,12}\|\s*/, '');                       // |AR|
    s = s.replace(/^[A-Z]{2,4}(?:\s[A-Z]{2,12}){0,2}\s*[:|]\s*/, ''); // "PM :", "USA:", "UK MOVIES:", "VIP| X"
    s = s.replace(BARE_COUNTRY, '');                               // "US Cozi" (2-letter codes only)
    // flag / pictographic emoji and variation selectors
    s = s.replace(/^(?:[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]+\s*)+/u, '');
    // stray separators left behind by a stripped tag (last, so it can't eat
    // the opening "|" of a |XX| tag before the rule above sees it; a lone
    // pipe only counts when followed by a space, so "|AR| x" stays intact)
    s = s.replace(/^(?:\|\s+|[\s\-–—:•·.]+)+/, '');
    if (s === before) break;
  }
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || String(raw).trim(); // never clean a name into nothing
}
// Map live items to display shape (original name survives in the cache/DB).
function cleanLiveItems(items) {
  return items.map(it => it && it.name ? { ...it, name: cleanChannelName(it.name) } : it);
}

// Helper: Check if backend server is active. Memoized so the detection runs
// (and is awaited) exactly once, including before the first playlist read on boot.
let serverModePromise = null;
function ensureServerMode() {
  if (!serverModePromise) serverModePromise = checkServerMode();
  return serverModePromise;
}

async function checkServerMode() {
  try {
    // /api/status may block on an upstream provider check (up to ~8s), so allow
    // headroom — a too-short timeout makes REMOTE clients (phone over the
    // Cloudflare tunnel, added LTE latency) abort and wrongly fall back to
    // client mode with empty local storage → "0 channels". The web build has no
    // /api/status route, so it returns HTML/404 fast and this still resolves
    // quickly to false.
    const res = await fetch('/api/status', { signal: AbortSignal.timeout(9000) });
    if (res.ok) {
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data && typeof data === 'object' && 'loggedIn' in data) {
          isServerMode = true;
          return true;
        }
      }
    }
  } catch (err) {}
  isServerMode = false;
  return false;
}

// ---------------------------------------------------------------------------
// Multi-playlist local storage. Several Xtream logins can be saved; one is the
// "active" playlist. getCredentialsLocal() returns the active one so the rest of
// the client keeps working unchanged.
// ---------------------------------------------------------------------------
const PLAYLISTS_KEY = 'xtream_playlists';
const ACTIVE_KEY = 'xtream_active_id';
const LEGACY_KEY = 'xtream_credentials';

function makePlaylistId(c) {
  return `${(c.server_url || '').toLowerCase()}|${c.username || ''}`;
}

function readPlaylists() {
  let list = [];
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY);
    if (raw) list = JSON.parse(raw);
    if (!Array.isArray(list)) list = [];
  } catch (e) {
    list = [];
  }
  // One-time migration from the old single-credential storage.
  if (list.length === 0) {
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const c = JSON.parse(legacy);
        if (c && c.server_url) {
          c.id = c.id || makePlaylistId(c);
          list = [c];
          localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
          localStorage.setItem(ACTIVE_KEY, c.id);
          localStorage.removeItem(LEGACY_KEY);
        }
      }
    } catch (e) {}
  }
  return list;
}

function writePlaylists(list) {
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list));
}

function getActiveIdLocal() {
  return localStorage.getItem(ACTIVE_KEY);
}

function setActiveIdLocal(id) {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

function getCredentialsLocal() {
  const list = readPlaylists();
  if (list.length === 0) return null;
  const activeId = getActiveIdLocal();
  return list.find(p => p.id === activeId) || list[0];
}

// The active playlist's PROVIDER identity — the normalised server host, and
// deliberately NOT the username. One server routinely issues many different
// credentials (a household can hold several logins on the same provider), and
// those people should still be able to watch together: what has to match is that
// both devices can resolve the same stream ids, which is a property of the
// server, not of the login. Watch Together hashes this so two devices can prove
// they're on the same provider without either sending credentials anywhere.
// Returns null when no playlist is configured.
//
// Goes through getPlaylists() rather than getCredentialsLocal() because it must
// work in BOTH modes: in server mode (the desktop build's bundled Express server)
// credentials live server-side and localStorage is empty, so reading it locally
// would report "no playlist" on a device that plainly has one.
export async function getActiveSubscriptionKey() {
  let list, activeId;
  try {
    ({ playlists: list, activeId } = await getPlaylists());
  } catch (e) {
    return null;
  }
  const p = (list || []).find(x => x.id === activeId) || (list || [])[0];
  if (!p || !p.server_url) return null;
  return String(p.server_url).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

// Add a new playlist (or update an existing one with the same server+user) and
// make it the active playlist.
function saveCredentialsLocal(creds) {
  const list = readPlaylists();
  if (!creds.id) creds.id = makePlaylistId(creds);
  const idx = list.findIndex(p => p.id === creds.id);
  if (idx >= 0) {
    // Preserve favorites and recently viewed
    creds.favorites = list[idx].favorites || creds.favorites || { live: [], movie: [], series: [] };
    creds.recently_viewed = list[idx].recently_viewed || creds.recently_viewed || [];
    list[idx] = { ...list[idx], ...creds };
  } else {
    creds.favorites = creds.favorites || { live: [], movie: [], series: [] };
    creds.recently_viewed = creds.recently_viewed || [];
    list.push(creds);
  }
  writePlaylists(list);
  setActiveIdLocal(creds.id);
}

// Update a playlist's details by matching server URL and username.
export async function updatePlaylistByServerAndUser(serverUrl, username, settings) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');
  const targetKey = norm(serverUrl) + '|' + String(username || '').toLowerCase();
  
  // 1. Always update local storage first so the browser UI is kept in sync immediately
  const localList = readPlaylists();
  const localIdx = localList.findIndex(p => (norm(p.server_url) + '|' + String(p.username || '').toLowerCase()) === targetKey);
  let localChanged = false;
  let localId = null;
  let unhid = false;
  if (localIdx >= 0) {
    const old = localList[localIdx];
    localId = old.id;
    localChanged =
      JSON.stringify(old.hidden_tabs || []) !== JSON.stringify(settings.hidden_tabs || []) ||
      JSON.stringify(old.hidden_categories || []) !== JSON.stringify(settings.hidden_categories || []) ||
      (settings.playlistName && old.name !== settings.playlistName);

    // Was anything revealed? Hidden tabs/categories are skipped at sync time,
    // so unhiding one means its data is missing and needs a backfill sync.
    const newHidden = new Set([
      ...(settings.hidden_tabs || []),
      ...(settings.hidden_categories || []).map(String)
    ]);
    unhid = [...(old.hidden_tabs || []), ...(old.hidden_categories || []).map(String)]
      .some(h => !newHidden.has(h));

    if (localChanged) {
      localList[localIdx] = { ...old, ...settings };
      if (settings.playlistName) localList[localIdx].name = settings.playlistName;
      writePlaylists(localList);
    }
  }

  if (isServerMode) {
    try {
      const { playlists } = await getPlaylists();
      const match = (playlists || []).find(p => (norm(p.server_url) + '|' + String(p.username || '').toLowerCase()) === targetKey);
      if (match) {
        const old = match;
        const changed = 
          JSON.stringify(old.hidden_tabs || []) !== JSON.stringify(settings.hidden_tabs || []) ||
          JSON.stringify(old.hidden_categories || []) !== JSON.stringify(settings.hidden_categories || []) ||
          (settings.playlistName && old.playlistName !== settings.playlistName);
          
        if (changed) {
          await fetch('/api/playlists/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: old.id,
              hidden_tabs: settings.hidden_tabs,
              hidden_categories: settings.hidden_categories,
              playlistName: settings.playlistName
            })
          });
        }
        return { id: old.id, changed: changed || localChanged, unhid };
      }
    } catch (e) {
      console.warn('Failed to update remote settings on server:', e.message);
    }
    return { id: localId, changed: localChanged, unhid };
  } else {
    // Client mode
    return { id: localId, changed: localChanged, unhid };
  }
}

// Best-effort fetch of the Xtream user_info for a saved playlist (client mode),
// used to backfill the subscription expiry for playlists saved before exp_date
// was tracked. Returns the user_info object or null on any failure.
async function fetchUserInfoClient(creds) {
  try {
    let host = (creds.server_url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(host)) host = 'http://' + host;
    const url = `${host}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
    const res = await fetch(proxify(url), { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.user_info ? data.user_info : null;
  } catch (e) {
    return null;
  }
}

// Persist the resolved expiry/status back onto a saved playlist so the lookup
// above only happens once per playlist.
function persistAccountInfo(id, exp_date, account_status) {
  const list = readPlaylists();
  const idx = list.findIndex(p => p.id === id);
  if (idx >= 0) {
    list[idx].exp_date = exp_date;
    list[idx].account_status = account_status;
    writePlaylists(list);
  }
}

export async function login(hostUrl, username, password, playlistName, { skipAccountCheck = false } = {}) {
  await checkServerMode();

  if (isServerMode) {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostUrl, username, password, playlistName, skipAccountCheck })
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Login failed');
    }
    return response.json();
  } else {
    // Client Mode login
    let normalizedHost = hostUrl.trim();
    const lowerHost = normalizedHost.toLowerCase();
    if (!lowerHost.startsWith('http://') && !lowerHost.startsWith('https://')) {
      normalizedHost = 'http://' + normalizedHost;
    } else {
      normalizedHost = normalizedHost.replace(/^https?:\/\//i, (match) => match.toLowerCase());
    }
    if (normalizedHost.endsWith('/')) {
      normalizedHost = normalizedHost.slice(0, -1);
    }
    
    const testUrl = `${normalizedHost}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

    // 1. Reachability: a network error / timeout means the server is unavailable.
    let res;
    try {
      res = await fetch(proxify(testUrl), { signal: AbortSignal.timeout(12000) });
    } catch (e) {
      throw new Error('Server unavailable. Check the server URL and your internet connection.');
    }
    if (!res.ok) {
      throw new Error('Server unavailable. Check the server URL (status ' + res.status + ').');
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('Could not read a valid response. Check the server URL.');
    }

    const info = data.user_info;
    if (!info) {
      throw new Error('Could not read a valid response. Check the server URL.');
    }

    // 2. Credentials: auth === 0 means wrong username/password.
    if (info.auth === 0 || info.auth === '0') {
      throw new Error('Incorrect username or password.');
    }

    // 3. Subscription: expired or otherwise inactive account. Skipped when syncing
    // playlists from the ZIPTV admin dashboard — there, ZIPTV's own admin-set
    // expiry (Supabase devices.expires_at) is the sole authority, not the
    // underlying provider's own exp_date/status (which can differ or be stale).
    if (!skipAccountCheck) {
      const accountError = describeAccountState(info);
      if (accountError) {
        throw new Error(accountError);
      }
    }

    const credentials = {
      playlistName: playlistName || 'My Xtream Playlist',
      server_url: normalizedHost,
      username,
      password,
      stream_format: 'ts', // Default to ts on mobile for compatibility
      // Persist the real subscription expiry/status so getStatus (client mode)
      // can show it instead of always falling back to "Active - Unlimited".
      exp_date: info.exp_date ?? null,
      account_status: info.status ?? null
    };
    saveCredentialsLocal(credentials);
    return {
      success: true,
      user_info: info,
      server_info: data.server_info
    };
  }
}

// Returns a user-facing error string when the Xtream account is expired/inactive,
// or null when it's active. exp_date is a unix timestamp (seconds) or null.
function describeAccountState(info) {
  const status = String(info.status || '').toLowerCase();
  const exp = parseInt(info.exp_date, 10);
  const isExpired = status === 'expired' || (exp && !isNaN(exp) && exp * 1000 < Date.now());
  if (isExpired) return 'Your subscription has expired.';
  if (status && status !== 'active') return `Your account is not active (${info.status}).`;
  return null;
}

export async function getStatus() {
  await checkServerMode();
  if (isServerMode) {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('Failed to get status');
    return response.json();
  } else {
    // Client Mode getStatus
    const creds = getCredentialsLocal();
    if (!creds) {
      return { loggedIn: false };
    }
    
    // Try to get favorites from Dexie
    const favs = { live: [], movie: [], series: [] };
    try {
      const records = await db.favorites.toArray();
      records.forEach(r => {
        if (favs[r.type]) favs[r.type].push(String(r.id));
      });
    } catch (e) {}

    // Resolve the real subscription expiry. Newer playlists store it at login;
    // older ones are backfilled once via a live lookup so the header no longer
    // always reads "Active - Unlimited".
    let expDate = creds.exp_date;
    let acctStatus = creds.account_status || 'Active';
    if (expDate === undefined) {
      const info = await fetchUserInfoClient(creds);
      if (info) {
        expDate = info.exp_date ?? null;
        acctStatus = info.status ?? acctStatus;
        persistAccountInfo(creds.id, expDate, acctStatus);
      } else {
        expDate = null;
      }
    }

    return {
      loggedIn: true,
      credentials: {
        playlistName: creds.playlistName,
        server_url: creds.server_url,
        username: creds.username,
        stream_format: creds.stream_format
      },
      user_info: {
        username: creds.username,
        status: acctStatus,
        exp_date: expDate
      },
      server_info: {
        url: creds.server_url
      },
      favorites: favs
    };
  }
}

async function clearLocalCache() {
  try {
    await db.live_categories.clear();
    await db.vod_categories.clear();
    await db.series_categories.clear();
    await db.live_streams.clear();
    await db.vod_streams.clear();
    await db.series_streams.clear();
    await db.favorites.clear();
    await db.recently_viewed.clear();
  } catch (e) {}
}

async function loadPlaylistFavoritesAndHistoryIntoDB(target) {
  await db.favorites.clear();
  await db.recently_viewed.clear();
  if (!target) return;
  if (target.favorites) {
    for (const [type, ids] of Object.entries(target.favorites)) {
      if (Array.isArray(ids)) {
        for (const fid of ids) {
          try {
            await db.favorites.put({ type, id: String(fid) });
          } catch (e) {}
        }
      }
    }
  }
  if (target.recently_viewed && Array.isArray(target.recently_viewed)) {
    let timestamp = Date.now();
    for (const rid of target.recently_viewed) {
      try {
        await db.recently_viewed.put({ id: String(rid), timestamp: timestamp-- });
      } catch (e) {}
    }
  }
}
 
export async function logout() {
  if (isServerMode) {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Logout failed');
    return response.json();
  } else {
    // Disconnect/deactivate the active playlist (but keep it saved in playlists list)
    setActiveIdLocal(null);
    await clearLocalCache();
    const list = readPlaylists();
    return { success: true, remaining: list.length, activeId: null };
  }
}

// List saved playlists and which one is active.
export async function getPlaylists() {
  await ensureServerMode();
  if (isServerMode) {
    const response = await fetch('/api/playlists');
    if (!response.ok) throw new Error('Failed to load playlists');
    const data = await response.json();
    // Mirror the server's active playlist id locally so Continue Watching is
    // scoped per playlist in server mode (see switchPlaylist).
    if (data && data.activeId) setActiveIdLocal(data.activeId);
    return data;
  }
  const list = readPlaylists();
  let activeId = getActiveIdLocal();
  if (!list.find(p => p.id === activeId)) activeId = list[0] ? list[0].id : null;
  return {
    playlists: list.map(p => ({
      id: p.id,
      playlistName: p.playlistName,
      server_url: p.server_url,
      username: p.username
    })),
    activeId
  };
}

// Make a saved playlist the active one. The caller re-syncs + reloads afterward.
export async function switchPlaylist(id) {
  if (isServerMode) {
    const response = await fetch('/api/playlists/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!response.ok) throw new Error('Failed to switch playlist');
    // Mirror the active id locally so Continue Watching (keyed by cwKey() →
    // getActiveIdLocal()) is scoped per playlist in server mode too. Without
    // this, getActiveIdLocal() is null and every playlist shares 'cw_default'.
    setActiveIdLocal(id);
    return response.json();
  }
  const list = readPlaylists();
  const target = list.find(p => p.id === id);
  if (!target) throw new Error('Playlist not found');
  setActiveIdLocal(id);
  await clearLocalCache();
  await loadPlaylistFavoritesAndHistoryIntoDB(target);
  return { success: true, activeId: id };
}

// Remove a saved playlist. Returns whether any remain + the new active id.
export async function removePlaylist(id) {
  if (isServerMode) {
    const response = await fetch('/api/playlists/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!response.ok) throw new Error('Failed to remove playlist');
    return response.json();
  }
  let list = readPlaylists();
  const wasActive = getActiveIdLocal() === id;
  list = list.filter(p => p.id !== id);
  writePlaylists(list);
  if (wasActive) {
    const newActiveId = list[0] ? list[0].id : null;
    setActiveIdLocal(newActiveId);
    await clearLocalCache();
    if (newActiveId) {
      await loadPlaylistFavoritesAndHistoryIntoDB(list[0]);
    }
  }
  return { success: true, remaining: list.length, activeId: getActiveIdLocal(), wasActive };
}

// ---------------------------------------------------------------------------
// Continue Watching — tracks where the user stopped in movies/series episodes.
// Stored in localStorage, scoped per active playlist. Works in any mode.
// ---------------------------------------------------------------------------
const CW_PREFIX = 'cw_';

function cwKey() {
  return CW_PREFIX + (getActiveIdLocal() || 'default');
}

export function getContinueWatching(type = null) {
  let list = [];
  try {
    const raw = localStorage.getItem(cwKey());
    if (raw) list = JSON.parse(raw);
  } catch (e) {}
  if (!Array.isArray(list)) list = [];
  list.sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0));
  return type ? list.filter(i => i.type === type) : list;
}

export function saveWatchProgress(item) {
  if (!item || !item.id) return;
  const entry = { ...item, lastWatched: Date.now() };
  let list = getContinueWatching();
  list = list.filter(i => String(i.id) !== String(item.id));
  list.unshift(entry);
  if (list.length > 30) list = list.slice(0, 30);
  try {
    localStorage.setItem(cwKey(), JSON.stringify(list));
  } catch (e) {}
  // Re-watching a finished title puts it back "in progress" — clear its
  // completed (dimmed "Watch again") state locally and in the cloud copy.
  unmarkCompleted(item.id);
  // Mirror to the cloud (best-effort, throttled, fire-and-forget). localStorage
  // above stays the source of truth; this is just the backup for a later feature.
  try { backupWatchHistory(getDeviceCode(), getActiveIdLocal(), entry); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Completed — movies/episodes watched to the end (auto-marked when <5 min
// remain, see main.js persistProgress). Powers the dimmed "Watch again" tiles.
// Stored per playlist like Continue Watching; ids are stream/episode ids.
// ---------------------------------------------------------------------------
const DONE_PREFIX = 'done_';

function doneKey() {
  return DONE_PREFIX + (getActiveIdLocal() || 'default');
}

export function getCompletedIds() {
  try {
    const raw = localStorage.getItem(doneKey());
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map(String) : [];
  } catch (e) {
    return [];
  }
}

export function isCompleted(id) {
  if (id == null) return false;
  return getCompletedIds().includes(String(id));
}

// One-stop watch state for a movie/episode id, for decorating tiles:
//   { completed, pct, position, duration }
// completed → show the dimmed "Watch again" state; otherwise pct (>0) drives the
// "how far in" progress bar. Reads the same stores the UI already uses.
export function getWatchInfo(id) {
  const sid = String(id);
  if (isCompleted(sid)) return { completed: true, pct: 100, position: 0, duration: 0 };
  const it = getContinueWatching().find(i => String(i.id) === sid);
  const position = (it && (it.position || it.currentTime)) || 0;
  const duration = (it && it.duration) || 0;
  const pct = (position && duration) ? Math.min(100, (position / duration) * 100) : 0;
  return { completed: false, pct, position, duration };
}

export function markCompleted(item) {
  if (!item || item.id == null) return;
  const id = String(item.id);
  const existing = getCompletedIds();
  const already = existing.includes(id);
  const ids = existing.filter(x => x !== id);
  ids.unshift(id);
  if (ids.length > 500) ids.length = 500;
  try {
    localStorage.setItem(doneKey(), JSON.stringify(ids));
  } catch (e) {}
  // Back up the completion exactly once (on the transition), pinning position to
  // duration and flagging completed so a later feature can tell it apart.
  if (!already) {
    try {
      backupWatchHistory(
        getDeviceCode(),
        getActiveIdLocal(),
        { ...item, position: item.duration || item.position || 0, completed: true, lastWatched: Date.now() },
        true
      );
    } catch (e) {}
  }
}

export function unmarkCompleted(id) {
  if (id == null) return;
  const sid = String(id);
  const current = getCompletedIds();
  if (!current.includes(sid)) return;
  try {
    localStorage.setItem(doneKey(), JSON.stringify(current.filter(x => x !== sid)));
  } catch (e) {}
}

export function removeWatchProgress(id) {
  const list = getContinueWatching().filter(i => String(i.id) !== String(id));
  try {
    localStorage.setItem(cwKey(), JSON.stringify(list));
  } catch (e) {}
  try { deleteWatchHistory(getDeviceCode(), getActiveIdLocal(), id); } catch (e) {}
}

// Remove every Continue Watching entry belonging to a series (all episodes).
// seriesKey matches the collapse key used by the CW rows: seriesId || seriesName || id.
export function removeSeriesWatchProgress(seriesKey) {
  const all = getContinueWatching();
  const removed = all.filter(i => String(i.seriesId || i.seriesName || i.id) === String(seriesKey));
  const list = all.filter(i => String(i.seriesId || i.seriesName || i.id) !== String(seriesKey));
  try {
    localStorage.setItem(cwKey(), JSON.stringify(list));
  } catch (e) {}
  try {
    const code = getDeviceCode();
    const pid = getActiveIdLocal();
    removed.forEach(i => deleteWatchHistory(code, pid, i.id));
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Companion history merge — folds the paired device's cloud history rows into
// THIS device's local Continue Watching / Completed stores, newest-wins per
// item. Called by main.js after fetchCompanionHistory. Writes localStorage
// directly (no saveWatchProgress) so remote timestamps are preserved and no
// backup echo is triggered. Stream/episode ids match across the two devices
// because companions use the same provider playlists. Returns how many items
// changed so the caller knows whether to re-render.
// ---------------------------------------------------------------------------
export function mergeCompanionHistory(entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;

  const list = getContinueWatching();
  const localById = new Map(list.map((i) => [String(i.id), i]));
  const doneIds = getCompletedIds();
  const doneSet = new Set(doneIds);
  let cwChanged = false;
  let doneChanged = false;
  let changed = 0;

  for (const e of entries) {
    const id = String(e.item_id || '');
    if (!id || (e.type !== 'movie' && e.type !== 'series')) continue;

    const remoteAt = Date.parse(e.last_watched) || 0;
    const local = localById.get(id);
    // Local activity time for the id: its CW timestamp. A title completed
    // here is authoritative (Infinity) — completion time isn't stored, so a
    // stale companion in-progress row must never un-complete it on re-merge.
    const localAt = local ? (local.lastWatched || 0) : (doneSet.has(id) ? Infinity : 0);
    if (remoteAt <= localAt) continue;

    if (e.completed) {
      // Companion finished it more recently than anything here: drop the
      // in-progress entry and dim the tile as "Watch again".
      if (local) { list.splice(list.indexOf(local), 1); localById.delete(id); cwChanged = true; }
      if (!doneSet.has(id)) { doneSet.add(id); doneIds.unshift(id); doneChanged = true; }
      changed++;
      continue;
    }

    const item = {
      id,
      type: e.type,
      name: e.name || '',
      logo: e.logo || '',
      backdrop: e.backdrop || '',
      position: Number(e.position) || 0,
      duration: Number(e.duration) || 0,
      lastWatched: remoteAt
    };
    if (e.series_id) item.seriesId = e.series_id;
    if (e.series_name) item.seriesName = e.series_name;
    if (e.season != null) item.season = e.season;
    if (e.episode != null) item.episode = e.episode;

    if (local) list.splice(list.indexOf(local), 1);
    list.unshift(item);
    localById.set(id, item);
    cwChanged = true;
    // Companion re-watched a title this device had finished — undim it here too.
    if (doneSet.has(id)) {
      doneSet.delete(id);
      doneIds.splice(doneIds.indexOf(id), 1);
      doneChanged = true;
    }
    changed++;
  }

  if (cwChanged) {
    list.sort((a, b) => (b.lastWatched || 0) - (a.lastWatched || 0));
    try { localStorage.setItem(cwKey(), JSON.stringify(list.slice(0, 30))); } catch (e) {}
  }
  if (doneChanged) {
    try { localStorage.setItem(doneKey(), JSON.stringify(doneIds.slice(0, 500))); } catch (e) {}
  }
  return changed;
}

export async function updateSettings(settings) {
  if (isServerMode) {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    if (!response.ok) throw new Error('Failed to update settings');
    return response.json();
  } else {
    const creds = getCredentialsLocal();
    if (!creds) throw new Error('Not logged in');
    if (settings.stream_format) creds.stream_format = settings.stream_format;
    saveCredentialsLocal(creds);
    return { success: true, credentials: creds };
  }
}

export async function syncPlaylist(progressCallback = null, { onLiveReady = null } = {}) {
  if (isServerMode) {
    const response = await fetch('/api/sync', { method: 'POST' });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Sync failed');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let result = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep the last incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            if (data.error) {
              throw new Error(data.error);
            }
            if (data.progress && progressCallback) {
              progressCallback(data.progress);
            }
            if (data.success) {
              result = data;
            }
          } catch (e) {
            console.error('Error parsing SSE chunk:', e);
            if (e.message && e.message.includes('Sync failed')) {
              throw e;
            }
          }
        }
      }
    }

    // Process any remaining text in buffer
    if (buffer) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.error) throw new Error(data.error);
          if (data.progress && progressCallback) progressCallback(data.progress);
          if (data.success) result = data;
        } catch (e) {
          console.error('Error parsing trailing SSE chunk:', e);
          if (e.message && e.message.includes('Sync failed')) throw e;
        }
      }
    }

    if (result) {
      return result;
    }
    throw new Error('Sync connection terminated without success status.');
  } else {
    const creds = getCredentialsLocal();
    if (!creds) throw new Error('No playlist credentials found');

    // Hidden tabs / categories: don't download or store what the user can't
    // see. On low-power devices this skips entire multi-MB JSON catalogs.
    // Skipped stages leave the old cached tables untouched; unhiding marks
    // the sync stale so the next background sync backfills them.
    const hiddenTabs = Array.isArray(creds.hidden_tabs)
      ? creds.hidden_tabs
      : (() => { try { return JSON.parse(localStorage.getItem('hiddenTabs')) || []; } catch (e) { return []; } })();
    const hiddenCatSet = new Set(
      (Array.isArray(creds.hidden_categories) ? creds.hidden_categories : []).map(String)
    );
    const dropHiddenRows = (rows) =>
      (hiddenCatSet.size && Array.isArray(rows)) ? rows.filter(r => !hiddenCatSet.has(String(r.category_id))) : rows;
    const dropHiddenCats = (cats) =>
      (hiddenCatSet.size && Array.isArray(cats)) ? cats.filter(c => !hiddenCatSet.has(String(c.category_id))) : cats;

    const baseApiUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;

    const jget = (action) =>
      fetch(proxify(`${baseApiUrl}&action=${action}`)).then((r) => r.json()).catch(() => []);

    // Per-category counts are computed here (while the stream arrays are in
    // memory anyway) and stored ON the category records, so getCategories()
    // never has to materialize a whole stream table again — that full-table
    // scan was one of the big startup costs on Fire TV / low-power devices.
    const countByCategory = (rows) => {
      const map = {};
      for (const s of rows) {
        map[s.category_id] = (map[s.category_id] || 0) + 1;
      }
      return map;
    };
    const embedCounts = (cats, counts) =>
      (Array.isArray(cats) ? cats : []).map((c) => ({
        ...c,
        count: counts[String(c.category_id)] || 0
      }));

    // The sync now runs in three sequential stages (live → movies → series)
    // instead of six concurrent downloads. Rationale for weak devices:
    //   1. Live TV becomes usable as soon as stage 1 lands (onLiveReady) —
    //      the user isn't stuck staring at a blocker while 30MB of VOD JSON
    //      downloads and parses.
    //   2. Peak memory is one catalog at a time instead of all six raw JSON
    //      arrays + mapped copies held simultaneously (GC pressure was a big
    //      part of the "very slow" feel on Fire Sticks).

    // ---- Stage 1: LIVE (the critical path) ----
    let liveCount = 0;
    if (!hiddenTabs.includes('live')) {
    if (progressCallback) progressCallback('Downloading live channels…');
    let [liveCategories, liveStreams] = await Promise.all([
      jget('get_live_categories'),
      jget('get_live_streams')
    ]);
    liveStreams = dropHiddenRows(liveStreams);
    liveCategories = dropHiddenCats(liveCategories);
    const liveStreamsMapped = Array.isArray(liveStreams) ? liveStreams.map(s => ({
      stream_id: String(s.stream_id),
      category_id: String(s.category_id),
      name: s.name || '',
      stream_icon: s.stream_icon || '',
      epg_channel_id: s.epg_channel_id || '',
      tv_archive: s.tv_archive || 0,
      tv_archive_duration: s.tv_archive_duration || 0
    })) : [];
    liveStreams = null; // release the raw payload before the next download
    const liveCatsMapped = embedCounts(liveCategories, countByCategory(liveStreamsMapped));
    liveCategories = null;

    await db.transaction('rw', [db.live_categories, db.live_streams], async () => {
      await db.live_categories.clear();
      if (liveCatsMapped.length > 0) await db.live_categories.bulkAdd(liveCatsMapped);
      await db.live_streams.clear();
      if (liveStreamsMapped.length > 0) await db.live_streams.bulkAdd(liveStreamsMapped);
    });
    liveCount = liveStreamsMapped.length;
    } // end live stage

    // Live TV is browsable NOW — let the app paint while movies/series load.
    if (onLiveReady) {
      try { await onLiveReady({ live: liveCount }); } catch (e) { console.warn('onLiveReady failed:', e); }
    }

    // ---- Stage 2: MOVIES ----
    let vodCount = 0;
    if (!hiddenTabs.includes('movies')) {
    if (progressCallback) progressCallback('Downloading movies…');
    let [vodCategories, vodStreams] = await Promise.all([
      jget('get_vod_categories'),
      jget('get_vod_streams')
    ]);
    vodStreams = dropHiddenRows(vodStreams);
    vodCategories = dropHiddenCats(vodCategories);
    const vodStreamsMapped = Array.isArray(vodStreams) ? vodStreams.map(s => ({
      stream_id: String(s.stream_id),
      category_id: String(s.category_id),
      name: s.name || '',
      stream_icon: s.stream_icon || '',
      rating: parseFloat(s.rating) || 0,
      year: s.year || s.releaseDate || 'N/A'
    })) : [];
    vodStreams = null;
    const vodCatsMapped = embedCounts(vodCategories, countByCategory(vodStreamsMapped));
    vodCategories = null;

    await db.transaction('rw', [db.vod_categories, db.vod_streams], async () => {
      await db.vod_categories.clear();
      if (vodCatsMapped.length > 0) await db.vod_categories.bulkAdd(vodCatsMapped);
      await db.vod_streams.clear();
      if (vodStreamsMapped.length > 0) await db.vod_streams.bulkAdd(vodStreamsMapped);
    });
    vodCount = vodStreamsMapped.length;
    } // end movies stage

    // ---- Stage 3: SERIES ----
    let seriesCount = 0;
    if (!hiddenTabs.includes('series')) {
    if (progressCallback) progressCallback('Downloading series…');
    let [seriesCategories, seriesStreams] = await Promise.all([
      jget('get_series_categories'),
      jget('get_series')
    ]);
    seriesStreams = dropHiddenRows(seriesStreams);
    seriesCategories = dropHiddenCats(seriesCategories);
    const seriesStreamsMapped = Array.isArray(seriesStreams) ? seriesStreams.map(s => ({
      series_id: String(s.series_id || s.stream_id),
      category_id: String(s.category_id),
      name: s.name || '',
      stream_icon: s.cover || s.cover_big || s.stream_icon || '',
      rating: parseFloat(s.rating) || 0,
      releaseDate: s.releaseDate || s.year || 'N/A'
    })) : [];
    seriesStreams = null;
    const seriesCatsMapped = embedCounts(seriesCategories, countByCategory(seriesStreamsMapped));
    seriesCategories = null;

    await db.transaction('rw', [db.series_categories, db.series_streams], async () => {
      await db.series_categories.clear();
      if (seriesCatsMapped.length > 0) await db.series_categories.bulkAdd(seriesCatsMapped);
      await db.series_streams.clear();
      if (seriesStreamsMapped.length > 0) await db.series_streams.bulkAdd(seriesStreamsMapped);
    });
    seriesCount = seriesStreamsMapped.length;
    } // end series stage

    stampLastSync();

    return {
      success: true,
      counts: {
        live: liveCount,
        movies: vodCount,
        series: seriesCount
      }
    };
  }
}

// ---- Sync freshness -------------------------------------------------------
// Used to skip the automatic full re-download on every boot: on weak devices
// (Fire TV, smart TVs) that background sync saturated CPU + network right at
// startup and made the cached UI feel sluggish. Manual Refresh always syncs.
function lastSyncKey() {
  return `zp_last_sync_${getActiveIdLocal() || 'default'}`;
}
function stampLastSync() {
  try { localStorage.setItem(lastSyncKey(), String(Date.now())); } catch (e) {}
}
// Force the next background sync to run (used when a tab/category is unhidden
// so its skipped catalog gets backfilled).
export function markSyncStale() {
  try { localStorage.removeItem(lastSyncKey()); } catch (e) {}
}
export function getLastSyncAge() {
  try {
    const t = parseInt(localStorage.getItem(lastSyncKey()) || '0', 10);
    if (!t) return Infinity;
    return Date.now() - t;
  } catch (e) { return Infinity; }
}

// Cheap "is there anything cached for this playlist?" check for the boot path.
// (The old check ran getCategories(), which used to scan a full stream table.)
export async function hasCachedData() {
  await ensureServerMode();
  if (isServerMode) {
    try {
      const res = await getCategories('live');
      return !!(res && Array.isArray(res.categories) && res.categories.length > 0);
    } catch (e) { return false; }
  }
  try { return (await db.live_categories.count()) > 0; } catch (e) { return false; }
}

export async function getCategories(type) {
  const normType = type === 'movies' ? 'movie' : type;

  if (isServerMode) {
    const response = await fetch(`/api/categories?type=${encodeURIComponent(normType)}&t=${Date.now()}`);
    if (!response.ok) throw new Error('Failed to fetch categories');
    return response.json();
  } else {
    // Client Mode getCategories
    let categories = [];
    let streamsTable;
    
    if (normType === 'live') {
      categories = await db.live_categories.toArray();
      streamsTable = db.live_streams;
    } else if (normType === 'movie') {
      categories = await db.vod_categories.toArray();
      streamsTable = db.vod_streams;
    } else if (normType === 'series') {
      categories = await db.series_categories.toArray();
      streamsTable = db.series_streams;
    }

    if (!streamsTable) {
      return {
        categories: [],
        counts: { favorites: 0, recently_viewed: 0 }
      };
    }

    const favCount = await db.favorites.where('type').equals(normType).count();
    const recentCount = normType === 'live' ? await db.recently_viewed.count() : 0;

    // Fast path: category counts are embedded on the records at sync time, so
    // no stream-table scan is needed. Legacy caches (synced before counts were
    // stored) fall back to one full scan and persist the counts so every
    // subsequent call — and every future boot — takes the fast path.
    let mappedCategories;
    const hasStoredCounts = categories.length > 0 && categories.every(c => typeof c.count === 'number');
    if (hasStoredCounts) {
      mappedCategories = categories.filter(cat => cat.count > 0 || cat.category_id === 'all');
    } else {
      const countMap = {};
      await streamsTable.toCollection().each(s => {
        const catId = String(s.category_id);
        countMap[catId] = (countMap[catId] || 0) + 1;
      });

      mappedCategories = categories.map(cat => ({
        ...cat,
        count: countMap[String(cat.category_id)] || 0
      })).filter(cat => cat.count > 0 || cat.category_id === 'all');

      // Persist so the scan never runs again for this cache (fire-and-forget).
      const catTable = normType === 'live' ? db.live_categories
        : (normType === 'movie' ? db.vod_categories : db.series_categories);
      catTable.bulkPut(categories.map(cat => ({
        ...cat,
        count: countMap[String(cat.category_id)] || 0
      }))).catch(() => {});
    }

    const creds = getCredentialsLocal();
    const hiddenCats = creds && Array.isArray(creds.hidden_categories) ? creds.hidden_categories : [];
    if (hiddenCats.length > 0) {
      mappedCategories = mappedCategories.filter(cat => !hiddenCats.includes(String(cat.category_id)));
    }

    return {
      categories: mappedCategories,
      counts: {
        favorites: favCount,
        recently_viewed: recentCount
      }
    };
  }
}

export async function getStreams({ type, categoryId, page = 1, limit = 50, search = '', sort = 'added' }) {
  const normType = type === 'movies' ? 'movie' : type;

  if (isServerMode) {
    const params = new URLSearchParams({
      type: normType,
      category_id: categoryId,
      page: String(page),
      limit: String(limit),
      search,
      sort,
      t: String(Date.now())
    });
    const response = await fetch(`/api/streams?${params.toString()}`);
    if (!response.ok) throw new Error('Failed to fetch streams');
    const data = await response.json();
    if (normType === 'live' && Array.isArray(data.items)) data.items = cleanLiveItems(data.items);
    return data;
  } else {
    // Client Mode getStreams
    let table = normType === 'live' ? db.live_streams : (normType === 'movie' ? db.vod_streams : db.series_streams);
    let collection;
    const idField = normType === 'series' ? 'series_id' : 'stream_id';

    const creds = getCredentialsLocal();
    const hiddenCats = creds && Array.isArray(creds.hidden_categories) ? creds.hidden_categories : [];
    const hasHiddenCats = hiddenCats.length > 0;
    const isAll = !categoryId || categoryId === 'all';

    if (categoryId === 'favorites') {
      const favRecords = await db.favorites.where('type').equals(normType).toArray();
      const favIds = favRecords.map(f => String(f.id));
      if (favIds.length === 0) {
        return {
          items: [],
          pagination: { total: 0, page: 1, limit, pages: 0 }
        };
      }
      collection = table.where(idField).anyOf(favIds);
    } else if (categoryId === 'recently_viewed') {
      const recentRecords = await db.recently_viewed.orderBy('timestamp').reverse().toArray();
      const recentIds = recentRecords.map(r => String(r.id));
      if (recentIds.length === 0) {
        return {
          items: [],
          pagination: { total: 0, page: 1, limit, pages: 0 }
        };
      }
      collection = table.where(idField).anyOf(recentIds);
    } else if (categoryId && categoryId !== 'all') {
      collection = table.where('category_id').equals(String(categoryId));
    } else {
      collection = table.toCollection();
    }

    // FAST PATH (default view): no search, provider order. Page straight off
    // the index with offset/limit instead of materializing the entire table
    // (which on big playlists meant deserializing 20k-100k records just to
    // show 50). Ordering is identical to the slow path (primary-key order).
    // Bypassed if we need to filter out hidden categories from "All".
    if (!search && sort === 'added' && categoryId !== 'favorites' && categoryId !== 'recently_viewed' && !(hasHiddenCats && isAll)) {
      const total = await collection.count();
      const startIndex = (page - 1) * limit;
      const paginatedItems = await collection.offset(startIndex).limit(limit).toArray();
      return {
        items: normType === 'live' ? cleanLiveItems(paginatedItems) : paginatedItems,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) }
      };
    }

    let items = await collection.toArray();
    // Clean before search/sort so both operate on the displayed name.
    if (normType === 'live') items = cleanLiveItems(items);

    // Filter out streams belonging to hidden categories
    if (hasHiddenCats) {
      items = items.filter(item => !hiddenCats.includes(String(item.category_id)));
    }

    // Preserve viewing order for recently viewed
    if (categoryId === 'recently_viewed') {
      const recentRecords = await db.recently_viewed.orderBy('timestamp').reverse().toArray();
      const recentIds = recentRecords.map(r => String(r.id));
      items = recentIds
        .map(id => items.find(item => String(item[idField]) === id))
        .filter(Boolean);
    }

    if (search) {
      const query = search.toLowerCase();
      items = items.filter(item => {
        const name = (item.name || '').toLowerCase();
        return name.includes(query);
      });
    }

    // Sort (before pagination). 'added' keeps the provider's default order
    // (which is recency for most panels); recently_viewed/favorites keep their
    // own order under 'added'.
    if (sort === 'name') {
      items.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
    } else if (sort === 'rating') {
      items.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
    }

    const total = items.length;
    const startIndex = (page - 1) * limit;
    const paginatedItems = items.slice(startIndex, startIndex + limit);

    return {
      items: paginatedItems,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      }
    };
  }
}

export async function getEPG(streamId) {
  if (isServerMode) {
    const response = await fetch(`/api/epg?stream_id=${encodeURIComponent(streamId)}`);
    if (!response.ok) throw new Error('Failed to fetch EPG');
    return response.json();
  } else {
    // Client Mode getEPG
    const cached = epgMemoryCache[streamId];
    if (cached && cached.expiry > Date.now()) {
      return { listings: cached.listings };
    }

    const creds = getCredentialsLocal();
    if (!creds) throw new Error('Not logged in');

    // get_simple_data_table returns the full schedule; get_short_epg often
    // returns only a few entries from the start of the day (all in the past),
    // which leaves the now/next guide empty.
    const epgUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=get_simple_data_table&stream_id=${streamId}`;
    const response = await fetch(proxify(epgUrl));
    if (!response.ok) throw new Error('Failed to fetch EPG');
    const data = await response.json();
    const rawListings = data.epg_listings || [];

    // Xtream EPG titles/descriptions are base64 of the *whole* string. Decode it
    // as one blob \u2014 never per word: real base64 has no spaces, so a value that
    // contains spaces is already plain text and must be returned untouched.
    // (The old per-word split mis-decoded ordinary words like "Vampire" into
    // garbage, which is what corrupted the guide.)
    const decodeBase64Safe = (str) => {
      if (!str) return '';
      const trimmed = String(str).trim();
      // Anything with whitespace or non-base64 chars is plain text already.
      const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
      let padded = trimmed;
      while (padded.length % 4 !== 0) padded += '=';
      if (!base64Regex.test(padded)) return trimmed;
      try {
        const binaryString = atob(padded);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);

        const decodedUtf8 = new TextDecoder('utf-8').decode(bytes);
        const hasReplacement = decodedUtf8.includes('\ufffd');
        const isPrintableUtf8 = /^[\x20-\x7E\r\n\t\u00A0-\uFFFF]*$/.test(decodedUtf8);
        if (!hasReplacement && isPrintableUtf8) return decodedUtf8;

        const decodedLatin1 = new TextDecoder('windows-1252').decode(bytes);
        const isPrintableLatin1 = /^[\x20-\x7E\r\n\t\x80-\xFF]*$/.test(decodedLatin1);
        if (isPrintableLatin1) return decodedLatin1;
      } catch (err) {}
      return trimmed;
    };

    const listings = rawListings.map(prog => {
      const titleDecoded = decodeBase64Safe(prog.title);
      const descDecoded = decodeBase64Safe(prog.description);
      
      let startTimestamp = prog.start_timestamp;
      if (!startTimestamp && prog.start) {
        try {
          startTimestamp = String(Math.floor(new Date(prog.start.replace(' ', 'T')).getTime() / 1000));
        } catch (e) {}
      }
      
      let endTimestamp = prog.stop_timestamp || prog.end_timestamp;
      if (!endTimestamp && prog.end) {
        try {
          endTimestamp = String(Math.floor(new Date(prog.end.replace(' ', 'T')).getTime() / 1000));
        } catch (e) {}
      }

      return {
        ...prog,
        title: titleDecoded,
        description: descDecoded,
        start_timestamp: startTimestamp,
        end_timestamp: endTimestamp
      };
    });

    epgMemoryCache[streamId] = {
      expiry: Date.now() + 4 * 60 * 60 * 1000,
      listings
    };

    return { listings };
  }
}

export async function toggleFavorite(type, id) {
  const normType = type === 'movies' ? 'movie' : type;

  if (isServerMode) {
    const response = await fetch('/api/favorites/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: normType, id })
    });
    if (!response.ok) throw new Error('Failed to toggle favorite');
    return response.json();
  } else {
    // Client Mode toggleFavorite
    const key = [normType, String(id)];
    const exists = await db.favorites.get(key);
    
    let isFav = false;
    if (exists) {
      await db.favorites.delete(key);
      isFav = false;
    } else {
      await db.favorites.put({ type: normType, id: String(id) });
      isFav = true;
    }
    
    // Also save in localStorage
    const activeId = getActiveIdLocal();
    if (activeId) {
      const list = readPlaylists();
      const activePlaylist = list.find(p => p.id === activeId);
      if (activePlaylist) {
        if (!activePlaylist.favorites) activePlaylist.favorites = { live: [], movie: [], series: [] };
        if (!activePlaylist.favorites[normType]) activePlaylist.favorites[normType] = [];
        const strId = String(id);
        const idx = activePlaylist.favorites[normType].indexOf(strId);
        if (isFav) {
          if (idx === -1) activePlaylist.favorites[normType].push(strId);
        } else {
          if (idx >= 0) activePlaylist.favorites[normType].splice(idx, 1);
        }
        writePlaylists(list);
      }
    }
    
    return { success: true, isFavorite: isFav };
  }
}

export async function trackPlayback(id) {
  if (isServerMode) {
    const response = await fetch('/api/play-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!response.ok) throw new Error('Failed to track playback');
    return response.json();
  } else {
    // Client Mode trackPlayback
    await db.recently_viewed.put({ id: String(id), timestamp: Date.now() });
    
    // Limit to 50 items
    const count = await db.recently_viewed.count();
    if (count > 50) {
      const oldest = await db.recently_viewed.orderBy('timestamp').first();
      if (oldest) {
        await db.recently_viewed.delete(oldest.id);
      }
    }

    // Also save in localStorage
    const activeId = getActiveIdLocal();
    if (activeId) {
      const list = readPlaylists();
      const activePlaylist = list.find(p => p.id === activeId);
      if (activePlaylist) {
        if (!activePlaylist.recently_viewed) activePlaylist.recently_viewed = [];
        const strId = String(id);
        activePlaylist.recently_viewed = activePlaylist.recently_viewed.filter(x => x !== strId);
        activePlaylist.recently_viewed.unshift(strId);
        if (activePlaylist.recently_viewed.length > 50) {
          activePlaylist.recently_viewed.pop();
        }
        writePlaylists(list);
      }
    }

    return { success: true };
  }
}

export function getIsServerMode() {
  return isServerMode;
}

export function getStreamUrlSync(streamId, type = 'live', containerExtension = '', formatOverride = '') {
  // Client Mode getStreamUrl
  const creds = getCredentialsLocal();
  if (!creds) throw new Error('Not logged in');

  // Live default is .ts (most reliable); m3u8 is the fallback. On hosted web we
  // must force m3u8 since a continuous .ts would hold the serverless proxy open.
  // formatOverride lets the player request the backup format on failure.
  const format = formatOverride || (USE_WEB_PROXY ? 'm3u8' : (creds.stream_format || 'ts'));
  // VOD (movies/series episodes) are individual files addressed by their own
  // container extension (mp4, mkv, …). Live channels use the stream_format.
  const ext = containerExtension ? `.${containerExtension}` : '';

  let targetUrl;
  if (type === 'movie') {
    targetUrl = `${creds.server_url}/movie/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}${ext}`;
  } else if (type === 'series') {
    targetUrl = `${creds.server_url}/series/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}${ext}`;
  } else {
    targetUrl = `${creds.server_url}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${streamId}.${format}`;
  }

  return proxify(targetUrl);
}

// Format a Unix timestamp (seconds, UTC) as the Xtream catch-up "start" token
// Y-m-d:H-i. Some providers read this as server-local time — if replays come out
// shifted, a timezone offset would go here.
function fmtCatchupStart(unixSec) {
  const d = new Date(unixSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`;
}

// Build the Xtream catch-up (timeshift.php) URL for a past programme.
// start = programme start (unix seconds); duration = programme length (minutes).
export function getCatchupUrlSync(streamId, start, duration) {
  const creds = getCredentialsLocal();
  if (!creds) throw new Error('Not logged in');
  const dur = Math.max(1, parseInt(duration, 10) || 0);
  const startStr = fmtCatchupStart(parseInt(start, 10));
  const targetUrl = `${creds.server_url}/streaming/timeshift.php`
    + `?username=${encodeURIComponent(creds.username)}`
    + `&password=${encodeURIComponent(creds.password)}`
    + `&start=${encodeURIComponent(startStr)}`
    + `&duration=${dur}`;
  return proxify(targetUrl);
}

export async function getCatchupUrl(streamId, start, duration) {
  if (isServerMode) {
    const params = new URLSearchParams({ start: String(start), duration: String(duration) });
    const response = await fetch(`/api/catchup-url/${encodeURIComponent(streamId)}?${params.toString()}`);
    if (!response.ok) throw new Error('Failed to get catch-up URL');
    const data = await response.json();
    return data.url;
  }
  return getCatchupUrlSync(streamId, start, duration);
}

export async function getStreamUrl(streamId, type = 'live', containerExtension = '', formatOverride = '') {
  if (isServerMode) {
    const params = new URLSearchParams({ type });
    if (containerExtension) params.set('ext', containerExtension);
    if (formatOverride) params.set('format', formatOverride);
    const response = await fetch(`/api/stream-url/${encodeURIComponent(streamId)}?${params.toString()}`);
    if (!response.ok) throw new Error('Failed to get stream URL');
    const data = await response.json();
    return data.url;
  } else {
    return getStreamUrlSync(streamId, type, containerExtension, formatOverride);
  }
}


export async function getStreamInfo(id, type) {
  if (isServerMode) {
    const response = await fetch(`/api/stream-info/${encodeURIComponent(id)}?type=${encodeURIComponent(type)}`);
    if (!response.ok) throw new Error('Failed to fetch stream details');
    return response.json();
  } else {
    // Client Mode getStreamInfo
    const creds = getCredentialsLocal();
    if (!creds) throw new Error('Not logged in');

    const action = type === 'series' ? 'get_series_info' : 'get_vod_info';
    const paramName = type === 'series' ? 'series_id' : 'vod_id';
    
    const infoUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=${action}&${paramName}=${id}`;
    const response = await fetch(proxify(infoUrl));
    if (!response.ok) throw new Error('Failed to fetch stream details');
    return response.json();
  }
}
