/**
 * Stalker / Ministra (MAG) portal proxy.
 *
 * Xtream uses plain username/password over player_api.php, so /api/proxy is
 * enough for it. Stalker is different: the portal authenticates a *device* by
 * its MAC and only answers requests that carry a MAG-style User-Agent, a
 * `Cookie: mac=..` header, and (after handshake) an `Authorization: Bearer`
 * token. Browsers refuse to let fetch set User-Agent / Cookie / Referer, so
 * those headers have to be injected server-side. That's all this does.
 *
 * Usage: /api/stalker?url=<encodeURIComponent(portalUrl)>&mac=<MAC>&token=<optional>
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = req.query || {};
  const target = Array.isArray(q.url) ? q.url[0] : q.url;
  const mac = Array.isArray(q.mac) ? q.mac[0] : q.mac;
  const token = Array.isArray(q.token) ? q.token[0] : q.token;
  if (!target || !mac) return res.status(400).send('Missing url or mac');

  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).send('Invalid url'); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).send('Bad protocol');

  // The headers a MAG-254 box sends. Some portals sniff the exact UA string.
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) ' +
      'MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    'Referer': `${parsed.origin}/c/`,
    'Accept': '*/*',
    'X-User-Agent': 'Model: MAG254; Link: WiFi',
    'Cookie': `mac=${mac}; stb_lang=en; timezone=Europe/London`,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const upstream = await fetch(target, { headers, redirect: 'follow' });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(body);
  } catch (err) {
    res.status(502).send(`Stalker proxy failed: ${err.message}`);
  }
}
