// HOME DASHBOARD — the landing tab. Netflix-style rows over the user's own
// activity: hero (latest continue-watching item), last-watched channels,
// continue watching for movies + series, favorite channels, and fresh
// content from the playlist. Renders into #home-view; all playback/routing
// goes through handlers injected by main.js (no circular imports).
//
// D-pad: every tile is a .home-card inside a [data-hrow] row container —
// tv-navigation.js's 'home' zone walks rows (UP/DOWN) and cards (LEFT/RIGHT).

import { getStreams, getContinueWatching, proxifyImage, removeWatchProgress, removeSeriesWatchProgress, isCompleted } from './xtream-api.js';

let handlers = null; // { onPlayChannel, onResumeItem, onOpenMovie, onOpenSeries, onGoTab }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// Collapse series CW to one card per show (newest episode first — the list is
// already sorted by lastWatched).
function seriesCW() {
  const seen = new Set();
  return getContinueWatching('series').filter((it) => {
    const key = String(it.seriesId || it.seriesName || it.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- tile builders ----------------------------------------------------------
function posterTile({ img, title, sub, badge, pct, removeId, removeType, watched }) {
  return `
    <div class="home-poster${watched ? ' home-poster-watched' : ''}">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <div class="home-poster-shade"></div>
      ${badge ? `<span class="home-badge">${badge}</span>` : ''}
      ${removeId != null ? `<button class="home-cw-remove" data-remove-id="${esc(removeId)}" data-remove-type="${esc(removeType || '')}" title="Remove from Continue Watching" aria-label="Remove"><i data-lucide="x"></i></button>` : ''}
      ${watched ? '<div class="home-watch-again"><i data-lucide="rotate-ccw"></i><span>Watch again</span></div>' : '<div class="home-tile-play"><i data-lucide="play"></i></div>'}
      ${pct != null ? `<div class="home-progress"><div class="home-progress-fill" style="width:${pct}%"></div></div>` : ''}
    </div>
    <span class="home-tile-title">${esc(title)}</span>
    ${sub ? `<span class="home-tile-sub">${esc(sub)}</span>` : ''}`;
}

function channelTile(ch) {
  return `
    <div class="home-chtile">
      ${ch.stream_icon ? `<img src="${esc(proxifyImage(ch.stream_icon))}" alt="" loading="lazy" onerror="this.remove()">` : '<i data-lucide="tv"></i>'}
      <span class="home-badge home-badge-live">LIVE</span>
      <div class="home-tile-play"><i data-lucide="play"></i></div>
    </div>
    <span class="home-tile-title">${esc(ch.name)}</span>`;
}

function row({ title, icon, cards, wide = false }) {
  if (!cards.length) return '';
  return `
    <section class="home-row">
      <h3 class="home-row-title"><i data-lucide="${icon}"></i>${esc(title)}</h3>
      <div class="home-row-cards ${wide ? 'home-row-wide' : ''}" data-hrow>
        ${cards.join('')}
      </div>
    </section>`;
}

function card(cls, data, inner) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<div class="home-card ${cls}" tabindex="0" ${attrs}>${inner}</div>`;
}

// ---- hero -------------------------------------------------------------------
function heroHtml(cw, channels) {
  const it = cw[0];
  if (it) {
    const pct = (it.duration && it.position) ? Math.min(100, Math.round((it.position / it.duration) * 100)) : 0;
    const sub = it.type === 'series'
      ? `${esc(it.seriesName || it.name)} · ${esc(it.episodeLabel || 'Episode')}`
      : 'Movie';
    const backdropUrl = it.backdrop || it.logo || '';
    return `
      <div class="home-hero${backdropUrl ? ' home-hero-media' : ''}" data-hrow>
        ${backdropUrl ? `<img class="home-hero-backdrop" src="${esc(proxifyImage(backdropUrl))}" alt="" onerror="this.parentElement.classList.remove('home-hero-media')">` : ''}
        <div class="home-hero-scrim"></div>
        ${it.logo ? `<img class="home-hero-poster" src="${esc(proxifyImage(it.logo))}" alt="" onerror="this.remove()">` : ''}
        <div class="home-hero-info">
          <span class="home-hero-kicker">${greeting()} — pick up where you left off</span>
          <h2 class="home-hero-title">${esc(it.cardTitle || it.seriesName || it.name)}</h2>
          <span class="home-hero-sub">${sub} · ${fmtClock(it.position)} in</span>
          <div class="home-hero-progress"><div style="width:${pct}%"></div></div>
          <button class="home-card home-hero-btn" tabindex="0" data-act="resume" data-id="${esc(it.id)}">
            <i data-lucide="play"></i> Continue Watching
          </button>
        </div>
      </div>`;
  }
  const ch = channels[0];
  if (ch) {
    const art = ch.stream_icon || '';
    return `
      <div class="home-hero home-hero-live" data-hrow>
        ${art ? `<img class="home-hero-live-art" src="${esc(proxifyImage(art))}" alt="" onerror="this.remove()">` : ''}
        <div class="home-hero-scrim"></div>
        <div class="home-hero-info">
          <span class="home-badge home-badge-live home-hero-live-badge">LIVE</span>
          <span class="home-hero-kicker">${greeting()} — pick up where you left off</span>
          <h2 class="home-hero-title">${esc(ch.name)}</h2>
          <span class="home-hero-sub">Continue watching Live TV</span>
          <button class="home-card home-hero-btn" tabindex="0" data-act="channel" data-id="${esc(ch.stream_id)}">
            <i data-lucide="play"></i> Watch Live
          </button>
        </div>
      </div>`;
  }
  return `
    <div class="home-hero home-hero-empty" data-hrow>
      <div class="home-hero-info">
      <span class="home-hero-kicker">${greeting()}</span>
      <h2 class="home-hero-title">Welcome to ZIPTV Pro</h2>
      <span class="home-hero-sub">Start watching — everything you play shows up here.</span>
      <button class="home-card home-hero-btn" tabindex="0" data-act="gotab" data-id="live">
        <i data-lucide="tv"></i> Browse Live TV
      </button>
      </div>
    </div>`;
}

// ---- render -----------------------------------------------------------------
export async function renderHome(h) {
  handlers = h || handlers;
  const view = document.getElementById('home-view');
  if (!view) return;

  // Pull everything in parallel; each source fails soft to an empty list.
  const soft = (p) => p.then((r) => r.items || []).catch(() => []);
  const [recentCh, favCh, newMovies, newSeries] = await Promise.all([
    soft(getStreams({ type: 'live', categoryId: 'recently_viewed', page: 1, limit: 5 })),
    soft(getStreams({ type: 'live', categoryId: 'favorites', page: 1, limit: 12 })),
    soft(getStreams({ type: 'movies', categoryId: 'all', page: 1, limit: 12 })),
    soft(getStreams({ type: 'series', categoryId: 'all', page: 1, limit: 12 }))
  ]);
  const cwMovies = getContinueWatching('movie');
  const cwSeries = seriesCW();
  const cwAll = getContinueWatching(); // newest first, for the hero

  view.innerHTML = `
    <div class="home-scroll">
      ${heroHtml(cwAll, recentCh)}

      ${row({
        title: 'Recently Watched Channels', icon: 'tv', wide: true,
        cards: recentCh.map((ch) => card('home-card-live', { act: 'channel', id: ch.stream_id }, channelTile(ch)))
      })}

      ${row({
        title: 'Continue Watching · Movies', icon: 'film',
        cards: cwMovies.map((it) => card('home-card-cw', { act: 'resume', id: it.id }, posterTile({
          img: it.logo ? proxifyImage(it.logo) : '',
          title: it.cardTitle || it.name,
          sub: `Resume · ${fmtClock(it.position)}`,
          pct: (it.duration && it.position) ? Math.min(100, (it.position / it.duration) * 100) : 0,
          removeId: it.id,
          removeType: 'movie'
        })))
      })}

      ${row({
        title: 'Continue Watching · Series', icon: 'clapperboard',
        cards: cwSeries.map((it) => card('home-card-cw', { act: 'resume', id: it.id }, posterTile({
          img: it.logo ? proxifyImage(it.logo) : '',
          title: it.cardTitle || it.seriesName || it.name,
          sub: it.episodeLabel || 'Continue',
          pct: (it.duration && it.position) ? Math.min(100, (it.position / it.duration) * 100) : 0,
          removeId: it.seriesId || it.seriesName || it.id,
          removeType: 'series'
        })))
      })}

      ${row({
        title: 'Favorite Channels', icon: 'star', wide: true,
        cards: favCh.map((ch) => card('home-card-live', { act: 'channel', id: ch.stream_id }, channelTile(ch)))
      })}

      ${row({
        title: 'Recently Added · Movies', icon: 'sparkles',
        cards: newMovies.map((m) => card('home-card-vod', { act: 'movie', id: m.stream_id }, posterTile({
          img: m.stream_icon ? proxifyImage(m.stream_icon) : '',
          title: m.name,
          sub: m.rating ? `★ ${m.rating}` : '',
          watched: isCompleted(m.stream_id)
        })))
      })}

      ${row({
        title: 'Recently Added · Series', icon: 'sparkles',
        cards: newSeries.map((s) => card('home-card-vod', { act: 'series', id: s.series_id }, posterTile({
          img: s.cover ? proxifyImage(s.cover) : '',
          title: s.name,
          sub: s.rating ? `★ ${s.rating}` : ''
        })))
      })}
    </div>`;

  if (window.lucide) { try { window.lucide.createIcons(); } catch (e) {} }

  // One delegated click handler for every tile (hero button included).
  view.onclick = async (e) => {
    const removeBtn = e.target.closest('.home-cw-remove');
    if (removeBtn) {
      e.stopPropagation();
      const { removeId, removeType } = removeBtn.dataset;
      if (removeType === 'series') {
        removeSeriesWatchProgress(removeId);
      } else {
        removeWatchProgress(removeId);
      }
      await renderHome(handlers);
      return;
    }
    const el = e.target.closest('.home-card');
    if (!el || !handlers) return;
    const { act, id } = el.dataset;
    try {
      if (act === 'resume') {
        const item = getContinueWatching().find((i) => String(i.id) === String(id));
        if (item) await handlers.onResumeItem(item);
      } else if (act === 'channel') {
        const ch = recentCh.concat(favCh).find((c) => String(c.stream_id) === String(id));
        if (ch) await handlers.onPlayChannel(ch);
      } else if (act === 'movie') {
        const m = newMovies.find((x) => String(x.stream_id) === String(id));
        if (m) await handlers.onOpenMovie(m);
      } else if (act === 'series') {
        const s = newSeries.find((x) => String(x.series_id) === String(id));
        if (s) await handlers.onOpenSeries(s);
      } else if (act === 'gotab') {
        await handlers.onGoTab(id);
      }
    } catch (err) {
      console.error('Home tile action failed:', err);
    }
  };
}
