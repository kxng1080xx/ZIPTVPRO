import {
  getStatus,
  login,
  logout,
  updateSettings,
  syncPlaylist,
  getCategories,
  getStreams,
  toggleFavorite,
  trackPlayback,
  getStreamUrl,
  getStreamInfo,
  getPlaylists,
  switchPlaylist,
  removePlaylist,
  getContinueWatching,
  saveWatchProgress,
  removeWatchProgress,
  getIsServerMode,
  getStreamUrlSync
} from './components/xtream-api.js';
import { Capacitor } from '@capacitor/core';
import { VideoPlayer } from './components/player.js';
import { EPGGrid } from './components/epg.js';
import { navigation } from './components/tv-navigation.js';
import { initCastUI, setCastContext } from './components/cast.js';
import { checkForUpdate, downloadApp, startPeriodicUpdateCheck } from './components/update-check.js';
import { openSearchKeyboard, openSortDropdown } from './components/tv-search.js';

// Supabase Configuration for Remote Playlist Pairing
// Swap these with your own Supabase project credentials
const SUPABASE_URL = 'https://jnocgdemunelygygnozw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_uK2Tm5mvnvpODwlaHX6bZw_mry7o2FN';

let remoteLoginInterval = null;
let deviceCode = null;

// Application State
const state = {
  user: null,
  activeTab: 'live', // 'live', 'movies', 'series'
  activeCategory: null, // null until the user picks one (avoids auto-loading huge "All")
  activeChannel: null,
  activeProgram: null,
  favorites: {
    live: [],
    movie: [],
    series: []
  },
  counts: {
    favorites: 0,
    recently_viewed: 0
  },
  // VOD pagination & filters
  movies: {
    categoryId: 'all',
    page: 1,
    limit: 30,
    search: '',
    sort: 'added'
  },
  series: {
    categoryId: 'all',
    page: 1,
    limit: 30,
    search: '',
    sort: 'added'
  }
};

// Global Components instances
let playerInstance = null;
let epgGridInstance = null;
let liveFallbackTried = false; // guards the one-time .ts → m3u8 live fallback
let currentVodItem = null;     // metadata of the movie/episode currently playing (for Continue Watching)
let lastProgressSave = 0;      // throttle progress writes

// Clock update timer
let clockInterval = null;
let progressInterval = null;

// Document Ready
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  // 1. Initialize time clock
  startClock();

  // Initialize device code for remote login
  deviceCode = getOrCreateDeviceCode();
  const codeEl = document.getElementById('remote-device-code');
  if (codeEl) codeEl.textContent = deviceCode;

  const nameEl = document.getElementById('playlist-name');
  if (nameEl && (!nameEl.value || nameEl.value === 'Xtream Codes')) {
    nameEl.value = deviceCode;
  }

  // Show the build version (injected from package.json at build time)
  const versionEl = document.getElementById('app-version');
  if (versionEl && typeof __APP_VERSION__ !== 'undefined') {
    versionEl.textContent = `v${__APP_VERSION__}`;
  }

  // "Download latest version" button — point it at the right installer for the
  // platform. Windows/desktop → the PC .exe; everything else → the Android APK.
  // Both are hardwired to the public host so it also works as an update link
  // from inside the native apps.
  const dlBtn = document.getElementById('download-app-btn');
  const dlLabel = document.getElementById('download-app-label');
  if (dlBtn) {
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isWindowsDesktop = /Windows NT/i.test(ua) && !isAndroid;
    if (isWindowsDesktop) {
      dlBtn.href = 'https://ziptvpro.vercel.app/latest.exe';
      dlBtn.removeAttribute('download'); // cross-origin redirect handles the download
      if (dlLabel) dlLabel.textContent = 'Download Latest Version (PC)';
    } else {
      dlBtn.href = 'https://ziptvpro.vercel.app/app.apk';
      if (dlLabel) dlLabel.textContent = 'Download Latest Version';
    }

    // On Android (Fire TV's browser can't install APKs) download + install in
    // app via the native installer instead of opening the link.
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      dlBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const label = dlLabel ? dlLabel.textContent : '';
        if (dlLabel) dlLabel.textContent = 'Downloading…';
        const res = await downloadApp('https://ziptvpro.vercel.app/app.apk', (m) => { if (dlLabel) dlLabel.textContent = m; });
        if (dlLabel) dlLabel.textContent = res.needsPermission
          ? 'Allow "Install unknown apps", then retry'
          : (res.ok ? label : 'Download failed — retry');
      });
    }
  }

  // 2. Initialize Core Components
  playerInstance = new VideoPlayer();
  window.playerInstance = playerInstance;
  
  // Set player skip handlers
  playerInstance.setOnPrevChannel(() => playPreviousChannel());
  playerInstance.setOnNextChannel(() => playNextChannel());
  playerInstance.onExitVod = exitVodPlayer;
  playerInstance.onVodProgress = saveCurrentProgress;

  epgGridInstance = new EPGGrid(
    (channel, program) => {
      selectAndPlayChannel(channel, program);
    },
    (channel, program) => {
      updateDetailsPanel(channel, program);
    }
  );

  // Provide global function for EPG stars updates
  window.isChannelFavorite = (type, id) => {
    return state.favorites[type]?.includes(String(id)) || false;
  };
  window.toggleChannelFavorite = toggleChannelFavorite;

  // 3. Bind Global UI Events (Tabs, Logins, Settings, Modal Closers)
  bindGlobalEvents();

  // Casting (Electron/PC only — no-op elsewhere). Shows the Cast button when
  // the preload bridge is present.
  initCastUI();

  // Update checks: on every launch, plus every 3 hours on Windows desktop.
  // In the Electron app, electron-updater handles updates silently in the
  // background, so skip the custom prompt there to avoid double notifications.
  const isElectronApp = !!(window.electronCast || window.appHost);
  if (!isElectronApp) {
    checkForUpdate();
    if (/Windows NT/i.test(navigator.userAgent)) {
      startPeriodicUpdateCheck(3 * 60 * 60 * 1000);
    }
  }

  // Settings → Check for Update button (manual; always reports a result).
  const checkUpdateBtn = document.getElementById('settings-check-update');
  const updateStatusEl = document.getElementById('settings-update-status');
  const currentVerEl = document.getElementById('settings-current-version');
  if (currentVerEl && typeof __APP_VERSION__ !== 'undefined') currentVerEl.textContent = `v${__APP_VERSION__}`;
  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener('click', () => {
      checkForUpdate({ manual: true, onStatus: (m) => { if (updateStatusEl) updateStatusEl.textContent = m; } });
    });
  }

  // 4. Check Saved Playlists on Boot
  try {
    const { playlists, activeId } = await getPlaylists();
    if (!playlists || playlists.length === 0) {
      showLogin();
    } else if (playlists.length === 1) {
      // Only one playlist — no point showing a one-row picker. Go straight in,
      // loading from cache when we have it (a re-sync would be the slow part).
      await autoEnterSinglePlaylist(playlists[0].id, activeId);
    } else {
      showPlaylistSelect(playlists, localStorage.getItem('last_playlist_id') || activeId);
    }
  } catch (err) {
    console.error('Failed to initialize app session:', err);
    showLogin();
  }
}

// ==========================================================================
// TABS & VIEW ROUTER
// ==========================================================================
async function switchTab(tabId) {
  if (tabId !== 'series' || state.activeTab === 'series') {
    exitSeriesPlaybackDashboard();
  }
  state.activeTab = tabId;
  state.activeCategory = null;

  // Toggle tab buttons class
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Toggle visible panels
  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `${tabId}-view`);
  });

  // Load left categories and main content area
  await loadTabCategoriesAndContent();
}

async function loadTabCategoriesAndContent() {
  try {
    // 1. Fetch categories for tab
    const res = await getCategories(state.activeTab);
    
    // Sync counts
    state.counts.favorites = res.counts.favorites || 0;
    state.counts.recently_viewed = res.counts.recently_viewed || 0;
    
    document.getElementById('count-favorites').textContent = state.counts.favorites;
    document.getElementById('count-recently-viewed').textContent = state.counts.recently_viewed;

    // 2. Render categories sidebar list
    renderCategoriesList(res.categories);

    // 3. Auto-load the "All" category for movies and series, but show selection hint for live TV
    // (Live TV can contain thousands of channels, making startup crawl).
    if (state.activeTab === 'movies' || state.activeTab === 'series') {
      await selectCategory('all');
      refreshContinueWatching(); // Continue Watching row (movies / series only)
    } else {
      showSelectCategoryHint();
    }

    // TV Navigation: default focus categories
    navigation.focusDefault('categories');
  } catch (err) {
    console.error('Failed to load categories/content:', err);
  }
}

// Placeholder shown in the content area until the user picks a category
// (we no longer auto-load the big "All" category on startup).
function showSelectCategoryHint() {
  const hint = '<div class="select-category-hint">Select a category to load content</div>';
  if (state.activeTab === 'live') {
    const chList = document.getElementById('epg-channels-list');
    const progRows = document.getElementById('epg-programs-rows');
    if (chList) chList.innerHTML = hint;
    if (progRows) progRows.innerHTML = '';
    const visibleCount = document.getElementById('epg-visible-count');
    if (visibleCount) visibleCount.textContent = '(0)';
  } else if (state.activeTab === 'movies') {
    const grid = document.getElementById('movies-grid');
    if (grid) grid.innerHTML = hint;
  } else if (state.activeTab === 'series') {
    const grid = document.getElementById('series-grid');
    if (grid) grid.innerHTML = hint;
  }
}

function showCategoryLoading() {
  const message = '<div class="select-category-hint">Loading content...</div>';
  if (state.activeTab === 'live') {
    const chList = document.getElementById('epg-channels-list');
    const progRows = document.getElementById('epg-programs-rows');
    if (chList) chList.innerHTML = message;
    if (progRows) progRows.innerHTML = '';
    const visibleCount = document.getElementById('epg-visible-count');
    if (visibleCount) visibleCount.textContent = '(0)';
  } else {
    const grid = document.getElementById(state.activeTab === 'movies' ? 'movies-grid' : 'series-grid');
    if (grid) grid.innerHTML = message;
  }
}

function showCategoryLoadError() {
  const message = '<div class="select-category-hint">Unable to load this category. Try again.</div>';
  if (state.activeTab === 'live') {
    const chList = document.getElementById('epg-channels-list');
    const progRows = document.getElementById('epg-programs-rows');
    if (chList) chList.innerHTML = message;
    if (progRows) progRows.innerHTML = '';
    const visibleCount = document.getElementById('epg-visible-count');
    if (visibleCount) visibleCount.textContent = '(0)';
  } else {
    const grid = document.getElementById(state.activeTab === 'movies' ? 'movies-grid' : 'series-grid');
    if (grid) grid.innerHTML = message;
  }
}

// Render the categories side panel list
function renderCategoriesList(categories) {
  const container = document.getElementById('categories-list');
  container.innerHTML = '';

  // Add "All" node
  const allNode = document.createElement('div');
  allNode.className = `category-item ${state.activeCategory === 'all' ? 'active' : ''}`;
  allNode.dataset.category = 'all';
  allNode.setAttribute('role', 'button');
  allNode.tabIndex = 0;
  
  let totalStreams = 0;
  categories.forEach(c => totalStreams += (c.count || 0));

  allNode.innerHTML = `
    <span class="cat-label">All ${state.activeTab === 'live' ? 'channels' : state.activeTab === 'movies' ? 'movies' : 'series'}</span>
    <span class="cat-count">${totalStreams}</span>
  `;
  container.appendChild(allNode);

  // Apply the chosen sort (the "All" node always stays pinned at the top).
  const sorted = sortCategories(categories, state.categorySort);

  // Add dynamic categories
  sorted.forEach(cat => {
    const item = document.createElement('div');
    item.className = `category-item ${state.activeCategory === String(cat.category_id) ? 'active' : ''}`;
    item.dataset.category = String(cat.category_id);
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.innerHTML = `
      <span class="cat-label">${cat.category_name}</span>
      <span class="cat-count">${cat.count || 0}</span>
    `;
    container.appendChild(item);
  });

  // Update categories total count text
  document.getElementById('categories-count-total').textContent = categories.length;

  // Remember the current tab's categories (used to look up names/counts for the
  // pinned-category shortcuts) and refresh the pinned list in the top section.
  state.lastCategories = categories;
  renderPinnedCategories();

  // Re-apply any active category search filter after a re-render.
  applyCategorySearch();
}

// ==========================================================================
// CATEGORY SEARCH + SORT
// ==========================================================================
const CATEGORY_SORTS = [
  { value: 'default', label: 'Default' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'count', label: 'Count (High–Low)' }
];

function sortCategories(categories, sort) {
  const list = [...categories];
  if (sort === 'name') {
    list.sort((a, b) => (a.category_name || '').localeCompare(b.category_name || ''));
  } else if (sort === 'count') {
    list.sort((a, b) => (b.count || 0) - (a.count || 0));
  }
  return list; // 'default' keeps the provider's original order
}

// Hide categories that don't match the current search query.
function applyCategorySearch() {
  const query = (state.categorySearch || '').toLowerCase();
  document.querySelectorAll('#categories-list .category-item').forEach(item => {
    if (item.dataset.category === 'all') return; // always keep "All"
    const label = item.querySelector('.cat-label')?.textContent.toLowerCase() || '';
    item.classList.toggle('hidden', !label.includes(query));
  });
}

// ==========================================================================
// PINNED CATEGORIES (top-section shortcuts to favourite categories)
// Pinned per tab in localStorage; rendered under "Recently Viewed" so the
// user's favourite categories are reachable without scrolling the long list.
// ==========================================================================
const RESERVED_PINS = ['all', 'favorites', 'recordings', 'recently_viewed'];

function getPinnedStore() {
  try { return JSON.parse(localStorage.getItem('pinned_categories') || '{}'); }
  catch (e) { return {}; }
}

// Categories differ from playlist to playlist, so pins are keyed by both the
// active playlist id and the tab.
function getCurrentPlaylistId() {
  return state.activePlaylistId || localStorage.getItem('last_playlist_id') || 'default';
}

function pinKey(tab = state.activeTab) {
  return `${getCurrentPlaylistId()}::${tab}`;
}

function getPinnedForTab(tab = state.activeTab) {
  const store = getPinnedStore();
  const list = store[pinKey(tab)];
  return Array.isArray(list) ? list : [];
}

function savePinnedForTab(list, tab = state.activeTab) {
  const store = getPinnedStore();
  store[pinKey(tab)] = list;
  localStorage.setItem('pinned_categories', JSON.stringify(store));
}

function isCategoryPinned(id, tab = state.activeTab) {
  return getPinnedForTab(tab).some(p => String(p.id) === String(id));
}

function togglePinCategory(id, name, tab = state.activeTab) {
  id = String(id);
  let list = getPinnedForTab(tab);
  if (list.some(p => String(p.id) === id)) {
    list = list.filter(p => String(p.id) !== id);
    showToast(`Unpinned “${name}” from top`, 'info');
  } else {
    list.push({ id, name });
    showToast(`Pinned “${name}” to top`, 'success');
  }
  savePinnedForTab(list, tab);
  renderPinnedCategories();
}

function renderPinnedCategories() {
  const list = document.getElementById('sidebar-pin-list');
  if (!list) return;
  // Clear previously rendered pinned-category rows (keep the static pins).
  list.querySelectorAll('.pin-item.pinned-category').forEach(el => el.remove());

  const cats = state.lastCategories || [];
  getPinnedForTab().forEach(p => {
    const cat = cats.find(c => String(c.category_id) === String(p.id));
    const name = cat ? cat.category_name : p.name;
    const count = cat ? (cat.count || 0) : '';
    const li = document.createElement('li');
    li.className = 'pin-item pinned-category' + (state.activeCategory === String(p.id) ? ' active' : '');
    li.dataset.category = String(p.id);
    li.setAttribute('role', 'button');
    li.tabIndex = 0;
    li.innerHTML = `
      <span class="pin-label"><i data-lucide="pin" class="pin-icon-filled"></i> ${name}</span>
      <span class="pin-count">${count}</span>`;
    list.appendChild(li);
  });
  if (window.lucide) lucide.createIcons({ scope: list });
}

// Audio & Subtitle track picker for the player (remote/D-pad friendly).
window.openPlayerTrackMenu = function () {
  const p = window.playerInstance;
  if (!p || typeof p.getTrackMenu !== 'function') return;
  const { audio, subs } = p.getTrackMenu();

  const options = [];
  if (audio.length > 1) {
    audio.forEach(a => options.push({ value: a.id, label: `Audio: ${a.label}${a.active ? '  ✓' : ''}` }));
  }
  // Subtitles always offered (Off + any available tracks) when there's a choice.
  if (subs.length > 1) {
    subs.forEach(s => options.push({
      value: s.id,
      label: `${s.id === 'sub:off' ? 'Subtitles: Off' : 'Subtitle: ' + s.label}${s.active ? '  ✓' : ''}`
    }));
  }

  if (options.length === 0) {
    showToast('No alternate audio or subtitle tracks', 'info');
    return;
  }

  openSortDropdown({
    title: 'Audio & Subtitles',
    options,
    onSelect: (v) => {
      p.applyTrack(v);
      navigation.focusDefault('player');
    }
  });
};

// ==========================================================================
// SLEEP TIMER — stop playback after a chosen number of minutes.
// ==========================================================================
let sleepTimerId = null;
function setSleepTimer(minutes) {
  clearTimeout(sleepTimerId);
  sleepTimerId = null;
  const statusEl = document.getElementById('settings-sleep-status');
  if (!minutes) {
    if (statusEl) statusEl.textContent = 'Off';
    return;
  }
  sleepTimerId = setTimeout(() => {
    try { if (playerInstance) playerInstance.stop(); } catch (e) {}
    showToast('Sleep timer: playback stopped', 'info', 6000);
    const sel = document.getElementById('settings-sleep-timer');
    if (sel) sel.value = '0';
    if (statusEl) statusEl.textContent = 'Off';
    sleepTimerId = null;
  }, minutes * 60000);
  const endsAt = new Date(Date.now() + minutes * 60000)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (statusEl) statusEl.textContent = `Playback will stop at ${endsAt}`;
  showToast(`Sleep timer set for ${minutes} min`, 'success');
}

// ==========================================================================
// CHANNEL VIEW COUNTS (for "Most Viewed" sort) + PINNED CHANNELS
// Both are kept per-playlist in localStorage, like pinned categories.
// ==========================================================================
function getChannelViewCounts() {
  try {
    const all = JSON.parse(localStorage.getItem('channel_view_counts') || '{}');
    return all[getCurrentPlaylistId()] || {};
  } catch (e) { return {}; }
}
window.getChannelViewCounts = getChannelViewCounts;

function incrementChannelView(streamId) {
  if (streamId == null) return;
  try {
    const all = JSON.parse(localStorage.getItem('channel_view_counts') || '{}');
    const pid = getCurrentPlaylistId();
    all[pid] = all[pid] || {};
    all[pid][String(streamId)] = (all[pid][String(streamId)] || 0) + 1;
    localStorage.setItem('channel_view_counts', JSON.stringify(all));
  } catch (e) {}
}

function getPinnedChannelsStore() {
  try { return JSON.parse(localStorage.getItem('pinned_channels') || '{}'); }
  catch (e) { return {}; }
}
function getPinnedChannels() {
  const store = getPinnedChannelsStore();
  const list = store[getCurrentPlaylistId()];
  return Array.isArray(list) ? list : [];
}
window.getPinnedChannels = getPinnedChannels;

function isChannelPinned(id) {
  return getPinnedChannels().some(x => String(x) === String(id));
}
function togglePinChannel(id, name) {
  id = String(id);
  const store = getPinnedChannelsStore();
  const pid = getCurrentPlaylistId();
  let list = Array.isArray(store[pid]) ? store[pid] : [];
  if (list.some(x => String(x) === id)) {
    list = list.filter(x => String(x) !== id);
    showToast(`Unpinned “${name}”`, 'info');
  } else {
    list.push(id);
    showToast(`Pinned “${name}” to top`, 'success');
  }
  store[pid] = list;
  localStorage.setItem('pinned_channels', JSON.stringify(store));
  if (epgGridInstance) epgGridInstance.render();
}

// Pin/unpin menu for a focused/right-clicked channel row in the live guide.
window.openChannelPinMenu = function (rowEl) {
  if (!rowEl) return;
  const id = rowEl.dataset.streamId;
  if (!id) return;
  const name = rowEl.querySelector('.epg-channel-name-text')?.textContent?.trim() || 'Channel';
  const pinned = isChannelPinned(id);
  openSortDropdown({
    title: name,
    options: [{ value: 'toggle', label: pinned ? 'Unpin from top' : 'Pin to top' }],
    onSelect: () => {
      togglePinChannel(id, name);
      const again = document.querySelector(`.epg-channel-row[data-stream-id="${id}"]`);
      if (again) navigation.setFocus('channels', again);
      else navigation.focusDefault('channels');
    }
  });
};

// Open the pin/unpin action menu for a focused category (remote MENU key or
// right-click). Reuses the D-pad-navigable dropdown overlay.
window.openCategoryPinMenu = function (el) {
  if (!el) return;
  const id = el.dataset.category;
  if (!id || RESERVED_PINS.includes(id)) return; // can't pin the built-in shortcuts
  const name = (el.querySelector('.cat-label') || el.querySelector('.pin-label'))?.textContent?.trim() || 'Category';
  const pinned = isCategoryPinned(id);
  openSortDropdown({
    title: name,
    options: [{ value: 'toggle', label: pinned ? 'Unpin from top' : 'Pin to top' }],
    onSelect: () => {
      togglePinCategory(id, name);
      // Restore D-pad focus to the row (or the sidebar if the row was removed).
      if (document.body.contains(el)) navigation.setFocus('categories', el);
      else navigation.focusDefault('categories');
    }
  });
};

document.getElementById('categories-list')?.addEventListener('click', (event) => {
  const item = event.target.closest('.category-item');
  if (!item) return;
  selectCategory(item.dataset.category);
});

async function selectCategory(categoryId) {
  if (!categoryId) return;
  state.activeCategory = categoryId;
  
  // Highlight in list
  document.querySelectorAll('.category-item').forEach(item => {
    item.classList.toggle('active', item.dataset.category === categoryId);
  });

  // Highlight pins in list
  document.querySelectorAll('.pin-item').forEach(item => {
    item.classList.toggle('active', item.dataset.category === categoryId);
  });

  // Sync TV Focus
  const targetEl = document.querySelector(`.category-item[data-category="${categoryId}"]`) || 
                   document.querySelector(`.pin-item[data-category="${categoryId}"]`);
  if (targetEl) {
    navigation.setFocus('categories', targetEl);
  }

  // Close mobile sidebar drawer if open
  const appContainer = document.getElementById('app-container');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (appContainer && appContainer.classList.contains('sidebar-open')) {
    appContainer.classList.remove('sidebar-open');
    if (backdrop) backdrop.classList.add('hidden');
  }

  try {
    showCategoryLoading();
    await loadCategoryContent();
  } catch (err) {
    console.error('Failed to load category content:', err);
    showCategoryLoadError();
  }
}

async function loadCategoryContent() {
  if (state.activeTab === 'live') {
    // Live view: Fetch all streams for selected category and feed to EPG Grid
    // (EPG doesn't paginate internally because guide requires full list of active channels in timeline)
    const res = await getStreams({
      type: 'live',
      categoryId: state.activeCategory,
      page: 1,
      limit: 1000, // Load top 1000 channels of category to prevent browser layout crash
      search: ''
    });
    
    epgGridInstance.setChannels(res.items);
  } else if (state.activeTab === 'movies') {
    state.movies.categoryId = state.activeCategory;
    state.movies.page = 1;
    await loadMoviesGrid();
  } else if (state.activeTab === 'series') {
    state.series.categoryId = state.activeCategory;
    state.series.page = 1;
    await loadSeriesGrid();
  }
}

// ==========================================================================
// LIVE TV CONTROLS & STREAMING
// ==========================================================================
async function selectAndPlayChannel(channel, programBlock) {
  state.activeChannel = channel;
  state.activeProgram = programBlock;

  // Track history
  try {
    incrementChannelView(channel.stream_id); // local tally for the "Most Viewed" sort
    await trackPlayback(channel.stream_id);
    state.counts.recently_viewed = Math.min(50, state.counts.recently_viewed + 1);
    document.getElementById('count-recently-viewed').textContent = state.counts.recently_viewed;
  } catch (err) {
    console.warn('History tracking failed:', err);
  }

  // Live playback uses the Live-TV layout, never the VOD overlay.
  document.body.classList.remove('vod-mode');

  // Get stream URL (direct or proxy based on settings)
  try {
    const epgTitle = programBlock?.title || 'No Information';
    const streamUrl = await getStreamUrl(channel.stream_id, 'live');

    // Load to player
    playerInstance.setSeriesMode(false);
    playerInstance.loadStream(streamUrl, channel.name, channel.stream_icon, epgTitle);

    // Remember what's playing so the Cast button can send it to a TV (live → HLS).
    setCastContext({ streamId: channel.stream_id, type: 'live', title: channel.name, isLive: true });

    // If the primary (.ts) stream fails, fall back once to the m3u8 backup.
    liveFallbackTried = false;
    playerInstance.onFatalError = async () => {
      if (liveFallbackTried) return;
      liveFallbackTried = true;
      console.warn('Primary (.ts) stream failed — falling back to m3u8…');
      try {
        const fbUrl = await getStreamUrl(channel.stream_id, 'live', '', 'm3u8');
        playerInstance.setSeriesMode(false);
        playerInstance.loadStream(fbUrl, channel.name, channel.stream_icon, epgTitle);
      } catch (e) {
        console.error('m3u8 fallback failed:', e);
      }
    };

    // Show the channel-info banner with a short lineup (prev / current / next 2)
    const channelList = epgGridInstance?.channels || [];
    const currentIndex = channelList.findIndex(c => String(c.stream_id) === String(channel.stream_id));
    playerInstance.showChannelInfo(channel, channelList, currentIndex);

    // Show the one-line now/next guide for the current channel (cable-box style)
    const { current, next } = epgGridInstance?.getNowNext(channel.stream_id) || {};
    playerInstance.showProgramGuide(current || programBlock, next);

    // Automatically enter fullscreen
    playerInstance.autoFullscreen();

    // Set navigation focus to player zone
    navigation.focusDefault('player');

    // Update frontend Details Panel
    updateDetailsPanel(channel, programBlock);
  } catch (err) {
    console.error('Failed to start channel playback:', err);
    alert(`Could not start stream: ${err.message}`);
  }
}

function updateDetailsPanel(channel, program) {
  const channelIcon = document.getElementById('detail-channel-icon');
  const channelName = document.getElementById('detail-channel-name');
  const categoryName = document.getElementById('detail-category-name');
  const favBtn = document.getElementById('detail-favorite-btn');
  const favIcon = document.getElementById('detail-favorite-icon');

  const progTitle = document.getElementById('detail-program-title');
  const progTime = document.getElementById('detail-program-time');
  const progDesc = document.getElementById('detail-program-desc');
  const progProgress = document.getElementById('detail-program-progress');

  // Setup Logo
  if (channel.stream_icon) {
    channelIcon.src = channel.stream_icon;
    channelIcon.classList.remove('fallback-logo');
  } else {
    channelIcon.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%234b5563" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="4"/></svg>';
    channelIcon.classList.add('fallback-logo');
  }

  channelName.textContent = channel.name || 'Live TV Channel';
  
  // Find category name
  const catItem = document.querySelector(`.category-item[data-category="${channel.category_id}"]`);
  categoryName.textContent = catItem ? catItem.querySelector('.cat-label').textContent : 'Live TV';

  // Favorite button state
  const isFav = window.isChannelFavorite('live', channel.stream_id);
  favBtn.classList.toggle('favorited', isFav);
  
  // Set programs details
  const progInfoContainer = document.querySelector('.details-program-info');
  const hasValidProgram = program && program.title && program.title !== 'No information available';

  if (hasValidProgram) {
    if (progInfoContainer) progInfoContainer.classList.remove('hidden');
    progTitle.textContent = program.title || 'No Information';
    
    const startMs = parseInt(program.start_timestamp) * 1000;
    const endMs = parseInt(program.end_timestamp) * 1000;
    const startStr = new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const endStr = new Date(endMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    progTime.textContent = `${startStr} - ${endStr}`;
    
    progDesc.textContent = program.description || 'No program details available.';

    // Setup Progress Bar Auto Update
    clearInterval(progressInterval);
    const updateProgress = () => {
      const total = endMs - startMs;
      const elapsed = Date.now() - startMs;
      const pct = Math.max(0, Math.min(100, (elapsed / total) * 100));
      progProgress.style.width = `${pct}%`;
    };
    updateProgress();
    progressInterval = setInterval(updateProgress, 30000); // update progress bar every 30s
  } else {
    if (progInfoContainer) progInfoContainer.classList.add('hidden');
    progTitle.textContent = 'No Schedule Data';
    progTime.textContent = '12:00 AM - 12:00 AM';
    progDesc.textContent = 'No program details available.';
    progProgress.style.width = '0%';
    clearInterval(progressInterval);
  }
}

async function toggleChannelFavorite(type, id) {
  try {
    const res = await toggleFavorite(type, id);
    if (res.success) {
      if (res.isFavorite) {
        if (!state.favorites[type]) state.favorites[type] = [];
        state.favorites[type].push(String(id));
      } else {
        state.favorites[type] = state.favorites[type].filter(x => x !== String(id));
      }
      
      // Update sidebar badge
      state.counts.favorites = state.favorites[type].length;
      document.getElementById('count-favorites').textContent = state.counts.favorites;

      // Update active controls
      if (state.activeChannel && String(state.activeChannel.stream_id) === String(id)) {
        document.getElementById('detail-favorite-btn').classList.toggle('favorited', res.isFavorite);
      }

      // Update guide icons
      epgGridInstance.updateFavoritesHighlighting();

      // Refresh list if we are currently viewing the favorites category
      if (state.activeCategory === 'favorites') {
        await loadCategoryContent();
      }
    }
  } catch (err) {
    console.error('Toggle favorite failed:', err);
  }
}

function playNextChannel() {
  if (!state.activeChannel) return;
  const list = epgGridInstance.channels;
  const currentIndex = list.findIndex(c => String(c.stream_id) === String(state.activeChannel.stream_id));
  if (currentIndex !== -1 && currentIndex < list.length - 1) {
    const nextChan = list[currentIndex + 1];
    const targetRow = document.querySelector(`.epg-channel-row[data-stream-id="${nextChan.stream_id}"]`);
    if (targetRow) targetRow.click();
  }
}

function playPreviousChannel() {
  if (!state.activeChannel) return;
  const list = epgGridInstance.channels;
  const currentIndex = list.findIndex(c => String(c.stream_id) === String(state.activeChannel.stream_id));
  if (currentIndex > 0) {
    const prevChan = list[currentIndex - 1];
    const targetRow = document.querySelector(`.epg-channel-row[data-stream-id="${prevChan.stream_id}"]`);
    if (targetRow) targetRow.click();
  }
}

// ==========================================================================
// MOVIES VIEW (VOD)
// ==========================================================================
async function loadMoviesGrid() {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '<div class="spinner-center"><div class="spinner"></div></div>';

  try {
    const res = await getStreams({
      type: 'movie',
      categoryId: state.movies.categoryId,
      page: state.movies.page,
      limit: state.movies.limit,
      search: state.movies.search,
      sort: state.movies.sort
    });

    renderMoviesCatalog(res.items);
    renderPagination('movies', res.pagination);
  } catch (err) {
    grid.innerHTML = `<div class="error-msg">Failed to load movies: ${err.message}</div>`;
  }
}

function renderMoviesCatalog(movies) {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '';

  if (movies.length === 0) {
    grid.innerHTML = '<div class="no-results">No movies found in this category.</div>';
    return;
  }

  movies.forEach(movie => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    
    const rating = parseFloat(movie.rating) || 0;
    const year = movie.year || movie.releaseDate || 'N/A';
    const logo = movie.stream_icon || '';

    card.innerHTML = `
      <div class="vod-poster-wrapper">
        ${logo ? `<img src="${logo}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22150%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%221%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%222%22/></svg>'">` : '<div class="poster-placeholder"><i data-lucide="film"></i></div>'}
        <div class="vod-card-overlay">
          <span class="vod-card-year">${year}</span>
          ${rating > 0 ? `<span class="vod-rating-badge"><i data-lucide="star"></i>${rating.toFixed(1)}</span>` : ''}
        </div>
      </div>
      <span class="vod-card-title">${movie.name}</span>
    `;

    card.addEventListener('click', () => {
      navigation.setFocus('grid', card);
      openVODDetailsModal(movie, 'movie');
    });
    grid.appendChild(card);
  });
  
  lucide.createIcons({ scope: grid });
  if (navigation.currentZone === 'grid') {
    navigation.focusDefault('grid');
  }
  navigation.triggerPendingFocus();
}

// ==========================================================================
// SERIES VIEW (VOD)
// ==========================================================================
async function loadSeriesGrid() {
  const grid = document.getElementById('series-grid');
  grid.innerHTML = '<div class="spinner-center"><div class="spinner"></div></div>';

  try {
    const res = await getStreams({
      type: 'series',
      categoryId: state.series.categoryId,
      page: state.series.page,
      limit: state.series.limit,
      search: state.series.search,
      sort: state.series.sort
    });

    renderSeriesCatalog(res.items);
    renderPagination('series', res.pagination);
  } catch (err) {
    grid.innerHTML = `<div class="error-msg">Failed to load series: ${err.message}</div>`;
  }
}

function renderSeriesCatalog(seriesList) {
  const grid = document.getElementById('series-grid');
  grid.innerHTML = '';

  if (seriesList.length === 0) {
    grid.innerHTML = '<div class="no-results">No series found in this category.</div>';
    return;
  }

  seriesList.forEach(series => {
    const card = document.createElement('div');
    card.className = 'vod-card';
    
    const rating = parseFloat(series.rating) || 0;
    const year = series.releaseDate || 'N/A';
    // Series posters live in `cover`/`cover_big`; `stream_icon` is movies-only.
    const logo = series.stream_icon || series.cover || series.cover_big || '';

    card.innerHTML = `
      <div class="vod-poster-wrapper">
        ${logo ? `<img src="${logo}" alt="" loading="lazy" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22150%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%221%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%222%22/></svg>'">` : '<div class="poster-placeholder"><i data-lucide="tv"></i></div>'}
        <div class="vod-card-overlay">
          <span class="vod-card-year">${year}</span>
          ${rating > 0 ? `<span class="vod-rating-badge"><i data-lucide="star"></i>${rating.toFixed(1)}</span>` : ''}
        </div>
      </div>
      <span class="vod-card-title">${series.name}</span>
    `;

    // In Xtream Codes, TV Series items contain series_id instead of stream_id
    card.addEventListener('click', () => {
      navigation.setFocus('grid', card);
      openSeriesPlaybackDashboard(series);
    });
    grid.appendChild(card);
  });

  lucide.createIcons({ scope: grid });
  if (navigation.currentZone === 'grid') {
    navigation.focusDefault('grid');
  }
  navigation.triggerPendingFocus();
}

// TV Series Playback Dashboard controllers
async function openSeriesPlaybackDashboard(series, resumeOpts = null) {
  const playbackContainer = document.getElementById('series-playback-container');
  const catalogContainer = document.getElementById('series-catalog-container');

  if (!playbackContainer || !catalogContainer) return;

  // Remember series metadata for Continue Watching entries.
  state.currentSeriesMeta = {
    id: series.series_id,
    name: series.name,
    cover: series.stream_icon || series.cover || series.cover_big || ''
  };

  const title = document.getElementById('series-title');
  const rating = document.getElementById('series-rating');
  const yearBadge = document.getElementById('series-year');
  const coverImg = document.getElementById('series-cover-img');
  const plot = document.getElementById('series-plot');
  const select = document.getElementById('series-season-select');
  const episodesList = document.getElementById('series-episodes-list');
  const countNum = document.getElementById('series-episodes-count-num');
  
  if (title) title.textContent = series.name;
  if (rating) rating.innerHTML = `<i data-lucide="star"></i> ${parseFloat(series.rating)?.toFixed(1) || 'N/A'}`;
  if (yearBadge) yearBadge.textContent = series.releaseDate || series.year || 'N/A';
  if (coverImg) coverImg.src = series.stream_icon || series.cover || series.cover_big || '';
  if (plot) plot.textContent = 'Loading description details...';
  if (select) select.innerHTML = '';
  if (episodesList) episodesList.innerHTML = '<div class="spinner-center"><div class="spinner"></div></div>';
  if (countNum) countNum.textContent = '(0)';
  
  catalogContainer.classList.add('hidden');
  playbackContainer.classList.remove('hidden');
  
  // Relocate #video-container dynamically to series player wrapper
  const videoContainer = document.getElementById('video-container');
  const seriesPlayerWrapper = document.querySelector('.series-player-wrapper');
  if (videoContainer && seriesPlayerWrapper) {
    seriesPlayerWrapper.appendChild(videoContainer);
  }
  
  if (rating) lucide.createIcons({ scope: rating });
  
  if (playerInstance) {
    playerInstance.setOnPrevChannel(() => playPreviousEpisode());
    playerInstance.setOnNextChannel(() => playNextEpisode());
    playerInstance.onExitVod = () => {
      exitSeriesPlaybackDashboard();
    };
    playerInstance.onVideoEnded = () => {
      playNextEpisode();
    };
  }
  
  try {
    const info = await getStreamInfo(series.series_id, 'series');
    const infoMeta = info.info || {};
    
    if (plot) plot.textContent = infoMeta.plot || infoMeta.description || 'No summary available.';
    if (yearBadge) yearBadge.textContent = infoMeta.releasedate || infoMeta.releaseDate || infoMeta.year || yearBadge.textContent;
    
    const episodesMap = info.episodes || {};
    const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
    
    if (seasons.length === 0) {
      if (episodesList) episodesList.innerHTML = '<div class="no-results">No episodes available.</div>';
      return;
    }
    
    if (select) {
      seasons.forEach(seasonNum => {
        const opt = document.createElement('option');
        opt.value = seasonNum;
        opt.textContent = `Season ${seasonNum}`;
        select.appendChild(opt);
      });
    }
    
    const loadSeasonEpisodes = (seasonNum) => {
      if (!episodesList) return;
      episodesList.innerHTML = '';
      const episodes = episodesMap[seasonNum] || [];
      if (countNum) countNum.textContent = `(${episodes.length})`;
      
      if (episodes.length === 0) {
        episodesList.innerHTML = '<div class="no-results">No episodes in this season.</div>';
        return;
      }
      
      episodes.forEach((ep, epIdx) => {
        const row = document.createElement('div');
        row.className = 'episode-list-row';
        row.dataset.episodeId = ep.id;
        row.innerHTML = `
          <div class="episode-row-left-details">
            <span class="episode-row-title-text">Ep ${ep.episode_num || '0'}: ${ep.title || 'Episode'}</span>
            <span class="episode-row-duration-text">Duration: ${ep.info?.duration || 'N/A'}</span>
          </div>
          <i data-lucide="play-circle" class="episode-row-play-icon"></i>
        `;
        
        row.addEventListener('click', async () => {
          document.querySelectorAll('.episode-list-row').forEach(r => r.classList.remove('active'));
          row.classList.add('active');
          
          const epStreamId = ep.id;
          const epExt = ep.container_extension || ep.info?.container_extension || '';
          const epName = `${infoMeta.name || 'Series'} - S${seasonNum}E${ep.episode_num}: ${ep.title}`;
          
          await playSeriesEpisode(epStreamId, epName, infoMeta.cover, ep.info?.plot || '', epExt, epIdx, episodes, seasonNum, info);
        });
        
        episodesList.appendChild(row);
      });
      
      lucide.createIcons({ scope: episodesList });
    };
    
    if (select) {
      select.onchange = (e) => loadSeasonEpisodes(e.target.value);
    }

    // Resume a specific episode (from Continue Watching), else load season 1.
    if (resumeOpts && resumeOpts.episodeId) {
      const rSeason = episodesMap[resumeOpts.season] ? String(resumeOpts.season) : seasons[0];
      if (select) select.value = rSeason;
      loadSeasonEpisodes(rSeason);
      const epsArr = episodesMap[rSeason] || [];
      const idx = epsArr.findIndex(e => String(e.id) === String(resumeOpts.episodeId));
      if (idx !== -1) {
        const ep = epsArr[idx];
        const epExt = ep.container_extension || ep.info?.container_extension || '';
        const epName = `${infoMeta.name || series.name || 'Series'} - S${rSeason}E${ep.episode_num}: ${ep.title}`;
        const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${ep.id}"]`);
        if (targetRow) {
          document.querySelectorAll('.episode-list-row').forEach(r => r.classList.remove('active'));
          targetRow.classList.add('active');
        }
        await playSeriesEpisode(ep.id, epName, infoMeta.cover, ep.info?.plot || '', epExt, idx, epsArr, rSeason, info, resumeOpts.position || 0);
      }
    } else {
      loadSeasonEpisodes(seasons[0]);
      navigation.focusDefault('series-episodes');
    }

  } catch (err) {
    console.error('Failed to load Series details:', err);
    if (plot) plot.textContent = 'Failed to load details from server.';
    if (episodesList) episodesList.innerHTML = '<div class="error-msg">Failed to load episodes.</div>';
  }
}

async function playSeriesEpisode(epStreamId, epName, logo, plot, epExt, epIndex, episodesListForSeason, seasonNum, seriesInfo, resumeTime = 0) {
  if (!playerInstance) return;
  playerInstance.showSpinner();
  if (playerInstance.vodTitleTag) {
    playerInstance.vodTitleTag.textContent = epName || '';
  }

  state.seriesPlayback = {
    seriesInfo: seriesInfo,
    activeSeason: seasonNum,
    episodes: episodesListForSeason,
    currentIndex: epIndex
  };

  // Track this episode for Continue Watching.
  const ep = episodesListForSeason[epIndex] || {};
  const sm = state.currentSeriesMeta || {};
  currentVodItem = {
    id: String(epStreamId),
    type: 'series',
    name: epName,
    cardTitle: sm.name || seriesInfo.info?.name || 'Series',
    logo: sm.cover || logo || '',
    containerExtension: epExt,
    seriesId: sm.id,
    seriesName: sm.name || seriesInfo.info?.name || 'Series',
    season: String(seasonNum),
    episodeLabel: `S${seasonNum}E${ep.episode_num || (epIndex + 1)}`
  };
  lastProgressSave = 0;

  try {
    let playUrl;
    if (getIsServerMode()) {
      playUrl = await getStreamUrl(epStreamId, 'series', epExt);
    } else {
      playUrl = getStreamUrlSync(epStreamId, 'series', epExt);
    }
    playerInstance.setSeriesMode(true);
    playerInstance.loadStream(playUrl, epName, logo, '', true, resumeTime);

    setCastContext({ streamId: epStreamId, type: 'series', title: epName, isLive: false, ext: epExt });

    // Show Now/Next Episode bar for Series
    const currentEp = episodesListForSeason[epIndex];
    const currentEpTitle = `S${seasonNum}E${currentEp.episode_num || (epIndex + 1)}: ${currentEp.title || 'Episode'}`;
    
    let nextEpName = '';
    if (epIndex + 1 < episodesListForSeason.length) {
      const nextEp = episodesListForSeason[epIndex + 1];
      nextEpName = `S${seasonNum}E${nextEp.episode_num || (epIndex + 2)}: ${nextEp.title || 'Episode'}`;
    } else {
      const episodesMap = seriesInfo.episodes || {};
      const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
      const currentSeasonIdx = seasons.indexOf(String(seasonNum));
      if (currentSeasonIdx !== -1 && currentSeasonIdx + 1 < seasons.length) {
        const nextSeasonNum = seasons[currentSeasonIdx + 1];
        const nextSeasonEpisodes = episodesMap[nextSeasonNum] || [];
        if (nextSeasonEpisodes.length > 0) {
          const firstEp = nextSeasonEpisodes[0];
          nextEpName = `S${nextSeasonNum}E${firstEp.episode_num || 1}: ${firstEp.title || 'Episode'}`;
        }
      }
    }
    playerInstance.showSeriesNowNext(currentEpTitle, nextEpName);

    playerInstance.autoFullscreen();
  } catch (err) {
    console.error('Failed to play Series episode:', err);
    alert(`Failed to load stream: ${err.message}`);
    playerInstance.hideSpinner();
  }
}

async function playNextEpisode() {
  if (!state.seriesPlayback || !state.seriesPlayback.seriesInfo) return;
  
  const { seriesInfo, activeSeason, episodes, currentIndex } = state.seriesPlayback;
  const select = document.getElementById('series-season-select');
  
  if (currentIndex + 1 < episodes.length) {
    const nextEp = episodes[currentIndex + 1];
    
    const rows = document.querySelectorAll('.episode-list-row');
    rows.forEach(r => r.classList.remove('active'));
    const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${nextEp.id}"]`);
    if (targetRow) {
      targetRow.classList.add('active');
      targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    
    const epExt = nextEp.container_extension || nextEp.info?.container_extension || '';
    const epName = `${seriesInfo.info?.name || 'Series'} - S${activeSeason}E${nextEp.episode_num}: ${nextEp.title}`;
    await playSeriesEpisode(nextEp.id, epName, seriesInfo.info?.cover, nextEp.info?.plot || '', epExt, currentIndex + 1, episodes, activeSeason, seriesInfo);
  } else {
    const episodesMap = seriesInfo.episodes || {};
    const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
    const currentSeasonIdx = seasons.indexOf(String(activeSeason));
    
    if (currentSeasonIdx !== -1 && currentSeasonIdx + 1 < seasons.length) {
      const nextSeasonNum = seasons[currentSeasonIdx + 1];
      
      if (select) {
        select.value = nextSeasonNum;
      }
      
      const nextSeasonEpisodes = episodesMap[nextSeasonNum] || [];
      if (nextSeasonEpisodes.length > 0) {
        if (select) {
          const event = new Event('change');
          select.dispatchEvent(event);
        }
        
        const firstEp = nextSeasonEpisodes[0];
        setTimeout(async () => {
          const rows = document.querySelectorAll('.episode-list-row');
          rows.forEach(r => r.classList.remove('active'));
          const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${firstEp.id}"]`);
          if (targetRow) {
            targetRow.classList.add('active');
            targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          
          const epExt = firstEp.container_extension || firstEp.info?.container_extension || '';
          const epName = `${seriesInfo.info?.name || 'Series'} - S${nextSeasonNum}E${firstEp.episode_num}: ${firstEp.title}`;
          await playSeriesEpisode(firstEp.id, epName, seriesInfo.info?.cover, seriesInfo.info?.cover, epExt, 0, nextSeasonEpisodes, nextSeasonNum, seriesInfo);
        }, 100);
      }
    }
  }
}

async function playPreviousEpisode() {
  if (!state.seriesPlayback || !state.seriesPlayback.seriesInfo) return;
  
  const { seriesInfo, activeSeason, episodes, currentIndex } = state.seriesPlayback;
  const select = document.getElementById('series-season-select');
  
  if (currentIndex - 1 >= 0) {
    const prevEp = episodes[currentIndex - 1];
    
    const rows = document.querySelectorAll('.episode-list-row');
    rows.forEach(r => r.classList.remove('active'));
    const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${prevEp.id}"]`);
    if (targetRow) {
      targetRow.classList.add('active');
      targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    
    const epExt = prevEp.container_extension || prevEp.info?.container_extension || '';
    const epName = `${seriesInfo.info?.name || 'Series'} - S${activeSeason}E${prevEp.episode_num}: ${prevEp.title}`;
    await playSeriesEpisode(prevEp.id, epName, seriesInfo.info?.cover, seriesInfo.info?.cover, epExt, currentIndex - 1, episodes, activeSeason, seriesInfo);
  } else {
    const episodesMap = seriesInfo.episodes || {};
    const seasons = Object.keys(episodesMap).sort((a, b) => parseInt(a) - parseInt(b));
    const currentSeasonIdx = seasons.indexOf(String(activeSeason));
    
    if (currentSeasonIdx > 0) {
      const prevSeasonNum = seasons[currentSeasonIdx - 1];
      
      if (select) {
        select.value = prevSeasonNum;
      }
      
      const prevSeasonEpisodes = episodesMap[prevSeasonNum] || [];
      if (prevSeasonEpisodes.length > 0) {
        if (select) {
          const event = new Event('change');
          select.dispatchEvent(event);
        }
        
        const lastEpIdx = prevSeasonEpisodes.length - 1;
        const lastEp = prevSeasonEpisodes[lastEpIdx];
        
        setTimeout(async () => {
          const rows = document.querySelectorAll('.episode-list-row');
          rows.forEach(r => r.classList.remove('active'));
          const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${lastEp.id}"]`);
          if (targetRow) {
            targetRow.classList.add('active');
            targetRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
          
          const epExt = lastEp.container_extension || lastEp.info?.container_extension || '';
          const epName = `${seriesInfo.info?.name || 'Series'} - S${prevSeasonNum}E${lastEp.episode_num}: ${lastEp.title}`;
          await playSeriesEpisode(lastEp.id, epName, seriesInfo.info?.cover, seriesInfo.info?.cover, epExt, lastEpIdx, prevSeasonEpisodes, prevSeasonNum, seriesInfo);
        }, 100);
      }
    }
  }
}

function exitSeriesPlaybackDashboard() {
  const playbackContainer = document.getElementById('series-playback-container');
  const catalogContainer = document.getElementById('series-catalog-container');

  if (playbackContainer && !playbackContainer.classList.contains('hidden')) {
    flushProgress();
    currentVodItem = null;
    playbackContainer.classList.add('hidden');
    if (catalogContainer) catalogContainer.classList.remove('hidden');
    refreshContinueWatching();

    if (playerInstance) {
      playerInstance.stop();
      playerInstance.setOnPrevChannel(() => playPreviousChannel());
      playerInstance.setOnNextChannel(() => playNextChannel());
      playerInstance.onExitVod = exitVodPlayer;
      playerInstance.onVideoEnded = null;
    }
    
    const videoContainer = document.getElementById('video-container');
    const livePlayerWrapper = document.querySelector('#live-view .player-wrapper');
    if (videoContainer && livePlayerWrapper) {
      livePlayerWrapper.appendChild(videoContainer);
    }
    navigation.focusDefault('grid');
  }
}

// Render pagination buttons in catalog footers
function renderPagination(type, pagination) {
  const container = document.getElementById(`${type}-pagination`);
  container.innerHTML = '';

  if (!pagination || pagination.pages <= 1) return;

  const current = pagination.page;
  const maxPages = pagination.pages;

  // Draw first / prev buttons
  if (current > 1) {
    const firstBtn = document.createElement('button');
    firstBtn.className = 'page-btn';
    firstBtn.innerHTML = '<i data-lucide="chevrons-left"></i>';
    firstBtn.addEventListener('click', () => setPage(type, 1));
    container.appendChild(firstBtn);

    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.innerHTML = '<i data-lucide="chevron-left"></i>';
    prevBtn.addEventListener('click', () => setPage(type, current - 1));
    container.appendChild(prevBtn);
  }

  // Draw page numbers (sliding window of 5 pages)
  const windowSize = 5;
  let startPage = Math.max(1, current - Math.floor(windowSize / 2));
  let endPage = Math.min(maxPages, startPage + windowSize - 1);
  if (endPage - startPage + 1 < windowSize) {
    startPage = Math.max(1, endPage - windowSize + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    const pageBtn = document.createElement('button');
    pageBtn.className = `page-btn ${i === current ? 'active' : ''}`;
    pageBtn.textContent = i;
    pageBtn.addEventListener('click', () => setPage(type, i));
    container.appendChild(pageBtn);
  }

  // Draw next / last buttons
  if (current < maxPages) {
    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.innerHTML = '<i data-lucide="chevron-right"></i>';
    nextBtn.addEventListener('click', () => setPage(type, current + 1));
    container.appendChild(nextBtn);

    const lastBtn = document.createElement('button');
    lastBtn.className = 'page-btn';
    lastBtn.innerHTML = '<i data-lucide="chevrons-right"></i>';
    lastBtn.addEventListener('click', () => setPage(type, maxPages));
    container.appendChild(lastBtn);
  }

  lucide.createIcons({ scope: container });
}

function setPage(type, pageNum) {
  if (type === 'movies') {
    state.movies.page = pageNum;
    loadMoviesGrid();
  } else {
    state.series.page = pageNum;
    loadSeriesGrid();
  }
}

// ==========================================================================
// MOVIE & SERIES DETAILS MODALS
// ==========================================================================
async function openVODDetailsModal(vodData, type, resumeTime = 0) {
  const modal = document.getElementById('vod-modal');
  const title = document.getElementById('vod-modal-title');
  const rating = document.getElementById('vod-modal-rating');
  const poster = document.getElementById('vod-modal-poster');
  const genre = document.getElementById('vod-modal-genre');
  const release = document.getElementById('vod-modal-release');
  const duration = document.getElementById('vod-modal-duration');
  const plot = document.getElementById('vod-modal-plot');
  const director = document.getElementById('vod-modal-director');
  const cast = document.getElementById('vod-modal-cast');
  const playBtn = document.getElementById('vod-modal-play-btn');
  const seriesEpisodesContainer = document.getElementById('vod-series-episodes-container');

  // Clear modal values first
  title.textContent = vodData.name;
  rating.innerHTML = `<i data-lucide="star"></i> ${parseFloat(vodData.rating)?.toFixed(1) || 'N/A'}`;
  poster.src = vodData.stream_icon || vodData.cover || vodData.cover_big || '';
  genre.textContent = 'General';
  release.textContent = vodData.releaseDate || vodData.year || 'N/A';
  duration.textContent = 'N/A';
  plot.textContent = 'Loading description details...';
  director.textContent = 'Loading...';
  cast.textContent = 'Loading...';

  playBtn.classList.remove('hidden');
  seriesEpisodesContainer.classList.add('hidden');
  modal.classList.remove('hidden');
  navigation.focusDefault('modal');
  lucide.createIcons({ scope: rating });

  // Get dynamic ID (stream_id for movie, series_id for series)
  const queryId = type === 'series' ? vodData.series_id : vodData.stream_id;

  try {
    const info = await getStreamInfo(queryId, type);
    
    // Parse metadata
    const infoMeta = info.info || {};
    plot.textContent = infoMeta.plot || infoMeta.description || 'No summary available.';
    director.textContent = infoMeta.director || 'N/A';
    cast.textContent = infoMeta.cast || infoMeta.actors || 'N/A';
    release.textContent = infoMeta.releasedate || infoMeta.releaseDate || infoMeta.year || release.textContent;
    genre.textContent = infoMeta.genre || genre.textContent;

    if (type === 'movie') {
      const runTime = infoMeta.duration_secs ? `${Math.floor(infoMeta.duration_secs / 60)}m` : infoMeta.duration || 'N/A';
      duration.textContent = runTime;

      // Play Movie Action — "Resume" when there's saved progress, else "Play Now"
      const movieExt = info.movie_data?.container_extension || infoMeta.container_extension || '';
      playBtn.innerHTML = resumeTime > 0
        ? `<i data-lucide="play-circle"></i> Resume playing · ${formatClock(resumeTime)}`
        : `<i data-lucide="play-circle"></i> Play Now`;
      lucide.createIcons({ scope: playBtn });
      playBtn.onclick = async () => {
        modal.classList.add('hidden');
        await playVODStream(queryId, 'movie', vodData.name, vodData.stream_icon, plot.textContent, movieExt, resumeTime);
      };
    } else if (type === 'series') {
      // It's a Series, hide direct play button and show Episode Lists
      playBtn.classList.add('hidden');
      duration.textContent = `${info.seasons?.length || 0} Seasons`;
      
      seriesEpisodesContainer.classList.remove('hidden');
      renderSeriesSeasons(info);
    }
    
    // Refresh modal focus list since elements have loaded
    navigation.focusDefault('modal');
  } catch (err) {
    console.error('Failed to load VOD info:', err);
    plot.textContent = 'Failed to load details from server.';
    director.textContent = 'N/A';
    cast.textContent = 'N/A';
  }
}

// Populate series season selector and episodes list
function renderSeriesSeasons(seriesInfo) {
  const select = document.getElementById('seasons-dropdown');
  const episodesList = document.getElementById('episodes-list');
  select.innerHTML = '';
  episodesList.innerHTML = '';

  const episodesMap = seriesInfo.episodes || {};
  const seasons = Object.keys(episodesMap);

  if (seasons.length === 0) {
    episodesList.innerHTML = '<div class="no-results">No episodes available.</div>';
    return;
  }

  // Add options
  seasons.forEach(seasonNum => {
    const opt = document.createElement('option');
    opt.value = seasonNum;
    opt.textContent = `Season ${seasonNum}`;
    select.appendChild(opt);
  });

  // Render episodes on dropdown change
  const loadSeasonEpisodes = (seasonNum) => {
    episodesList.innerHTML = '';
    const episodes = episodesMap[seasonNum] || [];

    episodes.forEach(ep => {
      const row = document.createElement('div');
      row.className = 'episode-row';
      row.innerHTML = `
        <div class="episode-row-left">
          <span class="episode-title">Ep ${ep.episode_num || '0'}: ${ep.title || 'Episode'}</span>
          <span class="episode-meta">Duration: ${ep.info?.duration || 'N/A'}</span>
        </div>
        <i data-lucide="play-circle" class="episode-play-icon"></i>
      `;
      row.addEventListener('click', async () => {
        document.getElementById('vod-modal').classList.add('hidden');
        
        // Each episode is its own stream: identified by ep.id and played from a
        // file with its own container extension (mp4/mkv/…).
        const epStreamId = ep.id;
        const epExt = ep.container_extension || ep.info?.container_extension || '';
        const epName = `${seriesInfo.info?.name || 'Series'} - S${seasonNum}E${ep.episode_num}: ${ep.title}`;
        await playVODStream(epStreamId, 'series', epName, seriesInfo.info?.cover, ep.info?.plot || '', epExt);
      });
      episodesList.appendChild(row);
    });

    lucide.createIcons({ scope: episodesList });
  };

  select.onchange = (e) => loadSeasonEpisodes(e.target.value);
  
  // Initial load season 1
  loadSeasonEpisodes(seasons[0]);
}

async function playVODStream(streamId, type, name, logo, description, containerExtension = '', resumeTime = 0) {
  // Track this movie for Continue Watching.
  currentVodItem = { id: String(streamId), type: 'movie', name, cardTitle: name, logo, containerExtension };
  lastProgressSave = 0;

  // VOD plays in its own full-screen player overlay (movies/series), NOT the
  // Live-TV layout. We don't switch tabs — the overlay sits over the catalog.
  document.body.classList.add('vod-mode');
  
  // Programmatically hide the sidebar, header, EPG guide, and details panel
  document.querySelector('.sidebar')?.classList.add('hidden');
  document.querySelector('.top-header')?.classList.add('hidden');
  document.querySelector('.epg-section-container')?.classList.add('hidden');
  document.querySelector('.program-details-panel')?.classList.add('hidden');

  if (playerInstance.vodTitleTag) playerInstance.vodTitleTag.textContent = name || '';

  playerInstance.showSpinner();
  try {
    let playUrl;
    if (getIsServerMode()) {
      playUrl = await getStreamUrl(streamId, type, containerExtension);
    } else {
      playUrl = getStreamUrlSync(streamId, type, containerExtension);
    }

    // VOD = on-demand file, played differently from live channels (seekable).
    playerInstance.setSeriesMode(false);
    playerInstance.loadStream(playUrl, name, logo, '', true, resumeTime);
    setCastContext({ streamId, type, title: name, isLive: false, ext: containerExtension });
    playerInstance.autoFullscreen();
  } catch (err) {
    console.error('Failed to play VOD stream:', err);
    alert(`Failed to load stream: ${err.message}`);
    playerInstance.hideSpinner();
  }
}

// Leave the VOD player overlay and return to the catalog grid.
function exitVodPlayer() {
  flushProgress();
  document.body.classList.remove('vod-mode');

  // Programmatically restore layout elements
  document.querySelector('.sidebar')?.classList.remove('hidden');
  document.querySelector('.top-header')?.classList.remove('hidden');
  document.querySelector('.epg-section-container')?.classList.remove('hidden');

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  playerInstance.stop();
  currentVodItem = null;
  refreshContinueWatching();
  navigation.focusDefault('grid');
}

// ==========================================================================
// CONTINUE WATCHING
// ==========================================================================
function formatClock(sec) {
  if (!sec || !isFinite(sec)) return '0:00';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Persist the current play position (called from the player on a throttle).
function saveCurrentProgress(currentTime, duration) {
  if (!currentVodItem || !currentTime || currentTime < 5) return;
  const now = Date.now();
  if (now - lastProgressSave < 8000) return;
  lastProgressSave = now;
  persistProgress(currentTime, duration);
}

function persistProgress(currentTime, duration) {
  if (!currentVodItem || !currentTime || currentTime < 5) return;
  // Finished (or nearly) → drop from Continue Watching.
  if (duration && isFinite(duration) && currentTime / duration > 0.95) {
    removeWatchProgress(currentVodItem.id);
    return;
  }
  saveWatchProgress({
    ...currentVodItem,
    position: currentTime,
    duration: isFinite(duration) ? duration : 0
  });
}

function flushProgress() {
  if (!currentVodItem || !playerInstance || !playerInstance.video) return;
  persistProgress(playerInstance.video.currentTime, playerInstance.video.duration);
}

function refreshContinueWatching() {
  renderContinueWatching('movie');
  renderContinueWatching('series');
}

function renderContinueWatching(type) {
  const container = document.getElementById(type === 'movie' ? 'movies-continue' : 'series-continue');
  if (!container) return;
  const items = getContinueWatching(type);
  if (!items.length) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const icon = type === 'series' ? 'tv' : 'film';
  let html = '<div class="continue-row-title">Continue Watching</div><div class="continue-row-cards">';
  items.forEach(it => {
    const pct = (it.duration && it.position) ? Math.min(100, (it.position / it.duration) * 100) : 0;
    const sub = type === 'series'
      ? `${it.episodeLabel || 'Episode'} · ${formatClock(it.position)}`
      : `Resume · ${formatClock(it.position)}`;
    html += `
      <div class="continue-card" data-id="${it.id}" tabindex="-1">
        <div class="continue-poster">
          ${it.logo ? `<img src="${it.logo}" alt="" loading="lazy">` : `<div class="poster-placeholder"><i data-lucide="${icon}"></i></div>`}
          <div class="continue-resume-overlay"><i data-lucide="play"></i></div>
          <div class="continue-progress"><div class="continue-progress-fill" style="width:${pct}%"></div></div>
        </div>
        <span class="continue-card-title">${it.cardTitle || it.name}</span>
        <span class="continue-card-sub">${sub}</span>
      </div>`;
  });
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.continue-card').forEach(card => {
    card.addEventListener('click', () => {
      const item = getContinueWatching(type).find(i => String(i.id) === String(card.dataset.id));
      if (item) resumeContinueWatching(item);
    });
  });
  if (window.lucide) lucide.createIcons({ scope: container });
}

function resumeContinueWatching(item) {
  if (item.type === 'series') {
    openSeriesPlaybackDashboard(
      { series_id: item.seriesId, name: item.seriesName, cover: item.logo },
      { episodeId: item.id, season: item.season, position: item.position }
    );
  } else {
    openVODDetailsModal(
      { stream_id: item.id, name: item.name, stream_icon: item.logo },
      'movie',
      item.position
    );
  }
}

// ==========================================================================
// DOCK WIDGETS & MODAL BINDS
// ==========================================================================
function startClock() {
  const timeEl = document.getElementById('current-time');
  const dateEl = document.getElementById('current-date');

  const update = () => {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
    dateEl.textContent = now.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
  };
  
  update();
  clearInterval(clockInterval);
  clockInterval = setInterval(update, 1000);
}

function parseM3uUrl(urlStr) {
  try {
    const url = new URL(urlStr.trim());
    const host = url.origin;
    const username = url.searchParams.get('username') || url.searchParams.get('auth_username');
    const password = url.searchParams.get('password') || url.searchParams.get('auth_password');
    if (host && username && password) {
      return { host, username, password };
    }
  } catch (e) {}
  return null;
}

// Sort options shared by Movies + Series.
const VOD_SORT_OPTIONS = [
  { value: 'added', label: 'Recently Added' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'rating', label: 'Rating' }
];
const VOD_SORT_LABEL = { added: 'Recently Added', name: 'Name (A-Z)', rating: 'Rating' };

// Wire the TV-navigable Search + Sort buttons for a VOD catalog (movies/series).
function wireVodFilters(kind, reload) {
  const st = kind === 'movies' ? state.movies : state.series;
  const searchBtn = document.getElementById(`${kind}-search-btn`);
  const searchLabel = document.getElementById(`${kind}-search-label`);
  const sortBtn = document.getElementById(`${kind}-sort-btn`);
  const sortLabel = document.getElementById(`${kind}-sort-label`);

  if (sortLabel) sortLabel.textContent = VOD_SORT_LABEL[st.sort] || 'Sort';

  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      openSearchKeyboard({
        title: kind === 'movies' ? 'Search Movies' : 'Search Series',
        initial: st.search || '',
        onChange: (q) => { st.search = q; st.page = 1; reload(); },
        onClose: (q) => {
          if (searchLabel) searchLabel.textContent = q ? `“${q}”` : 'Search';
          navigation.setFocus('grid', searchBtn);
        }
      });
    });
  }

  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      openSortDropdown({
        title: 'Sort by',
        options: VOD_SORT_OPTIONS,
        current: st.sort,
        onSelect: (v) => {
          st.sort = v;
          st.page = 1;
          if (sortLabel) sortLabel.textContent = VOD_SORT_LABEL[v] || 'Sort';
          reload();
          navigation.setFocus('grid', sortBtn);
        }
      });
    });
  }
}

function bindGlobalEvents() {
  // Remote manual login button handler
  document.getElementById('remote-manual-login-btn')?.addEventListener('click', () => {
    showManualLoginForm();
  });

  // Manual form back to remote activation button handler
  document.getElementById('manual-back-btn')?.addEventListener('click', () => {
    showRemoteActivation();
  });

  // Auto-extract and populate credentials when pasting M3U URL
  const m3uInput = document.getElementById('m3u-url');
  if (m3uInput) {
    const handleM3uInput = () => {
      const val = m3uInput.value;
      const parsed = parseM3uUrl(val);
      if (parsed) {
        document.getElementById('host-url').value = parsed.host;
        document.getElementById('username').value = parsed.username;
        document.getElementById('password').value = parsed.password;
        
        // Auto-set playlist name if empty or default
        try {
          const host = new URL(parsed.host).hostname;
          const nameEl = document.getElementById('playlist-name');
          if (nameEl && (!nameEl.value || nameEl.value === 'Xtream Codes')) {
            nameEl.value = host;
          }
        } catch (e) {}
      }
    };
    m3uInput.addEventListener('input', handleM3uInput);
    m3uInput.addEventListener('paste', () => setTimeout(handleM3uInput, 20));
  }

  // Login Form Connect
  const loginForm = document.getElementById('login-form');
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const playlistName = document.getElementById('playlist-name').value;
    let hostUrl = document.getElementById('host-url').value;
    let username = document.getElementById('username').value;
    let password = document.getElementById('password').value;
    const m3uUrl = document.getElementById('m3u-url').value;

    const errorMsg = document.getElementById('login-error');
    const btnText = document.querySelector('#login-btn .btn-text');
    const loader = document.querySelector('#login-btn .btn-loader');

    errorMsg.classList.add('hidden');
    btnText.classList.add('hidden');
    loader.classList.remove('hidden');

    // Parse M3U URL on submit if fields are empty
    if (m3uUrl && (!hostUrl || !username || !password)) {
      const parsed = parseM3uUrl(m3uUrl);
      if (parsed) {
        hostUrl = parsed.host;
        username = parsed.username;
        password = parsed.password;
        document.getElementById('host-url').value = hostUrl;
        document.getElementById('username').value = username;
        document.getElementById('password').value = password;
      } else {
        errorMsg.textContent = 'Could not extract login details from the M3U URL. Please check the URL or enter details manually.';
        errorMsg.classList.remove('hidden');
        btnText.classList.remove('hidden');
        loader.classList.add('hidden');
        return;
      }
    }

    if (!hostUrl || !username || !password) {
      errorMsg.textContent = 'Please enter either a valid M3U URL or your host, username, and password manually.';
      errorMsg.classList.remove('hidden');
      btnText.classList.remove('hidden');
      loader.classList.add('hidden');
      return;
    }

    try {
      const res = await login(hostUrl, username, password, playlistName);
      if (res.success) {
        const status = await getStatus();
        state.user = status;
        if (status.favorites) {
          state.favorites = status.favorites;
        }
        showDashboard();
        
        // Trigger initial sync
        await triggerFullSync();
        await loadTabCategoriesAndContent();
      }
    } catch (err) {
      errorMsg.textContent = err.message || 'Login connection failed.';
      errorMsg.classList.remove('hidden');
    } finally {
      btnText.classList.remove('hidden');
      loader.classList.add('hidden');
    }
  });

  // Playlist switcher dropdown
  const profileBtn = document.getElementById('profile-card-btn');
  if (profileBtn) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlaylistDropdown();
    });
  }
  document.getElementById('playlist-add-btn')?.addEventListener('click', showAddPlaylist);
  document.getElementById('playlist-dropdown-list')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      deletePlaylist(del.getAttribute('data-del'));
      return;
    }
    const row = e.target.closest('.playlist-row');
    if (!row) return;
    if (row.classList.contains('active')) {
      closePlaylistDropdown();
    } else {
      switchToPlaylist(row.dataset.id);
    }
  });
  document.getElementById('login-back-btn')?.addEventListener('click', () => {
    if (state.user && state.user.loggedIn) {
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app-container').classList.remove('hidden');
      document.getElementById('login-back-btn').classList.add('hidden');
    } else {
      // Go back to playlist selection screen
      getPlaylists().then(({ playlists }) => {
        if (playlists && playlists.length > 0) {
          showPlaylistSelect(playlists);
        } else {
          showLogin();
        }
      }).catch(() => {
        showLogin();
      });
    }
  });

  // Bind the Add New Playlist / Show Login Form button on boot selection screen
  document.getElementById('login-show-form-btn')?.addEventListener('click', () => {
    showRemoteActivation();
  });
  // Close the dropdown when clicking outside of it
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('playlist-dropdown');
    if (dd && !dd.classList.contains('hidden') && !e.target.closest('.profile-wrap')) {
      dd.classList.add('hidden');
    }
  });

  // Settings Binds
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close-btn');

  settingsBtn.addEventListener('click', () => {
    // Populate settings
    if (state.user && state.user.credentials) {
      const creds = state.user.credentials;
      document.getElementById('settings-format').value = creds.stream_format || 'ts';
      document.getElementById('settings-proxy').checked = creds.proxy_streams ?? true;
      document.getElementById('settings-connected-server').textContent = creds.server_url;
    }
    
    // Populate network info if running on local server
    const networkSection = document.getElementById('settings-network-section');
    const networkIps = document.getElementById('settings-network-ips');
    if (networkSection && networkIps) {
      if (state.user && state.user.local_ips && state.user.local_ips.length > 0) {
        const port = state.user.server_port || 3000;
        networkIps.innerHTML = state.user.local_ips
          .map(ip => `http://${ip}:${port}`)
          .join('<br>');
        networkSection.style.display = 'block';
      } else {
        networkSection.style.display = 'none';
      }
    }
    
    settingsModal.classList.remove('hidden');
    navigation.focusDefault('modal');
  });

  settingsClose.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    navigation.focusDefault('tabs');
  });

  // Save Settings
  document.getElementById('settings-format').addEventListener('change', async (e) => {
    await updatePreferences({ stream_format: e.target.value });
  });

  document.getElementById('settings-proxy').addEventListener('change', async (e) => {
    await updatePreferences({ proxy_streams: e.target.checked });
  });

  // Sleep timer — stop playback after the chosen duration.
  document.getElementById('settings-sleep-timer')?.addEventListener('change', (e) => {
    setSleepTimer(parseInt(e.target.value, 10) || 0);
  });

  // Sync now click
  document.getElementById('settings-sync-now').addEventListener('click', async () => {
    settingsModal.classList.add('hidden');
    await triggerFullSync();
    await loadTabCategoriesAndContent();
  });

  // Logout Click
  document.getElementById('settings-logout').addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect this playlist? This will erase local cache.')) {
      settingsModal.classList.add('hidden');
      playerInstance.stop();
      await logout();
      state.user = null;
      try {
        const { playlists } = await getPlaylists();
        if (playlists && playlists.length > 0) {
          showPlaylistSelect(playlists);
        } else {
          showLogin();
        }
      } catch (err) {
        showLogin();
      }
    }
  });

  // Modal Closers
  document.getElementById('vod-modal-close').addEventListener('click', () => {
    document.getElementById('vod-modal').classList.add('hidden');
  });

  // Close modals on background overlay click
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.add('hidden');
    }
  });

  // Navigation tab binds
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Sidebar Pins Binds
  document.querySelectorAll('.pin-item').forEach(pin => {
    pin.addEventListener('click', () => {
      const cat = pin.dataset.category;
      selectCategory(cat);
    });
  });

  // Dynamic pinned-category shortcuts are added later, so use delegation.
  document.getElementById('sidebar-pin-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.pin-item.pinned-category');
    if (item) selectCategory(item.dataset.category);
  });

  // Right-click (PC) on a category or pinned shortcut → pin/unpin menu. The
  // remote MENU key is handled in tv-navigation.js.
  document.querySelector('.sidebar')?.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.category-item, .pin-item.pinned-category');
    if (!el) return;
    e.preventDefault();
    window.openCategoryPinMenu(el);
  });

  // Categories list Search (TV-navigable D-pad keyboard overlay)
  const catSearchBtn = document.getElementById('categories-search-btn');

  if (catSearchBtn) {
    catSearchBtn.addEventListener('click', () => {
      openSearchKeyboard({
        title: 'Search Categories',
        initial: state.categorySearch || '',
        onChange: (q) => {
          state.categorySearch = q;
          applyCategorySearch();
        },
        onClose: () => {
          // Mark the icon when a filter is active so it's clear search is on.
          catSearchBtn.classList.toggle('filter-active', !!(state.categorySearch && state.categorySearch.trim()));
          navigation.setFocus('categories', catSearchBtn);
        }
      });
    });
  }

  // Categories list Sort (Default / Name / Count)
  const catSortBtn = document.getElementById('categories-sort-btn');
  const catSortLabel = document.getElementById('categories-sort-label');
  // Restore the saved sort preference.
  state.categorySort = localStorage.getItem('category_sort') || 'default';
  if (catSortLabel) {
    catSortLabel.textContent = (CATEGORY_SORTS.find(s => s.value === state.categorySort) || CATEGORY_SORTS[0]).label;
  }
  if (catSortBtn) {
    catSortBtn.addEventListener('click', () => {
      openSortDropdown({
        title: 'Sort categories',
        options: CATEGORY_SORTS,
        current: state.categorySort,
        onSelect: (value) => {
          state.categorySort = value;
          localStorage.setItem('category_sort', value);
          if (catSortLabel) {
            catSortLabel.textContent = (CATEGORY_SORTS.find(s => s.value === value) || CATEGORY_SORTS[0]).label;
          }
          renderCategoriesList(state.lastCategories || []);
          navigation.setFocus('categories', catSortBtn);
        }
      });
    });
  }



  // Detail panel favorite button click
  document.getElementById('detail-favorite-btn').addEventListener('click', () => {
    if (state.activeChannel) {
      toggleChannelFavorite('live', state.activeChannel.stream_id);
    }
  });

  // Global Sync Header Button
  document.getElementById('sync-btn').addEventListener('click', async () => {
    await triggerFullSync();
    await loadTabCategoriesAndContent();
  });

  // Mobile Hamburger Menu Binds
  const menuBtn = document.getElementById('mobile-menu-btn');
  const backdrop = document.getElementById('sidebar-backdrop');
  const appContainer = document.getElementById('app-container');

  if (menuBtn && backdrop && appContainer) {
    menuBtn.addEventListener('click', () => {
      appContainer.classList.add('sidebar-open');
      backdrop.classList.remove('hidden');
    });

    backdrop.addEventListener('click', () => {
      appContainer.classList.remove('sidebar-open');
      backdrop.classList.add('hidden');
    });
  }

  // Collapsible "Pin top section" (accordion)
  const pinSection = document.getElementById('pin-top-section');
  const pinToggle = document.getElementById('pin-section-toggle');
  if (pinSection && pinToggle) {
    // Restore saved state
    if (localStorage.getItem('pin_section_collapsed') === 'true') {
      pinSection.classList.add('collapsed');
      pinToggle.setAttribute('aria-expanded', 'false');
    }

    const togglePinSection = () => {
      const collapsed = pinSection.classList.toggle('collapsed');
      pinToggle.setAttribute('aria-expanded', String(!collapsed));
      localStorage.setItem('pin_section_collapsed', String(collapsed));
    };

    pinToggle.addEventListener('click', togglePinSection);
    window.addEventListener('toggle-pin-section', togglePinSection);
    pinToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePinSection();
      }
    });
  }

  // TV-navigable Search + Sort (on-screen keyboard / dropdown — no input fields)
  wireVodFilters('movies', loadMoviesGrid);
  wireVodFilters('series', loadSeriesGrid);

  // Live channel filter button (icon-only) → on-screen keyboard
  const liveFilterBtn = document.getElementById('epg-channels-filter-btn');
  if (liveFilterBtn) {
    liveFilterBtn.addEventListener('click', () => {
      openSearchKeyboard({
        title: 'Filter Channels',
        initial: (epgGridInstance && epgGridInstance.channelFilterQuery) || '',
        onChange: (q) => { if (epgGridInstance) epgGridInstance.setChannelFilter(q); },
        onClose: (q) => {
          // No label on the icon button — highlight it when a filter is active.
          liveFilterBtn.classList.toggle('filter-active', !!(q && q.trim()));
          navigation.setFocus('channels', liveFilterBtn);
        }
      });
    });
  }

  // Right-click a channel row (PC) → pin/unpin menu. Remote MENU key is handled
  // in tv-navigation.js.
  document.getElementById('epg-channels-list')?.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.epg-channel-row');
    if (!row) return;
    e.preventDefault();
    window.openChannelPinMenu(row);
  });

  // Live channel sort button → custom dropdown
  const liveSortBtn = document.getElementById('epg-channels-sort-btn');
  const liveSortLabel = document.getElementById('epg-channels-sort-label');
  if (liveSortBtn) {
    const LIVE_SORT_OPTIONS = [
      { value: 'added', label: 'Default Order' },
      { value: 'name', label: 'Name (A-Z)' },
      { value: 'name_desc', label: 'Name (Z-A)' },
      { value: 'most_viewed', label: 'Most Viewed' }
    ];
    const LIVE_SORT_LABEL = {
      added: 'Default Order',
      name: 'Name (A-Z)',
      name_desc: 'Name (Z-A)',
      most_viewed: 'Most Viewed'
    };
    liveSortBtn.addEventListener('click', () => {
      openSortDropdown({
        title: 'Sort Channels',
        options: LIVE_SORT_OPTIONS,
        current: (epgGridInstance && epgGridInstance.channelsSort) || 'added',
        onSelect: (v) => {
          if (epgGridInstance) epgGridInstance.setChannelsSort(v);
          if (liveSortLabel) liveSortLabel.textContent = LIVE_SORT_LABEL[v] || 'Default Order';
          navigation.setFocus('channels', liveSortBtn);
        }
      });
    });
  }

  // TV Series Playback Back button
  document.getElementById('series-back-btn')?.addEventListener('click', () => {
    exitSeriesPlaybackDashboard();
  });
}

async function updatePreferences(prefs) {
  try {
    const res = await updateSettings(prefs);
    if (res.success && state.user) {
      state.user.credentials = res.credentials;
    }
  } catch (err) {
    console.error('Failed to update settings preferences:', err);
  }
}

// Show a full-screen loading blocker during Xtream playlist sync
async function triggerFullSync() {
  const syncBlocker = document.createElement('div');
  syncBlocker.className = 'modal-overlay';
  syncBlocker.style.zIndex = '10000';
  syncBlocker.innerHTML = `
    <div style="text-align: center; display: flex; flex-direction: column; align-items: center; gap: 20px; color: white;">
      <div class="spinner" style="width: 60px; height: 60px;"></div>
      <h2 style="font-family: var(--font-title); font-size: 1.8rem; font-weight: 700;">Syncing Playlist Data</h2>
      <p id="sync-progress-msg" style="color: var(--text-secondary); max-width: 400px; font-size: 0.95rem; line-height: 1.5;">
        Initializing connection to your provider...
      </p>
    </div>
  `;
  document.body.appendChild(syncBlocker);

  try {
    const progressEl = document.getElementById('sync-progress-msg');
    const res = await syncPlaylist((statusText) => {
      if (progressEl) {
        progressEl.textContent = statusText;
      }
    });
    console.log('Sync completed! Channels cached:', res.counts);
  } catch (err) {
    console.error('Playlist sync failed:', err);
    alert(`Sync Warning: Could not download latest channels list. Using previously cached data if available. (${err.message})`);
  } finally {
    syncBlocker.remove();
  }
}

// ==========================================================================
// SESSION SCREEN TRANSITIONS
// ==========================================================================
function showLogin() {
  showRemoteActivation();
}

function showRemoteActivation() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-startup-loader')?.classList.add('hidden');
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('login-playlist-select').classList.add('hidden');
  
  const box = document.getElementById('remote-login-box');
  if (box) box.classList.remove('hidden');
  startRemoteLoginPolling();

  // Show back to playlists button if there are playlists
  getPlaylists().then(({ playlists }) => {
    const backBtn = document.getElementById('login-back-btn');
    if (backBtn) {
      if (playlists && playlists.length > 0) {
        backBtn.classList.remove('hidden');
      } else {
        backBtn.classList.add('hidden');
      }
    }
  }).catch(() => {});

  let remoteAttempts = 0;
  const tryFocusRemote = () => {
    const manualBtn = document.getElementById('remote-manual-login-btn');
    if (manualBtn && manualBtn.offsetParent !== null) {
      navigation.setFocus('login', manualBtn);
    } else if (remoteAttempts < 10) {
      remoteAttempts++;
      setTimeout(tryFocusRemote, 50);
    }
  };
  setTimeout(tryFocusRemote, 50);
}

function showManualLoginForm() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-startup-loader')?.classList.add('hidden');
  document.getElementById('login-playlist-select').classList.add('hidden');
  document.getElementById('remote-login-box').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
  
  // Hide global back-to-playlists (manual form has its own back button)
  document.getElementById('login-back-btn')?.classList.add('hidden');

  let manualAttempts = 0;
  const tryFocusManual = () => {
    const defaultFocus = document.getElementById('m3u-url') || document.getElementById('playlist-name');
    if (defaultFocus && defaultFocus.offsetParent !== null) {
      navigation.setFocus('login', defaultFocus);
    } else if (manualAttempts < 10) {
      manualAttempts++;
      setTimeout(tryFocusManual, 50);
    }
  };
  setTimeout(tryFocusManual, 50);
}

function showPlaylistSelect(playlists, lastUsedId = localStorage.getItem('last_playlist_id')) {
  console.log('showPlaylistSelect called with', playlists.length, 'playlists');

  // Surface the last-used playlist at the top so it's the default focus.
  if (lastUsedId) {
    playlists = [...playlists];
    const i = playlists.findIndex(p => String(p.id) === String(lastUsedId));
    if (i > 0) playlists.unshift(playlists.splice(i, 1)[0]);
  }

  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-container').classList.add('hidden');
  document.getElementById('login-back-btn')?.classList.add('hidden');
  document.getElementById('login-startup-loader')?.classList.add('hidden');

  // Hide form and remote activation box, show selection list
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('remote-login-box').classList.add('hidden');
  stopRemoteLoginPolling();

  const container = document.getElementById('login-playlist-select');
  container.classList.remove('hidden');

  const listEl = document.getElementById('login-playlists-list');
  listEl.innerHTML = '';
  
  playlists.forEach(p => {
    let domain = p.server_url;
    try { domain = new URL(p.server_url).hostname; } catch (e) {}
    
    const row = document.createElement('div');
    row.className = 'playlist-row';
    row.dataset.id = p.id;
    row.dataset.playlistName = p.playlistName || 'Playlist';
    const isLastUsed = lastUsedId && String(p.id) === String(lastUsedId);
    if (isLastUsed) row.classList.add('last-used');
    row.innerHTML = `
      <div class="playlist-row-main">
        <span class="playlist-row-name">${p.playlistName || 'Playlist'}${isLastUsed ? '<span class="playlist-row-badge">Last used</span>' : ''}</span>
        <span class="playlist-row-server">${domain} · ${p.username}</span>
      </div>
      <button class="playlist-row-del" data-del="${p.id}" title="Remove playlist"><i data-lucide="trash-2"></i></button>
    `;

    // Make row keyboard focusable
    row.setAttribute('tabindex', '0');

    // Click handler for mouse/pointer clicks
    const handleRowSelect = async (e) => {
      if (e.target.closest('.playlist-row-del')) return; // ignore delete click

      console.log('Playlist row clicked:', p.playlistName);

      const errorMsg = document.getElementById('login-error');
      errorMsg.classList.add('hidden');

      // Show loader or update row style
      row.style.opacity = '0.7';
      row.style.pointerEvents = 'none';

      try {
        console.log('Switching to playlist:', p.id);
        await switchToPlaylist(p.id);
        console.log('Playlist switched successfully');
      } catch (err) {
        console.error('Playlist switch error:', err);
        row.style.opacity = '1';
        row.style.pointerEvents = 'auto';
        errorMsg.textContent = err.message || 'Login connection failed.';
        errorMsg.classList.remove('hidden');
      }
    };

    row.addEventListener('click', handleRowSelect);

    // Keyboard handler for TV remote (ENTER/OK key)
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRowSelect({ target: row });
      }
    });
    
    listEl.appendChild(row);
  });
  
  // Delete handler
  listEl.querySelectorAll('.playlist-row-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      await deletePlaylistFromLoginScreen(id);
    });
  });

  if (window.lucide) lucide.createIcons({ scope: listEl });

  console.log('Playlist rows rendered, setting focus with retry checks');

  // Attempt to focus the first playlist row, with multiple retries to handle rendering delays.
  let focusAttempts = 0;
  const tryFocusPlaylist = () => {
    const firstRow = document.querySelector('#login-playlists-list .playlist-row');
    if (firstRow) {
      console.log(`Setting focus to playlist-select zone (attempt ${focusAttempts + 1})`);
      navigation.focusDefault('playlist-select');
    } else if (focusAttempts < 10) {
      focusAttempts++;
      setTimeout(tryFocusPlaylist, 50);
    }
  };
  setTimeout(tryFocusPlaylist, 50);
}

async function deletePlaylistFromLoginScreen(id) {
  if (!confirm('Remove this playlist?')) return;
  try {
    const res = await removePlaylist(id);
    if (!res.remaining) {
      state.user = null;
      showLogin();
      return;
    }
    // Refresh the list
    const { playlists } = await getPlaylists();
    showPlaylistSelect(playlists);
  } catch (err) {
    alert('Could not remove playlist: ' + (err.message || err));
  }
}

// ==========================================================================
// PLAYLIST SWITCHER (multiple saved logins)
// ==========================================================================
function closePlaylistDropdown() {
  document.getElementById('playlist-dropdown')?.classList.add('hidden');
}

async function renderPlaylistDropdown() {
  const listEl = document.getElementById('playlist-dropdown-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="playlist-row-empty">Loading…</div>';
  try {
    const { playlists, activeId } = await getPlaylists();
    if (!playlists || playlists.length === 0) {
      listEl.innerHTML = '<div class="playlist-row-empty">No saved playlists</div>';
      return;
    }
    listEl.innerHTML = '';
    playlists.forEach(p => {
      let domain = p.server_url;
      try { domain = new URL(p.server_url).hostname; } catch (e) {}
      const row = document.createElement('div');
      row.className = 'playlist-row' + (p.id === activeId ? ' active' : '');
      row.dataset.id = p.id;
      row.innerHTML = `
        <div class="playlist-row-main">
          <span class="playlist-row-name">${p.playlistName || 'Playlist'}</span>
          <span class="playlist-row-server">${domain} · ${p.username}</span>
        </div>
        ${p.id === activeId ? '<i data-lucide="check" class="playlist-row-check"></i>' : ''}
        <button class="playlist-row-del" data-del="${p.id}" title="Remove playlist"><i data-lucide="trash-2"></i></button>
      `;
      listEl.appendChild(row);
    });
    if (window.lucide) lucide.createIcons({ scope: listEl });
  } catch (err) {
    listEl.innerHTML = '<div class="playlist-row-empty">Failed to load playlists</div>';
  }
}

async function togglePlaylistDropdown() {
  const dd = document.getElementById('playlist-dropdown');
  if (!dd) return;
  if (dd.classList.contains('hidden')) {
    await renderPlaylistDropdown();
    dd.classList.remove('hidden');
    setTimeout(() => {
      navigation.focusDefault('playlist-dropdown');
    }, 150);
  } else {
    dd.classList.add('hidden');
    const profileBtn = document.getElementById('profile-card-btn');
    if (profileBtn) {
      navigation.setFocus('tabs', profileBtn);
    }
  }
}

// Boot straight into the only saved playlist, skipping the selection screen.
// Crucially, avoid the forced full re-sync when a cached catalog already exists:
// load instantly from cache and refresh in the background. Switching is only
// needed if this playlist isn't already the active one (switchPlaylist wipes
// the cache, which is the slow part we're trying to avoid).
async function autoEnterSinglePlaylist(id, activeId) {
  try {
    state.activePlaylistId = id;
    try { localStorage.setItem('last_playlist_id', String(id)); } catch (e) {}
    if (activeId !== id) {
      await switchPlaylist(id);
    }
    const status = await getStatus();
    state.user = status;
    if (status.favorites) state.favorites = status.favorites;
    showDashboard();

    // Detect an existing cache cheaply via the (small) live category list.
    let hasCache = false;
    try {
      const cats = await getCategories('live');
      hasCache = !!(cats && Array.isArray(cats.categories) && cats.categories.length > 0);
    } catch (e) {}

    if (hasCache) {
      state.activeCategory = null;
      await loadTabCategoriesAndContent();   // instant, from cache
      syncPlaylist().catch(() => {});         // silent background refresh
    } else {
      await triggerFullSync();                // first run: nothing cached yet
      state.activeCategory = null;
      await loadTabCategoriesAndContent();
    }
  } catch (err) {
    console.error('Auto-enter single playlist failed:', err);
    showLogin();
  }
}

async function switchToPlaylist(id) {
  closePlaylistDropdown();
  state.activePlaylistId = id;
  try { localStorage.setItem('last_playlist_id', String(id)); } catch (e) {}
  try {
    playerInstance.stop();
    exitSeriesPlaybackDashboard();
    await switchPlaylist(id);
    const status = await getStatus();
    state.user = status;
    if (status.favorites) state.favorites = status.favorites;
    showDashboard();
    await triggerFullSync();
    state.activeCategory = null;
    await loadTabCategoriesAndContent();
  } catch (err) {
    console.error('Failed to switch playlist:', err);
    throw err; // Re-throw so the caller can handle it
  }
}

async function deletePlaylist(id) {
  if (!confirm('Remove this playlist?')) return;
  try {
    const res = await removePlaylist(id);
    if (!res.remaining) {
      state.user = null;
      showLogin();
      return;
    }
    if (res.wasActive) {
      await switchToPlaylist(res.activeId);
    }
    await renderPlaylistDropdown();
  } catch (err) {
    alert('Could not remove playlist: ' + (err.message || err));
  }
}

function showAddPlaylist() {
  closePlaylistDropdown();
  document.getElementById('host-url').value = '';
  document.getElementById('username').value = '';
  document.getElementById('password').value = '';
  const err = document.getElementById('login-error');
  if (err) err.classList.add('hidden');

  showRemoteActivation();
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  document.getElementById('login-back-btn')?.classList.add('hidden');
  
  // Hide remote login box and stop polling
  const box = document.getElementById('remote-login-box');
  if (box) box.classList.add('hidden');
  stopRemoteLoginPolling();

  // Set topbar credentials details
  if (state.user && state.user.credentials) {
    const creds = state.user.credentials;
    
    // Format simple name e.g. "your-provider-url.com" from host
    let domain = creds.server_url;
    try {
      const urlObj = new URL(creds.server_url);
      domain = urlObj.hostname;
    } catch(e){}

    document.getElementById('nav-playlist-name').textContent = `${creds.playlistName} (${domain})`;
  }

  // Set expiry text
  if (state.user && state.user.user_info) {
    const info = state.user.user_info;
    const expiryEl = document.getElementById('expiry-text');
    
    if (info.exp_date === null || info.exp_date === undefined || info.exp_date === '0') {
      expiryEl.textContent = 'Active - Unlimited';
    } else {
      const expDate = new Date(parseInt(info.exp_date) * 1000);
      const diffTime = expDate - Date.now();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      
      if (diffDays <= 0) {
        expiryEl.textContent = 'Expired';
        expiryEl.parentElement.classList.replace('gold-badge', 'danger-badge');
      } else if (diffDays <= 7) {
        expiryEl.textContent = `${diffDays} days left`;
      } else {
        expiryEl.textContent = `Expires ${expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      }
    }
  }

  // Set SVG lucide icons
  lucide.createIcons();

  // Update TV Connection IP badge in the top header
  updateHeaderTvIpBadge(state.user);
}

function updateHeaderTvIpBadge(status) {
  const badge = document.getElementById('header-tv-ip');
  const text = document.getElementById('header-tv-ip-text');
  
  if (Capacitor.isNativePlatform()) {
    if (badge) badge.style.display = 'none';
    return;
  }
  
  if (badge && text && status && status.local_ips && status.local_ips.length > 0) {
    const ip = status.local_ips[0];
    const port = status.server_port || 3000;
    text.textContent = `TV Link: http://${ip}:${port}`;
    badge.style.display = 'inline-flex';
    
    if (typeof lucide !== 'undefined') {
      lucide.createIcons({ scope: badge });
    }
  } else if (badge) {
    badge.style.display = 'none';
  }
}

// ==========================================================================
// SUPABASE REMOTE LOGIN SYSTEM
// ==========================================================================
function getOrCreateDeviceCode() {
  let code = localStorage.getItem('ziptv_device_code');
  if (!code) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid confusing characters
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    localStorage.setItem('ziptv_device_code', code);
  }
  return code;
}

function startRemoteLoginPolling() {
  if (remoteLoginInterval) return;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('Supabase URL or Anon Key is missing. Remote login polling disabled.');
    return;
  }

  // Insert base pairing record if not exists
  ensureDevicePairingExists();

  remoteLoginInterval = setInterval(async () => {
    try {
      const url = `${SUPABASE_URL}/rest/v1/device_pairings?device_id=eq.${deviceCode}&select=*`;
      const res = await fetch(url, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.length > 0) {
        const pairing = data[0];
        if (pairing.status === 'loaded' && pairing.server_url && pairing.username && pairing.password) {
          stopRemoteLoginPolling();
          
          // Show connecting status on screen
          const codeEl = document.getElementById('remote-device-code');
          if (codeEl) codeEl.textContent = 'LINKING…';

          // Attempt login/save credentials
          await saveRemotePlaylist(pairing);
        }
      }
    } catch (err) {
      console.error('Error polling remote login status:', err);
    }
  }, 4000);
}

function stopRemoteLoginPolling() {
  if (remoteLoginInterval) {
    clearInterval(remoteLoginInterval);
    remoteLoginInterval = null;
  }
}

async function ensureDevicePairingExists() {
  try {
    const url = `${SUPABASE_URL}/rest/v1/device_pairings`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        device_id: deviceCode,
        status: 'pending'
      })
    });
  } catch (err) {
    console.error('Error ensuring device pairing record exists:', err);
  }
}

// Lightweight toast notification (auto-dismisses).
function showToast(message, type = 'success', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'error' ? 'alert-circle' : (type === 'info' ? 'info' : 'check-circle');
  toast.innerHTML = `
    <span class="toast-icon"><i data-lucide="${icon}"></i></span>
    <span class="toast-message">${message}</span>
  `;
  container.appendChild(toast);
  if (window.lucide) lucide.createIcons({ scope: toast });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
window.showToast = showToast;

// Report the remote-pairing outcome back to Supabase so the connect page knows.
function reportPairingStatus(status) {
  const updateUrl = `${SUPABASE_URL}/rest/v1/device_pairings?device_id=eq.${deviceCode}`;
  return fetch(updateUrl, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status })
  }).catch(e => console.error('Failed to report pairing status:', e));
}

async function saveRemotePlaylist(pairing) {
  try {
    // Use the shared login() helper — it works in both server mode and native
    // (APK) client mode. Calling /api/login directly fails on the TV because
    // there's no Express server there (the WebView returns index.html → the
    // "Unexpected token < in JSON" error).
    const loginRes = await login(
      pairing.server_url,
      pairing.username,
      pairing.password,
      pairing.playlist_name || 'Remote Playlist'
    );
    if (!loginRes || !loginRes.success) {
      throw new Error('Login failed');
    }

    // Tell the connect page it worked (don't delete yet, so the phone can read it).
    await reportPairingStatus('connected');

    state.user = loginRes;
    showDashboard();

    const box = document.getElementById('remote-login-box');
    if (box) box.classList.add('hidden');

    showToast('Playlist connected', 'success');

    await triggerFullSync();
    state.activeCategory = null;
    await loadTabCategoriesAndContent();

  } catch (err) {
    console.error('Failed to link remote playlist:', err);
    const codeEl = document.getElementById('remote-device-code');
    if (codeEl) codeEl.textContent = deviceCode;

    // Tell the connect page it failed, then resume polling for a retry.
    await reportPairingStatus('failed');

    showToast('Could not connect playlist: ' + err.message, 'error', 5000);
    startRemoteLoginPolling();
  }
}
