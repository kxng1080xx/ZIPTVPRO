import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.ELECTRON_RUNNING === 'true'
  ? path.join(os.homedir(), '.ziptv_pro_data')
  : path.join(__dirname, 'data');

const CREDS_FILE = path.join(DATA_DIR, 'credentials.json');
const CACHE_FILE = path.join(DATA_DIR, 'playlist_cache.json');
const EPG_CACHE_FILE = path.join(DATA_DIR, 'epg_cache.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Memory cache state
let cache = {
  live_categories: [],
  live_streams: [],
  vod_categories: [],
  vod_streams: [],
  series_categories: [],
  series_streams: [],
  favorites: {
    live: [],
    movie: [],
    series: []
  },
  recently_viewed: []
};

let epgCache = {};

// Load cache from disk on startup
export function initCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      cache = { ...cache, ...parsed };
      console.log(`Loaded cache: ${cache.live_streams.length} live channels, ${cache.vod_streams.length} movies, ${cache.series_streams.length} series.`);
    }
  } catch (err) {
    console.error('Error loading cache file:', err);
  }

  try {
    if (fs.existsSync(EPG_CACHE_FILE)) {
      const data = fs.readFileSync(EPG_CACHE_FILE, 'utf8');
      epgCache = JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading EPG cache file:', err);
  }

  const activeCreds = getCredentials();
  if (activeCreds) {
    cache.favorites = activeCreds.favorites || { live: [], movie: [], series: [] };
    cache.recently_viewed = activeCreds.recently_viewed || [];
  }
}

// ---------------------------------------------------------------------------
// Credentials store: { playlists: [...], activeId }. getCredentials() returns
// the active playlist so the rest of the server keeps working unchanged.
// ---------------------------------------------------------------------------
function makePlaylistId(c) {
  return `${(c.server_url || '').toLowerCase()}|${c.username || ''}`;
}

function readStore() {
  try {
    if (fs.existsSync(CREDS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.playlists)) return parsed;
      // Legacy single-credential file → migrate to the list format.
      if (parsed && parsed.server_url) {
        parsed.id = parsed.id || makePlaylistId(parsed);
        return { playlists: [parsed], activeId: parsed.id };
      }
    }
  } catch (err) {
    console.error('Error reading credentials:', err);
  }
  return { playlists: [], activeId: null };
}

function writeStore(store) {
  try {
    fs.writeFileSync(CREDS_FILE, JSON.stringify(store, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving credentials:', err);
    return false;
  }
}

// Wipe cached streams/EPG (but not the credential store) — used when switching
// playlists so the newly-active one re-syncs.
function clearPlaylistData() {
  cache = {
    live_categories: [],
    live_streams: [],
    vod_categories: [],
    vod_streams: [],
    series_categories: [],
    series_streams: [],
    favorites: { live: [], movie: [], series: [] },
    recently_viewed: []
  };
  epgCache = {};
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    if (fs.existsSync(EPG_CACHE_FILE)) fs.unlinkSync(EPG_CACHE_FILE);
  } catch (e) {}
}

export function getCredentials() {
  const store = readStore();
  if (store.playlists.length === 0) return null;
  return store.playlists.find(p => p.id === store.activeId) || store.playlists[0];
}

// Add a new playlist (or update an existing one) and make it active.
export function saveCredentials(creds) {
  const store = readStore();
  if (!creds.id) creds.id = makePlaylistId(creds);
  const idx = store.playlists.findIndex(p => p.id === creds.id);
  if (idx >= 0) {
    // Preserve favorites and recently viewed
    creds.favorites = store.playlists[idx].favorites || creds.favorites || { live: [], movie: [], series: [] };
    creds.recently_viewed = store.playlists[idx].recently_viewed || creds.recently_viewed || [];
    store.playlists[idx] = { ...store.playlists[idx], ...creds };
  } else {
    creds.favorites = creds.favorites || { live: [], movie: [], series: [] };
    creds.recently_viewed = creds.recently_viewed || [];
    store.playlists.push(creds);
  }
  store.activeId = creds.id;
  
  // Set in-memory cache
  cache.favorites = creds.favorites;
  cache.recently_viewed = creds.recently_viewed;

  writeStore(store);

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {}

  return true;
}

export function getPlaylistsList() {
  const store = readStore();
  let activeId = store.activeId;
  if (!store.playlists.find(p => p.id === activeId)) activeId = store.playlists[0] ? store.playlists[0].id : null;
  return {
    playlists: store.playlists.map(p => ({
      id: p.id,
      playlistName: p.playlistName,
      server_url: p.server_url,
      username: p.username
    })),
    activeId
  };
}

export function setActivePlaylist(id) {
  const store = readStore();
  const target = store.playlists.find(p => p.id === id);
  if (!target) return false;
  store.activeId = id;
  writeStore(store);
  clearPlaylistData();

  // Load target playlist's favorites and history
  cache.favorites = target.favorites || { live: [], movie: [], series: [] };
  cache.recently_viewed = target.recently_viewed || [];

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {}

  return true;
}

export function removePlaylist(id) {
  const store = readStore();
  const wasActive = store.activeId === id;
  store.playlists = store.playlists.filter(p => p.id !== id);
  const newActiveId = store.playlists[0] ? store.playlists[0].id : null;
  if (wasActive) store.activeId = newActiveId;
  writeStore(store);
  if (wasActive) {
    clearPlaylistData();
    if (newActiveId) {
      const newActive = store.playlists[0];
      cache.favorites = newActive.favorites || { live: [], movie: [], series: [] };
      cache.recently_viewed = newActive.recently_viewed || [];
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
      } catch (e) {}
    }
  }
  return { success: true, remaining: store.playlists.length, activeId: store.activeId, wasActive };
}

export function deactivateActivePlaylist() {
  const store = readStore();
  store.activeId = null;
  writeStore(store);
  clearPlaylistData();
  return { success: true, remaining: store.playlists.length, activeId: null };
}

export function clearCredentials() {
  try {
    if (fs.existsSync(CREDS_FILE)) fs.unlinkSync(CREDS_FILE);
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    if (fs.existsSync(EPG_CACHE_FILE)) fs.unlinkSync(EPG_CACHE_FILE);
    cache = {
      live_categories: [],
      live_streams: [],
      vod_categories: [],
      vod_streams: [],
      series_categories: [],
      series_streams: [],
      favorites: { live: [], movie: [], series: [] },
      recently_viewed: []
    };
    epgCache = {};
    return true;
  } catch (err) {
    console.error('Error clearing credentials/cache:', err);
    return false;
  }
}

// Update playlist cache data
export function updatePlaylistCache(newData) {
  // Retain existing favorites and recently viewed
  const favorites = cache.favorites || { live: [], movie: [], series: [] };
  const recently_viewed = cache.recently_viewed || [];

  cache = {
    ...cache,
    ...newData,
    favorites,
    recently_viewed
  };

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing playlist cache:', err);
    return false;
  }
}

// EPG Cache helpers
export function getCachedEPG(streamId) {
  const cached = epgCache[streamId];
  if (cached && cached.expiry > Date.now()) {
    return cached.listings;
  }
  return null;
}

export function setCachedEPG(streamId, listings, ttlMs = 4 * 60 * 60 * 1000) { // Default EPG cache is 4 hours
  epgCache[streamId] = {
    expiry: Date.now() + ttlMs,
    listings
  };
  try {
    fs.writeFileSync(EPG_CACHE_FILE, JSON.stringify(epgCache), 'utf8');
  } catch (err) {
    console.error('Error writing EPG cache:', err);
  }
}

// Data query helpers
export function getCategories(type) {
  const normType = type === 'movies' ? 'movie' : type;
  let categories = [];
  let streams = [];

  if (normType === 'live') {
    categories = cache.live_categories || [];
    streams = cache.live_streams || [];
  } else if (normType === 'movie') {
    categories = cache.vod_categories || [];
    streams = cache.vod_streams || [];
  } else if (normType === 'series') {
    categories = cache.series_categories || [];
    streams = cache.series_streams || [];
  }

  // Calculate stream counts per category
  const countMap = {};
  streams.forEach(stream => {
    const catId = stream.category_id;
    countMap[catId] = (countMap[catId] || 0) + 1;
  });

  // Map categories and add count
  return categories.map(cat => ({
    ...cat,
    count: countMap[cat.category_id] || 0
  })).filter(cat => cat.count > 0 || cat.category_id === 'all'); // Keep empty categories out unless 'all'
}

export function getStreams(type, categoryId, page = 1, limit = 50, search = '') {
  const normType = type === 'movies' ? 'movie' : type;
  let streams = [];
  if (normType === 'live') streams = cache.live_streams || [];
  else if (normType === 'movie') streams = cache.vod_streams || [];
  else if (normType === 'series') streams = cache.series_streams || [];

  // Filter by category
  let filtered = streams;
  if (categoryId === 'favorites') {
    const favIds = cache.favorites?.[normType] || [];
    const idField = normType === 'series' ? 'series_id' : 'stream_id';
    filtered = streams.filter(s => favIds.includes(String(s[idField] || s.stream_id)));
  } else if (categoryId === 'recently_viewed') {
    const recentIds = cache.recently_viewed || [];
    const idField = normType === 'series' ? 'series_id' : 'stream_id';
    // Sort recently viewed in the order they were viewed
    filtered = recentIds
      .map(id => streams.find(s => String(s[idField] || s.stream_id) === String(id)))
      .filter(Boolean);
  } else if (categoryId && categoryId !== 'all') {
    filtered = streams.filter(s => String(s.category_id) === String(categoryId));
  }

  // Filter by search query
  if (search) {
    const query = search.toLowerCase();
    filtered = filtered.filter(s => {
      const name = (s.name || s.title || '').toLowerCase();
      return name.includes(query);
    });
  }

  // Pagination
  const total = filtered.length;
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;
  const items = filtered.slice(startIndex, endIndex);

  return {
    items,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    }
  };
}

// Favorites Management
export function toggleFavorite(type, id) {
  const normType = type === 'movies' ? 'movie' : type;
  if (!cache.favorites) {
    cache.favorites = { live: [], movie: [], series: [] };
  }
  if (!cache.favorites[normType]) {
    cache.favorites[normType] = [];
  }

  const index = cache.favorites[normType].indexOf(String(id));
  if (index === -1) {
    cache.favorites[normType].push(String(id));
  } else {
    cache.favorites[normType].splice(index, 1);
  }

  // Save to active playlist in credentials.json
  const store = readStore();
  const active = store.playlists.find(p => p.id === store.activeId);
  if (active) {
    active.favorites = cache.favorites;
    writeStore(store);
  }

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving favorite status:', err);
    return false;
  }
}

export function isFavorite(type, id) {
  const normType = type === 'movies' ? 'movie' : type;
  return cache.favorites?.[normType]?.includes(String(id)) || false;
}

// Recently Viewed Management
export function addToRecentlyViewed(id) {
  if (!cache.recently_viewed) {
    cache.recently_viewed = [];
  }

  const strId = String(id);
  // Remove if already exists so we can move it to the front
  cache.recently_viewed = cache.recently_viewed.filter(x => x !== strId);
  // Add to front
  cache.recently_viewed.unshift(strId);
  // Limit to 50 items
  if (cache.recently_viewed.length > 50) {
    cache.recently_viewed.pop();
  }

  // Save to active playlist in credentials.json
  const store = readStore();
  const active = store.playlists.find(p => p.id === store.activeId);
  if (active) {
    active.recently_viewed = cache.recently_viewed;
    writeStore(store);
  }

  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving recently viewed status:', err);
    return false;
  }
}

export function getRecentlyViewedCount() {
  return cache.recently_viewed?.length || 0;
}

export function getFavoritesCount(type) {
  return cache.favorites?.[type]?.length || 0;
}

export function getFavorites() {
  return cache.favorites || { live: [], movie: [], series: [] };
}

