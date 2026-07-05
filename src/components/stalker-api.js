/**
 * Stalker / Ministra (MAG) portal client.
 *
 * The counterpart to xtream-api.js, for portals like:
 *   http://fullhdtv.link:8080/c/  +  MAC 00:1A:79:xx:xx:xx
 *
 * Auth model (vs Xtream's username/password):
 *   1. handshake      -> portal issues a random `token`
 *   2. get_profile    -> portal binds the token to this MAC/device (authorizes)
 *   3. get_genres     -> category list
 *   4. get_all_channels (or get_ordered_list per page) -> the channel list
 *   5. create_link    -> turns a channel's `cmd` into a real, playable stream URL
 *
 * Every call carries MAG headers (UA, Cookie: mac=.., Bearer token). Browsers
 * can't set those, so requests are routed through the server-side /api/stalker
 * proxy, which injects them. See api/stalker.js.
 */

// The portal API endpoint. The `/c/` in a URL is the STB web UI; the actual API
// lives at one of these. We probe them in order during connect().
const API_PATHS = [
  '/portal.php',
  '/stalker_portal/server/load.php',
  '/server/load.php',
];

// --- request plumbing --------------------------------------------------------

// Build a portal.php query string from a params object.
function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

// Fire one portal call through the header-injecting proxy and parse its JSON.
// Stalker wraps every response as { js: <payload> }.
async function stbFetch(portal, params, { mac, token } = {}) {
  const url = `${portal.origin}${portal.apiPath}?${qs({ ...params, JsHttpRequest: '1-xml' })}`;
  const proxied =
    `/api/stalker?url=${encodeURIComponent(url)}&mac=${encodeURIComponent(mac)}` +
    (token ? `&token=${encodeURIComponent(token)}` : '');

  const res = await fetch(proxied, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Stalker HTTP ${res.status}`);
  const data = await res.json();
  return data && 'js' in data ? data.js : data;
}

// --- public API --------------------------------------------------------------

/**
 * Connect: probe for the working API path, handshake, and authorize the MAC.
 * `hostUrl` is anything like "http://fullhdtv.link:8080" or ".../c/".
 * Returns a session { origin, apiPath, mac, token } to pass to later calls.
 */
export async function connect(hostUrl, mac) {
  const origin = new URL(hostUrl).origin;
  mac = mac.trim().toUpperCase();

  let lastErr;
  for (const apiPath of API_PATHS) {
    const portal = { origin, apiPath };
    try {
      // 1. handshake -> token
      const hs = await stbFetch(portal, { type: 'stb', action: 'handshake', token: '', prehash: '' }, { mac });
      const token = hs && hs.token;
      if (!token) throw new Error('no token in handshake');

      // 2. get_profile -> authorize this MAC against the token
      await stbFetch(portal, {
        type: 'stb',
        action: 'get_profile',
        hd: '1',
        ver: 'ImageDescription: 0.2.18-r23; api: 588; stb: MAG254',
        device_id: '',
        device_id2: '',
        sn: '',
        stb_type: 'MAG254',
        client_type: 'STB',
        auth_second_step: '0',
        num_banks: '1',
        image_version: '218',
      }, { mac, token });

      return { origin, apiPath, mac, token };
    } catch (err) {
      lastErr = err;
      // try the next candidate path
    }
  }
  throw new Error(`Could not connect to Stalker portal: ${lastErr && lastErr.message}`);
}

/** Account/subscription info (expiry, status). */
export function getAccountInfo(s) {
  return stbFetch(s, { type: 'account_info', action: 'get_main_info' }, s);
}

/** Live TV genres/categories. */
export function getGenres(s) {
  return stbFetch(s, { type: 'itv', action: 'get_genres' }, s);
}

/**
 * Live channels. Portals cap page size (usually 14), so this walks all pages.
 * Pass a genre id to filter, or '*' for everything.
 */
export async function getChannels(s, genre = '*') {
  const first = await stbFetch(s, {
    type: 'itv', action: 'get_ordered_list', genre, fav: '0', sortby: 'number', p: '1',
  }, s);

  const perPage = (first.data || []).length || 14;
  const total = Number(first.total_items || first.max_page_items || perPage);
  const pages = Math.max(1, Math.ceil(total / perPage));

  let all = first.data || [];
  for (let p = 2; p <= pages; p++) {
    const page = await stbFetch(s, {
      type: 'itv', action: 'get_ordered_list', genre, fav: '0', sortby: 'number', p: String(p),
    }, s);
    all = all.concat(page.data || []);
  }
  return all; // each item: { id, name, number, cmd, logo, ... }
}

/**
 * Resolve a channel's `cmd` into a real, playable stream URL.
 * Channel.cmd looks like "ffmpeg http://localhost/ch/12345_" — the portal
 * swaps that placeholder for a tokenised, time-limited stream URL.
 */
export async function getStreamUrl(s, cmd) {
  const js = await stbFetch(s, {
    type: 'itv', action: 'create_link', cmd, series: '', forced_storage: '0', disable_ad: '0',
  }, s);
  // js.cmd is usually "ffmpeg http://real/stream" — strip the leading token.
  const raw = (js && js.cmd) || '';
  const url = raw.replace(/^ffmpeg\s+/, '').trim();
  // Play through /api/proxy like your Xtream streams (mixed-content / UA gating).
  return url;
}

/* --- typical usage ---------------------------------------------------------
import { connect, getGenres, getChannels, getStreamUrl } from './stalker-api.js';

const s = await connect('http://fullhdtv.link:8080/c/', '00:1A:79:b4:f4:6f');
const genres   = await getGenres(s);
const channels = await getChannels(s, '*');
const streamUrl = await getStreamUrl(s, channels[0].cmd);
// -> hand streamUrl to your player (via proxify() as you do for Xtream)
--------------------------------------------------------------------------- */
