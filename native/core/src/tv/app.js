/* ZIPTV Pro TV page: served by the PC/phone app, opened in a TV browser.
   Targets Chromium 47+ (Tizen 3+, webOS 4+): arrows/let/template strings/fetch are fine;
   no async/await, no ?. / ??, no object spread. Player engines are served by the app itself. */
'use strict';
var $ = (s, r) => (r || document).querySelector(s);
var $$ = (s, r) => [].slice.call((r || document).querySelectorAll(s));
var main = $('#main');
var esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
var api = (p, body) => fetch('/api/tv/' + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  .then(r => r.json());
var store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };
var mins = ms => Math.max(1, Math.round(ms / 60000));
var hhmm = s => { var d = new Date(s * 1000); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); };
var clock = sec => { sec = Math.max(0, Math.floor(sec || 0)); var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + s).slice(-2); };
// TMDB serves any size from the same path: posters at 342 px wide are plenty on a TV and ~6x lighter.
var sized = (u, w) => u ? String(u).replace(/\/t\/p\/[^/]+\//, '/t/p/' + w + '/') : u;
var h = html => { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
var join = a => a.filter(Boolean).join('   ·   ');

var toastTimer;
function toast(msg) {
  var old = $('#toast'), t = old.cloneNode(false); old.parentNode.replaceChild(t, old); // restart the enter animation
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
}

/* Images fade in once loaded instead of popping in line by line. */
function art(u, extra) {
  var el = h(`<div class="art ring ${extra || ''}"><div class="img"></div></div>`);
  if (u) {
    var im = new Image();
    im.onload = () => { var i = $('.img', el); i.style.backgroundImage = `url("${u.replace(/"/g, '%22')}")`; i.classList.add('in'); };
    im.src = u;
  }
  return el;
}
function bg(el, u) {
  if (!u) return;
  var im = new Image();
  im.onload = () => { el.style.backgroundImage = `url("${u.replace(/"/g, '%22')}")`; el.classList.add('in'); };
  im.src = u;
}

/* ------------------------------------------------------------ focus + tracks (D-pad) */
function act(el, fn) { el._act = fn; el.addEventListener('click', () => fn(el)); return el; }
function focus(el) {
  if (!el) return;
  try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  reveal(el);
  if (el._onfocus) el._onfocus(el);
}
// Lists move by transform on their .track (GPU, animated) so focus glides instead of jumping.
function reveal(el) {
  var t = el.parentElement;
  while (t && t !== document.body) {
    if (t.classList.contains('track') && t.parentElement.classList.contains('vp')) slide(t, el);
    t = t.parentElement;
  }
}
function slide(track, el) {
  var vp = track.parentElement, horiz = vp.classList.contains('h');
  var vr = vp.getBoundingClientRect(), tr = track.getBoundingClientRect(), er = el.getBoundingClientRect();
  var cur = track._o || 0, pad = horiz ? 16 : vr.height * 0.18;
  var rel = horiz ? er.left - tr.left : er.top - tr.top, size = horiz ? er.width : er.height, view = horiz ? vr.width : vr.height;
  var full = horiz ? track.scrollWidth : track.scrollHeight;
  var o = cur;
  if (rel + o < pad) o = pad - rel;
  else if (rel + size + o > view - pad) o = view - pad - rel - size;
  o = Math.min(0, Math.max(o, Math.min(0, view - full - (horiz ? 0 : 40))));
  if (o === cur) return;
  track._o = o;
  track.style.transform = horiz ? `translate3d(${o}px,0,0)` : `translate3d(0,${o}px,0)`;
}
function focusables() {
  var scope = playerOpen() ? $('#osd') : document;
  return $$('.f', scope).filter(e => e.offsetParent !== null);
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
    // Rows: stay in the row going sideways; going up/down prefer what's straight above/below.
    var score = gap + off * (dir === 'left' || dir === 'right' ? 4 : 0.6);
    if (score < bestScore) { bestScore = score; best = e; }
  });
  if (best) focus(best);
  else if (dir === 'left' && !playerOpen()) focus($('.nav.on') || $('.nav'));
}

/* ------------------------------------------------------------ views + back stack */
var stack = [], current = null;
function view(cls) { main.innerHTML = ''; var v = h(`<div class="view ${cls || ''}"></div>`); main.appendChild(v); return v; }
function go(fn, push) {
  if (push !== false && current) stack.push({ fn: current, focus: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null });
  current = fn; fn();
}
function back() {
  if (playerOpen()) return closePlayer();
  if (stack.length) {
    var prev = stack.pop(); current = prev.fn; prev.fn();
    if (prev.focus) setTimeout(() => focus($(`[data-k="${prev.focus}"]`)), 60); // land back where you were
    return;
  }
  focus($('.nav.on'));
}
function setNav(name) { $$('.nav').forEach(n => n.classList.toggle('on', n.dataset.view === name)); }

// One focusable card. opts: wide | chan | progress (0..1) | sub | key | onClick
function card(item, opts) {
  opts = opts || {};
  var el = h(`<div class="card f ${opts.wide ? 'wide' : ''} ${opts.chan ? 'chan' : ''}" tabindex="0" ${opts.key ? `data-k="${esc(opts.key)}"` : ''}></div>`);
  var a = art(opts.wide ? sized(item.backdrop || item.image || item.poster, 'w780') : opts.chan ? (item.logo || '') : sized(item.poster || item.image, 'w342'));
  if (opts.progress != null) a.appendChild(h(`<div class="bar"><i style="width:${Math.max(3, Math.round(opts.progress * 100))}%"></i></div>`));
  el.appendChild(a);
  el.appendChild(h(`<div class="t">${esc(item.name || item.title)}</div>`));
  if (opts.sub) el.appendChild(h(`<div class="s">${esc(opts.sub)}</div>`));
  return act(el, opts.onClick || (() => {}));
}
function row(title, items, make) {
  if (!items || !items.length) return null;
  var sec = h(`<section class="row"><h2>${esc(title)}</h2><div class="vp h"><div class="track"></div></div></section>`);
  var t = $('.track', sec);
  items.forEach((it, i) => t.appendChild(make(it, i)));
  return sec;
}
function skeletonRow(n, wide) {
  var sec = h('<section class="row"><h2>&nbsp;</h2><div class="vp h"><div class="track"></div></div></section>');
  for (var i = 0; i < n; i++) $('.track', sec).appendChild(h(`<div class="card skel ${wide ? 'wide' : ''}"><div class="art"></div></div>`));
  return sec;
}
// Full-screen vertical scroller: content inside a moving track.
function scroller(v) { var vp = h('<div class="vp v" style="height:100%"><div class="track"></div></div>'); v.appendChild(vp); return $('.track', vp); }

/* ------------------------------------------------------------ Home */
function viewHome() {
  setNav('home');
  var v = view(), t = scroller(v);
  var hero = h(`<div class="hero"><div class="bg"></div><div class="shade"></div><div class="copy"></div></div>`);
  var rows = h('<div class="rows"></div>');
  t.appendChild(hero); t.appendChild(rows);
  rows.appendChild(skeletonRow(5, true)); rows.appendChild(skeletonRow(8));
  api('home').then(d => {
    rows.innerHTML = '';
    var cont = d.continue || [];
    // Hero: what you were watching, else the newest movie.
    var top = cont[0], heroItem = top ? { title: top.kind === 'Series' ? top.title.split(' · ')[0] : top.title, kind: top.kind === 'Series' ? 'series' : 'movie', image: top.image }
      : d.movies[0] ? { title: d.movies[0].name, kind: 'movie', image: d.movies[0].poster, movie: d.movies[0] } : null;
    if (heroItem) {
      var copy = $('.copy', hero);
      copy.appendChild(h(`<div class="kicker">${top ? 'Continue watching' : 'New on ZIPTV'}</div>`));
      copy.appendChild(h(`<h1>${esc(cleanName(heroItem.title))}</h1>`));
      var metaEl = h('<div class="meta"></div>'), plot = h('<div class="plot"></div>');
      copy.appendChild(metaEl); copy.appendChild(plot);
      var btns = h('<div></div>'); copy.appendChild(btns);
      if (top) {
        metaEl.textContent = top.kind === 'Movie' ? mins(top.duration_ms - top.position_ms) + ' min left' : cleanTitle(top.subtitle, heroItem.title, '') + '   ·   ' + mins(top.duration_ms - top.position_ms) + ' min left';
        btns.appendChild(act(h('<a class="btn primary f" tabindex="0" data-k="hero-play">Resume</a>'), () => playProgress(top)));
      } else btns.appendChild(act(h('<a class="btn primary f" tabindex="0" data-k="hero-play">Play</a>'), () => go(() => viewDetail('movie', heroItem.movie))));
      api(`meta?kind=${heroItem.kind}&title=${encodeURIComponent(heroItem.title)}`).then(m => {
        bg($('.bg', hero), m && m.backdrop ? m.backdrop : sized(heroItem.image, 'w780'));
        if (m && m.overview) plot.textContent = m.overview;
      }).catch(() => bg($('.bg', hero), sized(heroItem.image, 'w780')));
    }
    [
      row('Continue watching', cont, (p, i) => card({ name: p.kind === 'Series' ? p.title.split(' · ')[0] : p.title, image: p.image }, { wide: true, key: 'cw' + i,
        progress: p.duration_ms ? p.position_ms / p.duration_ms : 0,
        sub: p.kind === 'Movie' ? mins(p.duration_ms - p.position_ms) + ' min left' : cleanTitle(p.subtitle, p.title.split(' · ')[0], ''), onClick: () => playProgress(p) })),
      row('Favorite channels', d.favorites, (c, i) => card(c, { chan: true, key: 'fav' + i, onClick: () => playLive(d.favorites, i) })),
      row('Recently watched channels', d.recent, (c, i) => card(c, { chan: true, key: 'rec' + i, onClick: () => playLive(d.recent, i) })),
      row('New movies', d.movies, (m, i) => card(m, { sub: m.year, key: 'nm' + i, onClick: () => go(() => viewDetail('movie', m)) })),
      row('New series', d.series, (s, i) => card(s, { sub: s.year, key: 'ns' + i, onClick: () => go(() => viewDetail('series', s)) })),
    ].filter(Boolean).forEach(s => rows.appendChild(s));
    if (!rows.children.length) rows.appendChild(h('<div class="empty">Start watching and your shows will appear here.</div>'));
    focus($('.f', v));
  }).catch(() => { rows.innerHTML = '<div class="empty">Can\'t reach ZIPTV Pro. Is the app open on your PC?</div>'; });
}

/* ------------------------------------------------------------ Live */
function viewLive() {
  setNav('live');
  var v = view();
  v.appendChild(h('<div class="live"><h1>Live TV</h1></div>'));
  var cols = h('<div class="cols"><div class="col cats vp v"><div class="track"></div></div><div class="col chans vp v"><div class="track"></div></div></div>');
  v.appendChild(cols);
  var cats = $('.cats .track', cols), chans = $('.chans .track', cols);
  var loadChannels = (cat, focusFirst) => {
    store.set('tv_cat', cat);
    $$('.cat', cats).forEach(c => c.classList.toggle('on', c.dataset.id === cat));
    chans.innerHTML = ''; chans._o = 0; chans.style.transform = '';
    var list = [];
    var page = offset => api(`channels?cat=${encodeURIComponent(cat)}&offset=${offset}&limit=60`).then(d => {
      var added = [];
      d.items.forEach(c => {
        var i = list.length; list.push(c);
        var el = h(`<div class="item ch f" tabindex="0" data-k="ch${esc(c.id)}"><div class="logo"></div><div class="nm">${esc(c.name)}</div><div class="now">&nbsp;</div></div>`);
        if (c.logo) bgLogo($('.logo', el), c.logo);
        act(el, () => playLive(list, i));
        if (i === list.length - 1 && list.length < d.total) el._onfocus = () => { el._onfocus = null; page(list.length); };
        chans.appendChild(el); added.push([el, c]);
      });
      if (!list.length) chans.appendChild(h('<div class="empty">No channels here.</div>'));
      // "On now" arrives separately so the list never waits on the guide download.
      if (added.length) api('nows?ids=' + added.map(a => encodeURIComponent(a[1].id)).join(',')).then(nows => {
        added.forEach(a => { if (nows[a[1].id]) $('.now', a[0]).textContent = nows[a[1].id]; });
      });
      if (focusFirst && offset === 0) focus($('.f', chans));
    });
    page(0);
  };
  api('categories').then(list => {
    [{ id: '', name: 'All channels', count: '' }].concat(list).forEach(c => {
      cats.appendChild(act(h(`<div class="item cat f" data-id="${esc(c.id)}" data-k="cat${esc(c.id)}" tabindex="0"><span class="n">${esc(c.count)}</span>${esc(c.name)}</div>`),
        () => loadChannels(c.id, true)));
    });
    var saved = store.get('tv_cat') || '';
    var start = $$('.cat', cats).filter(c => c.dataset.id === saved)[0] || $('.cat', cats);
    loadChannels(start.dataset.id, false);
    focus(start);
  });
}
function bgLogo(el, u) { var im = new Image(); im.onload = () => { el.style.backgroundImage = `url("${u.replace(/"/g, '%22')}")`; }; im.src = u; }

/* ------------------------------------------------------------ Movies / Series grids */
function viewGrid(kind) {
  setNav(kind);
  var v = view();
  v.appendChild(h(`<div class="pad"><h1>${kind === 'movies' ? 'Movies' : 'Series'}</h1></div>`));
  var vp = h('<div class="grid vp v"><div class="track"></div></div>'); v.appendChild(vp);
  var grid = $('.track', vp), n = 0;
  for (var i = 0; i < 14; i++) grid.appendChild(h('<div class="card skel"><div class="art"></div></div>'));
  var page = offset => api(`${kind}?offset=${offset}&limit=56`).then(d => {
    if (offset === 0) grid.innerHTML = '';
    d.items.forEach((it, k) => {
      n++;
      var el = card(it, { key: kind[0] + it.id, sub: join([it.year, it.rating > 0 ? '★ ' + it.rating.toFixed(1) : '']),
        onClick: () => go(() => viewDetail(kind === 'movies' ? 'movie' : 'series', it)) });
      if (k === d.items.length - 8 && n < d.total) el._onfocus = () => { el._onfocus = null; page(n); };
      grid.appendChild(el);
    });
    if (offset === 0) focus($('.f', grid));
  });
  page(0);
}

/* ------------------------------------------------------------ Details (movie / series) */
function viewDetail(kind, it) {
  setNav(kind === 'movie' ? 'movies' : 'series');
  var v = view('detail'), t = scroller(v);
  var hero = h(`<div class="hero"><div class="bg"></div><div class="shade"></div><div class="copy">
    <div class="kicker">${kind === 'movie' ? 'Movie' : 'Series'}</div><h1>${esc(cleanName(it.name))}</h1><div class="meta">${esc(join([it.year, it.rating > 0 ? '★ ' + it.rating.toFixed(1) : '']))}</div>
    <div class="plot"></div><div class="btns"></div></div></div>`);
  var below = h('<div class="rows"></div>');
  t.appendChild(hero); t.appendChild(below);
  var btns = $('.btns', hero);
  api(`meta?kind=${kind}&title=${encodeURIComponent(it.name)}&year=${encodeURIComponent(it.year || '')}`).then(m => {
    bg($('.bg', hero), m && m.backdrop ? m.backdrop : sized(it.poster, 'w780'));
    if (!m) return;
    $('.plot', hero).textContent = m.overview || '';
    $('.meta', hero).textContent = join([it.year || (m.release_date || '').slice(0, 4), m.runtime ? m.runtime + ' min' : '', m.seasons ? m.seasons + ' seasons' : '',
      (m.rating || it.rating) > 0 ? '★ ' + (m.rating || it.rating).toFixed(1) : '', (m.genres || []).slice(0, 3).join(', ')]);
    var cast = row('Cast', (m.cast || []).filter(c => c.profile).slice(0, 14), c => card({ name: c.name, poster: c.profile }, { sub: c.character }));
    if (cast) { cast.classList.add('cast'); below.appendChild(cast); }
  }).catch(() => bg($('.bg', hero), sized(it.poster, 'w780')));

  if (kind === 'movie') {
    var vod = { kind: 'movie', id: it.id, ext: it.ext || 'mp4', title: cleanName(it.name), subtitle: it.year || 'Movie', image: it.poster, key: 'movie:' + it.id, contentKind: 'Movie' };
    api('progress?key=' + encodeURIComponent(vod.key)).then(p => {
      if (p && p.position_ms > 5000 && p.position_ms < p.duration_ms * 0.95) {
        btns.appendChild(act(h(`<a class="btn primary f" tabindex="0">Resume  ${clock(p.position_ms / 1000)}</a>`), () => playVod(vod, p.position_ms)));
        btns.appendChild(act(h('<a class="btn f" tabindex="0">Start over</a>'), () => playVod(vod, 0)));
      } else btns.appendChild(act(h('<a class="btn primary f" tabindex="0">Play</a>'), () => playVod(vod, 0)));
      focus($('.f', btns));
    });
    return;
  }
  // Series: season chips + episodes, opening on the season being watched.
  var seasonsEl = h('<div style="margin-bottom:1.2rem"></div>'), epsEl = h('<div></div>');
  var sec = h('<section class="row"><h2>Episodes</h2></section>'); sec.appendChild(seasonsEl); sec.appendChild(epsEl);
  below.insertBefore(sec, below.firstChild);
  api('episodes?id=' + encodeURIComponent(it.id)).then(eps => {
    if (eps.error || !eps.length) { epsEl.appendChild(h('<div class="empty">No episodes found.</div>')); return; }
    var seasons = []; eps.forEach(e => { if (seasons.indexOf(e.season) < 0) seasons.push(e.season); }); seasons.sort((a, b) => a - b);
    var watched = eps.filter(e => e.progress).pop();
    var vod = ep => ({ kind: 'series', id: ep.id, ext: ep.ext || 'mp4', title: cleanName(it.name) + ' · S' + ep.season + 'E' + ep.number,
      subtitle: cleanTitle(ep.title, it.name, ep.number), image: ep.image || it.poster, key: 'episode:' + ep.id, contentKind: 'Series', seriesId: it.id });
    var show = season => {
      $$('.chip', seasonsEl).forEach(c => c.classList.toggle('on', +c.dataset.s === season));
      epsEl.innerHTML = '';
      var list = eps.filter(e => e.season === season);
      list.forEach((e, i) => {
        var pr = e.progress && e.progress.dur ? e.progress.pos / e.progress.dur : null;
        var meta = join(['E' + e.number, e.duration ? Math.round(e.duration / 60) + ' min' : '', pr != null ? (pr > 0.92 ? 'Watched' : mins(e.progress.dur - e.progress.pos) + ' min left') : '']);
        var el = h(`<div class="ep f" tabindex="0" data-k="ep${esc(e.id)}"><div class="still"></div><div class="et">${esc(cleanTitle(e.title, it.name, e.number))}</div>
          <div class="em">${esc(meta)}</div><div class="ed">${esc(e.plot)}</div></div>`);
        bg($('.still', el), sized(e.image || it.poster, 'w300'));
        if (pr != null) $('.still', el).appendChild(h(`<div class="bar"><i style="width:${Math.max(3, Math.round(pr * 100))}%"></i></div>`));
        act(el, () => playVod(vod(e), pr != null && pr < 0.92 ? e.progress.pos : 0, k => list[i + 1 + k] ? vod(list[i + 1 + k]) : null));
        epsEl.appendChild(el);
      });
    };
    seasons.forEach(n => seasonsEl.appendChild(act(h(`<a class="chip f" data-s="${n}" tabindex="0">Season ${n}</a>`), () => show(n))));
    var first = watched ? watched.season : seasons[0];
    show(first);
    var resume = watched && watched.progress.pos < watched.progress.dur * 0.92 ? watched : eps.filter(e => e.season === first)[0];
    btns.appendChild(act(h(`<a class="btn primary f" tabindex="0">${watched ? 'Continue S' + resume.season + 'E' + resume.number : 'Play S' + resume.season + 'E' + resume.number}</a>`),
      () => playVod(vod(resume), watched && resume === watched ? resume.progress.pos : 0)));
    focus($('.f', btns));
  });
}
function cleanName(n) { return String(n || '').replace(/\s*\(\d{4}\)\s*$/, '').trim() || n; }
function cleanTitle(raw, show, n) {
  var t = String(raw || '').trim();
  show = cleanName(show);
  if (show && t.toLowerCase().indexOf(String(show).toLowerCase()) === 0) t = t.slice(show.length);
  t = t.replace(/^[\s\-:|.]*S\d{1,3}\s*E\d{1,4}[\s\-:|.]*/i, '').replace(/^[\s\-:|.]+|[\s\-:|.]+$/g, '');
  return t || (n ? 'Episode ' + n : '');
}

/* ------------------------------------------------------------ Search / Recordings */
function viewSearch() {
  setNav('search');
  var v = view(), t = scroller(v);
  var pad = h('<div class="pad"><h1>Search</h1><input class="search-box f" placeholder="Channels, movies, series" tabindex="0"></div>');
  var res = h('<div class="rows"></div>');
  t.appendChild(pad); t.appendChild(res);
  var input = $('input', pad), timer;
  var run = () => api('search?q=' + encodeURIComponent(input.value)).then(r => {
    res.innerHTML = '';
    [row('Channels', r.channels, (c, i) => card(c, { chan: true, onClick: () => playLive(r.channels, i) })),
     row('Movies', r.movies, m => card(m, { sub: m.year, onClick: () => go(() => viewDetail('movie', m)) })),
     row('Series', r.series, s => card(s, { sub: s.year, onClick: () => go(() => viewDetail('series', s)) }))]
      .filter(Boolean).forEach(s => res.appendChild(s));
    if (!res.children.length && input.value.length > 1) res.appendChild(h('<div class="empty">Nothing found.</div>'));
  });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  input._act = () => run();
  focus(input);
}

function viewRecordings() {
  setNav('recordings');
  var v = view(), t = scroller(v);
  var pad = h('<div class="pad"><h1>Recordings</h1><div class="muted" style="margin:0.6rem 0 1.6rem">Saved on the PC running ZIPTV Pro. Start one from a live channel: OK, then Record.</div><div class="list"></div></div>');
  t.appendChild(pad);
  var list = $('.list', pad);
  api('recordings').then(recs => {
    if (!recs.length) list.appendChild(h('<div class="empty">No recordings yet.</div>'));
    recs.sort((a, b) => b.start - a.start).forEach(r => {
      var running = r.status === 'Recording' || r.status === 'Scheduled';
      var el = h(`<div class="rec f" tabindex="0"><span class="st ${running ? 'live' : ''}">${running ? (r.status === 'Recording' ? 'REC  until ' + hhmm(r.end) : 'Scheduled ' + hhmm(r.start)) : esc(r.status)}</span>
        <b>${esc(r.title)}</b>   <span class="muted">${esc(r.channel)}</span></div>`);
      act(el, () => {
        if (running) api('stop-recording?id=' + encodeURIComponent(r.id)).then(() => { toast('Recording stopped'); viewRecordings(); });
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
// Poster + title + spinner until the first frame, instead of a black screen.
function loading(title, image) {
  var l = $('#loading');
  l.classList.remove('out');
  l.style.backgroundImage = image ? `url("${String(image).replace(/"/g, '%22')}")` : '';
  $('.lt', l).textContent = title || '';
}
function open(title, image) { $('#player').classList.remove('hidden'); loading(title, image); }
video.addEventListener('playing', () => { $('#loading').classList.add('out'); });

function startHls(url) {
  if (video.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource) { video.src = url; video.play(); return; }
  loadScript('/tv/hls.js', err => {
    if (err || !window.Hls || !Hls.isSupported()) { video.src = url; video.play(); return; }
    engine = new Hls({ maxBufferLength: 12, backBufferLength: 10 });
    engine.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) { teardown(); toast('This channel isn\'t playing right now'); } });
    engine.loadSource(url); engine.attachMedia(video); video.play();
  });
}
// Live: MPEG-TS through the PC (first frame in ~1-2 s, survives provider session cuts);
// HLS only if this TV can't run mpegts.js.
function startLive(c) {
  teardown();
  var id = encodeURIComponent(c.id), ts = '/cast/live/' + id + '.ts', m3u8 = '/cast/live/' + id + '.m3u8';
  api('watched?id=' + id);
  if (!window.MediaSource) { if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = m3u8; video.play(); } else { video.src = ts; video.play(); } return; }
  loadScript('/tv/mpegts.js', err => {
    if (err || !window.mpegts || !mpegts.isSupported()) return startHls(m3u8);
    engine = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: ts },
      { enableStashBuffer: false, enableWorker: true, lazyLoad: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 4, liveBufferLatencyMinRemain: 1, autoCleanupSourceBuffer: true });
    engine.on(mpegts.Events.ERROR, () => { teardown(); startHls(m3u8); });
    engine.attachMediaElement(video); engine.load();
    var p = video.play(); if (p && p.catch) p.catch(() => {});
  });
}
function playLive(list, i) {
  vodItem = null; nextOf = null;
  live = { list: list, i: i };
  open(list[i].name, null); startLive(list[i]); showOsd();
}
function zap(d) {
  if (!live) return;
  live.i = (live.i + d + live.list.length) % live.list.length;
  loading(live.list[live.i].name, null); startLive(live.list[live.i]); showOsd();
}

function playVod(item, fromMs, next) {
  live = null; vodItem = item; nextOf = next || null;
  open(item.title, sized(item.image, 'w780')); teardown();
  video.src = `/cast/${item.kind}/${encodeURIComponent(item.id)}.${item.ext}`;
  var seek = () => { video.removeEventListener('loadedmetadata', seek); if (fromMs > 5000) video.currentTime = fromMs / 1000; var p = video.play(); if (p && p.catch) p.catch(() => {}); };
  video.addEventListener('loadedmetadata', seek);
  clearInterval(saveTimer); saveTimer = setInterval(saveProgress, 15000);
}
function playProgress(p) {
  playVod({ kind: p.kind === 'Movie' ? 'movie' : 'series', id: p.stream_id, ext: p.extension || 'mp4', title: p.title, subtitle: p.subtitle, image: p.image,
    key: p.key, contentKind: p.kind, seriesId: p.series_id }, p.position_ms);
}
function playUrl(url, meta) {
  live = null; vodItem = null; nextOf = null;
  open(meta.title, null); teardown(); video.src = url; video.play();
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
  if (n) { var after = nextOf; playVod(n, 0, k => after(k + 1)); toast('Up next: ' + n.subtitle); }
  else if (vodItem) closePlayer();
});
video.addEventListener('error', () => { if (vodItem) toast('This title can\'t play in the TV browser. Try casting it from the app instead.'); });
function closePlayer() {
  saveProgress(); clearInterval(saveTimer); teardown();
  $('#player').classList.add('hidden'); hideOsd();
  live = null; vodItem = null;
  if (current) {
    var k = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
    current();
    if (k) setTimeout(() => focus($(`[data-k="${k}"]`)), 80);
  }
}

function hideOsd() { $('#osd').classList.add('off'); }
// Live: channel + now/next + Record / Favorite. VOD: title, seek bar, time.
function showOsd() {
  var o = $('#osd');
  clearTimeout(osdTimer);
  if (live) {
    var c = live.list[live.i];
    o.innerHTML = `<div class="ot"><span class="badge">LIVE</span>${esc(c.name)}</div><div class="os">&nbsp;</div><div class="seek"><i style="width:0"></i></div><div class="btns"></div>`;
    api('epg?id=' + encodeURIComponent(c.id)).then(e => {
      if (!e.length) return;
      var now = Date.now() / 1000;
      $('.os', o).innerHTML = [['NOW', e[0]], ['NEXT', e[1]], ['LATER', e[2]]].filter(x => x[1])
        .map(x => `<span class="slot"><span class="tag">${x[0]}</span><span class="st"><span class="tm">${hhmm(x[1].start)} - ${hhmm(x[1].end)}</span>${esc(x[1].title)}</span></span>`).join('');
      $('.seek i', o).style.width = Math.min(100, Math.max(0, (now - e[0].start) / (e[0].end - e[0].start) * 100)) + '%';
    });
    var b = $('.btns', o);
    b.appendChild(act(h('<a class="btn primary f" tabindex="0">Record on PC</a>'), () => api('record?id=' + encodeURIComponent(c.id)).then(r => {
      toast(r.error ? r.error : `Recording "${r.title}" on the PC until ${hhmm(r.until)}`);
    })));
    b.appendChild(act(h('<a class="btn f" tabindex="0">Favorite</a>'), () => api('favorite?id=' + encodeURIComponent(c.id)).then(r => toast(r.on ? 'Added to favorites' : 'Removed from favorites'))));
    b.appendChild(act(h('<a class="btn f" tabindex="0">Close</a>'), closePlayer));
  } else if (vodItem) {
    var d = video.duration || 0, t = video.currentTime || 0;
    o.innerHTML = `<div class="ot">${esc(vodItem.title)}</div><div class="os">${esc(vodItem.subtitle || '')}<span class="time">${clock(t)} / ${clock(d)}</span></div>
      <div class="seek"><i style="width:${d ? (t / d * 100).toFixed(2) : 0}%"></i></div>`;
  }
  o.classList.remove('off');
  osdTimer = setTimeout(hideOsd, live ? 6000 : 3500);
}

/* ------------------------------------------------------------ keys */
var KEY = { 37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok', 8: 'back', 27: 'back', 10009: 'back', 461: 'back',
  415: 'play', 19: 'pause', 10252: 'playpause', 179: 'playpause', 413: 'stop', 427: 'chup', 428: 'chdown', 33: 'chup', 34: 'chdown',
  412: 'rew', 417: 'ff' };
document.addEventListener('keydown', e => {
  var k = KEY[e.keyCode]; if (!k) return;
  var a = document.activeElement;
  if (a && a.tagName === 'INPUT' && (k === 'left' || k === 'right' || (k === 'back' && e.keyCode === 8 && a.value))) return;
  e.preventDefault();
  if (playerOpen()) {
    var osdOpen = !$('#osd').classList.contains('off');
    if (k === 'back') { if (osdOpen && live) return hideOsd(); return closePlayer(); }
    if (k === 'stop') return closePlayer();
    if (k === 'playpause' || k === 'play' || k === 'pause' || (k === 'ok' && vodItem)) { video.paused ? video.play() : video.pause(); return showOsd(); }
    if (live) {
      if (k === 'chup' || (k === 'up' && !osdOpen)) return zap(-1);
      if (k === 'chdown' || (k === 'down' && !osdOpen)) return zap(1);
      if (k === 'ok' && !osdOpen) { showOsd(); return focus($('#osd .f')); }
      if (osdOpen && (k === 'left' || k === 'right')) { clearTimeout(osdTimer); osdTimer = setTimeout(hideOsd, 6000); return move(k); }
      if (k === 'ok' && a && a._act) return a._act(a);
      return;
    }
    if (vodItem && (k === 'left' || k === 'right' || k === 'rew' || k === 'ff')) {
      video.currentTime = Math.max(0, video.currentTime + (k === 'left' || k === 'rew' ? -10 : 30)); return showOsd();
    }
    return showOsd();
  }
  if (k === 'back') return back();
  if (k === 'ok') { if (a && a._act) a._act(a); return; }
  if (k === 'left' || k === 'right' || k === 'up' || k === 'down') move(k);
});

/* ------------------------------------------------------------ boot */
var views = { home: viewHome, live: viewLive, movies: () => viewGrid('movies'), series: () => viewGrid('series'), search: viewSearch, recordings: viewRecordings };
$$('.nav').forEach(n => act(n, () => { stack = []; current = null; go(views[n.dataset.view], false); }));
setInterval(function tick() { var d = new Date(); $('#clock').textContent = d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); return tick; }(), 15000);
go(views[location.hash.slice(1)] || viewHome, false); // #live, #movies... open a view directly (TV bookmarks)
