/* ZIPTV Pro TV page: served by the PC/phone app, opened in a TV browser.
   Targets Chromium 47+ (Tizen 3+, webOS 4+): arrows/let/template strings/fetch are fine;
   no async/await, no ?. / ??, no object spread. */
'use strict';
var HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js';
var MPEGTS_JS = 'https://cdn.jsdelivr.net/npm/mpegts.js@1.8.0/dist/mpegts.js';

var $ = (s, r) => (r || document).querySelector(s);
var main = $('#main');
var esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
var img = u => u ? `background-image:url('${String(u).replace(/'/g, '%27')}')` : '';
var api = (p, body) => fetch('/api/tv/' + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  .then(r => r.json());
var store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
var mins = ms => Math.max(1, Math.round(ms / 60000));
var hhmm = s => { var d = new Date(s * 1000); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
var clock = sec => { sec = Math.max(0, Math.floor(sec)); var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + s).slice(-2); };

var toastTimer;
function toast(msg) {
  var t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* ------------------------------------------------------------ focus (D-pad) */
function act(el, fn) { el._act = fn; el.addEventListener('click', () => fn(el)); return el; }
function focus(el) {
  if (!el) return;
  try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  reveal(el);
  if (el._onfocus) el._onfocus(el);
}
// Keep the focused element inside every clipping ancestor (overflow:hidden still scrolls by script).
function reveal(el) {
  var p = el.parentElement;
  while (p && p !== document.body) {
    if (p.scrollHeight > p.clientHeight + 2 || p.scrollWidth > p.clientWidth + 2) {
      var pr = p.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.top < pr.top + 24) p.scrollTop -= pr.top + 24 - r.top;
      else if (r.bottom > pr.bottom - 24) p.scrollTop += r.bottom - pr.bottom + 24;
      if (r.left < pr.left + 12) p.scrollLeft -= pr.left + 12 - r.left;
      else if (r.right > pr.right - 12) p.scrollLeft += r.right - pr.right + 12;
    }
    p = p.parentElement;
  }
}
function focusables() {
  var scope = playerOpen() ? $('#osd') : document;
  return [].slice.call(scope.querySelectorAll('.f')).filter(e => e.offsetParent !== null);
}
function move(dir) {
  var cur = document.activeElement, all = focusables();
  if (!cur || all.indexOf(cur) < 0) return focus(all[0]);
  var r = cur.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, best = null, bestScore = 1e9;
  all.forEach(e => {
    if (e === cur) return;
    var q = e.getBoundingClientRect(), ex = q.left + q.width / 2, ey = q.top + q.height / 2, gap, off;
    if (dir === 'left') { if (q.right > r.left + 2) return; gap = r.left - q.right; off = Math.abs(ey - cy); }
    else if (dir === 'right') { if (q.left < r.right - 2) return; gap = q.left - r.right; off = Math.abs(ey - cy); }
    else if (dir === 'up') { if (q.bottom > r.top + 2) return; gap = r.top - q.bottom; off = Math.abs(ex - cx); }
    else { if (q.top < r.bottom - 2) return; gap = q.top - r.bottom; off = Math.abs(ex - cx); }
    var score = gap + off * (dir === 'left' || dir === 'right' ? 3 : 1.2);
    if (score < bestScore) { bestScore = score; best = e; }
  });
  if (best) focus(best);
  else if (dir === 'left' && !playerOpen()) focus($('.nav.on') || $('.nav'));
}

/* ------------------------------------------------------------ views + back stack */
var stack = [], current = null;
function go(view, push) {
  if (push !== false && current) stack.push(current);
  current = view;
  main.innerHTML = '';
  view();
}
function back() {
  if (playerOpen()) return closePlayer();
  if (stack.length) { current = stack.pop(); main.innerHTML = ''; current(); return; }
  focus($('.nav.on'));
}
function setNav(name) {
  [].forEach.call(document.querySelectorAll('.nav'), n => n.classList.toggle('on', n.dataset.view === name));
}
function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }

function card(item, opts) {
  opts = opts || {};
  var el = h(`<div class="card f ${opts.wide ? 'wide' : ''} ${opts.chan ? 'chan-card' : ''}" tabindex="0">
    <div class="art" style="${img(item.poster || item.logo || item.image)}">${opts.progress != null ? `<div class="bar"><i style="width:${Math.round(opts.progress * 100)}%"></i></div>` : ''}</div>
    <div class="t">${esc(item.name || item.title)}</div>${opts.sub ? `<div class="s">${esc(opts.sub)}</div>` : ''}</div>`);
  return act(el, opts.onClick);
}
function row(title, items, make) {
  if (!items || !items.length) return null;
  var sec = h(`<section><h2>${esc(title)}</h2><div class="row"></div></section>`);
  var r = $('.row', sec);
  items.forEach(i => r.appendChild(make(i)));
  return sec;
}

/* Home */
function viewHome() {
  setNav('home');
  var wrap = h('<div class="scroll"><h1>Home</h1></div>');
  main.appendChild(wrap);
  api('home').then(d => {
    var secs = [
      row('Continue watching', d.continue, p => card({ name: p.title, image: p.image }, { wide: true, progress: p.duration_ms ? p.position_ms / p.duration_ms : 0,
        sub: p.kind === 'Movie' ? mins(p.duration_ms - p.position_ms) + ' min left' : cleanTitle(p.subtitle, p.title.split(' · ')[0], '') + '  ·  ' + mins(p.duration_ms - p.position_ms) + ' min left',
        onClick: () => playProgress(p) })),
      row('Favorite channels', d.favorites, c => card(c, { chan: true, onClick: () => playLive([c], 0) })),
      row('Recently watched', d.recent, c => card(c, { chan: true, onClick: () => playLive(d.recent, d.recent.indexOf(c)) })),
      row('Recently added movies', d.movies, m => card(m, { sub: m.year, onClick: () => go(() => viewMovie(m)) })),
      row('Recently added series', d.series, s => card(s, { sub: s.year, onClick: () => go(() => viewSeries(s)) })),
    ].filter(Boolean);
    if (!secs.length) wrap.appendChild(h('<div class="empty">Start watching on the PC or here and your shows will appear.</div>'));
    secs.forEach(s => wrap.appendChild(s));
    focus($('.f', wrap));
  }).catch(() => wrap.appendChild(h('<div class="empty">Can\'t reach ZIPTV Pro on the PC. Is the app open?</div>')));
}

/* Live: categories | channels (remembers the last category) */
function viewLive() {
  setNav('live');
  var wrap = h('<div style="height:100%"><h1>Live TV</h1><div class="cols"><div class="col cats"></div><div class="col chans"></div></div></div>');
  main.appendChild(wrap);
  var cats = $('.cats', wrap), chans = $('.chans', wrap);
  var loadChannels = (cat, focusFirst) => {
    store.set('tv_cat', cat);
    [].forEach.call(cats.children, c => c.classList.toggle('on', c.dataset.id === cat));
    chans.innerHTML = '';
    chans.scrollTop = 0;
    var list = [];
    var page = offset => api(`channels?cat=${encodeURIComponent(cat)}&offset=${offset}&limit=60`).then(d => {
      d.items.forEach(c => {
        var i = list.length; list.push(c);
        var el = h(`<div class="row-item ch f" tabindex="0"><div class="logo" style="${img(c.logo)}"></div>
          <div class="nm">${esc(c.name)}</div><div class="now">${esc(c.now || '')}</div></div>`);
        act(el, () => playLive(list, i));
        // Near the end of what's loaded: fetch the next page.
        if (i === list.length - 1 && list.length < d.total) el._onfocus = () => { el._onfocus = null; page(list.length); };
        chans.appendChild(el);
      });
      if (!list.length) chans.appendChild(h('<div class="empty">No channels here.</div>'));
      // "On now" arrives separately so the list never waits on the guide download.
      var ids = d.items.map(c => c.id);
      if (ids.length) api('nows?ids=' + ids.map(encodeURIComponent).join(',')).then(nows => {
        [].forEach.call(chans.querySelectorAll('.ch'), (el, k) => { var c = list[k]; if (c && nows[c.id]) $('.now', el).textContent = nows[c.id]; });
      });
      if (focusFirst && offset === 0) focus($('.f', chans));
    });
    page(0);
  };
  api('categories').then(list => {
    var all = [{ id: '', name: 'All channels', count: '' }].concat(list);
    all.forEach(c => {
      var el = h(`<div class="row-item cat f" data-id="${esc(c.id)}" tabindex="0"><span class="n">${esc(c.count)}</span>${esc(c.name)}</div>`);
      act(el, () => loadChannels(c.id, true));
      cats.appendChild(el);
    });
    var saved = store.get('tv_cat') || '';
    var start = [].filter.call(cats.children, c => c.dataset.id === saved)[0] || cats.firstElementChild;
    loadChannels(start.dataset.id, false);
    focus(start);
  });
}

/* Movies / Series grids (paged) */
function viewGrid(kind) {
  setNav(kind);
  var wrap = h(`<div style="height:100%"><h1>${kind === 'movies' ? 'Movies' : 'Series'}</h1><div class="grid"></div></div>`);
  main.appendChild(wrap);
  var grid = $('.grid', wrap), n = 0;
  var page = offset => api(`${kind}?offset=${offset}&limit=48`).then(d => {
    d.items.forEach((it, k) => {
      n++;
      var el = card(it, { sub: [it.year, it.rating > 0 ? '★ ' + it.rating.toFixed(1) : ''].filter(Boolean).join('  ·  '),
        onClick: () => go(() => kind === 'movies' ? viewMovie(it) : viewSeries(it)) });
      if (k === d.items.length - 6 && n < d.total) el._onfocus = () => { el._onfocus = null; page(n); };
      grid.appendChild(el);
    });
    if (offset === 0) focus($('.f', grid));
  });
  page(0);
}

function viewMovie(m) {
  setNav('movies');
  var key = 'movie:' + m.id;
  api('progress?key=' + encodeURIComponent(key)).then(p => {
    var wrap = h(`<div class="detail"><div class="poster" style="${img(m.poster)}"></div><h1>${esc(m.name)}</h1>
      <div class="meta">${esc([m.year, m.rating > 0 ? '★ ' + m.rating.toFixed(1) : ''].filter(Boolean).join('  ·  '))}</div><div class="btns"></div></div>`);
    var btns = $('.btns', wrap);
    var vod = { kind: 'movie', id: m.id, ext: m.ext || 'mp4', title: m.name, subtitle: m.year || 'Movie', image: m.poster, key: key, contentKind: 'Movie' };
    if (p && p.position_ms > 5000) {
      btns.appendChild(act(h(`<a class="btn primary f" tabindex="0">Resume ${clock(p.position_ms / 1000)}</a>`), () => playVod(vod, p.position_ms)));
      btns.appendChild(act(h('<a class="btn f" tabindex="0">Start over</a>'), () => playVod(vod, 0)));
    } else btns.appendChild(act(h('<a class="btn primary f" tabindex="0">Play</a>'), () => playVod(vod, 0)));
    main.innerHTML = ''; main.appendChild(wrap); focus($('.f', btns));
  });
}

function viewSeries(s) {
  setNav('series');
  var wrap = h(`<div class="scroll"><div class="detail" style="overflow:hidden"><div class="poster" style="${img(s.poster)};height:15rem;width:10rem"></div>
    <h1>${esc(s.name)}</h1><div class="meta">${esc(s.year || '')}</div><div class="seasons"></div></div><div class="eps"></div></div>`);
  main.appendChild(wrap);
  var seasonsEl = $('.seasons', wrap), epsEl = $('.eps', wrap);
  api('episodes?id=' + encodeURIComponent(s.id)).then(eps => {
    if (eps.error || !eps.length) { epsEl.appendChild(h('<div class="empty">No episodes found.</div>')); return; }
    var seasons = []; eps.forEach(e => { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); }); seasons.sort((a, b) => a - b);
    // Open on the season being watched.
    var watched = eps.filter(e => e.progress).pop();
    var show = season => {
      [].forEach.call(seasonsEl.children, c => c.classList.toggle('on', +c.dataset.s === season));
      epsEl.innerHTML = '';
      var list = eps.filter(e => e.season === season);
      list.forEach((e, i) => {
        var name = cleanTitle(e.title, s.name, e.number);
        var pr = e.progress && e.progress.dur ? e.progress.pos / e.progress.dur : null;
        var meta = ['E' + e.number, e.duration ? Math.round(e.duration / 60) + ' min' : '', pr != null ? (pr > 0.92 ? 'Watched' : mins(e.progress.dur - e.progress.pos) + ' min left') : '']
          .filter(Boolean).join('  ·  ');
        var el = h(`<div class="ep f" tabindex="0"><div class="still" style="${img(e.image || s.poster)}">${pr != null ? `<div class="bar"><i style="width:${Math.round(pr * 100)}%"></i></div>` : ''}</div>
          <div class="et">${esc(name)}</div><div class="em">${esc(meta)}</div><div class="ed">${esc(e.plot)}</div></div>`);
        var vod = ep => ({ kind: 'series', id: ep.id, ext: ep.ext || 'mp4', title: s.name + ' · S' + ep.season + 'E' + ep.number, subtitle: cleanTitle(ep.title, s.name, ep.number),
          image: ep.image || s.poster, key: 'episode:' + ep.id, contentKind: 'Series', seriesId: s.id });
        act(el, () => playVod(vod(e), pr != null && pr < 0.92 ? e.progress.pos : 0, idx => list[i + 1 + idx] ? vod(list[i + 1 + idx]) : null));
        epsEl.appendChild(el);
      });
    };
    seasons.forEach(n => seasonsEl.appendChild(act(h(`<a class="chip f" data-s="${n}" tabindex="0">Season ${n}</a>`), () => show(n))));
    var first = watched ? watched.season : seasons[0];
    show(first);
    focus($(`.chip[data-s="${first}"]`, seasonsEl));
  });
}
function cleanTitle(raw, show, n) {
  var t = String(raw || '').trim();
  if (t.toLowerCase().indexOf(String(show).toLowerCase()) === 0) t = t.slice(show.length);
  t = t.replace(/^[\s\-:|.]*S\d{1,3}\s*E\d{1,4}[\s\-:|.]*/i, '').replace(/^[\s\-:|.]+|[\s\-:|.]+$/g, '');
  return t || 'Episode ' + n;
}

function viewSearch() {
  setNav('search');
  var wrap = h('<div class="scroll"><h1>Search</h1><input class="search-box f" placeholder="Channels, movies, series" tabindex="0"><div class="res"></div></div>');
  main.appendChild(wrap);
  var input = $('input', wrap), res = $('.res', wrap), timer;
  var run = () => api('search?q=' + encodeURIComponent(input.value)).then(r => {
    res.innerHTML = '';
    [row('Channels', r.channels, c => card(c, { chan: true, onClick: () => playLive(r.channels, r.channels.indexOf(c)) })),
     row('Movies', r.movies, m => card(m, { sub: m.year, onClick: () => go(() => viewMovie(m)) })),
     row('Series', r.series, s => card(s, { sub: s.year, onClick: () => go(() => viewSeries(s)) }))]
      .filter(Boolean).forEach(s => res.appendChild(s));
    if (!res.children.length && input.value.length > 1) res.appendChild(h('<div class="empty">Nothing found.</div>'));
  });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  input._act = () => run();
  focus(input);
}

function viewRecordings() {
  setNav('recordings');
  var wrap = h('<div class="scroll"><h1>Recordings</h1><div class="muted" style="margin-bottom:1rem">Recordings are saved on the PC running ZIPTV Pro.</div><div class="list"></div></div>');
  main.appendChild(wrap);
  var list = $('.list', wrap);
  api('recordings').then(recs => {
    if (!recs.length) list.appendChild(h('<div class="empty">No recordings yet. Open a live channel and choose Record.</div>'));
    recs.sort((a, b) => b.start - a.start).forEach(r => {
      var running = r.status === 'Recording' || r.status === 'Scheduled';
      var el = h(`<div class="rec f" tabindex="0"><span class="st ${running ? 'live' : ''}">${running ? (r.status === 'Recording' ? 'REC · until ' + hhmm(r.end) : 'Scheduled ' + hhmm(r.start)) : esc(r.status)}</span>
        <b>${esc(r.title)}</b> <span class="muted">${esc(r.channel)}</span></div>`);
      act(el, () => {
        if (running) api('stop-recording?id=' + encodeURIComponent(r.id)).then(() => { toast('Recording stopped'); go(viewRecordings, false); });
        else if (r.status === 'Done') playUrl('/rec/' + encodeURIComponent(r.id), { title: r.title, subtitle: r.channel });
      });
      list.appendChild(el);
    });
    focus($('.f', list));
  });
}

/* ------------------------------------------------------------ player */
var video = $('#video'), engine = null, live = null, vodItem = null, nextOf = null, saveTimer = null, osdTimer = null;
function playerOpen() { return !$('#player').classList.contains('hidden'); }
function spinner(on) { $('#spinner').classList.toggle('hidden', !on); }
function loadScript(src, cb) {
  if (loadScript[src]) return cb();
  var s = document.createElement('script'); s.src = src;
  s.onload = () => { loadScript[src] = true; cb(); }; s.onerror = () => cb(new Error('load'));
  document.head.appendChild(s);
}
function teardown() {
  if (engine) { try { engine.destroy(); } catch (e) {} engine = null; }
  video.removeAttribute('src'); try { video.load(); } catch (e) {}
}
function open() { $('#player').classList.remove('hidden'); spinner(true); }
video.addEventListener('playing', () => spinner(false));
video.addEventListener('waiting', () => spinner(true));

function startTs(url) {
  // Raw MPEG-TS: mpegts.js over MSE, else hand it to the TV's own player.
  if (window.MediaSource) loadScript(MPEGTS_JS, err => {
    if (err || !window.mpegts || !mpegts.isSupported()) { video.src = url; video.play(); return; }
    engine = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: url }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
    engine.attachMediaElement(video); engine.load(); video.play();
  });
  else { video.src = url; video.play(); }
}
function startLive(c) {
  teardown();
  var id = encodeURIComponent(c.id), m3u8 = '/cast/live/' + id + '.m3u8', ts = '/cast/live/' + id + '.ts';
  api('watched?id=' + id);
  if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = m3u8; video.play(); return; } // Tizen/webOS native HLS
  if (!window.MediaSource) return startTs(ts);
  loadScript(HLS_JS, err => {
    if (err || !window.Hls || !Hls.isSupported()) return startTs(ts);
    engine = new Hls({ lowLatencyMode: false });
    engine.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) { teardown(); startTs(ts); } });
    engine.loadSource(m3u8); engine.attachMedia(video); video.play();
  });
}
function playLive(list, i) {
  vodItem = null; nextOf = null;
  live = { list: list, i: i };
  open(); startLive(list[i]); showOsd();
}
function zap(d) {
  if (!live) return;
  live.i = (live.i + d + live.list.length) % live.list.length;
  spinner(true); startLive(live.list[live.i]); showOsd();
}

function playVod(item, fromMs, next) {
  live = null; vodItem = item; nextOf = next || null;
  open(); teardown();
  video.src = `/cast/${item.kind}/${encodeURIComponent(item.id)}.${item.ext}`;
  var seek = () => { video.removeEventListener('loadedmetadata', seek); if (fromMs > 5000) video.currentTime = fromMs / 1000; video.play(); };
  video.addEventListener('loadedmetadata', seek);
  clearInterval(saveTimer); saveTimer = setInterval(saveProgress, 15000);
  showOsd();
}
function playProgress(p) {
  playVod({ kind: p.kind === 'Movie' ? 'movie' : 'series', id: p.stream_id, ext: p.extension || 'mp4', title: p.title, subtitle: p.subtitle, image: p.image,
    key: p.key, contentKind: p.kind, seriesId: p.series_id }, p.position_ms);
}
function playUrl(url, meta) {
  live = null; vodItem = null; nextOf = null;
  open(); teardown(); video.src = url; video.play(); osdText(meta.title, meta.subtitle);
}
function saveProgress() {
  if (!vodItem || !video.duration || !isFinite(video.duration) || video.currentTime < 5) return;
  api('save-progress', { key: vodItem.key, kind: vodItem.contentKind, title: vodItem.title, subtitle: vodItem.subtitle, image: vodItem.image,
    stream_id: vodItem.id, extension: vodItem.ext, series_id: vodItem.seriesId || null,
    position_ms: Math.round(video.currentTime * 1000), duration_ms: Math.round(video.duration * 1000), updated_at: Math.floor(Date.now() / 1000) });
}
video.addEventListener('ended', () => {
  saveProgress();
  var n = nextOf ? nextOf(0) : null;
  if (n) { var after = nextOf; playVod(n, 0, idx => after(idx + 1)); toast('Up next: ' + n.subtitle); }
  else if (vodItem) closePlayer();
});
function closePlayer() {
  saveProgress(); clearInterval(saveTimer); teardown();
  $('#player').classList.add('hidden'); $('#osd').classList.add('hidden');
  live = null; vodItem = null;
  if (current) { main.innerHTML = ''; current(); }
}

function osdText(title, sub) {
  var o = $('#osd'); o.innerHTML = `<div class="ot">${esc(title)}</div><div class="os">${esc(sub || '')}</div>`; o.classList.remove('hidden');
  clearTimeout(osdTimer); osdTimer = setTimeout(() => o.classList.add('hidden'), 5000);
}
// Live: channel + now/next + Record / Favorite. VOD: title + seek bar + play/pause.
function showOsd() {
  var o = $('#osd');
  clearTimeout(osdTimer);
  if (live) {
    var c = live.list[live.i];
    o.innerHTML = `<div class="ot"><span class="badge">LIVE</span>${esc(c.name)}</div><div class="os">&nbsp;</div><div class="btns"></div>`;
    api('epg?id=' + encodeURIComponent(c.id)).then(e => {
      if (!e.length) return;
      $('.os', o).textContent = `${hhmm(e[0].start)} - ${hhmm(e[0].end)}  ${e[0].title}` + (e[1] ? `   ·   Next: ${e[1].title}` : '');
    });
    var b = $('.btns', o);
    b.appendChild(act(h('<a class="btn f" tabindex="0">Record on PC</a>'), () => api('record?id=' + encodeURIComponent(c.id)).then(r => {
      toast(r.error ? r.error : `Recording "${r.title}" on the PC until ${hhmm(r.until)}`);
    })));
    b.appendChild(act(h('<a class="btn f" tabindex="0">Favorite</a>'), () => api('favorite?id=' + encodeURIComponent(c.id)).then(r => toast(r.on ? 'Added to favorites' : 'Removed from favorites'))));
    b.appendChild(act(h('<a class="btn f" tabindex="0">Close</a>'), closePlayer));
  } else if (vodItem) {
    var d = video.duration || 0, t = video.currentTime || 0;
    o.innerHTML = `<div class="ot">${esc(vodItem.title)}</div><div class="os">${esc(vodItem.subtitle || '')}<span class="time">${clock(t)} / ${clock(d)}</span></div>
      <div class="seek"><i style="width:${d ? Math.round(t / d * 100) : 0}%"></i></div>`;
  }
  o.classList.remove('hidden');
  osdTimer = setTimeout(() => o.classList.add('hidden'), 6000);
}

/* ------------------------------------------------------------ keys */
var KEY = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 8: 'back', 27: 'back', 10009: 'back', 461: 'back',
  415: 'play', 19: 'pause', 10252: 'playpause', 179: 'playpause', 413: 'stop', 427: 'chup', 428: 'chdown', 33: 'chup', 34: 'chdown' };
document.addEventListener('keydown', e => {
  var k = KEY[e.keyCode]; if (!k) return;
  var a = document.activeElement;
  if (a && a.tagName === 'INPUT' && (k === 'left' || k === 'right' || (k === 'back' && e.keyCode === 8 && a.value))) return;
  e.preventDefault();
  if (playerOpen()) {
    var osdOpen = !$('#osd').classList.contains('hidden');
    if (k === 'back') { if (osdOpen && live) { $('#osd').classList.add('hidden'); return; } return closePlayer(); }
    if (k === 'stop') return closePlayer();
    if (k === 'playpause' || k === 'play' || k === 'pause' || (k === 'ok' && vodItem)) { video.paused ? video.play() : video.pause(); return showOsd(); }
    if (live) {
      if (k === 'chup' || (k === 'up' && !osdOpen)) return zap(-1);
      if (k === 'chdown' || (k === 'down' && !osdOpen)) return zap(1);
      if (k === 'ok' && !osdOpen) { showOsd(); return focus($('#osd .f')); }
      if (osdOpen && (k === 'left' || k === 'right')) return move(k);
      if (k === 'ok' && a && a._act) return a._act(a);
      return;
    }
    if (vodItem && (k === 'left' || k === 'right')) { video.currentTime = Math.max(0, video.currentTime + (k === 'left' ? -10 : 30)); return showOsd(); }
    return showOsd();
  }
  if (k === 'back') return back();
  if (k === 'ok') { if (a && a._act) a._act(a); return; }
  if (k === 'left' || k === 'right' || k === 'up' || k === 'down') move(k);
});

/* ------------------------------------------------------------ boot */
var views = { home: viewHome, live: viewLive, movies: () => viewGrid('movies'), series: () => viewGrid('series'), search: viewSearch, recordings: viewRecordings };
[].forEach.call(document.querySelectorAll('.nav'), n => act(n, () => { stack = []; current = null; go(views[n.dataset.view], false); }));
setInterval(function tick() { var d = new Date(); $('#clock').textContent = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); return tick; }(), 15000);
go(views[location.hash.slice(1)] || viewHome, false); // #live, #movies... open a view directly (TV bookmarks)
