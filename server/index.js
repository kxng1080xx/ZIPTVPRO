import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import {
  initCache,
  getCredentials,
  saveCredentials,
  clearCredentials,
  updatePlaylistCache,
  getCachedEPG,
  setCachedEPG,
  getCategories,
  getStreams,
  toggleFavorite,
  isFavorite,
  addToRecentlyViewed,
  getFavoritesCount,
  getRecentlyViewedCount,
  getFavorites,
  getPlaylistsList,
  setActivePlaylist,
  removePlaylist
} from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Initialize cache from disk
initCache();

// Helpers to query Xtream API
async function fetchXtream(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// 1. API: Login & Test Credentials
app.post('/api/login', async (req, res) => {
  const { hostUrl, username, password, playlistName } = req.body;

  if (!hostUrl || !username || !password) {
    return res.status(400).json({ error: 'Missing Host URL, Username or Password' });
  }

  // Normalize host URL
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

  let response;
  try {
    response = await fetchXtream(testUrl);
  } catch (err) {
    // Network error / timeout / DNS failure → server unreachable.
    return res.status(503).json({ error: 'Server unavailable. Check the server URL and your internet connection.' });
  }

  if (!response.ok) {
    return res.status(502).json({ error: 'Server unavailable. Check the server URL.' });
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return res.status(502).json({ error: 'Could not read a valid response. Check the server URL.' });
  }

  const info = data.user_info;
  if (!info) {
    return res.status(400).json({ error: 'Could not read a valid response. Check the server URL.' });
  }

  // Wrong username/password.
  if (info.auth === 0 || info.auth === '0') {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  // Expired / inactive subscription (Xtream returns auth:1 with status "Expired").
  const status = String(info.status || '').toLowerCase();
  const exp = parseInt(info.exp_date, 10);
  const isExpired = status === 'expired' || (exp && !isNaN(exp) && exp * 1000 < Date.now());
  if (isExpired) {
    return res.status(403).json({ error: 'Your subscription has expired.' });
  }
  if (status && status !== 'active') {
    return res.status(403).json({ error: `Your account is not active (${info.status}).` });
  }

  // Save credentials
  const credentials = {
    playlistName: playlistName || 'My Xtream Playlist',
    server_url: normalizedHost,
    username,
    password,
    stream_format: 'ts', // Default to .ts (most reliable); m3u8 is the fallback
    proxy_streams: true // Default to using local CORS proxy
  };
  saveCredentials(credentials);

  res.json({
    success: true,
    user_info: info,
    server_info: data.server_info
  });
});

// 2. API: Get Status & User Info
app.get('/api/status', async (req, res) => {
  const creds = getCredentials();
  if (!creds) {
    return res.json({ loggedIn: false });
  }

  const testUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;

  try {
    const response = await fetchXtream(testUrl, 8000);
    const data = await response.json();
    res.json({
      loggedIn: true,
      credentials: {
        playlistName: creds.playlistName,
        server_url: creds.server_url,
        username: creds.username,
        stream_format: creds.stream_format,
        proxy_streams: creds.proxy_streams
      },
      user_info: data.user_info || {},
      server_info: data.server_info || {},
      favorites: getFavorites()
    });
  } catch (err) {
    // If server is offline, still return loggedIn: true but with local credentials
    res.json({
      loggedIn: true,
      offline: true,
      credentials: {
        playlistName: creds.playlistName,
        server_url: creds.server_url,
        username: creds.username,
        stream_format: creds.stream_format,
        proxy_streams: creds.proxy_streams
      },
      favorites: getFavorites()
    });
  }
});

// 3. API: Logout (removes the active playlist; keeps any others)
app.post('/api/logout', (req, res) => {
  const creds = getCredentials();
  if (!creds) return res.json({ success: true, remaining: 0, activeId: null });
  return res.json(removePlaylist(creds.id));
});

// 3b. API: Playlists — list / switch / remove
app.get('/api/playlists', (req, res) => {
  res.json(getPlaylistsList());
});

app.post('/api/playlists/switch', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing playlist id' });
  if (!setActivePlaylist(id)) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ success: true, activeId: id });
});

app.post('/api/playlists/remove', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing playlist id' });
  res.json(removePlaylist(id));
});

// 4. API: Update Settings
app.post('/api/settings', (req, res) => {
  const creds = getCredentials();
  if (!creds) return res.status(401).json({ error: 'Not logged in' });

  const { stream_format, proxy_streams } = req.body;
  if (stream_format) creds.stream_format = stream_format;
  if (proxy_streams !== undefined) creds.proxy_streams = proxy_streams;

  saveCredentials(creds);
  res.json({ success: true, credentials: creds });
});

// 5. API: Sync Playlists (Fetch Live, Movies, Series and cache them)
app.post('/api/sync', async (req, res) => {
  const creds = getCredentials();
  if (!creds) {
    return res.status(401).json({ error: 'No playlist configuration found' });
  }

  const baseApiUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;

  try {
    // Run fetches sequentially to prevent throttling on cheaper IPTV services
    console.log('Syncing categories...');
    const liveCatRes = await fetchXtream(`${baseApiUrl}&action=get_live_categories`);
    const liveCategories = await liveCatRes.json();

    const vodCatRes = await fetchXtream(`${baseApiUrl}&action=get_vod_categories`);
    const vodCategories = await vodCatRes.json();

    const seriesCatRes = await fetchXtream(`${baseApiUrl}&action=get_series_categories`);
    const seriesCategories = await seriesCatRes.json();

    console.log('Syncing streams (live)...');
    const liveStreamsRes = await fetchXtream(`${baseApiUrl}&action=get_live_streams`);
    const liveStreams = await liveStreamsRes.json();

    console.log('Syncing streams (movies)...');
    const vodStreamsRes = await fetchXtream(`${baseApiUrl}&action=get_vod_streams`);
    const vodStreams = await vodStreamsRes.json();

    console.log('Syncing streams (series)...');
    const seriesRes = await fetchXtream(`${baseApiUrl}&action=get_series`);
    const seriesStreams = await seriesRes.json();

    console.log('Saving all cached contents...');
    updatePlaylistCache({
      live_categories: Array.isArray(liveCategories) ? liveCategories : [],
      live_streams: Array.isArray(liveStreams) ? liveStreams : [],
      vod_categories: Array.isArray(vodCategories) ? vodCategories : [],
      vod_streams: Array.isArray(vodStreams) ? vodStreams : [],
      series_categories: Array.isArray(seriesCategories) ? seriesCategories : [],
      series_streams: Array.isArray(seriesStreams) ? seriesStreams : []
    });

    res.json({
      success: true,
      counts: {
        live: liveStreams.length,
        movies: vodStreams.length,
        series: seriesStreams.length
      }
    });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: `Sync failed: ${err.message}` });
  }
});

// 6. API: Get Categories
app.get('/api/categories', (req, res) => {
  const { type } = req.query; // 'live', 'movie', 'series'
  if (!type) return res.status(400).json({ error: 'Missing type parameter' });
  
  res.json({
    categories: getCategories(type),
    counts: {
      favorites: getFavoritesCount(type),
      recently_viewed: type === 'live' ? getRecentlyViewedCount() : 0
    }
  });
});

// 7. API: Get Channels/Streams (Paginated)
app.get('/api/streams', (req, res) => {
  const { type, category_id, page, limit, search } = req.query;
  if (!type) return res.status(400).json({ error: 'Missing type parameter' });

  const result = getStreams(
    type,
    category_id,
    parseInt(page) || 1,
    parseInt(limit) || 50,
    search || ''
  );
  res.json(result);
});

// Base64 helper to safely decode strings
function decodeBase64Safe(str) {
  if (!str) return '';
  const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!base64Regex.test(str)) return str;
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf8');
    const isPrintable = /^[\x20-\x7E\r\n\t\xA0-\xFF]*$/.test(decoded);
    if (isPrintable) return decoded;
  } catch (err) {}
  return str;
}

// Normalize listing helper to decode base64 fields and standardize end_timestamp keys
function normalizeListing(prog) {
  if (!prog) return prog;
  
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
}

// 8. API: Get short EPG for channel
app.get('/api/epg', async (req, res) => {
  const { stream_id } = req.query;
  if (!stream_id) return res.status(400).json({ error: 'Missing stream_id parameter' });

  const cached = getCachedEPG(stream_id);
  if (cached) {
    const normalizedCached = cached.map(prog => normalizeListing(prog));
    return res.json({ listings: normalizedCached });
  }

  const creds = getCredentials();
  if (!creds) return res.status(401).json({ error: 'Not logged in' });

  // get_simple_data_table returns the full schedule; get_short_epg often returns
  // only a few past entries, leaving the now/next guide empty.
  const epgUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=get_simple_data_table&stream_id=${stream_id}`;

  try {
    const response = await fetchXtream(epgUrl, 8000);
    const data = await response.json();
    const rawListings = data.epg_listings || [];

    // Normalize listings on receipt (will cache the decoded and mapped values)
    const listings = rawListings.map(prog => normalizeListing(prog));

    setCachedEPG(stream_id, listings);
    res.json({ listings });
  } catch (err) {
    console.error(`EPG fetch error for stream ${stream_id}:`, err);
    res.json({ listings: [], error: err.message });
  }
});

// 9. API: Toggle Favorite
app.post('/api/favorites/toggle', (req, res) => {
  const { type, id } = req.body;
  if (!type || !id) return res.status(400).json({ error: 'Missing type or id' });

  const success = toggleFavorite(type, id);
  res.json({ success, isFavorite: isFavorite(type, id) });
});

// 10. API: Add to Recently Viewed & Get Stream URL
app.post('/api/play-track', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing stream id' });

  addToRecentlyViewed(id);
  res.json({ success: true });
});

// 11. CORS Stream Proxy
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  const decodedUrl = decodeURIComponent(url);

  try {
    const response = await fetch(decodedUrl);
    if (!response.ok) {
      return res.status(response.status).send(`Error fetching stream: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    // Handle HLS playlist rewriting to keep segments running through proxy
    if (decodedUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('application/x-mpegURL')) {
      const text = await response.text();
      const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);
      
      const rewrittenText = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
          return line;
        }
        
        let absoluteUrl = trimmed;
        if (!trimmed.startsWith('http')) {
          // Resolve relative URL
          absoluteUrl = baseUrl + trimmed;
        }
        
        // Rewrite segment or sub-playlist URL to route through proxy
        return `/api/proxy?url=${encodeURIComponent(absoluteUrl)}`;
      }).join('\n');
      
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewrittenText);
    } else {
      // Stream chunks (e.g. .ts, .mp4) - pipe binary response
      res.setHeader('Content-Type', contentType || 'video/mp2t');
      
      const reader = response.body.getReader();
      const pump = async () => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            res.end();
            return;
          }
          res.write(Buffer.from(value));
          await pump();
        } catch (err) {
          console.error('Error pumping stream chunks:', err);
          res.end();
        }
      };
      await pump();
    }
  } catch (err) {
    console.error('Proxy request failed:', err);
    res.status(500).send(`Proxy error: ${err.message}`);
  }
});

// API: Get direct or proxied stream URL
app.get('/api/stream-url/:stream_id', (req, res) => {
  const { stream_id } = req.params;
  const { type, ext, format: formatOverride } = req.query; // + optional format override for live fallback

  const creds = getCredentials();
  if (!creds) return res.status(401).json({ error: 'Not logged in' });

  // Live default is .ts (most reliable); m3u8 is the fallback. A ?format= override
  // lets the client request the backup format when the primary stream fails.
  const format = formatOverride || creds.stream_format || 'ts';
  // VOD (movies/series episodes) are individual files keyed by their own
  // container extension (mp4, mkv, …); without it the provider returns a 404.
  const vodExt = ext ? `.${ext}` : '';
  let targetUrl = '';

  if (type === 'movie') {
    // VOD format: http://host/movie/user/pass/id.extension (mp4, mkv, etc.)
    targetUrl = `${creds.server_url}/movie/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${stream_id}${vodExt}`;
  } else if (type === 'series') {
    // Series episodes are addressed by the episode id + its container extension
    targetUrl = `${creds.server_url}/series/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${stream_id}${vodExt}`;
  } else {
    // Live TV format
    targetUrl = `${creds.server_url}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${stream_id}.${format}`;
  }

  if (creds.proxy_streams) {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
    res.json({ url: proxyUrl });
  } else {
    res.json({ url: targetUrl });
  }
});

// API: Get VOD/Series Info (Info, Cast, Director, Release Date, Episodes, etc.)
app.get('/api/stream-info/:id', async (req, res) => {
  const { id } = req.params;
  const { type } = req.query; // 'movie' or 'series'
  
  const creds = getCredentials();
  if (!creds) return res.status(401).json({ error: 'Not logged in' });

  const action = type === 'series' ? 'get_series_info' : 'get_vod_info';
  const paramName = type === 'series' ? 'series_id' : 'vod_id';
  
  const infoUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}&action=${action}&${paramName}=${id}`;

  try {
    const response = await fetchXtream(infoUrl, 10000);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(`Error fetching info for ${type} ${id}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Serve Vite frontend in production
const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('IPTV Server is running! Run client dev server with `npm run dev`.');
  });
}

app.listen(PORT, () => {
  console.log(`IPTV Player backend listening on http://localhost:${PORT}`);
});
