import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import http from 'http';
import https from 'https';
import { spawn, spawnSync } from 'child_process';

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
  deactivateActivePlaylist,
  updatePlaylistSettings
} from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// SHARE-TUNNEL GUARD (desktop phone-sharing over Cloudflare Quick Tunnel)
// The Electron app can expose THIS server on a public trycloudflare.com URL so
// the user watches on their phone. That URL is unguessable but technically
// reachable by anyone who has it, so we require a per-session token on requests
// that ARRIVE THROUGH THE TUNNEL. Cloudflare's edge stamps every such request
// with `cf-ray` / `cf-connecting-ip`; local desktop traffic and LAN casting have
// neither, so they pass untouched — only tunnel visitors are gated.
//
// Token travels as `?t=<token>` on the first load (from the QR), then a cookie
// carries it for playlist/segment requests. No token (web build / dev) = no gate.
// ---------------------------------------------------------------------------
const SHARE_TOKEN = process.env.SHARE_TOKEN || '';
const SHARE_COOKIE = 'ziptv_share';

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

if (SHARE_TOKEN) {
  app.use((req, res, next) => {
    // Not via the tunnel (no Cloudflare edge headers) → local/LAN → allow.
    const viaTunnel = !!(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
    if (!viaTunnel) return next();
    if (req.method === 'OPTIONS') return next(); // let CORS preflight through

    const provided = (req.query && req.query.t) || readCookie(req, SHARE_COOKIE);
    if (provided === SHARE_TOKEN) {
      // Persist so subsequent same-origin requests (HLS segments, API) are authorized.
      if (req.query && req.query.t) {
        res.setHeader('Set-Cookie',
          `${SHARE_COOKIE}=${encodeURIComponent(SHARE_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=86400`);
      }
      return next();
    }
    res.status(403).type('text/plain').send('This ZIPTV share link is invalid or expired.');
  });
}

// Disable caching for all API endpoints
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

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
  const { hostUrl, username, password, playlistName, skipAccountCheck } = req.body;

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
  // Skipped when syncing playlists from the ZIPTV admin dashboard — there,
  // ZIPTV's own admin-set expiry (Supabase devices.expires_at) is the sole
  // authority, not the underlying provider's own exp_date/status.
  if (!skipAccountCheck) {
    const status = String(info.status || '').toLowerCase();
    const exp = parseInt(info.exp_date, 10);
    const isExpired = status === 'expired' || (exp && !isNaN(exp) && exp * 1000 < Date.now());
    if (isExpired) {
      return res.status(403).json({ error: 'Your subscription has expired.' });
    }
    if (status && status !== 'active') {
      return res.status(403).json({ error: `Your account is not active (${info.status}).` });
    }
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

app.post('/api/playlists/update', (req, res) => {
  const { id, hidden_tabs, hidden_categories, playlistName } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing playlist id' });
  const result = updatePlaylistSettings(id, { hidden_tabs, hidden_categories, playlistName });
  res.json({ success: true, ...result });
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
    // These six provider calls are independent, so fetch them in two parallel
    // batches (categories, then streams) instead of six sequential round-trips.
    // On a slow/flaky provider this is the difference between ~6×latency and
    // ~2×latency, and no single slow endpoint blocks the others.
    const fetchJson = (action) =>
      fetchXtream(`${baseApiUrl}&action=${action}`).then((r) => r.json());

    sendEvent({ progress: 'Syncing categories (live, movies, series)...' });
    const [liveCategories, vodCategories, seriesCategories] = await Promise.all([
      fetchJson('get_live_categories'),
      fetchJson('get_vod_categories'),
      fetchJson('get_series_categories')
    ]);

    sendEvent({ progress: 'Downloading streams (live, movies, series)...' });
    const [liveStreams, vodStreams, seriesStreams] = await Promise.all([
      fetchJson('get_live_streams'),
      fetchJson('get_vod_streams'),
      fetchJson('get_series')
    ]);

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
  const { type, category_id, page, limit, search, sort } = req.query;
  if (!type) return res.status(400).json({ error: 'Missing type parameter' });

  const result = getStreams(
    type,
    category_id,
    parseInt(page) || 1,
    parseInt(limit) || 50,
    search || '',
    sort || 'added'
  );
  res.json(result);
});

// Base64 helper to safely decode strings. Xtream encodes the *whole* field, so
// decode it as one blob \u2014 never per word. base64 has no spaces, so any value
// containing whitespace is already plain text and is returned untouched. (The
// old per-word split mis-decoded ordinary words like "Vampire" into garbage.)
function decodeBase64Safe(str) {
  if (!str) return '';
  const trimmed = String(str).trim();
  const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  let padded = trimmed;
  while (padded.length % 4 !== 0) padded += '=';
  if (!base64Regex.test(padded)) return trimmed;
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
  return trimmed;
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

  // Express has already URL-decoded the query param once. Do NOT decode again:
  // a second decodeURIComponent corrupts HLS segment URLs whose tokens contain
  // percent-encoded characters (e.g. base64 "==" arrives as "%3D%3D" and a second
  // decode turns it into "==", producing a 404 from the provider's CDN).

  // Live Xtream TS goes through the continuous splice proxy: session-TTL
  // panels hard-close every connection on a timer (some as short as ~25s).
  // proxyLiveStream reconnects upstream and PTS-splices the sessions, so the
  // player sees ONE unbroken stream — its buffer survives, nothing replays,
  // and the drop never reaches the screen.
  if (/\/live\/[^?]*\.ts(\?|$)/i.test(url)) {
    return proxyLiveStream(url, req, res, { contentType: 'video/mpeg' });
  }
  // VOD (movie/series) files are finite and byte-seekable, so they get the
  // resumable proxy: when the provider or network drops the connection
  // mid-file, we reconnect with a Range request at the exact byte we last
  // forwarded — the player's buffer keeps filling and the drop never shows.
  if (/\/(movie|series)\/[^?]*\.\w+(\?|$)/i.test(url)) {
    return proxyVodStream(url, req, res);
  }
  proxyStream(url, req, res);
});

// Build the upstream provider URL for a stream (shared by stream-url + cast).
function buildProviderUrl(creds, type, streamId, ext, formatOverride) {
  const u = encodeURIComponent(creds.username);
  const p = encodeURIComponent(creds.password);
  if (type === 'movie') {
    return `${creds.server_url}/movie/${u}/${p}/${streamId}${ext ? '.' + ext : ''}`;
  }
  if (type === 'series') {
    return `${creds.server_url}/series/${u}/${p}/${streamId}${ext ? '.' + ext : ''}`;
  }
  const format = formatOverride || creds.stream_format || 'ts';
  return `${creds.server_url}/live/${u}/${p}/${streamId}.${format}`;
}

// --- Cast request debug log -------------------------------------------------
// Records exactly what a DLNA/Cast receiver requests from /cast/* (method, Range,
// User-Agent, DLNA probe header) and what we returned. Read it from any device
// at http://<pc-ip>:<port>/cast-debug to see if/how the TV fetches the stream.
const castDebugLog = [];
app.use('/cast', (req, res, next) => {
  const entry = {
    t: new Date().toISOString().slice(11, 19),
    method: req.method,
    path: req.originalUrl,
    range: req.headers['range'] || null,
    ua: req.headers['user-agent'] || null,
    wantContentFeatures: req.headers['getcontentfeatures.dlna.org'] || null
  };
  res.on('finish', () => {
    entry.status = res.statusCode;
    entry.contentType = res.getHeader('content-type') || null;
    entry.contentFeatures = res.getHeader('contentFeatures.dlna.org') || null;
    entry.contentLength = res.getHeader('content-length') || null;
  });
  castDebugLog.push(entry);
  if (castDebugLog.length > 40) castDebugLog.shift();
  next();
});
app.get('/cast-debug', (_req, res) => res.json(castDebugLog.slice().reverse()));

// Cast-friendly endpoint: a SHORT, clean, extension-bearing URL that DLNA
// renderers (Samsung especially) accept, unlike the long query-string form of
// /api/proxy?url=… which they truncate or can't type-sniff (→ UPnP 716). The
// path carries the kind + id + extension, e.g. /cast/movie/12345.mp4 or
// /cast/live/678.ts ; the real provider URL is rebuilt server-side and streamed.
const CAST_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska',
  avi: 'video/avi', mov: 'video/quicktime', ts: 'video/mpeg', m3u8: 'application/x-mpegurl'
};

app.get('/cast/:kind/:file', async (req, res) => {

  const creds = getCredentials();
  if (!creds) return res.status(401).send('Not logged in');

  const kind = req.params.kind; // 'live' | 'movie' | 'series'
  const file = req.params.file; // '<id>.<ext>'
  const dot = file.lastIndexOf('.');
  const streamId = dot >= 0 ? file.slice(0, dot) : file;
  const ext = (dot >= 0 ? file.slice(dot + 1) : '').toLowerCase();

  const isLive = kind === 'live';
  let targetUrl;
  if (isLive) {
    // For live the extension IS the format (ts / m3u8).
    targetUrl = buildProviderUrl(creds, 'live', streamId, '', ext || undefined);
  } else {
    targetUrl = buildProviderUrl(creds, kind, streamId, ext);
  }

  // DLNA renderers (Samsung) validate the media HTTP RESPONSE too, not just the
  // DIDL metadata, AND require a DLNA.ORG_PN profile they advertise as a sink.
  // Map our streams to the profiles a typical Samsung lists (mirror its FLAGS
  // value ED10…). A browser ignores all of this, which is why it played there.
  const { mime, features } = dlnaProfile(isLive, ext);

  // DLNA renderers send a HEAD probe (with getcontentFeatures.dlna.org) BEFORE
  // playing to validate the resource. Answer with the DLNA headers and no body —
  // do NOT open the streaming pipe, or the HEAD hangs forever and the TV reports
  // 716. For VOD (a finite file) the renderer needs Content-Length to set up
  // playback, so fetch it from the provider first; live is a stream (no length).
  if (req.method === 'HEAD') {
    res.setHeader('Content-Type', mime);
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader('contentFeatures.dlna.org', features);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (isLive) {
      res.setHeader('Accept-Ranges', 'none');
      return res.status(200).end();
    }
    return fetchUpstreamLength(targetUrl, (len) => {
      res.setHeader('Accept-Ranges', 'bytes');
      if (len) res.setHeader('Content-Length', String(len));
      res.status(200).end();
    });
  }

  // Live .ts to a cast receiver: the TV holds one long GET, so when the provider
  // closes the upstream (~60s) we must reconnect server-side and keep feeding the
  // same connection — otherwise the stream just ends and the TV stops. (HLS/m3u8
  // for Chromecast is segmented, so it uses the normal proxy.)
  if (isLive && ext === 'ts') {
    return proxyLiveStream(targetUrl, req, res, { contentType: mime, dlnaContentFeatures: features });
  }

  // Cast VOD gets the resumable proxy too — the TV holds one long GET for the
  // whole film, so a provider session cut without resume just ends the movie.
  if (!isLive) {
    return proxyVodStream(targetUrl, req, res, { contentType: mime, dlnaContentFeatures: features });
  }

  proxyStream(targetUrl, req, res, {
    contentType: mime,
    dlnaContentFeatures: features
  });
});

// Fetch a VOD file's total size from the provider (for the DLNA HEAD probe).
// Uses a 1-byte ranged GET so it works even when the provider ignores HEAD;
// parses the total from Content-Range, falling back to Content-Length.
function fetchUpstreamLength(url, cb, redirects = 0) {
  let done = false;
  const finish = (len) => { if (!done) { done = true; cb(len); } };
  const protocol = url.startsWith('https') ? https : http;
  const r = protocol.get(url, { headers: { 'User-Agent': 'VLC/3.0.20', 'Range': 'bytes=0-0' } }, (up) => {
    if ([301, 302, 307, 308].includes(up.statusCode) && up.headers.location && redirects < 5) {
      let loc = up.headers.location;
      if (!loc.startsWith('http')) { try { loc = new URL(url).origin + loc; } catch (e) {} }
      up.destroy();
      return fetchUpstreamLength(loc, (len) => finish(len), redirects + 1);
    }
    let total = null;
    const cr = up.headers['content-range']; // e.g. "bytes 0-0/123456"
    if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) total = parseInt(m[1], 10); }
    if (total == null && up.statusCode === 200 && up.headers['content-length']) {
      total = parseInt(up.headers['content-length'], 10);
    }
    up.destroy();
    finish(Number.isFinite(total) ? total : null);
  });
  r.on('error', () => finish(null));
  r.setTimeout(8000, () => { try { r.destroy(); } catch (e) {} finish(null); });
}

// --- MPEG-TS PES PTS extraction (for splice-on-reconnect) -------------------
// Returns the 33-bit PTS if this 188-byte packet starts a VIDEO PES with a
// PTS, else null. Used to find where a reconnected session's backlog overlaps
// content we already forwarded.
function tsVideoPts(pkt) {
  if (pkt[0] !== 0x47) return null;
  if (!(pkt[1] & 0x40)) return null;              // payload_unit_start only
  const afc = (pkt[3] >> 4) & 0x3;
  let off = 4;
  if (afc === 2) return null;                     // adaptation field only
  if (afc === 3) off = 5 + pkt[4];
  if (off + 14 > 188) return null;
  if (pkt[off] !== 0x00 || pkt[off + 1] !== 0x00 || pkt[off + 2] !== 0x01) return null;
  const sid = pkt[off + 3];
  if (sid < 0xE0 || sid > 0xEF) return null;      // video stream ids
  if (!((pkt[off + 7] >> 6) & 0x2)) return null;  // PTS_DTS_flags: PTS present
  const p = off + 9;
  return ((pkt[p] >> 1) & 0x07) * 2 ** 30 +
         (((pkt[p + 1] << 7) | (pkt[p + 2] >> 1)) & 0x7FFF) * 2 ** 15 +
         (((pkt[p + 3] << 7) | (pkt[p + 4] >> 1)) & 0x7FFF);
}
// a >= b in wrapped 33-bit PTS space (window = half the range)
function ptsAtOrAfter(a, b) { return ((a - b + 2 ** 33) % 2 ** 33) < 2 ** 32; }

// Continuous live proxy: keeps one client connection open and transparently
// reconnects to the provider whenever it drops the source (session-TTL panels
// cut EVERY connection on a timer — measured ~25s on some providers), so the
// player sees an unbroken stream. On reconnect the panel bursts ~10-20s of
// backlog it already sent us; forwarding that verbatim would make the client
// replay it and drift further behind live every cycle. Instead we PTS-splice:
// drop backlog packets until the new session's video PTS passes the last PTS
// we forwarded, then resume at that PES boundary — byte-continuous for the
// demuxer, no replay, no drift. A tight-loop guard bails if the source keeps
// dying immediately; a first-connect failure mirrors the provider's status to
// the client so dead channels still error out fast.
function proxyLiveStream(targetUrl, req, res, opts) {
  let upstream = null;
  let closed = false;
  let recentReconnects = 0;
  let lastConnectAt = 0;
  let firstConnect = true;

  // splice state
  let lastVideoPts = null;   // newest video PTS forwarded to the client
  let skipping = false;      // dropping reconnect backlog until PTS catches up
  let skipped = 0;           // bytes dropped this splice (safety-capped)
  let carry = Buffer.alloc(0); // partial TS packet between chunks
  const MAX_SKIP = 48 * 1024 * 1024; // never skip forever (~2 min at 3 Mbps)

  const stop = () => {
    closed = true;
    if (upstream) { try { upstream.destroy(); } catch (e) {} }
  };
  res.on('close', stop);
  req.on('close', stop);

  const sendHeaders = () => {
    if (res.headersSent) return;
    res.status(200);
    res.setHeader('Content-Type', opts.contentType || 'video/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Accept-Ranges', 'none');
    if (opts.dlnaContentFeatures) {
      res.setHeader('transferMode.dlna.org', 'Streaming');
      res.setHeader('contentFeatures.dlna.org', opts.dlnaContentFeatures);
    }
  };

  const writeOut = (buf, up) => {
    if (closed || !buf.length) return;
    if (!res.write(buf)) { up.pause(); res.once('drain', () => { try { up.resume(); } catch (e) {} }); }
  };

  // Align to 188-byte packets (resyncing on corruption), track the forwarded
  // video PTS, and while `skipping` drop everything until the overlap ends.
  const processChunk = (chunk, up) => {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    if (buf[0] !== 0x47) {
      const idx = buf.indexOf(0x47);
      if (idx < 0) { carry = Buffer.alloc(0); return; }
      start = idx;
    }
    const whole = Math.floor((buf.length - start) / 188) * 188;
    carry = Buffer.from(buf.subarray(start + whole));
    if (!whole) return;
    const body = buf.subarray(start, start + whole);

    let fwdFrom = 0;
    if (skipping) {
      fwdFrom = -1;
      for (let i = 0; i < body.length; i += 188) {
        const pts = tsVideoPts(body.subarray(i, i + 188));
        if (pts != null && (lastVideoPts == null || ptsAtOrAfter(pts, lastVideoPts))) {
          fwdFrom = i; // resume exactly at the first new video PES
          break;
        }
      }
      skipped += (fwdFrom === -1 ? body.length : fwdFrom);
      if (fwdFrom === -1 && skipped > MAX_SKIP) fwdFrom = 0; // safety valve
      if (fwdFrom === -1) return;
      skipping = false;
      console.log(`[live-proxy] spliced session (skipped ${(skipped / 1024 / 1024).toFixed(1)} MB of backlog overlap)`);
    }
    const out = body.subarray(fwdFrom);
    for (let i = 0; i < out.length; i += 188) {
      const pts = tsVideoPts(out.subarray(i, i + 188));
      if (pts != null) lastVideoPts = pts;
    }
    writeOut(out, up);
  };

  const connect = (url, redirects = 0) => {
    if (closed) return;

    const now = Date.now();
    if (now - lastConnectAt < 1000) recentReconnects++; else recentReconnects = 0;
    lastConnectAt = now;
    if (recentReconnects > 6) { // source is dying immediately — give up cleanly
      try { res.headersSent ? res.end() : res.status(502).end(); } catch (e) {}
      return;
    }

    const protocol = url.startsWith('https') ? https : http;
    const upReq = protocol.get(url, { headers: { 'User-Agent': 'VLC/3.0.20' } }, (up) => {
      if ([301, 302, 307, 308].includes(up.statusCode) && up.headers.location && redirects < 5) {
        let loc = up.headers.location;
        if (!loc.startsWith('http')) { try { loc = new URL(url).origin + loc; } catch (e) {} }
        up.destroy();
        return connect(loc, redirects + 1);
      }
      if (up.statusCode !== 200 && up.statusCode !== 206) {
        up.resume();
        // First attempt failing = channel is actually bad: tell the client the
        // truth so the app errors fast instead of hanging on an empty stream.
        if (firstConnect && !res.headersSent) {
          try { res.status(up.statusCode).end(); } catch (e) {}
          closed = true;
          return;
        }
        if (!closed) setTimeout(() => connect(targetUrl), 800); // retry original
        return;
      }

      if (firstConnect) { sendHeaders(); firstConnect = false; }
      // Reconnected session: drop the panel's backlog burst up to what the
      // client already has (splice), unless we never forwarded video yet.
      skipping = lastVideoPts != null;
      skipped = 0;
      carry = Buffer.alloc(0);

      upstream = up;
      up.on('data', (chunk) => { if (!closed) processChunk(chunk, up); });
      // Provider closed the source → immediately reconnect to the original URL.
      up.on('end', () => { if (!closed) connect(targetUrl); });
      up.on('error', () => { if (!closed) setTimeout(() => connect(targetUrl), 500); });
    });
    upReq.on('error', () => {
      if (closed) return;
      if (firstConnect && !res.headersSent) { try { res.status(502).end(); } catch (e) {} closed = true; return; }
      setTimeout(() => connect(targetUrl), 500);
    });
  };

  connect(targetUrl);
}

// Resumable VOD proxy: a movie/series file is finite and byte-seekable, so
// unlike live we don't need a PTS splice — when the provider drops the
// connection mid-file (session-TTL panels cut long VOD downloads on the same
// ~25s timer as live) or the network blips, we reconnect with a Range request
// at the exact byte we last forwarded and keep writing to the SAME client
// response. Byte-continuous, so the player's buffer just keeps filling and
// the drop never reaches the screen. Also covers silent stalls (no FIN, no
// error — a black-holed TCP connection) via an idle watchdog.
function proxyVodStream(targetUrl, req, res, opts = {}) {
  // Only open-ended "bytes=N-" ranges (what media players send) get resume
  // accounting; bounded/suffix ranges fall back to the one-shot proxy.
  const rangeMatch = /^bytes=(\d+)-$/.exec(req.headers.range || '');
  if (req.headers.range && !rangeMatch) return proxyStream(targetUrl, req, res, opts);

  const baseOffset = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
  let bytesSent = 0;       // bytes forwarded to the client on this response
  let totalSize = null;    // absolute file size (from Content-Range/-Length)
  let skipBytes = 0;       // overlap to discard when a resume gets 200 not 206
  let upstream = null;
  let closed = false;
  let firstConnect = true;
  let consecFails = 0;     // reset whenever upstream bytes actually arrive
  let pausedForClient = false; // backpressure pause — idle watchdog ignores it
  let lastDataAt = Date.now();

  const finish = (destroy) => {
    if (closed) return;
    closed = true;
    clearInterval(idleTimer);
    if (upstream) { try { upstream.destroy(); } catch (e) {} }
    // destroy = we owe the client bytes we can't deliver: cut the socket so
    // it sees a network error, never a clean-but-truncated end.
    try { destroy ? res.destroy() : res.end(); } catch (e) {}
  };
  const stop = () => {
    closed = true;
    clearInterval(idleTimer);
    if (upstream) { try { upstream.destroy(); } catch (e) {} }
  };
  res.on('close', stop);
  req.on('close', stop);

  // Bytes still owed to the client, or null when the provider never told us
  // the file size (then a clean upstream end is trusted as the real end).
  const remaining = () => (totalSize == null ? null : totalSize - baseOffset - bytesSent);

  // A dead connection doesn't always error or FIN — a wifi drop can leave the
  // socket silently black-holed, which is the frozen frame that never
  // recovers. If no data flows for 15s and it's not our own backpressure
  // pause, destroy the upstream so the error path reconnects at the offset.
  const idleTimer = setInterval(() => {
    if (closed || pausedForClient || !upstream) return;
    if (Date.now() - lastDataAt > 15000) {
      console.warn('[vod-proxy] upstream silent 15s — forcing reconnect');
      try { upstream.destroy(new Error('idle')); } catch (e) {}
    }
  }, 5000);

  // Failed connect attempt: back off exponentially (0.5s → 8s). The budget
  // (~1 min of solid failures) rides out router reboots and provider restarts;
  // it only gives up when the source is truly gone. Delivered bytes reset it.
  const failRetry = () => {
    if (closed) return;
    consecFails++;
    if (consecFails > 12) return finish(true); // destroy: never fake a clean EOF short
    setTimeout(() => connect(targetUrl), Math.min(500 * 2 ** (consecFails - 1), 8000));
  };

  const connect = (url, redirects = 0) => {
    if (closed) return;
    const resumeAt = baseOffset + bytesSent;
    const headers = { 'User-Agent': 'VLC/3.0.20' };
    // Keep the client's range semantics on first connect (a 206 vs 200 answer
    // tells the browser whether it can seek); afterwards resume at our offset.
    if (rangeMatch || resumeAt > 0) headers['Range'] = `bytes=${resumeAt}-`;

    const protocol = url.startsWith('https') ? https : http;
    const upReq = protocol.get(url, { headers, rejectUnauthorized: false }, (up) => {
      if ([301, 302, 307, 308].includes(up.statusCode) && up.headers.location && redirects < 5) {
        let loc = up.headers.location;
        if (!loc.startsWith('http')) { try { loc = new URL(url).origin + loc; } catch (e) {} }
        up.destroy();
        return connect(loc, redirects + 1);
      }
      // Resuming exactly at EOF → 416: everything was already delivered.
      if (up.statusCode === 416 && !firstConnect) { up.resume(); return finish(false); }
      if (up.statusCode !== 200 && up.statusCode !== 206) {
        up.resume();
        // First attempt failing = the file is actually bad: mirror the status
        // so the app errors fast instead of hanging on an empty stream.
        if (firstConnect && !res.headersSent) {
          try { res.status(up.statusCode).end(); } catch (e) {}
          closed = true;
          clearInterval(idleTimer);
          return;
        }
        return failRetry();
      }

      // Learn the absolute file size (Content-Range total, else Content-Length
      // of a full 200 response) — that's how a premature FIN is detected.
      const crTotal = /\/(\d+)\s*$/.exec(up.headers['content-range'] || '');
      if (crTotal) totalSize = parseInt(crTotal[1], 10);
      else if (up.statusCode === 200 && up.headers['content-length'] && totalSize == null) {
        totalSize = parseInt(up.headers['content-length'], 10);
      }

      skipBytes = 0;
      if (firstConnect) {
        res.status(up.statusCode);
        for (const k of ['content-range', 'content-length', 'accept-ranges', 'content-type']) {
          if (up.headers[k]) res.setHeader(k, up.headers[k]);
        }
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (opts.contentType) res.setHeader('Content-Type', opts.contentType);
        if (opts.dlnaContentFeatures) {
          res.setHeader('transferMode.dlna.org', 'Streaming');
          res.setHeader('contentFeatures.dlna.org', opts.dlnaContentFeatures);
          if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
        }
        if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'video/mp2t');
        firstConnect = false;
      } else {
        // Where does this resume response actually start? A server that
        // ignores Range answers 200 from byte 0 — discard the overlap. One
        // that starts PAST our offset can't be spliced byte-continuously.
        let respStart = 0;
        const crStart = /bytes (\d+)-/.exec(up.headers['content-range'] || '');
        if (up.statusCode === 206 && crStart) respStart = parseInt(crStart[1], 10);
        if (respStart > resumeAt) { up.destroy(); return finish(true); }
        skipBytes = resumeAt - respStart;
      }

      upstream = up;
      lastDataAt = Date.now();
      let sessionBytes = 0; // forwarded THIS session — a 0-byte session must back off, not tight-loop
      up.on('data', (chunk) => {
        if (closed) return;
        lastDataAt = Date.now();
        if (skipBytes) {
          if (chunk.length <= skipBytes) { skipBytes -= chunk.length; return; }
          chunk = chunk.subarray(skipBytes);
          skipBytes = 0;
        }
        consecFails = 0;
        sessionBytes += chunk.length;
        bytesSent += chunk.length;
        if (!res.write(chunk)) {
          pausedForClient = true;
          up.pause();
          res.once('drain', () => {
            pausedForClient = false;
            lastDataAt = Date.now();
            try { up.resume(); } catch (e) {}
          });
        }
      });
      up.on('end', () => {
        if (closed) return;
        const rem = remaining();
        if (rem == null || rem <= 0) return finish(false); // true end of file
        console.log(`[vod-proxy] upstream ended ${(rem / 1024 / 1024).toFixed(1)} MB early — resuming at byte ${baseOffset + bytesSent}`);
        // A FIN after delivering data is the session-TTL cut, not a failure —
        // reconnect immediately. A 0-byte session goes through the backoff.
        if (sessionBytes > 0) return connect(targetUrl);
        failRetry();
      });
      up.on('error', () => { if (!closed) failRetry(); });
    });
    upReq.on('error', () => {
      if (closed) return;
      if (firstConnect && !res.headersSent) {
        try { res.status(502).end(); } catch (e) {}
        closed = true;
        clearInterval(idleTimer);
        return;
      }
      failRetry();
    });
  };

  connect(targetUrl);
}

// Map a stream to a Content-Type + DLNA.ORG_PN profile string the renderer
// accepts. Kept in sync with the DIDL protocolInfo built in the Electron cast
// manager. FLAGS mirror what Samsung advertises (ED10…).
function dlnaProfile(isLive, ext) {
  const FLAGS = 'ED100000000000000000000000000000';
  if (isLive && ext === 'm3u8') {
    // eShare-type renderers get live as HLS (the renderer fetches the segments).
    // Advertise the HLS mime, no DLNA.ORG_PN, no seek (live).
    return { mime: 'application/x-mpegurl', features: `DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${FLAGS}` };
  }
  if (isLive) {
    // IPTV live is 188-byte MPEG-TS → MPEG_TS_NA_ISO (video/mpeg), no seek.
    return { mime: 'video/mpeg', features: `DLNA.ORG_PN=MPEG_TS_NA_ISO;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${FLAGS}` };
  }
  // VOD: do NOT claim a specific DLNA.ORG_PN. IPTV files vary in codec/profile/
  // resolution, and a wrong PN (e.g. AVC SD for an HD file) makes strict
  // renderers reject with "file not supported". Omitting the PN lets the TV
  // sniff the actual media and play it if it can decode it (this TV decodes
  // H.264 fine — live proves it). Just advertise byte-seek + streaming flags.
  return { mime: CAST_MIME[ext] || 'video/mp4', features: `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${FLAGS}` };
}

function proxyStream(decodedUrl, req, res, opts = {}) {
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

    // ponytail: accept expired / self-signed certs. IPTV providers and logo
    // hosts routinely run broken cert chains; without this every such asset
    // 500s with CERT_HAS_EXPIRED. Tradeoff: no TLS verification on proxied
    // fetches (MITM risk) — acceptable for a media proxy, revisit if it ever
    // carries anything sensitive. Ignored for http://.
    const clientReq = protocol.get(currentUrl, { headers: fetchHeaders, rejectUnauthorized: false }, (clientRes) => {
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
          const rewrittenText = data.split('\n').map(line => {
            const trimmed = line.trim();
            if (trimmed.length === 0 || trimmed.startsWith('#')) {
              return line;
            }
            // Resolve against the (possibly redirected) playlist URL. The URL
            // constructor correctly handles all three forms providers emit:
            // absolute (http://…), root-relative (/hlsr/…), and directory-
            // relative (seg.ts). Naive baseUrl+path concatenation breaks the
            // root-relative case (produces …/live/u/p//hlsr/… → 401/404).
            let absoluteUrl;
            try {
              absoluteUrl = new URL(trimmed, currentUrl).href;
            } catch (e) {
              absoluteUrl = trimmed;
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

        // Cast (DLNA) responses: force the right Content-Type and advertise the
        // DLNA capabilities on the HTTP response, which Samsung validates before
        // playing. Also guarantee Accept-Ranges so the renderer can seek.
        if (opts.contentType) res.setHeader('Content-Type', opts.contentType);
        if (opts.dlnaContentFeatures) {
          res.setHeader('transferMode.dlna.org', 'Streaming');
          res.setHeader('contentFeatures.dlna.org', opts.dlnaContentFeatures);
          if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
        }

        if (!res.getHeader('content-type')) {
          res.setHeader('Content-Type', 'video/mp2t');
        }

        clientRes.pipe(res);
      }
    });

    clientReq.on('error', (err) => {
      // Dead logo domains / unreachable hosts are expected — log one line, not a
      // stack trace, so real problems aren't buried.
      console.warn(`Proxy request failed (${err.code || 'ERR'}): ${currentUrl}`);
      if (!res.headersSent) {
        res.status(502).send(`Proxy error: ${err.message}`);
      }
    });

    // Abort the active request if the client disconnects
    req.on('close', () => {
      clientReq.destroy();
    });
  };

  handleRequest(decodedUrl);
}

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

// Format a Unix timestamp (seconds, UTC) as the Xtream catch-up "start" token
// Y-m-d:H-i. Note: some providers interpret this in server-local time — if a
// provider's replays are shifted, this is the spot to apply a timezone offset.
function fmtCatchupStart(unixSec) {
  const d = new Date(unixSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}:${p(d.getUTCHours())}-${p(d.getUTCMinutes())}`;
}

// API: Catch-up / archive replay URL. Builds the Xtream timeshift.php link for a
// past programme (?start=<Y-m-d:H-i>&duration=<minutes>). Client passes the
// programme's start_timestamp (unix seconds) and duration in minutes.
app.get('/api/catchup-url/:stream_id', (req, res) => {
  const { stream_id } = req.params;
  const start = parseInt(req.query.start, 10);
  const duration = Math.max(1, parseInt(req.query.duration, 10) || 0);
  const creds = getCredentials();
  if (!creds) return res.status(401).json({ error: 'Not logged in' });
  if (!start || !duration) return res.status(400).json({ error: 'missing start/duration' });

  const startStr = fmtCatchupStart(start);
  const targetUrl = `${creds.server_url}/streaming/timeshift.php`
    + `?username=${encodeURIComponent(creds.username)}`
    + `&password=${encodeURIComponent(creds.password)}`
    + `&stream=${encodeURIComponent(stream_id)}`
    + `&start=${encodeURIComponent(startStr)}`
    + `&duration=${duration}`;

  const url = creds.proxy_streams ? `/api/proxy?url=${encodeURIComponent(targetUrl)}` : targetUrl;
  res.json({ url });
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

// ==========================================================================
// DESKTOP PREMIUM-VOD TRANSCODE (Electron only)
// Browser <video> in stock Electron can HW-decode HEVC but NOT E-AC3 audio, so
// premium VOD (MKV/HEVC Main10 + E-AC3) plays silent or not at all. This endpoint
// pipes the stream through ffmpeg and serves a fragmented MP4 the <video> can play:
//   - mode=audio (default): copy the HEVC video untouched, transcode only the
//     E-AC3 audio -> AAC. Near-zero CPU; relies on the GPU HEVC decoder.
//   - mode=full: also transcode video -> H.264 for GPUs that can't HW-decode HEVC.
// Only the desktop player calls this (see player.js _playViaTranscode); the web
// build never hits it (and a host without ffmpeg simply 500s, never called).
// ==========================================================================
function findFfmpeg() {
  const isWin = process.platform === 'win32';
  const bin = isWin ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  // Packaged Electron: extraResources copied to <resources>/bin/
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', bin));
  // Dev / unpackaged
  candidates.push(
    path.join(__dirname, '..', 'extraResources', bin),
    path.join(__dirname, '..', 'extraResources', process.platform, bin)
  );
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return bin; // fall back to PATH
}

// Detect the best available H.264 hardware encoder once, caching the result.
// Software libx264 can't sustain real-time encoding on weak CPUs — that's the
// "significant video delay on slow PCs" symptom — so whenever we must re-encode
// video (mode=full / deinterlace) we prefer a GPU encoder that offloads the work.
// The probe runs a single `ffmpeg -encoders`; being *listed* doesn't guarantee
// the encoder *initialises* (e.g. h264_nvenc is listed on a machine with no
// NVIDIA GPU), so every re-encode path also carries a runtime fallback to
// libx264 (see the transcode/timeshift exit handlers).
let _hwEncoderCache; // undefined = not probed; null = none; string = encoder name
function detectHwEncoder() {
  if (_hwEncoderCache !== undefined) return _hwEncoderCache;
  _hwEncoderCache = null;
  try {
    const out = spawnSync(findFfmpeg(), ['-hide_banner', '-encoders'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000
    });
    const text = `${out.stdout || ''}${out.stderr || ''}`;
    // Preference order by typical throughput/availability on each platform.
    const order = process.platform === 'darwin'
      ? ['h264_videotoolbox']
      : ['h264_nvenc', 'h264_qsv', 'h264_amf'];
    for (const enc of order) {
      if (new RegExp(`\\b${enc}\\b`).test(text)) { _hwEncoderCache = enc; break; }
    }
  } catch (e) {}
  console.log(_hwEncoderCache
    ? `[transcode] hardware H.264 encoder available: ${_hwEncoderCache}`
    : '[transcode] no hardware H.264 encoder — using libx264 (software)');
  return _hwEncoderCache;
}

// H.264 video-encode args. Prefers the detected hardware encoder; `soft` forces
// software libx264 (used by the runtime fallback when a HW encoder won't start).
// `lp` (low-power) picks the lightest software settings for weak CPUs. Callers
// prepend any -vf filters (deinterlace / downscale) themselves.
function h264EncodeArgs({ soft = false, lp = false } = {}) {
  const hw = soft ? null : detectHwEncoder();
  switch (hw) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', '23', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-pix_fmt', 'nv12'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-pix_fmt', 'yuv420p'];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', '55', '-pix_fmt', 'yuv420p'];
    default:
      // Software. Low-power trades quality for speed so a weak CPU keeps up.
      return ['-c:v', 'libx264', '-preset', lp ? 'ultrafast' : 'veryfast', '-crf', lp ? '25' : '23', '-pix_fmt', 'yuv420p'];
  }
}

// --- Child-process lifecycle ------------------------------------------------
// The ffmpeg children spawned for transcode/probe must die with the app. On
// Windows a child is NOT auto-killed when its parent (the Electron main process,
// which hosts this in-process server) exits — that's the stray ffmpeg.exe left
// running after closing the app. Track every spawn and force-kill them all on
// shutdown, however it's triggered.
const activeChildren = new Set();

function trackChild(proc) {
  if (!proc) return proc;
  activeChildren.add(proc);
  const drop = () => activeChildren.delete(proc);
  proc.on('exit', drop);
  proc.on('error', drop);
  return proc;
}

function killAllChildren() {
  try { stopTimeshift(); } catch (e) {}   // stop the live buffer + wipe its folder on exit
  for (const proc of activeChildren) {
    try {
      if (process.platform === 'win32' && proc.pid) {
        // taskkill /T kills the whole tree, /F forces it — a bare SIGKILL can
        // leave ffmpeg alive on Windows. spawnSync so it runs during 'exit'.
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
      } else {
        proc.kill('SIGKILL');
      }
    } catch (e) {}
  }
  activeChildren.clear();
}

// Fire on any shutdown path. 'exit' handlers must be synchronous — spawnSync is.
process.on('exit', killAllChildren);
process.on('SIGINT', () => { killAllChildren(); process.exit(0); });
process.on('SIGTERM', () => { killAllChildren(); process.exit(0); });
// Let the Electron main process trigger cleanup before it quits (same process,
// so globalThis is shared between main.electron.cjs and this module).
globalThis.__ziptvKillChildren = killAllChildren;

app.get('/api/transcode', (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send('missing or invalid url');
  }
  const mode = req.query.mode === 'full' ? 'full' : 'audio';
  const start = Math.max(0, parseInt(req.query.start, 10) || 0);
  const deint = req.query.deint === '1';
  const lp = req.query.lp === '1'; // low-power: weak CPU (perf-lite) — lightest re-encode
  const reEncode = deint || mode === 'full'; // paths that actually encode video
  const ffmpeg = findFfmpeg();

  const buildArgs = (hvc1Tag, forceSoft = false) => {
    const args = [];
    // Fast input seek (before -i) for resume / restart-at-offset.
    if (start > 0) args.push('-ss', String(start));
    args.push(
      '-user_agent', 'VLC/3.0.20',
      // Auto-reconnect when the provider drops the HTTP connection mid-file
      // (some Xtream servers kill long-lived VOD downloads). Without these,
      // ffmpeg treats the drop as EOF and the transcode ends early. A clean
      // premature FIN also reads as EOF, hence reconnect_at_eof; at the true
      // end of file the resume request fails and ffmpeg exits normally.
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '4',
      // Regenerate presentation timestamps: sources with missing/irregular PTS
      // otherwise let the copied video and re-encoded AAC audio drift apart.
      '-fflags', '+genpts',
      '-i', target
    );
    if (reEncode) {
      // Compose the software video filter (runs in system memory before the
      // encoder — hardware encoders upload from there). Deinterlace + field-
      // double turns 1080i (30 frames / 60 fields) into 1080p60 for smooth
      // motion; low-power also downscales to 720p to lighten the encode.
      const vf = [];
      if (deint) vf.push('bwdif=mode=send_field');
      if (lp) vf.push('scale=-2:720');
      if (vf.length) args.push('-vf', vf.join(','));
      // Prefer a GPU encoder (offloads the CPU); fall back to libx264.
      args.push(...h264EncodeArgs({ soft: forceSoft, lp }));
    } else {
      // Audio-only tier: keep the video as-is (Electron HW-decodes it). HEVC
      // needs the hvc1 tag for Chromium — but the tag is fatal on non-HEVC
      // sources ("Tag hvc1 incompatible with codec id"), so the exit handler
      // retries without it when the source turns out to be H.264 etc.
      args.push('-c:v', 'copy');
      if (hvc1Tag) args.push('-tag:v', 'hvc1');
    }
    args.push(
      '-c:a', 'aac', '-b:a', '256k', '-ac', '2',
      // A/V sync: resample audio to track the copied video's clock (absorbs AAC
      // encoder priming + drift), and zero-base timestamps so a keyframe -ss seek
      // doesn't leave audio lagging video by the pre-roll offset.
      '-af', 'aresample=async=1',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );
    return args;
  };

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');

  let proc = null;
  let wroteData = false;      // any bytes reached the client?
  let retriedTag = false;     // one-shot hvc1 → untagged retry
  let retriedSoftware = false;// one-shot hardware-encoder → libx264 retry
  let closed = false;         // client went away — don't respawn
  // True only while we're actually asking a HW encoder to run — so a fast,
  // data-less failure can be retried once in software before giving up.
  const usingHw = reEncode && !!detectHwEncoder();

  const kill = () => { closed = true; if (proc) { try { proc.kill('SIGKILL'); } catch (e) {} } };
  req.on('close', kill);
  res.on('close', kill);

  const startProc = (hvc1Tag, forceSoft = false) => {
    let stderrTail = '';
    try {
      proc = trackChild(spawn(ffmpeg, buildArgs(hvc1Tag, forceSoft), { windowsHide: true }));
    } catch (err) {
      console.error('[transcode] ffmpeg spawn failed:', err);
      if (!res.headersSent) res.status(500);
      return res.end();
    }

    proc.stdout.on('data', () => { wroteData = true; });
    // end:false — the response is ended explicitly in the exit handler, so the
    // hvc1-tag retry can reuse the same response stream.
    proc.stdout.pipe(res, { end: false });
    // ffmpeg logs to stderr; surface only on failure to keep logs quiet.
    proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });

    proc.on('error', (err) => {
      console.error('[transcode] ffmpeg error:', err && err.message, '| is ffmpeg installed/bundled?');
      if (!res.headersSent) res.status(500);
      try { res.end(); } catch (e) {}
    });
    proc.on('exit', (code) => {
      // Copy-video tier assumed HEVC but the source is H.264/other: the hvc1
      // tag kills muxing before a single byte is written. Retry untagged.
      if (!closed && !wroteData && !retriedTag && /Tag hvc1 incompatible/i.test(stderrTail)) {
        retriedTag = true;
        console.warn('[transcode] source is not HEVC — retrying without hvc1 tag');
        startProc(false);
        return;
      }
      // Hardware encoder was listed but wouldn't initialise (no matching GPU,
      // driver too old, session limit) — it dies before writing a byte. Retry
      // once in software so playback still works, just on the CPU.
      if (!closed && !wroteData && !retriedSoftware && usingHw && !forceSoft && code && code !== 0) {
        retriedSoftware = true;
        console.warn('[transcode] hardware encoder failed to start — falling back to libx264 (software)');
        startProc(hvc1Tag, true);
        return;
      }
      if (code && code !== 0 && code !== 255) {
        console.error(`[transcode] ffmpeg exited ${code} (${mode}). Tail:\n${stderrTail}`);
      }
      try { res.end(); } catch (e) {}
    });
  };

  startProc(mode === 'audio' && !deint);
});

// Probe a stream's total duration with the bundled ffmpeg (no ffprobe needed):
// `ffmpeg -i <url>` prints "Duration: HH:MM:SS.ss" to stderr then exits. Used by
// the desktop transcode path to give the (otherwise piped/non-seekable) fMP4 a
// real total duration so the seek bar works. Returns { duration } in seconds.
app.get('/api/probe', (req, res) => {
  const target = req.query.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'missing or invalid url' });
  }
  const ffmpeg = findFfmpeg();
  let stderr = '';
  let proc;
  try {
    proc = trackChild(spawn(ffmpeg, ['-user_agent', 'VLC/3.0.20', '-i', target], { windowsHide: true }));
  } catch (err) {
    return res.json({ duration: 0 });
  }
  // ffmpeg writes header/metadata then errors (no output specified). We only need
  // the first stderr chunks containing "Duration:"; kill once we have enough.
  proc.stderr.on('data', (d) => {
    stderr += d;
    if (/Duration:\s*\d+:\d+:\d+/.test(stderr) || stderr.length > 16000) {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }
  });
  let sent = false;
  const finish = () => {
    if (sent) return; sent = true;
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    let duration = 0;
    if (m) duration = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    if (!res.headersSent) res.json({ duration });
  };
  proc.on('error', finish);
  proc.on('exit', finish);
  req.on('close', () => { try { proc.kill('SIGKILL'); } catch (e) {} });
});

// ==========================================================================
// DVR (record) + TIMESHIFT (pause/rewind live ~30 s) — desktop only.
// Both need the bundled ffmpeg, so they're only ever exercised by the
// Electron app. Reuse findFfmpeg()/trackChild() from the transcode section
// above so recordings/timeshift children die with the app like every other one.
//   Record:    ffmpeg -c copy <live> -> a single .ts file on disk.
//   Timeshift: ffmpeg segments <live> into a rolling ~30-sec HLS playlist held
//              entirely in RAM (no disk files); player reads it via hls.js.
// ==========================================================================
const DVR_DATA_DIR = process.env.ELECTRON_RUNNING === 'true'
  ? path.join(os.homedir(), '.ziptv_pro_data')   // same root cache.js uses
  : path.join(__dirname, 'data');
const REC_DIR = path.join(DVR_DATA_DIR, 'recordings');
const REC_INDEX = path.join(DVR_DATA_DIR, 'recordings.json');
const SCHED_INDEX = path.join(DVR_DATA_DIR, 'schedule.json');
try { fs.mkdirSync(REC_DIR, { recursive: true }); } catch (e) {}
// Timeshift is in-memory now — clean up any segment folder an older build left.
try { fs.rmSync(path.join(DVR_DATA_DIR, 'timeshift'), { recursive: true, force: true }); } catch (e) {}

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v, null, 2)); } catch (e) {} };
const sanitize = (s) => String(s || '').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80) || 'rec';

function updateRec(id, patch) {
  const list = readJson(REC_INDEX, []);
  const i = list.findIndex(r => r.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  writeJson(REC_INDEX, list);
  return list[i];
}

const recProcs = new Map(); // id -> live ffmpeg recording process

// Spawn one stream-copy recording. id lets a scheduled job reuse its own id.
function startRecording({ url, name, channel, durationMins, id }) {
  const recId = id || ('rec_' + Date.now());
  const file = path.join(REC_DIR, `${recId}__${sanitize(name || channel)}.ts`);
  const secs = Math.max(60, Math.round((+durationMins || 120) * 60));
  // ponytail: .ts + stream-copy always works from a live .ts source and the app
  // already plays .ts; remux to .mp4 here if you ever want portable files.
  const args = [
    '-user_agent', 'VLC/3.0.20',
    // Survive the connection cycling IPTV providers do periodically — and the
    // drop that happens when playing another channel opens a new connection —
    // instead of exiting and leaving a truncated recording. Same flags the
    // timeshift segmenter relies on; without them a single drop ends the capture.
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '4',
    '-fflags', '+genpts+discardcorrupt',
    '-i', url,
    '-c', 'copy',
    '-t', String(secs),
    '-f', 'mpegts',
    file,
  ];
  const proc = trackChild(spawn(findFfmpeg(), args, { windowsHide: true }));
  recProcs.set(recId, proc);
  const entry = {
    id: recId, name: name || channel || 'Recording', channel: channel || '',
    file, status: 'recording', createdAt: Date.now(), durationMins: +durationMins || 120,
  };
  writeJson(REC_INDEX, readJson(REC_INDEX, []).filter(r => r.id !== recId).concat(entry));
  const done = () => {
    recProcs.delete(recId);
    let ok = false; try { ok = fs.statSync(file).size > 0; } catch (e) {}
    updateRec(recId, { status: ok ? 'done' : 'failed' });
  };
  proc.on('exit', done);
  proc.on('error', done);
  return entry;
}

app.post('/api/record', (req, res) => {
  const { url, name, channel, durationMins } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'missing or invalid url' });
  try { res.json(startRecording({ url, name, channel, durationMins })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/recordings', (req, res) => {
  const list = readJson(REC_INDEX, []).map(r => {
    let size = 0; try { size = fs.statSync(r.file).size; } catch (e) {}
    return { id: r.id, name: r.name, channel: r.channel, status: r.status,
             createdAt: r.createdAt, durationMins: r.durationMins, size,
             playUrl: `/api/recordings/${r.id}/play.ts` };  // .ts → player picks mpegts engine
  }).sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.post('/api/recordings/:id/stop', (req, res) => {
  const proc = recProcs.get(req.params.id);
  if (proc) { try { proc.kill('SIGKILL'); } catch (e) {} }
  res.json(updateRec(req.params.id, { status: 'done' }) || { ok: true });
});

app.delete('/api/recordings/:id', (req, res) => {
  const list = readJson(REC_INDEX, []);
  const rec = list.find(r => r.id === req.params.id);
  const proc = recProcs.get(req.params.id);
  if (proc) { try { proc.kill('SIGKILL'); } catch (e) {} recProcs.delete(req.params.id); }
  if (rec) { try { fs.unlinkSync(rec.file); } catch (e) {} }
  writeJson(REC_INDEX, list.filter(r => r.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/api/recordings/:id/play.ts', (req, res) => {
  const rec = readJson(REC_INDEX, []).find(r => r.id === req.params.id);
  if (!rec || !fs.existsSync(rec.file)) return res.status(404).send('not found');
  res.type('video/mp2t');
  res.sendFile(rec.file); // express sendFile honors Range, so the .ts is seekable
});

// --- Scheduled recordings -------------------------------------------------
const schedTimers = new Map();

function armSchedule(job) {
  const delay = new Date(job.startAt).getTime() - Date.now();
  if (delay < 0) return false;
  // ponytail: setTimeout caps at ~24.8 days — past any sane TV scheduling horizon.
  const t = setTimeout(() => {
    startRecording({ url: job.url, name: job.name, channel: job.channel, durationMins: job.durationMins, id: job.id });
    writeJson(SCHED_INDEX, readJson(SCHED_INDEX, []).filter(j => j.id !== job.id));
    schedTimers.delete(job.id);
  }, delay);
  schedTimers.set(job.id, t);
  return true;
}

app.post('/api/recordings/schedule', (req, res) => {
  const { url, name, channel, startAt, durationMins } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'missing or invalid url' });
  if (!startAt || isNaN(new Date(startAt).getTime())) return res.status(400).json({ error: 'missing or invalid startAt' });
  const job = { id: 'sch_' + Date.now(), url, name: name || channel || 'Recording', channel: channel || '', startAt, durationMins: +durationMins || 120 };
  writeJson(SCHED_INDEX, readJson(SCHED_INDEX, []).concat(job));
  if (!armSchedule(job)) return res.status(400).json({ error: 'startAt is in the past' });
  res.json(job);
});

app.get('/api/recordings/schedule', (req, res) => res.json(readJson(SCHED_INDEX, [])));

app.delete('/api/recordings/schedule/:id', (req, res) => {
  const t = schedTimers.get(req.params.id);
  if (t) { clearTimeout(t); schedTimers.delete(req.params.id); }
  writeJson(SCHED_INDEX, readJson(SCHED_INDEX, []).filter(j => j.id !== req.params.id));
  res.json({ ok: true });
});

// Re-arm future jobs on boot; drop ones whose start time already passed.
{
  const jobs = readJson(SCHED_INDEX, []);
  const future = jobs.filter(j => new Date(j.startAt).getTime() > Date.now());
  future.forEach(armSchedule);
  if (future.length !== jobs.length) writeJson(SCHED_INDEX, future);
}

// --- Online subtitles (OpenSubtitles proxy) ---------------------------------
// The renderer can't call the OpenSubtitles API cross-origin, so the local
// server relays search + download. The user's API key is passed per-call and
// never stored here.
const OS_API = 'https://api.opensubtitles.com/api/v1';
const osHeaders = (key) => ({
  'Api-Key': key,
  'User-Agent': 'ZIPTV v1.0',
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

app.get('/api/subs/search', async (req, res) => {
  const { q, lang, key } = req.query;
  if (!q || !key) return res.status(400).json({ error: 'q and key are required' });
  try {
    const url = `${OS_API}/subtitles?query=${encodeURIComponent(q)}&languages=${encodeURIComponent(lang || 'en')}`;
    const r = await fetch(url, { headers: osHeaders(key) });
    if (!r.ok) throw new Error(`OpenSubtitles replied ${r.status}${r.status === 401 ? ' (bad API key?)' : ''}`);
    const data = await r.json();
    // Slim the payload to what the picker needs: one file per result.
    const items = (data.data || []).map((d) => {
      const a = d.attributes || {};
      const f = (a.files || [])[0];
      if (!f) return null;
      const name = a.release || a.feature_details?.title || 'Subtitle';
      return { fileId: f.file_id, label: `${name} [${a.language || '?'}]${a.hearing_impaired ? ' (HI)' : ''}` };
    }).filter(Boolean).slice(0, 15);
    res.json(items);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/subs/download', async (req, res) => {
  const { fileId, key } = req.body || {};
  if (!fileId || !key) return res.status(400).json({ error: 'fileId and key are required' });
  try {
    const r = await fetch(`${OS_API}/download`, {
      method: 'POST', headers: osHeaders(key), body: JSON.stringify({ file_id: fileId }),
    });
    if (!r.ok) throw new Error(`OpenSubtitles replied ${r.status}`);
    const { link } = await r.json();
    if (!link) throw new Error('No download link (daily download quota reached?)');
    const sub = await fetch(link);
    if (!sub.ok) throw new Error(`Subtitle file fetch failed (${sub.status})`);
    res.type('text/plain').send(await sub.text());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- Timeshift (rolling ~2-min in-memory HLS buffer) ------------------------
// Segments + playlist live in a RAM map (tsMem) — nothing is written to disk.
// ffmpeg PUTs each file to the local ingest route below; the player reads the
// same bytes back out of memory. 12 x 10s segments ≈ 100s of usable rewind.
let activeTimeshift = null; // { ch, url, proc, stopped, restarts, windowStart, lastSeq }
const tsMem = new Map();    // filename -> Buffer

function stopTimeshift() {
  if (activeTimeshift) {
    activeTimeshift.stopped = true;           // tell the exit handler not to restart
    try { activeTimeshift.proc.kill('SIGKILL'); } catch (e) {}
    activeTimeshift = null;
  }
  tsMem.clear();
}

// Spawn (or respawn) the segmenter for `state`. On respawn, segment numbering
// continues from lastSeq and the playlist is tagged with a DISCONTINUITY
// (discont_start) — a respawned ffmpeg restarts timestamps at zero, and an
// unmarked timestamp reset is what made hls.js lurch playback backwards.
function spawnTimeshiftProc(state) {
  // Video is stream-copied (cheap); audio is transcoded to AAC because live
  // channels often carry AC3/E-AC3/MP2 that Chromium's MSE can't decode from a
  // copied TS — that mismatch is what made hls.js throw media errors and flicker.
  const ingest = `http://127.0.0.1:${PORT}/api/timeshift/ingest`;
  const respawn = state.lastSeq >= 0;
  const args = [
    '-user_agent', 'VLC/3.0.20',
    // Auto-reconnect to the provider instead of exiting when it drops the
    // connection or sends EOF — IPTV servers cycle connections periodically, and
    // each drop was killing the segmenter (= a visible stop). These keep one
    // ffmpeg alive across drops so the buffer never gaps.
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '2',
    // Rebuild timestamps + drop corrupt packets so a raw-TS stream-copy stays
    // glitch-free without re-encoding video.
    '-fflags', '+genpts+discardcorrupt',
    '-i', state.url,
    // Deinterlace to 60fps (bwdif field-double) needs a video re-encode; otherwise
    // stream-copy the video untouched (cheap). The re-encode prefers a GPU
    // encoder — live 1080p60 x264 in software is CPU-heavy — and drops to
    // libx264 if the hardware encoder can't start (see the fast-fail below).
    ...(state.deint
      ? [
          '-vf', 'bwdif=mode=send_field' + (state.lp ? ',scale=-2:720' : ''),
          ...h264EncodeArgs({ soft: state.forceSoftEncode, lp: state.lp })
        ]
      : ['-c:v', 'copy']),
    '-c:a', 'aac', '-ac', '2', '-b:a', '256k',
    '-avoid_negative_ts', 'make_zero',
    // 10-sec chunks, 12 in the playlist = ~120s window in RAM. hls.js parks
    // playback ~2 segments behind the newest, and every network stall drifts
    // it further back — with the old 60s window a few stalls put playback at
    // the sliding window's tail, where segments are evicted while still being
    // fetched. That fetch/evict race is what caused the recurring backward
    // skips ("skips back once, then more and more"). The wider window keeps
    // drifted playback far from the tail (and doubles usable rewind to ~100s);
    // RAM cost is ~60-150MB at typical live bitrates, desktop-only.
    '-f', 'hls', '-hls_time', '10', '-hls_init_time', '1', '-hls_list_size', '12',
    '-start_number', String(state.lastSeq + 1),
    '-hls_flags', 'omit_endlist' + (respawn ? '+discont_start' : ''),
    '-hls_segment_type', 'mpegts',
    // Everything goes over HTTP into tsMem — no files on disk.
    '-method', 'PUT',
    '-hls_segment_filename', `${ingest}/seg_%05d.ts`,
    `${ingest}/index.m3u8`,
  ];
  const proc = trackChild(spawn(findFfmpeg(), args, { windowsHide: true }));
  state.proc = proc;
  // Note whether this attempt is riding a HW encoder and when it started, so a
  // fast crash with no segments produced can flip to software on respawn.
  state._encStart = Date.now();
  state._encWasHw = state.deint && !state.forceSoftEncode && !!detectHwEncoder();
  // Keep the last bit of ffmpeg stderr so an unexpected exit is explainable.
  let errTail = '';
  proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-1500); });
  proc.on('exit', (code) => {
    if (!state.stopped && activeTimeshift === state) {
      console.warn(`[timeshift] ffmpeg exited (code ${code}). Tail:\n${errTail}`);
    }
  });
  proc.on('exit', () => {
    if (state.stopped || activeTimeshift !== state) return; // deliberate / superseded
    // If a HW-encoded attempt died within a few seconds without producing a
    // single segment, the encoder never initialised — switch to software so the
    // respawn actually plays instead of crash-looping.
    if (state._encWasHw && !state.forceSoftEncode && state.lastSeq < 0 &&
        Date.now() - state._encStart < 5000) {
      state.forceSoftEncode = true;
      console.warn('[timeshift] hardware encoder failed to start — falling back to libx264 (software)');
    }
    // The provider dropped the connection — restart so the buffer (and the
    // viewer's playback) survives instead of freezing. Cap restarts so a dead
    // source doesn't get hammered: 6 within a rolling 60s window.
    const now = Date.now();
    if (now - state.windowStart > 60000) { state.windowStart = now; state.restarts = 0; }
    if (state.restarts >= 6) { console.warn('[timeshift] too many restarts — giving up'); activeTimeshift = null; return; }
    state.restarts++;
    console.warn(`[timeshift] segmenter exited — restarting (${state.restarts})`);
    setTimeout(() => { if (activeTimeshift === state && !state.stopped) spawnTimeshiftProc(state); }, 1500);
  });
  return proc;
}

// ffmpeg PUTs playlist + segments here → straight into RAM.
app.put('/api/timeshift/ingest/:file', (req, res) => {
  const file = String(req.params.file).replace(/[^a-z0-9_.\-]+/gi, '_');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    tsMem.set(file, Buffer.concat(chunks));
    const m = file.match(/^seg_(\d+)\.ts$/);
    if (m && activeTimeshift) {
      activeTimeshift.lastSeq = Math.max(activeTimeshift.lastSeq, parseInt(m[1], 10));
    }
    // On each playlist update, prune segments that fell out of the window
    // (keep 2 just-expired ones so a lagging player never 404s mid-fetch).
    if (file.endsWith('.m3u8')) {
      const nums = [...tsMem.get(file).toString('utf8').matchAll(/seg_(\d+)\.ts/g)]
        .map((x) => parseInt(x[1], 10));
      if (nums.length) {
        const min = Math.min(...nums) - 2;
        for (const k of tsMem.keys()) {
          const km = k.match(/^seg_(\d+)\.ts$/);
          if (km && parseInt(km[1], 10) < min) tsMem.delete(k);
        }
      }
    }
    res.status(200).end();
  });
  req.on('error', () => res.status(500).end());
});

const waitForSegments = (n, ms) => new Promise((resolve) => {
  const deadline = Date.now() + ms;
  const tick = () => {
    let count = 0;
    for (const k of tsMem.keys()) if (k.endsWith('.ts')) count++;
    if (count >= n) return resolve(true);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(tick, 250);
  };
  tick();
});

app.get('/api/timeshift/start', async (req, res) => {
  const url = req.query.url;
  const ch = sanitize(req.query.ch || 'live');
  const deint = req.query.deint === '1';
  const lp = req.query.lp === '1'; // low-power (perf-lite): lightest deint re-encode
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'missing or invalid url' });
  // Already buffering this channel with the same deinterlace setting → reuse it.
  if (activeTimeshift && activeTimeshift.ch === ch && activeTimeshift.deint === deint && !activeTimeshift.stopped) {
    return res.json({ playlist: `/api/timeshift/${ch}/index.m3u8` });
  }
  stopTimeshift();   // also clears tsMem from any previous stream
  const state = { ch, url, deint, lp, proc: null, stopped: false, restarts: 0, windowStart: Date.now(), lastSeq: -1 };
  activeTimeshift = state;
  try { spawnTimeshiftProc(state); }
  catch (e) { activeTimeshift = null; return res.status(500).json({ error: 'ffmpeg spawn failed' }); }
  // Wait for a few segments (not just the first) so playback starts with a
  // cushion behind the live edge — starting on the only segment starves the
  // buffer and freezes once at startup.
  const ready = await waitForSegments(3, 20000);
  if (!ready) { stopTimeshift(); return res.status(504).json({ error: 'timeshift failed to start' }); }
  res.json({ playlist: `/api/timeshift/${ch}/index.m3u8` });
});

app.get('/api/timeshift/stop', (req, res) => { stopTimeshift(); res.json({ ok: true }); });

// Serve playlist + segments from RAM. The playlist may reference segments by
// their full ingest URL (ffmpeg writes the segment target as-is), so accept
// GETs on both the /:ch/ and /ingest/ shapes — same bytes either way.
const serveTsMem = (req, res) => {
  const file = String(req.params.file).replace(/[^a-z0-9_.\-]+/gi, '_');
  const buf = tsMem.get(file);
  if (!buf) return res.status(404).end();
  if (file.endsWith('.m3u8')) {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/vnd.apple.mpegurl');
  } else {
    res.type('video/mp2t');
  }
  res.send(buf);
};
app.get('/api/timeshift/ingest/:file', serveTsMem);
app.get('/api/timeshift/:ch/:file', serveTsMem);

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
