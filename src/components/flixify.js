// Flixify source — public-domain VOD, rendered as its own tab/view panel.
// Mounts into #flixify-view. Talks to /api/flixify/* (desktop/server mode).
// Auth = device-PIN flow; playback hands off to the app's player via a callback.

let pollTimer = null;
let onPlay = null;          // (streamUrl, title, poster, subtitles) -> void
let mounted = false;
let nav = [];               // stack: { label, path, q, page }
let searchPath = null;      // real search endpoint, captured from the home menu
let flixifyOff = false;     // negative cache: home had no search row (not connected)

function lucide(scope) {
  if (window.lucide) { try { window.lucide.createIcons({ scope }); } catch (e) {} }
}
function toast(msg, type = 'info') { if (window.showToast) window.showToast(msg, type); }
function fmtPin(pin) { return String(pin).replace(/(\d{2})(?=\d)/g, '$1-'); }
function flixQuality() { return localStorage.getItem('flixify_quality') || 'auto'; }

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  let d = null; try { d = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, data: d };
}

export async function flixifyStatus() {
  try { const { data } = await getJSON('/api/flixify/status'); return !!(data && data.loggedIn); }
  catch { return false; }
}
export async function flixifyLogout() {
  try { await fetch('/api/flixify/logout', { method: 'POST' }); } catch (e) {}
}

// Let the host register the play handler once at startup, so Flixify results can
// be played from the global search even before the Flixify tab is opened.
export function setFlixifyPlayHandler(cb) { onPlay = cb; }

// Return Flixify search results as a flat array (for the unified top-bar search).
// Fast no-op when Flixify isn't connected.
export async function flixifySearchResults(q) {
  q = (q || '').trim();
  if (!q || flixifyOff) return [];
  try {
    let url = searchPath;
    if (!url) {
      const home = (await getJSON('/api/flixify/home')).data;
      const sr = home && Array.isArray(home.items) ? home.items.find(r => r.act === 'search') : null;
      if (!sr || !sr.url) { flixifyOff = true; return []; }   // not connected / no search
      url = searchPath = sr.url;
    }
    const res = (await getJSON('/api/flixify/browse?path=' + encodeURIComponent(url) + '&q=' + encodeURIComponent(q))).data;
    return (res && res.kind === 'items' && Array.isArray(res.items)) ? res.items : [];
  } catch (e) { return []; }
}

// Play a Flixify item picked from the global search.
export function playFlixifySearchItem(item) { if (item) playItem(item, []); }

// Entry point — called by switchTab('flixify'). Renders into #flixify-view.
export async function enterFlixify(playCb) {
  onPlay = playCb;
  flixifyOff = false;
  mount();
  if (!(await flixifyStatus())) { renderConnectGate(); return; }
  // Prompt for a profile when the account has several and none is active yet.
  try {
    const prof = (await getJSON('/api/flixify/profiles')).data;
    if (prof && prof.count > 1 && !prof.selected) { renderProfilePicker(prof.items); return; }
  } catch (e) {}
  nav = [{ label: 'Flixify', path: null, q: '' }];   // null path = home
  loadCurrent();
}

function panel() { return document.getElementById('flixify-view'); }
function body() { return panel().querySelector('#flx-body'); }
function setTitle(t) { const e = panel().querySelector('#flx-title'); if (e) e.textContent = t; }

function mount() {
  if (mounted && panel().querySelector('#flx-body')) return;
  const p = panel();
  p.innerHTML = `
    <div class="vod-view-header" style="display:flex;align-items:center;gap:12px;">
      <button id="flx-back" title="Back" class="vod-filter-btn" style="display:none;"><i data-lucide="arrow-left"></i></button>
      <h2 id="flx-title" style="flex:1;margin:0;">Flixify</h2>
      <div class="vod-filters">
        <button class="vod-filter-btn" id="flx-profile" title="Switch profile"><i data-lucide="users"></i></button>
        <button class="vod-filter-btn" id="flx-settings" title="Flixify settings"><i data-lucide="settings"></i></button>
        <button class="vod-filter-btn" id="flx-search"><i data-lucide="search"></i> <span>Search</span></button>
      </div>
    </div>
    <div class="vod-scroll-container"><div id="flx-body" style="padding:4px;"></div></div>`;
  p.querySelector('#flx-back').addEventListener('click', goBack);
  p.querySelector('#flx-search').addEventListener('click', doSearch);
  p.querySelector('#flx-profile').addEventListener('click', openProfilePicker);
  p.querySelector('#flx-settings').addEventListener('click', openFlixifySettings);
  lucide(p);
  mounted = true;
}

function updateBack() {
  const b = panel().querySelector('#flx-back');
  if (b) b.style.display = nav.length > 1 ? '' : 'none';
}

function msg(t) { return `<div style="color:#9aa4b2;padding:24px;text-align:center;">${t}</div>`; }

// --- Connect gate (shown inside the panel when not authorised) -------------
function renderConnectGate() {
  setTitle('Flixify');
  const b = body();
  b.innerHTML = `
    <div style="max-width:420px;margin:40px auto;text-align:center;color:#cfd6df;">
      <div style="font-size:1.05rem;margin-bottom:14px;">Connect your Flixify account to browse.</div>
      <button id="flx-connect" class="vod-filter-btn" style="padding:10px 22px;">Connect Flixify</button>
    </div>`;
  b.querySelector('#flx-connect').addEventListener('click', async () => {
    const ok = await runConnect();
    if (ok && await flixifyStatus()) { nav = [{ label: 'Flixify', path: null, q: '' }]; loadCurrent(); }
  });
}

// --- Connect (device-PIN) — resolves true once authorised --------------------
function runConnect() {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3200;display:flex;align-items:center;justify-content:center;background:rgba(5,7,11,.6);backdrop-filter:blur(4px);';
    overlay.innerHTML = `
      <div style="width:min(440px,92vw);background:var(--rd-glass-drawer,#11151c);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:26px 24px;text-align:center;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:1.15rem;font-weight:600;margin-bottom:6px;"><i data-lucide="film"></i> Connect Flixify</div>
        <div id="flx-instr" style="color:#9aa4b2;font-size:.9rem;margin-bottom:18px;">Generating PIN…</div>
        <div id="flx-pin" style="font-size:2.4rem;font-weight:700;letter-spacing:.12em;font-variant-numeric:tabular-nums;margin:8px 0 14px;">— — —</div>
        <div id="flx-verify" style="color:#7cc4ff;font-size:.92rem;margin-bottom:18px;word-break:break-all;"></div>
        <div id="flx-cstatus" style="color:#9aa4b2;font-size:.85rem;min-height:1.2em;margin-bottom:16px;"></div>
        <button id="flx-cancel" style="padding:9px 20px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#e6eaf0;cursor:pointer;">Cancel</button>
      </div>`;
    document.body.appendChild(overlay);
    lucide(overlay);
    const $ = (id) => overlay.querySelector('#' + id);
    const done = (ok) => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } overlay.remove(); resolve(ok); };
    $('flx-cancel').addEventListener('click', () => done(false));

    let pin;
    try {
      const { ok, data } = await getJSON('/api/flixify/pin', { method: 'POST' });
      pin = data;
      if (!ok || !pin || !pin.pin) throw new Error((pin && pin.error) || 'Could not get a PIN');
    } catch (e) { $('flx-instr').textContent = 'Failed to start: ' + (e.message || e); return; }

    $('flx-instr').textContent = 'Enter this PIN on your account page to authorise this device:';
    $('flx-pin').textContent = fmtPin(pin.pin);
    if (pin.verify_url) $('flx-verify').textContent = pin.verify_url;
    $('flx-cstatus').textContent = 'Waiting for authorisation…';

    pollTimer = setInterval(async () => {
      let s;
      try { s = (await getJSON('/api/flixify/pin/status')).data; } catch { return; }
      if (!s) return;
      if (s.state === 'success') { toast('Flixify connected', 'success'); done(true); }
      else if (s.state === 'error') { $('flx-cstatus').textContent = 'Error: ' + (s.error || 'try again'); clearInterval(pollTimer); pollTimer = null; }
    }, 5000);
  });
}

// --- Navigation -------------------------------------------------------------
function goBack() { if (nav.length <= 1) return; nav.pop(); loadCurrent(); }

// Driven by the top-bar master search when the Flixify tab is active.
export async function flixifySearch(q) {
  q = (q || '').trim();
  const top = nav[nav.length - 1];
  if (!q) {                                    // cleared → drop back out of search
    if (top && top._search) { nav.pop(); loadCurrent(); }
    return;
  }
  let url = searchPath;
  if (!url) {
    try {
      const home = (await getJSON('/api/flixify/home')).data;
      const sr = (home && home.items || []).find(r => r.act === 'search');
      if (sr && sr.url) url = searchPath = sr.url;
    } catch (e) {}
  }
  if (!url) return;
  const frame = { label: `Search: ${q}`, path: url, q, _search: true };
  if (top && top._search) nav[nav.length - 1] = frame;   // replace, don't stack
  else nav.push(frame);
  loadCurrent();
}

// Electron disables window.prompt(), so roll a tiny input modal instead.
function promptSearch() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3200;display:flex;align-items:flex-start;justify-content:center;padding-top:16vh;background:rgba(5,7,11,.6);backdrop-filter:blur(4px);';
    overlay.innerHTML = `
      <div style="width:min(520px,92vw);background:var(--rd-glass-drawer,#11151c);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:20px;">
        <div style="display:flex;align-items:center;gap:8px;font-size:1.05rem;font-weight:600;margin-bottom:14px;"><i data-lucide="search"></i> Search Flixify</div>
        <input id="flx-q-in" type="text" placeholder="Type a title…" autocomplete="off"
               style="width:100%;padding:12px 14px;border-radius:10px;background:#0c1118;color:#e6eaf0;border:1px solid rgba(255,255,255,.14);font-size:1rem;">
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button id="flx-q-cancel" style="padding:9px 18px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#e6eaf0;cursor:pointer;">Cancel</button>
          <button id="flx-q-go" style="padding:9px 20px;border-radius:10px;border:none;background:#2f7fd1;color:#fff;cursor:pointer;">Search</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    lucide(overlay);
    const input = overlay.querySelector('#flx-q-in');
    setTimeout(() => input.focus(), 30);
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#flx-q-go').addEventListener('click', () => done((input.value || '').trim()));
    overlay.querySelector('#flx-q-cancel').addEventListener('click', () => done(null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done((input.value || '').trim());
      else if (e.key === 'Escape') done(null);
      e.stopPropagation();                     // keep TV-nav / global keys out
    });
  });
}

async function doSearch() {
  const q = await promptSearch();
  if (!q) return;
  let url = searchPath;
  if (!url) {                                  // not on home yet — fetch it to learn the path
    try {
      const home = (await getJSON('/api/flixify/home')).data;
      const sr = (home && home.items || []).find(r => r.act === 'search');
      if (sr && sr.url) url = searchPath = sr.url;
    } catch (e) {}
  }
  if (!url) { toast('Search is unavailable', 'error'); return; }
  nav.push({ label: `Search: ${q}`, path: url, q });
  loadCurrent();
}

async function loadCurrent() {
  const frame = nav[nav.length - 1];
  setTitle(frame.label);
  updateBack();
  body().innerHTML = msg('Loading…');

  let url;
  if (frame.path == null) url = '/api/flixify/home';
  else {
    const qs = new URLSearchParams({ path: frame.path });
    if (frame.q) qs.set('q', frame.q);
    if (frame.page) qs.set('page', frame.page);
    url = '/api/flixify/browse?' + qs.toString();
  }

  let res;
  try { res = (await getJSON(url)).data; } catch (e) { res = { kind: 'error', error: e.message }; }
  if (!res) { body().innerHTML = msg('Could not load.'); return; }
  if (res.kind === 'free_limit') { body().innerHTML = msg('Free limit reached. Try again later.'); return; }
  if (res.kind === 'error') { body().innerHTML = msg('Error: ' + (res.error || 'unknown')); return; }
  if (res.kind === 'lists') renderRows(res.items);
  else renderItems(res);
}

function rowIcon(row) {
  const t = (row.title || row.act || '').toLowerCase();
  if (row.act === 'search' || t.includes('search')) return 'search';
  if (t.includes('continue')) return 'history';
  if (t.includes('favorite')) return 'star';
  if (t.includes('later')) return 'clock';
  if (t.includes('trending')) return 'trending-up';
  if (t.includes('popular')) return 'flame';
  if (t.includes('collection')) return 'layers';
  if (t.includes('tv')) return 'tv';
  if (t.includes('movie')) return 'film';
  if (row.act === 'profiles' || t.includes('profile')) return 'users';
  return 'sparkles';
}

function renderRows(rows) {
  const sr = rows.find(r => r.act === 'search');
  if (sr && sr.url) searchPath = sr.url;      // remember the real search endpoint
  const b = body(); b.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'flx-menu';
  rows.forEach(row => {
    const label = (row.title || row.act || '').replace(/^\[|\]$/g, '');
    const btn = document.createElement('button');
    btn.className = 'flx-row';
    btn.innerHTML = `
      <span class="flx-row-ico"><i data-lucide="${rowIcon(row)}"></i></span>
      <span class="flx-row-label">${label.replace(/</g, '&lt;')}</span>
      <span class="flx-row-chev"><i data-lucide="chevron-right"></i></span>`;
    btn.addEventListener('click', () => onRow(row));
    wrap.appendChild(btn);
  });
  b.appendChild(wrap);
  lucide(wrap);
}

function onRow(row) {
  if (row.act === 'profiles') { openProfilePicker(); return; }
  if (row.act === 'search') {
    promptSearch().then((q) => {
      if (!q) return;
      nav.push({ label: `Search: ${q}`, path: row.url, q });
      loadCurrent();
    });
    return;
  } else {
    nav.push({ label: row.title || 'Flixify', path: row.url, q: '' });
  }
  loadCurrent();
}

function renderItems(res) {
  const b = body(); b.innerHTML = '';
  const items = res.items || [];
  if (items.length === 0) { b.innerHTML = msg('Nothing here.'); return; }
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px;';
  items.forEach(item => grid.appendChild(tile(item, items)));
  b.appendChild(grid);

  if (res.total && res.items_per_page) {
    const pages = Math.ceil(res.total / res.items_per_page);
    const cur = res.page || 1;
    if (cur < pages) {
      const more = document.createElement('button');
      more.textContent = 'Load more';
      more.style.cssText = 'display:block;margin:20px auto 0;padding:10px 24px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#e6eaf0;cursor:pointer;';
      more.addEventListener('click', async () => {
        more.disabled = true; more.textContent = 'Loading…';
        const qs = new URLSearchParams({ path: nav[nav.length - 1].path, page: cur + 1 });
        if (nav[nav.length - 1].q) qs.set('q', nav[nav.length - 1].q);
        const r = (await getJSON('/api/flixify/browse?' + qs.toString())).data;
        more.remove();
        if (r && r.items) {
          r.items.forEach(item => grid.appendChild(tile(item, items)));
          nav[nav.length - 1].page = cur + 1;
          renderMoreButton(r, grid, b);
        }
      });
      b.appendChild(more);
    }
  }
}

function renderMoreButton(res, grid, b) {
  const pages = Math.ceil(res.total / res.items_per_page);
  const cur = res.page || nav[nav.length - 1].page || 1;
  if (cur >= pages) return;
  const more = document.createElement('button');
  more.textContent = 'Load more';
  more.style.cssText = 'display:block;margin:20px auto 0;padding:10px 24px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#e6eaf0;cursor:pointer;';
  more.addEventListener('click', async () => {
    more.disabled = true; more.textContent = 'Loading…';
    const qs = new URLSearchParams({ path: nav[nav.length - 1].path, page: cur + 1 });
    if (nav[nav.length - 1].q) qs.set('q', nav[nav.length - 1].q);
    const r = (await getJSON('/api/flixify/browse?' + qs.toString())).data;
    more.remove();
    if (r && r.items) { r.items.forEach(item => grid.appendChild(tile(item, items))); nav[nav.length - 1].page = cur + 1; renderMoreButton(r, grid, b); }
  });
  b.appendChild(more);
}

function tile(item, siblings) {
  const el = document.createElement('div');
  el.className = 'flx-tile';
  const poster = item.poster || '';
  el.innerHTML = `
    <div style="aspect-ratio:2/3;border-radius:10px;overflow:hidden;background:#1a1f29;">
      ${poster ? `<img src="${poster}" loading="lazy" style="width:100%;height:100%;object-fit:cover;">` : ''}
    </div>
    <div style="margin-top:6px;font-size:.85rem;color:#cfd6df;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(item.title || '').replace(/</g, '&lt;')}</div>`;
  el.addEventListener('click', () => onItem(item, siblings));
  return el;
}

function onItem(item, siblings) {
  if (item.type === 'movie' || item.type === 'tvepisode') { playItem(item, siblings || []); return; }
  nav.push({ label: item.title || 'Flixify', path: item.url, q: '' });
  loadCurrent();
}

// Next playable episode after `item` within the same season list (binge).
function nextEpisodeOf(item, siblings) {
  if (!item || item.type !== 'tvepisode' || !Array.isArray(siblings)) return null;
  const idx = siblings.findIndex(x => String(x.id) === String(item.id));
  if (idx < 0) return null;
  for (let j = idx + 1; j < siblings.length; j++) {
    if (siblings[j].type === 'tvepisode') return siblings[j];
  }
  return null;
}

function openFlixifySettings() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:3200;display:flex;align-items:center;justify-content:center;background:rgba(5,7,11,.6);backdrop-filter:blur(4px);';
  overlay.innerHTML = `
    <div style="width:min(420px,92vw);background:var(--rd-glass-drawer,#11151c);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px;">
      <div style="display:flex;align-items:center;gap:8px;font-size:1.12rem;font-weight:600;margin-bottom:18px;"><i data-lucide="settings"></i> Flixify Settings</div>
      <label style="display:block;color:#9aa4b2;font-size:.85rem;margin-bottom:6px;">Video Quality</label>
      <select id="flx-q" style="width:100%;padding:10px;border-radius:10px;background:#0c1118;color:#e6eaf0;border:1px solid rgba(255,255,255,.14);margin-bottom:20px;">
        <option value="auto">Auto</option>
        <option value="1080">1080p</option>
        <option value="720">720p</option>
      </select>
      <div style="display:flex;gap:10px;justify-content:space-between;">
        <button id="flx-disconnect" style="padding:9px 16px;border-radius:10px;border:1px solid rgba(239,68,68,.4);background:transparent;color:#fca5a5;cursor:pointer;">Disconnect</button>
        <button id="flx-set-close" style="padding:9px 20px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#e6eaf0;cursor:pointer;">Done</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  lucide(overlay);
  const sel = overlay.querySelector('#flx-q');
  sel.value = flixQuality();
  sel.addEventListener('change', () => localStorage.setItem('flixify_quality', sel.value));
  overlay.querySelector('#flx-set-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#flx-disconnect').addEventListener('click', async () => {
    await flixifyLogout();
    overlay.remove();
    toast('Flixify disconnected', 'info');
    renderConnectGate();
  });
}

async function openProfilePicker() {
  setTitle('Profiles');
  body().innerHTML = msg('Loading profiles…');
  let prof;
  try { prof = (await getJSON('/api/flixify/profiles')).data; } catch (e) { prof = null; }
  if (!prof || !prof.items || prof.items.length === 0) { body().innerHTML = msg('No profiles found.'); return; }
  renderProfilePicker(prof.items);
}

function renderProfilePicker(items) {
  setTitle("Who's watching?");
  updateBack();
  const b = body(); b.innerHTML = '';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:24px;justify-content:center;padding:40px 12px;';
  items.forEach(pf => {
    const cell = document.createElement('div');
    cell.style.cssText = 'cursor:pointer;text-align:center;width:130px;';
    const initials = (pf.name || '?').trim().slice(0, 1).toUpperCase();
    cell.innerHTML = `
      <div style="width:120px;height:120px;border-radius:14px;overflow:hidden;background:#1f2632;display:flex;align-items:center;justify-content:center;font-size:2.4rem;color:#cfd6df;margin:0 auto;">
        ${pf.avatar ? `<img src="${pf.avatar}" style="width:100%;height:100%;object-fit:cover;">` : initials}
      </div>
      <div style="margin-top:8px;color:#e6eaf0;font-size:.95rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(pf.name || '').replace(/</g, '&lt;')}</div>`;
    cell.addEventListener('click', () => selectAndEnter(pf.id));
    grid.appendChild(cell);
  });
  b.appendChild(grid);
}

async function selectAndEnter(id) {
  body().innerHTML = msg('Switching profile…');
  try {
    const r = (await getJSON('/api/flixify/profiles/select', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    })).data;
    if (!r || !r.ok) toast('Could not switch profile', 'error');
  } catch (e) { toast('Could not switch profile', 'error'); }
  nav = [{ label: 'Flixify', path: null, q: '' }];
  loadCurrent();
}

async function playItem(item, siblings) {
  const path = item.url || ('/movies/' + item.id);
  toast('Loading…', 'info');
  let res;
  try { res = (await getJSON('/api/flixify/resolve?path=' + encodeURIComponent(path) + '&quality=' + encodeURIComponent(flixQuality()))).data; }
  catch (e) { res = { error: e.message }; }
  if (!res || res.error) {
    toast(res && res.error === 'free_limit' ? 'Free limit reached' : 'Video unavailable', 'error');
    return;
  }
  const id = res.id || item.id;

  // Throttled progress reporting (drives the platform's Continue Watching).
  let lastSent = 0;
  let lastPos = res.resumeTime || 0;
  const report = (pos, delta, completed) => {
    fetch('/api/flixify/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, pos, delta, cw: pos > 30, completed: !!completed }),
    }).catch(() => {});
  };
  const onProgress = (cur, dur) => {
    if (!cur) return;
    const now = Date.now();
    if (now - lastSent < 15000) return;       // report at most every 15s
    const delta = Math.max(0, cur - lastPos);
    lastSent = now; lastPos = cur;
    report(cur, delta, dur > 0 && cur > dur * 0.92);
  };

  // Binge: advance to the next episode in this season when one ends.
  const next = nextEpisodeOf(item, siblings);
  const onEnded = () => {
    report(lastPos, 0, true);                 // mark complete
    if (next) { toast('Up next: ' + (next.title || 'Next episode'), 'info'); playItem(next, siblings); return true; }
    return false;                             // nothing to advance to → host exits
  };

  if (onPlay) onPlay(res.streamUrl, res.title || item.title, item.poster, res.subtitles || [], {
    resumeTime: res.resumeTime || 0,
    castId: id,
    onProgress,
    onEnded,
  });
}
