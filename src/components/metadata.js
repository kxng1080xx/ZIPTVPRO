/**
 * TMDB metadata client (ZIPTV Pro 9.0).
 *
 * Prefers the local server's /api/meta route (server/tmdb.js), which keeps the
 * read token server-side and owns the disk cache. That's the desktop path.
 *
 * Builds with no bundled server — the APK, the TV-only build, hosted web —
 * get a 404 there, and fall through to tmdb-client.js, which calls TMDB
 * directly with a token baked in at build time. Without that fallback the
 * whole feature is silently dead on Android and Fire TV.
 *
 * Design rules this module exists to enforce:
 *
 *   - **Never throw, never block a render.** Every failure path resolves to
 *     null. Callers treat metadata as a bonus layer over provider data, so a
 *     missing lookup must degrade to "no extra info", never to a broken panel.
 *
 *   - **Ask once per title.** A poster row fires a lookup for every item that
 *     takes focus, and users sweep back and forth across the same dozen
 *     posters. Results (including misses) are memoised, and concurrent calls
 *     for the same key share one in-flight request.
 *
 *   - **Give up permanently when there's no server.** The hosted web build, the
 *     APK and the legacy Fire OS build have no /api/meta. One failed probe
 *     flips `unavailable` and every later call short-circuits, so those builds
 *     don't fire a doomed request per poster.
 *
 * AbortSignal.timeout is safe here: compat.js shims it and is imported first in
 * main.js, which is what old Fire OS WebViews need (see the 8.4.x sync fix).
 */

import { lookupDirect, hasClientToken } from './tmdb-client.js';

const cache = new Map();     // key -> meta object or null (null = known miss)
const inflight = new Map();  // key -> Promise, so duplicates share one request

// Set once the server proves it has no /api/meta (404 / HTML / network error).
// Deliberately sticky: re-probing per poster on a build that will never have
// the route is pure waste.
let unavailable = false;

function keyFor({ type, title, year, tmdbId }) {
  return tmdbId
    ? `${type}:id:${tmdbId}`
    : `${type}:q:${String(title || '').toLowerCase().trim()}:${year || ''}`;
}

/**
 * Fetch enrichment for one title.
 *
 * @param {object}  opts
 * @param {string}  opts.type    'movie' | 'series'
 * @param {string}  opts.title   raw playlist title — the server cleans it
 * @param {string} [opts.year]   year hint, if the caller has a better one
 * @param {string} [opts.tmdbId] provider-supplied TMDB id; skips the search
 * @returns {Promise<object|null>} normalized meta, or null when unavailable
 */
export async function getMeta({ type = 'movie', title = '', year = '', tmdbId = '' } = {}) {
  if (!title && !tmdbId) return null;

  const kind = type === 'series' ? 'series' : 'movie';
  const key = keyFor({ type: kind, title, year, tmdbId });

  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  // Server route already proved absent (APK / TV-only / hosted web): skip the
  // doomed request entirely and go straight to TMDB.
  if (unavailable) {
    const p = direct(key, { type: kind, title, year, tmdbId }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const params = new URLSearchParams({ type: kind });
  if (tmdbId) params.set('tmdb_id', tmdbId);
  else {
    params.set('title', title);
    if (year) params.set('year', year);
  }

  const req = (async () => {
    try {
      const res = await fetch(`/api/meta?${params.toString()}`, {
        signal: AbortSignal.timeout(10000)
      });

      // 503 = token not configured. That's a deployment state, not a per-title
      // failure, so stop asking rather than hammering once per poster.
      if (res.status === 503) { unavailable = true; return direct(key, { type: kind, title, year, tmdbId }); }

      // No route at all (APK / TV-only / hosted web) answers with HTML or a
      // 404. Those builds have no bundled server, so fall through to talking
      // to TMDB directly — otherwise the whole feature is dead on Android and
      // Fire TV.
      if (!res.ok || !/json/i.test(res.headers.get('content-type') || '')) {
        if (res.status === 404) unavailable = true;
        return direct(key, { type: kind, title, year, tmdbId });
      }

      const data = await res.json();
      // { ok: false } is a legitimate "TMDB has no entry" — cache it as a miss
      // so the same un-matchable title isn't retried all session.
      const meta = data && data.ok ? data : null;
      cache.set(key, meta);
      return meta;
    } catch (err) {
      // Timeout or network error. NOT cached — a transient blip shouldn't
      // blank a title for the rest of the session.
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, req);
  return req;
}

/**
 * Fall back to talking to TMDB from the client.
 *
 * Only does anything in builds that had a token baked in at build time (the
 * APK / TV-only / hosted web builds — see tmdb-client.js). The desktop app
 * never reaches here because its local server answers /api/meta. Results are
 * memoised in the same cache, misses included.
 */
async function direct(key, opts) {
  if (!hasClientToken()) {
    cache.set(key, null);
    return null;
  }
  const meta = await lookupDirect(opts);
  cache.set(key, meta);
  return meta;
}

/**
 * Warm the cache without waiting. Call this the moment a poster takes focus so
 * the request overlaps the dwell delay — by the time the preview is due to
 * open, the trailer key and backdrop are usually already in hand.
 */
export function prefetchMeta(opts) {
  try { getMeta(opts); } catch (e) {}
}

/** Synchronous peek — returns undefined if not yet fetched, null for a miss. */
export function peekMeta(opts) {
  const kind = opts.type === 'series' ? 'series' : 'movie';
  return cache.get(keyFor({ ...opts, type: kind }));
}

/**
 * Best year hint available from an Xtream item, for disambiguating remakes.
 * Provider fields are wildly inconsistent, hence the spread of candidates.
 */
export function yearHintOf(item = {}, meta = {}) {
  const raw = meta.releasedate || meta.releaseDate || meta.year ||
              item.year || item.releaseDate || item.added || '';
  const m = String(raw).match(/(19\d{2}|20\d{2})/);
  return m ? m[1] : '';
}
