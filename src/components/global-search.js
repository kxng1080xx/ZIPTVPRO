/**
 * Global search overlay — searches Live, Movies and Series at once and shows
 * grouped results. Two input modes, chosen by the caller:
 *   - PC build (.exe / web with a keyboard): a real text field you type into.
 *   - APK / TV (D-pad): a button-style display backed by the shared on-screen
 *     keyboard (openSearchKeyboard), exactly like the per-view search buttons.
 *
 * The overlay is fully self-contained: it captures its own keydown events
 * (capture phase + stopImmediatePropagation) so the global TV navigation never
 * also reacts, mirroring tv-search.js. No new navigation zone needed.
 */

import { getStreams, proxifyImage } from './xtream-api.js';
import { openSearchKeyboard, closeSearchKeyboard } from './tv-search.js';

const PLACEHOLDER_SVG =
  "data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22150%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%221%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%222%22/></svg>";

const PER_TYPE_LIMIT = 24;
const MIN_QUERY = 2;

let gs = null;

function lucide(scope) {
  if (window.lucide) { try { window.lucide.createIcons({ scope }); } catch (e) {} }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Open the results overlay.
 *
 * @param {object} opts
 * @param {boolean} opts.tvInput  APK/TV: open the shared on-screen keyboard for
 *   input. When false (PC), the overlay is results-only — the header text field
 *   drives it through setGlobalSearchQuery().
 * @param {(type:'live'|'movies'|'series', item:object)=>void} opts.onPick
 */
export function openGlobalSearch({ tvInput = false, onPick } = {}) {
  if (gs) { gs.onPick = onPick || gs.onPick; return; }

  const overlay = document.createElement('div');
  overlay.className = 'gsearch-overlay';
  overlay.innerHTML = `
    <div class="gsearch-modal">
      <div class="gsearch-bar">
        <i data-lucide="search"></i>
        <button class="gsearch-display" type="button">${tvInput ? 'Tap to type…' : 'Search…'}</button>
        <button class="gsearch-close" title="Close"><i data-lucide="x"></i></button>
      </div>
      <div class="gsearch-body">
        <div class="gsearch-hint">Type at least ${MIN_QUERY} characters to search across everything.</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  gs = {
    overlay,
    onPick,
    tvInput,
    query: '',
    searchToken: 0,
    debounce: null,
    body: overlay.querySelector('.gsearch-body'),
    field: null,
    display: overlay.querySelector('.gsearch-display'),
  };

  overlay.querySelector('.gsearch-close').addEventListener('click', closeGlobalSearch);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGlobalSearch(); });

  if (tvInput) {
    const open = () => openSearchKeyboard({
      title: 'Search',
      initial: gs.query,
      onChange: (q) => { setQuery(q); },
      onClose: () => { focusFirstResult(); },
    });
    gs.display.addEventListener('click', open);
    open(); // open the keyboard immediately, like tapping the button
  } else {
    // PC: the bar echoes the query; clicking it returns focus to the header field.
    gs.display.addEventListener('click', () => {
      const hf = document.getElementById('global-search-input');
      if (hf) { try { hf.focus(); } catch (e) {} }
    });
  }

  document.addEventListener('keydown', gsKeyHandler, true);
  lucide(overlay);
}

/** Drive the overlay from an external input (the PC header field). Opens the
 *  overlay on first non-empty query and closes it when cleared. */
export function setGlobalSearchQuery(q, onPick) {
  const query = (q || '').trim();
  if (!query) { closeGlobalSearch(); return; }
  if (!gs) openGlobalSearch({ tvInput: false, onPick });
  setQuery(q);
}

export function isGlobalSearchOpen() { return !!gs; }

export function closeGlobalSearch() {
  if (!gs) return;
  document.removeEventListener('keydown', gsKeyHandler, true);
  clearTimeout(gs.debounce);
  closeSearchKeyboard();
  gs.overlay.remove();
  gs = null;
}

function setQuery(q) {
  if (!gs) return;
  gs.query = q || '';
  const empty = gs.tvInput ? 'Tap to type…' : 'Search…';
  if (gs.display) gs.display.textContent = gs.query || empty;
  runSearch(gs.query.trim());
}

async function runSearch(q) {
  if (!gs) return;
  if (q.length < MIN_QUERY) {
    gs.body.innerHTML = `<div class="gsearch-hint">Type at least ${MIN_QUERY} characters to search across everything.</div>`;
    return;
  }

  const token = ++gs.searchToken;
  gs.body.innerHTML = '<div class="gsearch-loading"><div class="spinner"></div></div>';

  const fetchType = (type) => getStreams({ type, categoryId: 'all', page: 1, limit: PER_TYPE_LIMIT, search: q })
    .then((r) => (r && Array.isArray(r.items) ? r.items : []))
    .catch(() => []);

  const [live, movies, series] = await Promise.all([
    fetchType('live'), fetchType('movies'), fetchType('series'),
  ]);

  if (!gs || token !== gs.searchToken) return; // a newer query superseded this one
  renderResults({ live, movies, series });
}

function renderResults({ live, movies, series }) {
  if (!gs) return;
  const total = live.length + movies.length + series.length;
  if (total === 0) {
    gs.body.innerHTML = `<div class="gsearch-hint">No matches for “${esc(gs.query.trim())}”.</div>`;
    return;
  }

  const group = (title, icon, items, type) => {
    if (!items.length) return '';
    const cards = items.map((it) => {
      const name = type === 'live' ? (it.name || 'Unknown') : (it.name || it.title || 'Unknown');
      const img = proxifyImage(it.stream_icon || it.cover || it.cover_big || '');
      const meta = type === 'live' ? '' : esc(it.year || it.releaseDate || '');
      return `
        <button class="gsearch-item" data-type="${type}" data-id="${esc(it.stream_id || it.series_id || '')}">
          <div class="gsearch-thumb ${type}">
            ${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${PLACEHOLDER_SVG}'">`
                  : `<i data-lucide="${type === 'live' ? 'tv' : type === 'movies' ? 'film' : 'clapperboard'}"></i>`}
          </div>
          <span class="gsearch-item-title">${esc(name)}</span>
          ${meta ? `<span class="gsearch-item-meta">${meta}</span>` : ''}
        </button>`;
    }).join('');
    return `
      <div class="gsearch-group">
        <div class="gsearch-group-title"><i data-lucide="${icon}"></i> ${title} <span>${items.length}</span></div>
        <div class="gsearch-grid">${cards}</div>
      </div>`;
  };

  gs.body.innerHTML =
    group('Live TV', 'tv', live, 'live') +
    group('Movies', 'film', movies, 'movies') +
    group('Series', 'clapperboard', series, 'series');

  // Stash the raw item objects on each button so the click handler can route
  // them without re-querying.
  const items = gs.body.querySelectorAll('.gsearch-item');
  const all = [...live.map(i => ['live', i]), ...movies.map(i => ['movies', i]), ...series.map(i => ['series', i])];
  items.forEach((btn, idx) => {
    const [type, item] = all[idx];
    btn.addEventListener('click', () => pick(type, item));
  });

  lucide(gs.body);
}

function pick(type, item) {
  if (!gs) return;
  const cb = gs.onPick;
  closeGlobalSearch();
  if (cb) cb(type, item);
}

function focusableItems() {
  return gs ? [...gs.overlay.querySelectorAll('.gsearch-item')] : [];
}

function moveFocus(delta) {
  const items = focusableItems();
  if (!items.length) return;
  const cur = items.findIndex((b) => b.classList.contains('gsearch-focused'));
  let next = cur + delta;
  if (next < 0) next = 0;
  if (next >= items.length) next = items.length - 1;
  items.forEach((b) => b.classList.remove('gsearch-focused'));
  const el = items[next];
  el.classList.add('gsearch-focused');
  try { el.focus({ preventScroll: false }); } catch (e) {}
  el.scrollIntoView({ block: 'nearest' });
}

function focusFirstResult() {
  const items = focusableItems();
  if (items.length) { moveFocus(-9999); items[0].classList.add('gsearch-focused'); try { items[0].focus(); } catch (e) {} }
}

// Arrow/Enter navigation over the result tiles. The PC text field keeps normal
// typing — we only intercept navigation keys, and let ArrowDown jump from the
// field into the results.
function gsKeyHandler(e) {
  if (!gs) return;
  const k = e.key;
  // The PC header field lives outside the overlay; while it has focus, only
  // Escape (close) and ArrowDown (jump into results) are intercepted.
  const inField = document.activeElement === document.getElementById('global-search-input');

  if (k === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation();
    closeGlobalSearch();
    return;
  }

  if (inField) {
    if (k === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); focusFirstResult(); }
    return; // all other keys type into the field
  }

  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(k)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (k === 'Enter' || k === ' ') {
    const el = gs.overlay.querySelector('.gsearch-item.gsearch-focused');
    if (el) el.click();
    return;
  }
  if (k === 'ArrowRight' || k === 'ArrowDown') moveFocus(1);
  else moveFocus(-1);
}
