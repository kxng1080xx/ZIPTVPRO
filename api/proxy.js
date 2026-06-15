/**
 * Vercel Serverless CORS / mixed-content proxy.
 *
 * The web build is served over HTTPS, but most Xtream providers are plain HTTP
 * and send no CORS headers — so the browser blocks direct requests ("Failed to
 * fetch"). This function fetches the target server-side and streams the result
 * back from the same origin, sidestepping both problems.
 *
 * Usage:  /api/proxy?url=<encodeURIComponent(targetUrl)>
 *
 * Handles:
 *   - JSON API calls (player_api.php ...)        -> passthrough
 *   - HLS playlists (.m3u8)                       -> rewrite segment URLs through proxy
 *   - TS/MP4 segments & VOD                       -> binary passthrough (Range supported)
 */

export default async function handler(req, res) {
  // Same-origin in practice, but harmless and helps direct testing.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const rawUrl = req.query && req.query.url;
  if (!rawUrl) {
    res.status(400).send('Missing url parameter');
    return;
  }

  const target = decodeURIComponent(Array.isArray(rawUrl) ? rawUrl[0] : rawUrl);

  // Only allow http(s) targets (basic SSRF guard).
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.status(400).send('Invalid url');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).send('Unsupported protocol');
    return;
  }

  // Forward the headers that matter for media (seeking + some providers gate on UA).
  const fwdHeaders = {};
  if (req.headers['range']) fwdHeaders['Range'] = req.headers['range'];
  fwdHeaders['User-Agent'] = req.headers['user-agent'] || 'VLC/3.0.18 LibVLC/3.0.18';

  let upstream;
  try {
    upstream = await fetch(target, { headers: fwdHeaders, redirect: 'follow' });
  } catch (err) {
    res.status(502).send(`Proxy fetch failed: ${err.message}`);
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isM3u8 = target.toLowerCase().includes('.m3u8') || /mpegurl/i.test(contentType);

  // --- HLS playlist: rewrite child URLs so segments also flow through the proxy ---
  if (isM3u8) {
    const text = await upstream.text();

    const toProxy = (u) => {
      let abs;
      try {
        // Resolves relative, "./", "../" and root-absolute paths against the playlist URL.
        abs = new URL(u, target).href;
      } catch {
        abs = u;
      }
      return `/api/proxy?url=${encodeURIComponent(abs)}`;
    };

    const rewritten = text
      .split('\n')
      .map((line) => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          // Rewrite URI="..." attributes (EXT-X-KEY, EXT-X-MEDIA, EXT-X-MAP).
          return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${toProxy(uri)}"`);
        }
        return toProxy(t);
      })
      .join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(upstream.status).send(rewritten);
    return;
  }

  // --- Everything else: stream bytes straight through ---
  res.statusCode = upstream.status;
  if (contentType) res.setHeader('Content-Type', contentType);
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  try {
    const reader = upstream.body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // client disconnected or upstream aborted — just close.
  }
  res.end();
}
