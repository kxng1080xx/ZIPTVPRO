/**
 * Cloudflare Pages Functions CORS / mixed-content proxy.
 *
 * Cloudflare Pages Functions port of api/proxy.js (Vercel) — see that file's
 * header comment for why this exists. Logic is unchanged; the (req, res)
 * streaming-via-res.write() loop becomes a direct Response(stream) instead,
 * since Workers' fetch already gives us upstream.body as a ReadableStream.
 *
 * Usage:  /api/proxy?url=<encodeURIComponent(targetUrl)>
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request }) {
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get('url');
  if (!target) {
    return new Response('Missing url parameter', { status: 400, headers: CORS_HEADERS });
  }

  // Only allow http(s) targets (basic SSRF guard).
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('Invalid url', { status: 400, headers: CORS_HEADERS });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new Response('Unsupported protocol', { status: 400, headers: CORS_HEADERS });
  }

  // Forward the headers that matter for media (seeking + some providers gate on UA).
  const fwdHeaders = {};
  const range = request.headers.get('range');
  if (range) fwdHeaders['Range'] = range;
  fwdHeaders['User-Agent'] = request.headers.get('user-agent') || 'VLC/3.0.18 LibVLC/3.0.18';

  let upstream;
  try {
    upstream = await fetch(target, { headers: fwdHeaders, redirect: 'follow' });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, { status: 502, headers: CORS_HEADERS });
  }

  const contentType = upstream.headers.get('content-type') || '';
  const isM3u8 = target.toLowerCase().includes('.m3u8') || /mpegurl/i.test(contentType);

  // --- HLS playlist: rewrite child URLs so segments also flow through the proxy ---
  if (isM3u8) {
    const text = await upstream.text();

    // Resolve segment URLs against the FINAL (post-redirect) playlist URL, not the
    // originally requested one — providers often 302 to a load-balancer host whose
    // root-relative segment paths (/hlsr/…) must resolve against that final origin.
    const baseUrl = upstream.url || target;
    const toProxy = (u) => {
      let abs;
      try {
        // Resolves relative, "./", "../" and root-absolute paths against the playlist URL.
        abs = new URL(u, baseUrl).href;
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

    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      }
    });
  }

  // --- Everything else: stream bytes straight through ---
  const headers = { ...CORS_HEADERS };
  if (contentType) headers['Content-Type'] = contentType;
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
