// Custom web tabs — user-added "browser tabs" in the side rail (Electron only).
// Each tab is just a webpage rendered in an Electron <webview> (isolated guest
// process, persist:webtabs session — which is also where the built-in ad
// blocker hooks in). Adding a tab mirrors Chrome's add-bookmark flow: name +
// URL, icon = the site's favicon. Tabs (and built-in Flixify) can be hidden /
// edited / removed from Settings → Manage Tabs.
//
// Storage (localStorage):
//   webTabs    → [{ id, name, url }]
//   hiddenTabs → ['flixify', <webtab ids>...]   (hidden from the rail/tab bar)
//   adblock    → 'on' | 'off'                   (default on)

import { Capacitor } from '@capacitor/core';

const isAndroidNative = () => {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch (e) {
    return false;
  }
};

const LS_TABS = 'webTabs';
const LS_HIDDEN = 'hiddenTabs';
const LS_ADBLOCK = 'adblock';

let switchTabCb = null;   // main.js switchTab — custom tabs go through it too
let refreshTilesCb = null;

const isElectron = () => !!(window.appHost && window.appHost.isElectron);
const toast = (msg, type = 'info') => { if (window.showToast) window.showToast(msg, type); };

// ---- storage helpers -------------------------------------------------------
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; }
}
export function getWebTabs() { return readJSON(LS_TABS, []); }
function saveWebTabs(tabs) { localStorage.setItem(LS_TABS, JSON.stringify(tabs)); }
export function getHiddenTabs() { return readJSON(LS_HIDDEN, []); }
function saveHiddenTabs(list) { localStorage.setItem(LS_HIDDEN, JSON.stringify(list)); }
export function isAdblockOn() { return (localStorage.getItem(LS_ADBLOCK) || 'on') === 'on'; }

function faviconUrl(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`; }
  catch (e) { return ''; }
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.href;
  } catch (e) { return null; }
}

// ---- init ------------------------------------------------------------------
export function initWebTabs({ onSwitchTab, onRefreshTiles } = {}) {
  switchTabCb = onSwitchTab;
  refreshTilesCb = onRefreshTiles;

  if (isElectron()) {
    const addBtn = document.getElementById('add-tab-btn');
    if (addBtn) {
      addBtn.style.display = '';
      addBtn.addEventListener('click', () => openTabDialog(null));
    }
    renderRailTabs();
    // Wire the ad blocker to the saved setting (default: on).
    window.appHost.setAdblock(isAdblockOn()).then((r) => {
      if (r && r.ok === false) console.warn('[webtabs] adblock unavailable:', r.error);
    });
  }
  applyHiddenTabs();
}

// ---- rail rendering --------------------------------------------------------
function renderRailTabs() {
  const slot = document.getElementById('custom-tabs-slot');
  if (!slot) return;
  slot.innerHTML = '';
  const hidden = getHiddenTabs();
  for (const tab of getWebTabs()) {
    const btn = document.createElement('button');
    btn.className = 'nav-tab rail-item webtab-rail-item';
    btn.dataset.tab = `web:${tab.id}`;
    btn.title = tab.name;
    if (hidden.includes(tab.id)) btn.style.display = 'none';

    const img = document.createElement('img');
    img.className = 'webtab-favicon';
    img.alt = '';
    img.src = faviconUrl(tab.url);
    // lucide swaps <i> for <svg> (keeping the class), so look the fallback up
    // by class at error time instead of holding a reference.
    img.onerror = () => {
      img.style.display = 'none';
      const fb = btn.querySelector('.webtab-fallback');
      if (fb) fb.style.display = '';
    };
    const fallbackIcon = document.createElement('i');
    fallbackIcon.dataset.lucide = 'globe';
    fallbackIcon.className = 'webtab-fallback';
    fallbackIcon.style.display = 'none';

    const label = document.createElement('span');
    label.className = 'rail-label';
    label.textContent = tab.name;

    btn.append(img, fallbackIcon, label);
    btn.addEventListener('click', () => {
      // The rail stays expanded while anything inside it has focus
      // (.side-rail:focus-within). Built-in tabs re-render content that pulls
      // focus away; a webview doesn't — so drop focus explicitly or the rail
      // sticks open over the page.
      btn.blur();
      switchTabCb && switchTabCb(`web:${tab.id}`);
    });
    // Right-click → edit/delete (Chrome-bookmark style management in place).
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); openTabDialog(tab); });
    slot.appendChild(btn);
  }
  if (window.lucide) { try { window.lucide.createIcons(); } catch (e) {} }
}

// ---- hidden tabs (built-ins + custom) ---------------------------------------
export function applyHiddenTabs() {
  const hidden = getHiddenTabs();
  // Built-ins that support hiding (Flixify for now).
  for (const id of ['flixify']) {
    const off = isAndroidNative() || hidden.includes(id);
    document.querySelectorAll(`.nav-tab[data-tab="${id}"], .mobile-tab-btn[data-tab="${id}"]`)
      .forEach((el) => { el.style.display = off ? 'none' : ''; });
  }
  // Custom tabs live only in the rail slot.
  document.querySelectorAll('#custom-tabs-slot .nav-tab').forEach((el) => {
    const id = (el.dataset.tab || '').replace(/^web:/, '');
    el.style.display = hidden.includes(id) ? 'none' : '';
  });
}

function toggleHidden(id, hide) {
  const hidden = getHiddenTabs().filter((h) => h !== id);
  if (hide) hidden.push(id);
  saveHiddenTabs(hidden);
  applyHiddenTabs();
}

// ---- open a custom tab (webview browser panel) ------------------------------
const webviews = new Map(); // tab id → <webview>

// Pause any <video>/<audio> playing inside a webview and mute its audio, so a
// backgrounded tab can never keep playing behind whatever is on screen now.
// executeJavaScript / setAudioMuted throw until the guest page has attached —
// swallow those; a not-yet-ready webview isn't playing anything anyway.
function silenceWebview(wv) {
  if (!wv) return;
  try { wv.setAudioMuted(true); } catch (e) {}
  try {
    wv.executeJavaScript(
      "document.querySelectorAll('video,audio').forEach(function(m){try{m.pause();}catch(e){}});"
    ).catch(() => {});
  } catch (e) {}
}

// Stop playback in every custom web tab. Exposed on window so the video player
// (player.js) can call it whenever a local stream starts — one call silences
// all custom tabs regardless of which one was playing.
export function stopAllWebtabPlayback() {
  for (const wv of webviews.values()) silenceWebview(wv);
}
if (typeof window !== 'undefined') window.stopAllWebtabPlayback = stopAllWebtabPlayback;

export function openWebTab(id) {
  const tab = getWebTabs().find((t) => t.id === id);
  const view = document.getElementById('webtab-view');
  if (!tab || !view || !isElectron()) return;

  // Switching to a web tab takes over the screen — stop local IPTV playback so
  // its audio doesn't keep going behind the tab's own video (double audio).
  try {
    const p = window.playerInstance;
    if (p) {
      if (p.mpegtsPlayer) { try { p.mpegtsPlayer.pause(); } catch (e) {} }
      if (p.video) { try { p.video.pause(); } catch (e) {} }
    }
  } catch (e) {}

  // Only one tab plays at a time: silence every other custom tab as we switch in.
  for (const [tid, el] of webviews) { if (tid !== id) silenceWebview(el); }

  // Build the panel chrome once.
  if (!view.querySelector('.webtab-toolbar')) {
    view.innerHTML = `
      <div class="webtab-toolbar">
        <button class="webtab-btn" data-act="back" title="Back"><i data-lucide="arrow-left"></i></button>
        <button class="webtab-btn" data-act="fwd" title="Forward"><i data-lucide="arrow-right"></i></button>
        <button class="webtab-btn" data-act="reload" title="Reload"><i data-lucide="rotate-cw"></i></button>
        <span class="webtab-title" id="webtab-title"></span>
        <button class="webtab-btn" data-act="edit" title="Edit tab"><i data-lucide="pencil"></i></button>
        <button class="webtab-btn" data-act="external" title="Open in browser"><i data-lucide="external-link"></i></button>
      </div>
      <div class="webtab-stage" id="webtab-stage"></div>`;
    if (window.lucide) { try { window.lucide.createIcons(); } catch (e) {} }
    view.querySelector('.webtab-toolbar').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const wv = currentWebview();
      if (!act) return;
      try { // webview methods throw until the guest page has attached
        if (act === 'back' && wv?.canGoBack()) wv.goBack();
        else if (act === 'fwd' && wv?.canGoForward()) wv.goForward();
        else if (act === 'reload') wv?.reload();
        else if (act === 'external' && wv) window.appHost.openExternal(wv.getURL());
        else if (act === 'edit') {
          const t = getWebTabs().find((x) => x.id === view.dataset.activeId);
          if (t) openTabDialog(t);
        }
      } catch (err) { /* not ready yet — ignore */ }
    });
  }

  const stage = view.querySelector('#webtab-stage');
  view.dataset.activeId = id;

  // One persistent <webview> per tab — switching tabs keeps page state.
  let wv = webviews.get(id);
  if (!wv) {
    wv = document.createElement('webview');
    wv.setAttribute('partition', 'persist:webtabs');
    // NOTE: `allowpopups` is a boolean attribute — omitting it disables popups
    // (the main process additionally routes window.open back into the webview).
    wv.setAttribute('src', tab.url);
    wv.className = 'webtab-webview';
    wv.addEventListener('page-title-updated', (e) => {
      if (view.dataset.activeId === id) setTitle(e.title);
    });
    webviews.set(id, wv);
    stage.appendChild(wv);
  }
  for (const [tid, el] of webviews) el.classList.toggle('active', tid === id);
  // The tab we're entering is the one allowed to make sound — undo any mute
  // applied while it sat in the background.
  try { wv.setAudioMuted(false); } catch (e) {}
  setTitle(tab.name);

  function setTitle(t) {
    const el = view.querySelector('#webtab-title');
    if (el) el.textContent = t || tab.name;
  }
}

function currentWebview() {
  const view = document.getElementById('webtab-view');
  return view ? webviews.get(view.dataset.activeId) : null;
}

// Drop a webview when its tab is deleted.
function destroyWebview(id) {
  const wv = webviews.get(id);
  if (wv) { wv.remove(); webviews.delete(id); }
}

// ---- add / edit dialog (Chrome add-bookmark flow) ---------------------------
let dialogEl = null;

function ensureDialog() {
  if (dialogEl) return dialogEl;
  dialogEl = document.createElement('div');
  dialogEl.id = 'webtab-dialog';
  dialogEl.className = 'modal-overlay hidden';
  dialogEl.innerHTML = `
    <div class="webtab-dialog-card">
      <div class="webtab-dialog-header">
        <img class="webtab-dialog-favicon" id="webtab-dlg-icon" alt="" style="display:none">
        <h3 id="webtab-dlg-title">Add tab</h3>
      </div>
      <label class="webtab-dialog-label">Name
        <input type="text" id="webtab-dlg-name" placeholder="e.g. YouTube" autocomplete="off">
      </label>
      <label class="webtab-dialog-label">URL
        <input type="url" id="webtab-dlg-url" placeholder="https://example.com" autocomplete="off">
      </label>
      <div class="webtab-dialog-actions">
        <button class="webtab-dialog-btn webtab-dialog-danger hidden" id="webtab-dlg-delete">Remove</button>
        <span class="webtab-dialog-spacer"></span>
        <button class="webtab-dialog-btn" id="webtab-dlg-cancel">Cancel</button>
        <button class="webtab-dialog-btn webtab-dialog-primary" id="webtab-dlg-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(dialogEl);
  dialogEl.addEventListener('click', (e) => { if (e.target === dialogEl) closeDialog(); });
  dialogEl.querySelector('#webtab-dlg-cancel').addEventListener('click', closeDialog);
  // Live favicon preview while typing the URL (Chrome-style).
  dialogEl.querySelector('#webtab-dlg-url').addEventListener('input', (e) => {
    const u = normalizeUrl(e.target.value);
    const icon = dialogEl.querySelector('#webtab-dlg-icon');
    if (u) { icon.src = faviconUrl(u); icon.style.display = ''; }
    else icon.style.display = 'none';
  });
  // Enter saves (Chrome bookmark dialog behaviour)
  dialogEl.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dialogEl.querySelector('#webtab-dlg-save').click();
      else if (e.key === 'Escape') closeDialog();
    });
  });
  return dialogEl;
}

function closeDialog() { dialogEl?.classList.add('hidden'); }

export function openTabDialog(tab) {
  const dlg = ensureDialog();
  const nameInput = dlg.querySelector('#webtab-dlg-name');
  const urlInput = dlg.querySelector('#webtab-dlg-url');
  const delBtn = dlg.querySelector('#webtab-dlg-delete');
  const icon = dlg.querySelector('#webtab-dlg-icon');

  dlg.querySelector('#webtab-dlg-title').textContent = tab ? 'Edit tab' : 'Add tab';
  nameInput.value = tab ? tab.name : '';
  urlInput.value = tab ? tab.url : '';
  delBtn.classList.toggle('hidden', !tab);
  if (tab) { icon.src = faviconUrl(tab.url); icon.style.display = ''; }
  else icon.style.display = 'none';

  delBtn.onclick = () => {
    removeWebTab(tab.id);
    closeDialog();
    toast(`Removed "${tab.name}"`, 'success');
  };

  dlg.querySelector('#webtab-dlg-save').onclick = () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) { toast('Enter a valid web address', 'error'); urlInput.focus(); return; }
    let name = nameInput.value.trim();
    if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { name = url; } }

    const tabs = getWebTabs();
    if (tab) {
      const t = tabs.find((x) => x.id === tab.id);
      if (t) {
        const urlChanged = t.url !== url;
        t.name = name; t.url = url;
        saveWebTabs(tabs);
        if (urlChanged) { destroyWebview(t.id); }
      }
    } else {
      const id = 'wt' + Date.now().toString(36);
      tabs.push({ id, name, url });
      saveWebTabs(tabs);
    }
    renderRailTabs();
    applyHiddenTabs();
    closeDialog();
    toast(tab ? 'Tab updated' : `Added "${name}"`, 'success');
    if (!tab) switchTabCb && switchTabCb(`web:${getWebTabs().at(-1).id}`);
  };

  dlg.classList.remove('hidden');
  (tab ? nameInput : urlInput).focus();
}

function removeWebTab(id) {
  saveWebTabs(getWebTabs().filter((t) => t.id !== id));
  saveHiddenTabs(getHiddenTabs().filter((h) => h !== id));
  destroyWebview(id);
  renderRailTabs();
  // If the deleted tab is on screen, bounce back to Live.
  const view = document.getElementById('webtab-view');
  if (view?.classList.contains('active') && view.dataset.activeId === id) {
    switchTabCb && switchTabCb('live');
  }
}

// ---- Manage Tabs modal (Settings tile) --------------------------------------
let manageEl = null;

export function openManageTabs() {
  if (!manageEl) {
    manageEl = document.createElement('div');
    manageEl.id = 'managetabs-modal';
    manageEl.className = 'modal-overlay hidden';
    manageEl.innerHTML = `
      <div class="webtab-dialog-card">
        <div class="webtab-dialog-header"><h3>Manage tabs</h3></div>
        <div class="managetabs-list" id="managetabs-list"></div>
        <div class="webtab-dialog-actions">
          <button class="webtab-dialog-btn" id="managetabs-add">Add tab</button>
          <span class="webtab-dialog-spacer"></span>
          <button class="webtab-dialog-btn webtab-dialog-primary" id="managetabs-done">Done</button>
        </div>
      </div>`;
    document.body.appendChild(manageEl);
    manageEl.addEventListener('click', (e) => { if (e.target === manageEl) manageEl.classList.add('hidden'); });
    manageEl.querySelector('#managetabs-done').addEventListener('click', () => manageEl.classList.add('hidden'));
    manageEl.querySelector('#managetabs-add').addEventListener('click', () => {
      manageEl.classList.add('hidden');
      openTabDialog(null);
    });
  }
  renderManageList();
  manageEl.classList.remove('hidden');
}

function renderManageList() {
  const list = manageEl.querySelector('#managetabs-list');
  const hidden = getHiddenTabs();
  list.innerHTML = '';

  const row = ({ id, name, sub, icon, custom, tab }) => {
    const el = document.createElement('div');
    el.className = 'managetabs-row';
    el.innerHTML = `
      ${icon}
      <div class="managetabs-info">
        <span class="managetabs-name"></span>
        <span class="managetabs-sub"></span>
      </div>
      ${custom ? '<button class="webtab-btn" data-act="edit" title="Edit"><i data-lucide="pencil"></i></button>' : ''}
      ${custom ? '<button class="webtab-btn" data-act="del" title="Remove"><i data-lucide="trash-2"></i></button>' : ''}
      <button class="webtab-btn managetabs-eye" data-act="vis" title="Show / hide">
        <i data-lucide="${hidden.includes(id) ? 'eye-off' : 'eye'}"></i>
      </button>`;
    el.querySelector('.managetabs-name').textContent = name;
    el.querySelector('.managetabs-sub').textContent = hidden.includes(id) ? 'Hidden' : (sub || 'Visible');
    el.classList.toggle('managetabs-hidden', hidden.includes(id));
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'vis') { toggleHidden(id, !getHiddenTabs().includes(id)); renderManageList(); }
      else if (act === 'edit') { manageEl.classList.add('hidden'); openTabDialog(tab); }
      else if (act === 'del') { removeWebTab(id); renderManageList(); }
    });
    return el;
  };

  // Built-in hideable tab
  if (!isAndroidNative()) {
    list.appendChild(row({
      id: 'flixify', name: 'Flixify', sub: 'Built-in',
      icon: '<span class="managetabs-icon"><i data-lucide="popcorn"></i></span>', custom: false
    }));
  }

  // Custom web tabs (Electron only)
  if (isElectron()) {
    for (const tab of getWebTabs()) {
      list.appendChild(row({
        id: tab.id, name: tab.name, sub: tab.url, tab, custom: true,
        icon: `<span class="managetabs-icon"><img src="${faviconUrl(tab.url)}" alt=""></span>`
      }));
    }
    if (!getWebTabs().length) {
      const empty = document.createElement('div');
      empty.className = 'managetabs-empty';
      empty.textContent = 'No custom tabs yet — add a website with the + button in the sidebar.';
      list.appendChild(empty);
    }
  }
  if (window.lucide) { try { window.lucide.createIcons(); } catch (e) {} }
}

// ---- Ad blocker toggle (Settings tile) ---------------------------------------
export async function toggleAdblock() {
  const next = !isAdblockOn();
  localStorage.setItem(LS_ADBLOCK, next ? 'on' : 'off');
  if (isElectron()) {
    const r = await window.appHost.setAdblock(next);
    if (r && r.ok === false) {
      toast('Ad blocker unavailable (engine not installed)', 'error');
      localStorage.setItem(LS_ADBLOCK, 'off');
    } else {
      toast(`Ad blocker ${next ? 'enabled' : 'disabled'}`, 'success');
      // Reload open web tabs so blocking applies immediately.
      for (const wv of webviews.values()) { try { wv.reload(); } catch (e) {} }
    }
  }
  refreshTilesCb && refreshTilesCb();
}
