/**
 * Direct TMDB lookups for CLIENT-MODE builds (ZIPTV Pro 9.0).
 *
 * The desktop app proxies metadata through its bundled local server
 * (server/tmdb.js), which keeps the read token off the client entirely. The
 * APK, the TV-only build and the hosted web build have no such server — for
 * them `/api/meta` simply 404s, which would silently disable the ABOUT panels
 * and the poster-dwell trailers on exactly the 10-foot devices this release
 * was built for.
 *
 * So those builds talk to TMDB directly with a token baked in at build time
 * (`__TMDB_TOKEN__`, see vite.config.js). That does put a read-only token in
 * the shipped bundle — a deliberate, accepted trade for the feature working on
 * Android/Fire TV. It is read-scope only and revocable from the TMDB account.
 *
 * The transform logic below is intentionally a sibling of server/tmdb.js
 * rather than a shared import: that module is Node-only (fs/path/os for its
 * disk cache) and can't be bundled for the browser, and the packaged app ships
 * `server/` but not `src/`, so neither side can import the other. Keep the two
 * `cleanTitle`/`normalize` implementations in step when changing either.
 */

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

// Replaced at build time. Empty when no token was available, in which case
// every call here resolves to null and the caller falls back to provider data.
const TOKEN = typeof __TMDB_TOKEN__ !== 'undefined' ? __TMDB_TOKEN__ : '';

export function hasClientToken() {
  return !!TOKEN;
}

/**
 * Mirror of cleanTitle() in server/tmdb.js — see that file for why playlist
 * titles need this at all ("EN | Sicario (2015) 4K" finds nothing verbatim).
 */
export function cleanTitle(raw) {
  let s = String(raw || '');

  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/^\s*[[({|]\s*[A-Za-z0-9 .+-]{1,18}\s*[\])}|]\s*/, '')
      .replace(/^\s*(?:VOD|MOVIES?|SERIES|4K|UHD|HD|FHD|SD)\s*[-:|]\s*/i, '')
      .replace(/^\s*[A-Za-z]{2,6}\s*[:|]\s*/, '');
    if (s === before) break;
  }

  let year = '';
  const paren = s.match(/\((19\d{2}|20\d{2})\)/);
  if (paren) {
    year = paren[1];
    s = s.replace(paren[0], ' ');
  } else {
    const bare = s.match(/\b(19\d{2}|20\d{2})\b(?!.*\b(?:19|20)\d{2}\b)/);
    if (bare) {
      year = bare[1];
      s = s.replace(bare[0], ' ');
    }
  }

  s = s.replace(
    /\b(?:4K|UHD|HDR10\+?|HDR|DV|DOLBY(?:\s*VISION)?|ATMOS|IMAX|3D|REMUX|BLU-?RAY|WEB-?(?:DL|RIP)|HD-?RIP|DVD-?RIP|BR-?RIP|HDTS|CAM|x26[45]|H\.?26[45]|HEVC|AVC|AAC|DTS|DD5\.1|MULTI|DUAL|VOSTFR|LATINO|CASTELLANO|SUB(?:BED|S)?|DUB(?:BED)?|1080[pi]|720[pi]|2160[pi]|480[pi])\b/gi,
    ' '
  );

  s = s
    .replace(/[[\](){}]/g, ' ')
    .replace(/\s*[-–—_]+\s*$/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { query: s, year };
}

async function call(endpoint, params = {}) {
  const url = new URL(TMDB + endpoint);
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v !== '' && v != null) url.searchParams.set(k, v);
  }
  // AbortSignal.timeout is shimmed by compat.js, which main.js imports first —
  // required for the old Fire OS WebViews this path exists to serve.
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    signal: AbortSignal.timeout(9000)
  });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

const img = (p, size) => (p ? `${IMG}/${size}${p}` : '');

function pickTrailer(videos) {
  const all = ((videos && videos.results) || []).filter((v) => v.site === 'YouTube' && v.key);
  const score = (v) => (v.type === 'Trailer' ? 4 : v.type === 'Teaser' ? 2 : 0) + (v.official ? 1 : 0);
  const best = all.sort((a, b) => score(b) - score(a))[0];
  return best ? { key: best.key, name: best.name || '', type: best.type || '' } : null;
}

function pickLogo(images) {
  const logos = (images && images.logos) || [];
  const pick = logos.find((l) => l.iso_639_1 === 'en') || logos.find((l) => !l.iso_639_1) || logos[0];
  return pick ? img(pick.file_path, 'w500') : '';
}

function normalize(type, d) {
  const isSeries = type === 'series';
  const credits = d.credits || {};
  return {
    ok: true,
    tmdb_id: d.id,
    type,
    title: isSeries ? d.name : d.title,
    overview: d.overview || '',
    tagline: d.tagline || '',
    genres: (d.genres || []).map((g) => g.name),
    status: d.status || '',
    created_by: (d.created_by || []).map((c) => c.name),
    networks: (d.networks || []).map((n) => ({ name: n.name, logo: img(n.logo_path, 'w185') })),
    director: (credits.crew || []).filter((c) => c.job === 'Director').map((c) => c.name),
    seasons: isSeries ? d.number_of_seasons || 0 : 0,
    episodes: isSeries ? d.number_of_episodes || 0 : 0,
    release_date: (isSeries ? d.first_air_date : d.release_date) || '',
    runtime: isSeries ? (d.episode_run_time || [])[0] || 0 : d.runtime || 0,
    rating: typeof d.vote_average === 'number' ? Math.round(d.vote_average * 10) / 10 : 0,
    imdb_id: (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || '',
    backdrop: img(d.backdrop_path, 'w1280'),
    poster: img(d.poster_path, 'w500'),
    logo: pickLogo(d.images),
    cast: (credits.cast || []).slice(0, 20).map((c) => ({
      name: c.name,
      character: c.character || '',
      profile: img(c.profile_path, 'w185')
    })),
    trailer: pickTrailer(d.videos)
  };
}

/**
 * Same contract as the server route: resolves a normalized object, or null for
 * "no match" / "no token". Never throws — callers treat metadata as a bonus.
 */
export async function lookupDirect({ type = 'movie', title = '', year = '', tmdbId = '' } = {}) {
  if (!TOKEN) return null;
  const kind = type === 'series' ? 'series' : 'movie';
  const seg = kind === 'series' ? 'tv' : 'movie';

  try {
    let id = tmdbId;
    if (!id) {
      const cleaned = cleanTitle(title);
      if (!cleaned.query) return null;
      const params = { query: cleaned.query, include_adult: 'false' };
      params[seg === 'tv' ? 'first_air_date_year' : 'year'] = year || cleaned.year;
      const search = await call(`/search/${seg}`, params);
      const first = (search.results || [])[0];
      if (!first) return null;
      id = first.id;
    }
    const detail = await call(`/${seg}/${id}`, {
      append_to_response: 'credits,videos,images,external_ids',
      include_image_language: 'en,null'
    });
    return normalize(kind, detail);
  } catch (e) {
    return null;
  }
}
