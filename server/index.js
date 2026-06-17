import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();

  // Adapter name patterns that indicate virtual/software/VPN-only interfaces.
  // Case-insensitive so "vEthernet", "TAP-NordVPN", "WireGuard", etc. all match.
  const VIRTUAL_PATTERNS = [
    // Hypervisors / containers
    /vethernet/i,     // Hyper-V virtual switches
    /vmware/i,        // VMware host-only / NAT adapters
    /virtualbox/i,    // VirtualBox host-only adapters
    /vbox/i,          // VirtualBox short name
    /docker/i,        // Docker Desktop virtual adapters
    /wsl/i,           // Windows Subsystem for Linux
    // Tunnels / software loopback
    /loopback/i,      // Software loopback adapters
    /pseudo/i,        // Pseudo / tunnel adapters
    /teredo/i,        // Teredo tunneling
    /isatap/i,        // ISATAP tunneling
    /6to4/i,          // 6to4 tunneling adapters
    // VPN clients
    /\btap\b/i,       // OpenVPN TAP adapters (TAP-Windows, TAP-NordVPN, etc.)
    /openvpn/i,       // OpenVPN
    /nordvpn/i,       // NordVPN
    /expressvpn/i,    // ExpressVPN
    /protonvpn/i,     // ProtonVPN
    /mullvad/i,       // Mullvad VPN
    /wireguard/i,     // WireGuard
    /tailscale/i,     // Tailscale mesh VPN
    /zerotier/i,      // ZeroTier virtual network
    /anyconnect/i,    // Cisco AnyConnect
    /globalprotect/i, // Palo Alto GlobalProtect
    /pulse.?secure/i, // Pulse Secure / Ivanti
    /fortinet/i,      // Fortinet VPN
    /forticlient/i,   // FortiClient VPN
    /checkpoint/i,    // Check Point VPN
    /sonicwall/i,     // SonicWall VPN
    /citrix/i,        // Citrix VPN
    /pulsevpn/i,      // Pulse VPN
    /cloudflare/i,    // Cloudflare WARP
    /warp/i,          // Cloudflare WARP (short name)
    /vpn/i,           // Generic catch-all for any adapter with "vpn" in its name
  ];

  // Score an IPv4 address — higher = more likely to be a real LAN address.
  // 192.168.x.x and 10.x.x.x are typical home/office LAN ranges.
  // 172.16-31.x.x is the third private range (less common on home nets).
  // Anything else (e.g. a VPN tunnel like 100.64.x.x or 172.x.x.x outside the
  // private range) scores lowest so it is only returned as a last resort.
  function lanScore(ip) {
    if (/^192\.168\./.test(ip)) return 3;   // Home / office LAN — best
    if (/^10\./.test(ip))       return 2;   // Corporate LAN — great
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1; // RFC-1918 range B
    return 0;                               // Unknown / VPN tunnel range
  }

  const candidates = [];
  try {
    for (const name of Object.keys(interfaces)) {
      // Skip any adapter whose name matches a virtual/VPN/tunnel pattern
      if (VIRTUAL_PATTERNS.some(re => re.test(name))) continue;

      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          candidates.push({ ip: iface.address, score: lanScore(iface.address) });
        }
      }
    }
  } catch (e) {}

  // Sort so real LAN IPs come first; drop any that scored 0 (non-LAN) unless
  // there are no LAN IPs at all (graceful fallback).
  candidates.sort((a, b) => b.score - a.score);
  const lanOnly = candidates.filter(c => c.score > 0);
  return (lanOnly.length ? lanOnly : candidates).map(c => c.ip);
}



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
  removePlaylist,
  deactivateActivePlaylist
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
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'VLC/3.0.20'
      }
    });
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
    return res.json({ 
      loggedIn: false,
      server_port: PORT,
      local_ips: getLocalIpAddresses()
    });
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
      favorites: getFavorites(),
      server_port: PORT,
      local_ips: getLocalIpAddresses()
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
      favorites: getFavorites(),
      server_port: PORT,
      local_ips: getLocalIpAddresses()
    });
  }
});

// 3. API: Logout (clears active playlist session, keeps saved playlists)
app.post('/api/logout', (req, res) => {
  res.json(deactivateActivePlaylist());
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

  // Set EventStream headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const baseApiUrl = `${creds.server_url}/player_api.php?username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;

  try {
    sendEvent({ progress: 'Syncing Live Categories...' });
    const liveCatRes = await fetchXtream(`${baseApiUrl}&action=get_live_categories`);
    const liveCategories = await liveCatRes.json();

    sendEvent({ progress: 'Syncing Movies Categories...' });
    const vodCatRes = await fetchXtream(`${baseApiUrl}&action=get_vod_categories`);
    const vodCategories = await vodCatRes.json();

    sendEvent({ progress: 'Syncing Series Categories...' });
    const seriesCatRes = await fetchXtream(`${baseApiUrl}&action=get_series_categories`);
    const seriesCategories = await seriesCatRes.json();

    sendEvent({ progress: 'Downloading Live Streams...' });
    const liveStreamsRes = await fetchXtream(`${baseApiUrl}&action=get_live_streams`);
    const liveStreams = await liveStreamsRes.json();

    sendEvent({ progress: 'Downloading Movie Streams...' });
    const vodStreamsRes = await fetchXtream(`${baseApiUrl}&action=get_vod_streams`);
    const vodStreams = await vodStreamsRes.json();

    sendEvent({ progress: 'Downloading Series List...' });
    const seriesRes = await fetchXtream(`${baseApiUrl}&action=get_series`);
    const seriesStreams = await seriesRes.json();

    sendEvent({ progress: 'Saving all cached contents...' });
    updatePlaylistCache({
      live_categories: Array.isArray(liveCategories) ? liveCategories : [],
      live_streams: Array.isArray(liveStreams) ? liveStreams : [],
      vod_categories: Array.isArray(vodCategories) ? vodCategories : [],
      vod_streams: Array.isArray(vodStreams) ? vodStreams : [],
      series_categories: Array.isArray(seriesCategories) ? seriesCategories : [],
      series_streams: Array.isArray(seriesStreams) ? seriesStreams : []
    });

    sendEvent({
      success: true,
      counts: {
        live: Array.isArray(liveStreams) ? liveStreams.length : 0,
        movies: Array.isArray(vodStreams) ? vodStreams.length : 0,
        series: Array.isArray(seriesStreams) ? seriesStreams.length : 0
      }
    });
    res.end();
  } catch (err) {
    console.error('Sync error:', err);
    sendEvent({ error: `Sync failed: ${err.message}` });
    res.end();
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
  const words = str.split(' ');
  const decodedWords = words.map(word => {
    if (!word) return '';
    let padded = word;
    while (padded.length % 4 !== 0) {
      padded += '=';
    }
    const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    if (!base64Regex.test(padded)) return word;
    try {
      const buf = Buffer.from(padded, 'base64');
      const decodedUtf8 = buf.toString('utf8');
      const hasReplacement = decodedUtf8.includes('\ufffd');
      const isPrintableUtf8 = /^[\x20-\x7E\r\n\t\u00A0-\uFFFF]*$/.test(decodedUtf8);
      if (!hasReplacement && isPrintableUtf8) return decodedUtf8;
      
      const decodedLatin1 = buf.toString('latin1');
      const isPrintableLatin1 = /^[\x20-\x7E\r\n\t\x80-\xFF]*$/.test(decodedLatin1);
      if (isPrintableLatin1) return decodedLatin1;
    } catch (err) {}
    return word;
  });
  return decodedWords.join(' ').replace(/\s+/g, ' ').trim();
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
app.get('/api/proxy', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  const decodedUrl = decodeURIComponent(url);
  const maxRedirects = 5;

  const fetchHeaders = {
    'User-Agent': 'VLC/3.0.20'
  };
  if (req.headers.range) {
    fetchHeaders['range'] = req.headers.range;
  }

  const handleRequest = (currentUrl, redirectCount = 0) => {
    if (redirectCount > maxRedirects) {
      if (!res.headersSent) res.status(500).send('Too many redirects');
      return;
    }

    const protocol = currentUrl.startsWith('https') ? https : http;
    
    const clientReq = protocol.get(currentUrl, { headers: fetchHeaders }, (clientRes) => {
      // Handle HTTP redirects (301, 302, 307, 308)
      if ([301, 302, 307, 308].includes(clientRes.statusCode)) {
        let location = clientRes.headers.location;
        if (location) {
          if (!location.startsWith('http')) {
            // Resolve relative redirect location
            const parsed = new URL(currentUrl);
            location = parsed.origin + location;
          }
          clientReq.destroy();
          handleRequest(location, redirectCount + 1);
          return;
        }
      }

      if (clientRes.statusCode !== 200 && clientRes.statusCode !== 206) {
        if (!res.headersSent) {
          res.status(clientRes.statusCode).send(`Error fetching stream: ${clientRes.statusMessage}`);
        }
        return;
      }

      const contentType = clientRes.headers['content-type'] || '';
      const isM3u8 = currentUrl.includes('.m3u8') || 
                     contentType.includes('mpegurl') || 
                     contentType.includes('application/x-mpegURL');

      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      if (isM3u8) {
        // Accumulate text data for HLS playlist URL rewriting
        let data = '';
        clientRes.setEncoding('utf8');
        clientRes.on('data', (chunk) => {
          data += chunk;
        });
        clientRes.on('end', () => {
          const baseUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1);
          const rewrittenText = data.split('\n').map(line => {
            const trimmed = line.trim();
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
              return line;
            }
            let absoluteUrl = trimmed;
            if (!trimmed.startsWith('http')) {
              absoluteUrl = baseUrl + trimmed;
            }
            return `/api/proxy?url=${encodeURIComponent(absoluteUrl)}`;
          }).join('\n');
          
          res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
          res.send(rewrittenText);
        });
      } else {
        // Direct binary stream piping for TS / MP4 and other video assets
        res.status(clientRes.statusCode);
        
        // Forward select stream-related headers
        for (const key of Object.keys(clientRes.headers)) {
          if (['content-range', 'content-length', 'accept-ranges', 'content-type'].includes(key)) {
            res.setHeader(key, clientRes.headers[key]);
          }
        }
        if (!res.getHeader('content-type')) {
          res.setHeader('Content-Type', 'video/mp2t');
        }

        clientRes.pipe(res);
      }
    });

    clientReq.on('error', (err) => {
      console.error('Proxy request failed:', err);
      if (!res.headersSent) {
        res.status(500).send(`Proxy error: ${err.message}`);
      }
    });

    // Abort the active request if the client disconnects
    req.on('close', () => {
      clientReq.destroy();
    });
  };

  handleRequest(decodedUrl);
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
  try {
    const ips = getLocalIpAddresses();
    if (ips.length > 0) {
      console.log('Exposed on your local network at:');
      ips.forEach(ip => console.log(`  http://${ip}:${PORT}`));
    }
  } catch (e) {}
});
