/**
 * Frontend Client for interacting with the local IPTV Player Node.js backend API
 * or querying the IPTV server directly (using client-side IndexedDB cache).
 */
import { db } from './db.js';

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

// Helper: Check if backend server is active
async function checkServerMode() {
  try {
    const res = await fetch('/api/status', { signal: AbortSignal.timeout(1500) });
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

export async function login(hostUrl, username, password, playlistName) {
  await checkServerMode();
  
  if (isServerMode) {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostUrl, username, password, playlistName })
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

    // 3. Subscription: expired or otherwise inactive account.
    const accountError = describeAccountState(info);
    if (accountError) {
      throw new Error(accountError);
    }

    const credentials = {
      playlistName: playlistName || 'My Xtream Playlist',
      server_url: normalizedHost,
      username,
      password,
      stream_format: 'ts' // Default to ts on mobile for compatibility
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
        status: 'Active'
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
    // Disconnect the active playlist (keep any others) and clear cached data.
    const activeId = getActiveIdLocal();
    const list = readPlaylists().filter(p => p.id !== activeId);
    writePlaylists(list);
    const newActiveId = list[0] ? list[0].id : null;
    setActiveIdLocal(newActiveId);
    await clearLocalCache();
    if (newActiveId) {
      await loadPlaylistFavoritesAndHistoryIntoDB(list[0]);
    }
    return { success: true, remaining: list.length, activeId: getActiveIdLocal() };
  }
}

// List saved playlists and which one is active.
export async function getPlaylists() {
  if (isServerMode) {
    const response = await fetch('/api/playlists');
    if (!response.ok) throw new Error('Failed to load playlists');
    return response.json();
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
  let list = getContinueWatching();
  list = list.filter(i => String(i.id) !== String(item.id));
  list.unshift({ ...item, lastWatched: Date.now() });
  if (list.length > 30) list = list.slice(0, 30);
  try {
    localStorage.setItem(cwKey(), JSON.stringify(list));
  } catch (e) {}
}

export function removeWatchProgress(id) {
  const list = getContinueWatching().filter(i => String(i.id) !== String(id));
  try {
    localStorage.setItem(cwKey(), JSON.stringify(list));
  } catch (e) {}
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

export async function syncPlaylist(progressCallback = null) {
  if (isServerMode) {
    const response = await fetch('/api/sync', { method: 'POST' });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Sync failed');
    }
    return response.json();
  } else {
    const creds = getCredentialsLocal();
    if (!creds) throw new Error('No playlist credentials found');

    const baseApiUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;

    if (progressCallback) progressCallback('Syncing Live Categories...');
    const liveCatRes = await fetch(proxify(`${baseApiUrl}&action=get_live_categories`));
    const liveCategories = await liveCatRes.json();

    if (progressCallback) progressCallback('Syncing Movies Categories...');
    const vodCatRes = await fetch(proxify(`${baseApiUrl}&action=get_vod_categories`));
    const vodCategories = await vodCatRes.json();

    if (progressCallback) progressCallback('Syncing Series Categories...');
    const seriesCatRes = await fetch(proxify(`${baseApiUrl}&action=get_series_categories`));
    const seriesCategories = await seriesCatRes.json();

    // Clear and put categories
    await db.live_categories.clear();
    await db.live_categories.bulkPut(Array.isArray(liveCategories) ? liveCategories : []);
    
    await db.vod_categories.clear();
    await db.vod_categories.bulkPut(Array.isArray(vodCategories) ? vodCategories : []);

    await db.series_categories.clear();
    await db.series_categories.bulkPut(Array.isArray(seriesCategories) ? seriesCategories : []);

    if (progressCallback) progressCallback('Downloading Live Streams...');
    const liveStreamsRes = await fetch(proxify(`${baseApiUrl}&action=get_live_streams`));
    const liveStreams = await liveStreamsRes.json();

    if (progressCallback) progressCallback('Downloading Movie Streams...');
    const vodStreamsRes = await fetch(proxify(`${baseApiUrl}&action=get_vod_streams`));
    const vodStreams = await vodStreamsRes.json();

    if (progressCallback) progressCallback('Downloading Series List...');
    const seriesRes = await fetch(proxify(`${baseApiUrl}&action=get_series`));
    const seriesStreams = await seriesRes.json();

    // Write to Dexie in bulk
    if (progressCallback) progressCallback('Saving Live Channels...');
    await db.live_streams.clear();
    if (Array.isArray(liveStreams)) {
      const mapped = liveStreams.map(s => ({
        stream_id: String(s.stream_id),
        category_id: String(s.category_id),
        name: s.name || '',
        stream_icon: s.stream_icon || '',
        epg_channel_id: s.epg_channel_id || '',
        tv_archive: s.tv_archive || 0
      }));
      await db.live_streams.bulkPut(mapped);
    }

    if (progressCallback) progressCallback('Saving Movies Catalog...');
    await db.vod_streams.clear();
    if (Array.isArray(vodStreams)) {
      const mapped = vodStreams.map(s => ({
        stream_id: String(s.stream_id),
        category_id: String(s.category_id),
        name: s.name || '',
        stream_icon: s.stream_icon || '',
        rating: parseFloat(s.rating) || 0,
        year: s.year || s.releaseDate || 'N/A'
      }));
      await db.vod_streams.bulkPut(mapped);
    }

    if (progressCallback) progressCallback('Saving Series Catalog...');
    await db.series_streams.clear();
    if (Array.isArray(seriesStreams)) {
      const mapped = seriesStreams.map(s => ({
        series_id: String(s.series_id || s.stream_id),
        category_id: String(s.category_id),
        name: s.name || '',
        // Series use `cover` (Xtream get_series); only movies use `stream_icon`.
        stream_icon: s.cover || s.cover_big || s.stream_icon || '',
        rating: parseFloat(s.rating) || 0,
        releaseDate: s.releaseDate || s.year || 'N/A'
      }));
      await db.series_streams.bulkPut(mapped);
    }

    return {
      success: true,
      counts: {
        live: liveStreams.length,
        movies: vodStreams.length,
        series: seriesStreams.length
      }
    };
  }
}

export async function getCategories(type) {
  const normType = type === 'movies' ? 'movie' : type;

  if (isServerMode) {
    const response = await fetch(`/api/categories?type=${encodeURIComponent(normType)}`);
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

    // Fast category count mapping
    const allStreams = await streamsTable.toArray();
    const countMap = {};
    allStreams.forEach(s => {
      const catId = String(s.category_id);
      countMap[catId] = (countMap[catId] || 0) + 1;
    });

    const mappedCategories = categories.map(cat => ({
      ...cat,
      count: countMap[String(cat.category_id)] || 0
    })).filter(cat => cat.count > 0 || cat.category_id === 'all');

    return {
      categories: mappedCategories,
      counts: {
        favorites: favCount,
        recently_viewed: recentCount
      }
    };
  }
}

export async function getStreams({ type, categoryId, page = 1, limit = 50, search = '' }) {
  const normType = type === 'movies' ? 'movie' : type;

  if (isServerMode) {
    const params = new URLSearchParams({
      type: normType,
      category_id: categoryId,
      page: String(page),
      limit: String(limit),
      search
    });
    const response = await fetch(`/api/streams?${params.toString()}`);
    if (!response.ok) throw new Error('Failed to fetch streams');
    return response.json();
  } else {
    // Client Mode getStreams
    let table = normType === 'live' ? db.live_streams : (normType === 'movie' ? db.vod_streams : db.series_streams);
    let collection;
    const idField = normType === 'series' ? 'series_id' : 'stream_id';

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

    let items = await collection.toArray();

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

    const decodeBase64Safe = (str) => {
      if (!str) return '';
      try {
        return atob(str);
      } catch (e) {
        return str;
      }
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
