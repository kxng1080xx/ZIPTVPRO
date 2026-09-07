/**
 * TMDB metadata enrichment (ZIPTV Pro 9.0).
 *
 * Why this lives on the local server instead of in the renderer:
 *   1. The read token stays out of the shipped bundle.
 *   2. One place to cache. A poster row fires a lookup per focused item, so
 *      the same handful of titles gets asked for over and over.
 *   3. Old TV WebViews are poor at cross-origin TLS to extra hosts; they only
 *      ever talk to our own origin, which they already do for everything else.
 *
 * What TMDB adds over the provider: Xtream `get_vod_info` / `get_series_info`
 * return whatever the provider scraped — usually a plot, sometimes a
 * comma-joined cast string. Network, status, created-by, cast head-shots,
 * clear-logos and trailer keys are absent from that payload for every provider
 * tested. Those are exactly the ABOUT-panel and poster-preview fields.
 *
 * Auth is the TMDB **v4 Read Access Token** (`Authorization: Bearer eyJ...`),
 * NOT the v3 `?api_key=` string — a header keeps the credential out of URLs,
 * logs and Referer.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

// Same root cache.js and the DVR use, so everything the app stores lives in one
// place the user can delete to reset.
const DATA_DIR = process.env.ELECTRON_RUNNING === 'true'
  ? path.join(os.homedir(), '.ziptv_pro_data')
  : path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'tmdb_cache.json');
const TOKEN_FILE = path.join(DATA_DIR, 'tmdb.json');

// A hit is stable for a week — cast and networks don't change. A miss is
// retried after a day: a title can gain a trailer later, and a fix to
// cleanTitle() should start matching things it previously couldn't.
const TTL_HIT = 7 * 24 * 3600 * 1000;
const TTL_MISS = 24 * 3600 * 1000;

// --------------------------------------------------------------------------
// Token resolution
// --------------------------------------------------------------------------
/**
 * Looked up in order so the same build works in dev and installed:
 *   1. TMDB_TOKEN in the environment (npm run dev, or Electron passing it on).
 *   2. The repo-root .env — present in dev, deliberately NOT shipped in the EXE.
 *   3. tmdb.json in the data dir — how a packaged install gets one, since it
 *      has no .env to read.
 * Cached after the first hit; a token doesn't change mid-session.
 */
let cachedToken;
export function tmdbToken() {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.TMDB_TOKEN || '';

  if (!cachedToken) {
    // Minimal .env reader — not worth a dotenv dependency for one key.
    try {
      const envPath = path.join(__dirname, '..', '.env');
      const line = fs.readFileSync(envPath, 'utf8')
        .split(/\r?\n/)
        .find((l) => /^\s*TMDB_TOKEN\s*=/.test(l));
      if (line) cachedToken = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    } catch (e) {}
  }

  if (!cachedToken) {
    try { cachedToken = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')).token || ''; } catch (e) {}
  }

  // Baked at build time by scripts/bake-tmdb.mjs. This is what makes the
  // PACKAGED app work: it ships server/ but not .env, so without this an
  // installed build 503s every lookup and silently loses the ABOUT panels and
  // trailer previews.
  if (!cachedToken) {
    try {
      cachedToken = JSON.parse(fs.readFileSync(path.join(__dirname, 'tmdb-baked.json'), 'utf8')).token || '';
    } catch (e) {}
  }

  return cachedToken;
}

// --------------------------------------------------------------------------
// Disk cache
// --------------------------------------------------------------------------
let store = null;

function loadStore() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { store = {}; }
  return store;
}

// Batched — a poster row can write several entries a second while the user
// scrolls, and a synchronous write per entry would stutter the UI thread that
// is waiting on the response.
let flushTimer = null;
function saveStoreSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(store));
    } catch (e) {}
  }, 1500);
  if (flushTimer.unref) flushTimer.unref();   // never hold the process open
}

// --------------------------------------------------------------------------
// Title cleaning
// --------------------------------------------------------------------------
/**
 * Playlist titles are not search queries. Providers ship things like
 * "EN | Sicario (2015) 4K", "[MULTI] Dune Part Two 2024", "VOD - Aladdin
 * (2019) 3D". Sent verbatim to TMDB most of these return nothing, so without
 * this the feature looks broken across half the library.
 *
 * Returns { query, year } — the year is separated out because TMDB takes it as
 * its own parameter, and it disambiguates remakes (there are four Aladdins).
 */
export function cleanTitle(raw) {
  let s = String(raw || '');

  // Leading provider/country/package tags, which stack ("PM : CA TCM").
  // Bounded loop so a pathological name can't spin.
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s
      .replace(/^\s*[[({|]\s*[A-Za-z0-9 .+-]{1,18}\s*[\])}|]\s*/, '')      // [US] (VIP) |AR|
      .replace(/^\s*(?:VOD|MOVIES?|SERIES|4K|UHD|HD|FHD|SD)\s*[-:|]\s*/i, '')
      .replace(/^\s*[A-Za-z]{2,6}\s*[:|]\s*/, '');                          // EN | , US:
    if (s === before) break;
  }

  // Year: prefer a parenthesised one, else the last bare 19xx/20xx.
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

  // Quality / release / language noise. Word-bounded so real titles survive —
  // "3 Days to Kill" keeps its 3, "Dual Survival" keeps its Dual.
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

// --------------------------------------------------------------------------
// TMDB plumbing
// --------------------------------------------------------------------------
async function call(token, endpoint, params = {}) {
  const url = new URL(TMDB + endpoint);
  for (const [k, v] of Object.entries(params)) {
    if (v !== '' && v != null) url.searchParams.set(k, v);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: ctrl.signal
    });
    if (!res.ok) {
      // Cancel the body before throwing. An unread response body leaves the
      // undici socket half-consumed, which is one of the ways Node 24 trips the
      // `assert(!this.paused)` parser assertion when the peer later closes.
      try { await res.body?.cancel(); } catch (e) {}
      const err = new Error(`TMDB replied ${res.status}${res.status === 401 ? ' (bad read token?)' : ''}`);
      err.status = res.status === 401 ? 401 : 502;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const img = (p, size) => (p ? `${IMG}/${size}${p}` : '');

/**
 * Best trailer for the poster-dwell preview: an official YouTube trailer beats
 * a fan upload, and a trailer beats a teaser. Non-YouTube sites are dropped —
 * the player embeds YouTube only, so a Vimeo key would just fail at playback.
 */
function pickTrailer(videos) {
  const all = (videos?.results || []).filter((v) => v.site === 'YouTube' && v.key);
  const score = (v) => (v.type === 'Trailer' ? 4 : v.type === 'Teaser' ? 2 : 0) + (v.official ? 1 : 0);
  const best = all.sort((a, b) => score(b) - score(a))[0];
  return best ? { key: best.key, name: best.name || '', type: best.type || '' } : null;
}

/**
 * Prefer an English or textless logo. TMDB returns every language's logo in
 * one array; unfiltered you get whichever was uploaded first, often not the
 * viewer's language.
 */
function pickLogo(images) {
  const logos = images?.logos || [];
  const pick = logos.find((l) => l.iso_639_1 === 'en') || logos.find((l) => !l.iso_639_1) || logos[0];
  return pick ? img(pick.file_path, 'w500') : '';
}

function normalize(type, d) {
  const isSeries = type === 'series';
  return {
    ok: true,
    tmdb_id: d.id,
    type,
    title: isSeries ? d.name : d.title,
    overview: d.overview || '',
    tagline: d.tagline || '',
    genres: (d.genres || []).map((g) => g.name),
    status: d.status || '',
    // created_by / networks are series-only in TMDB's model; both are always
    // present (empty for films) so the renderer never branches on type.
    created_by: (d.created_by || []).map((c) => c.name),
    networks: (d.networks || []).map((n) => ({ name: n.name, logo: img(n.logo_path, 'w185') })),
    director: (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name),
    seasons: isSeries ? d.number_of_seasons || 0 : 0,
    episodes: isSeries ? d.number_of_episodes || 0 : 0,
    release_date: (isSeries ? d.first_air_date : d.release_date) || '',
    runtime: isSeries ? d.episode_run_time?.[0] || 0 : d.runtime || 0,
    rating: typeof d.vote_average === 'number' ? Math.round(d.vote_average * 10) / 10 : 0,
    imdb_id: d.external_ids?.imdb_id || d.imdb_id || '',
    backdrop: img(d.backdrop_path, 'w1280'),
    poster: img(d.poster_path, 'w500'),
    logo: pickLogo(d.images),
    cast: (d.credits?.cast || []).slice(0, 20).map((c) => ({
      name: c.name,
      character: c.character || '',
      profile: img(c.profile_path, 'w185')
    })),
    trailer: pickTrailer(d.videos)
  };
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------
/**
 * Look a title up, cache-first.
 *
 * `tmdbId` short-circuits the search entirely — many Xtream providers already
 * carry a tmdb id in get_vod_info, which is both free and exact, so the caller
 * should always pass it when present.
 *
 * Never throws for "not found"; returns { ok: false, reason } so the caller can
 * fall back to provider data without a try/catch. Upstream failures DO throw,
 * because those shouldn't be cached as a miss.
 */
export async function lookup({ type = 'movie', title = '', year = '', tmdbId = '' }) {
  const token = tmdbToken();
  if (!token) {
    const err = new Error('TMDB token not configured.');
    err.status = 503;
    throw err;
  }

  const kind = type === 'series' ? 'series' : 'movie';
  const seg = kind === 'series' ? 'tv' : 'movie';
  const key = tmdbId
    ? `${kind}:id:${tmdbId}`
    : `${kind}:q:${String(title).toLowerCase().trim()}:${year || ''}`;

  const db = loadStore();
  const cached = db[key];
  if (cached && Date.now() - cached.at < (cached.data.ok ? TTL_HIT : TTL_MISS)) {
    return cached.data;
  }

  const remember = (data) => {
    db[key] = { at: Date.now(), data };
    saveStoreSoon();
    return data;
  };

  let id = tmdbId;

  if (!id) {
    const cleaned = cleanTitle(title);
    if (!cleaned.query) return remember({ ok: false, reason: 'unmatchable-title' });
    const search = await call(token, `/search/${seg}`, {
      query: cleaned.query,
      // TMDB names the year parameter differently per media type.
      [seg === 'tv' ? 'first_air_date_year' : 'year']: year || cleaned.year,
      include_adult: 'false'
    });
    const first = (search.results || [])[0];
    if (!first) return remember({ ok: false, reason: 'not-found', query: cleaned.query });
    id = first.id;
  }

  const detail = await call(token, `/${seg}/${id}`, {
    append_to_response: 'credits,videos,images,external_ids',
    // Logos are language-tagged; `null` keeps textless artwork in the running.
    include_image_language: 'en,null'
  });

  return remember(normalize(kind, detail));
}
