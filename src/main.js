import './compat.js'; // MUST be first: patches globals old TV WebViews lack
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
  getCatchupUrl,
  getStreamInfo,
  getPlaylists,
  switchPlaylist,
  removePlaylist,
  getContinueWatching,
  saveWatchProgress,
  removeWatchProgress,
  removeSeriesWatchProgress,
  markCompleted,
  isCompleted,
  getWatchInfo,
  getIsServerMode,
  getStreamUrlSync,
  proxifyImage,
  getLastSyncAge,
  markSyncStale,
  hasCachedData,
  updatePlaylistByServerAndUser,
  setPlaylistCloudId,
  mergeCompanionHistory
} from './components/xtream-api.js';
import { Capacitor } from '@capacitor/core';
import { VideoPlayer } from './components/player.js';
import { EPGGrid } from './components/epg.js';
import { navigation } from './components/tv-navigation.js';
import { initCastUI, setCastContext } from './components/cast.js';
import { checkForUpdate, downloadApp, startPeriodicUpdateCheck, initElectronUpdaterUI } from './components/update-check.js';
import { openSearchKeyboard, openSortDropdown } from './components/tv-search.js';
import { openGlobalSearch, setGlobalSearchQuery } from './components/global-search.js';
import { isNativeAvailable, nativeIsTv } from './components/native-player.js';
import { getDeviceCode, syncDevice, detectPlatform, readCachedState, clearCachedState, isStateExpired, pairCompanion, unpairCompanion, fetchCompanionHistory, addPlaylistToCloud, removePlaylistFromCloud } from './components/cloud-sync.js';
import { initWebTabs, openWebTab, openManageTabs, toggleAdblock, isAdblockOn, applyHiddenTabs } from './components/web-tabs.js';
import { renderHome } from './components/home.js';
import { getStoredUiMode, setStoredUiMode, showDeviceChooser, initTvNative, enterTvNative, exitTvNative, isTvNativeActive } from './components/tv-native.js';
import { watchTogether } from './components/watch-together.js';
import { getAboutRows, DEVELOPER } from './components/about.js';
import { initShareTunnel, openShareTunnel } from './components/share-tunnel.js';
// Imported (not a literal "/src/assets/..." path) so Vite rewrites it to the
// hashed build URL — a raw path injected from JS isn't processed and 404s.
import logoUrl from './assets/logo.png';

// Cloud sync (ZIPTV Pro 5.0): device + playlist state lives in Supabase, managed
// from the /connect dashboard and pulled via the serverless /api/device endpoint.
// The app no longer holds a Supabase key — all DB access is server-side.
let cloudSyncInterval = null;
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
window.state = state;

// Global Components instances
let playerInstance = null;
let epgGridInstance = null;
let liveFallbackTried = false; // guards the one-time .ts → m3u8 live fallback
let currentVodItem = null;     // metadata of the movie/episode currently playing (for Continue Watching)
let lastProgressSave = 0;      // throttle progress writes

// Clock update timer
let clockInterval = null;
let progressInterval = null;

// ==========================================================================
// 7.0 NATIVE TV SHELL — handlers injected into the 10-foot interface so it
// drives the existing data/playback machinery (libVLC, timeshift, fallbacks)
// instead of reimplementing it. See src/components/tv-native.js.
// ==========================================================================
const tvNativeHandlers = {
  playChannel: (channel, program) => selectAndPlayChannel(channel, program),
  playVod: (id, type, name, logo, desc, ext, resume, backdrop) =>
    playVODStream(id, type, name, logo, desc, ext, resume, backdrop),
  playEpisode: (seriesItem, info, seasonNum, epIndex, resumeTime, backdrop) =>
    playSeriesEpisodeTv(seriesItem, info, seasonNum, epIndex, resumeTime, backdrop),
  resumeEpisode: (item) => resumeSeriesEpisodeTv(item),
  resumeCw: (item) => resumeContinueWatching(item),
  toggleFavorite: (type, id) => toggleChannelFavorite(type, id),
  isFavorite: (type, id) => state.favorites[type]?.includes(String(id)) || false,
  // Pinning (7.0.4) — same localStorage stores as the legacy UI, so pins made
  // in either interface show up in both.
  pinnedCats: (tab) => getPinnedForTab(tab),
  isCatPinned: (id, tab) => isCategoryPinned(id, tab),
  togglePinCat: (id, name, tab) => togglePinCategory(id, name, tab),
  pinnedChs: () => getPinnedChannels(),
  isChPinned: (id) => isChannelPinned(id),
  togglePinCh: (id, name) => togglePinChannel(id, name),
  getViewCount: (id) => getChannelViewCounts()[String(id)] || 0,
  switchPlaylist: (id) => switchToPlaylist(id),
  resync: () => triggerFullSync(),
  checkUpdate: () => checkForUpdate({ manual: true, onStatus: (m) => showToast(m, 'info') }),
  // Account status ("Active - Unlimited" / "Expires Jan 5, 2027" / "3 days
  // left" / "Expired") — same precedence as the desktop profile card: the
  // admin-set device expiry first, then the provider's Xtream exp_date.
  accountStatus: () => {
    const fmt = (expDate) => {
      const diffDays = Math.ceil((expDate - Date.now()) / (1000 * 60 * 60 * 24));
      if (diffDays <= 0) return { text: 'Expired', danger: true };
      if (diffDays <= 7) return { text: `${diffDays} days left`, danger: true };
      return { text: `Expires ${expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, danger: false };
    };
    try {
      const deviceExpiry = localStorage.getItem(DEVICE_EXPIRY_KEY);
      if (deviceExpiry) return fmt(new Date(deviceExpiry));
      const info = state.user && state.user.user_info;
      if (!info) return null;
      if (info.exp_date === null || info.exp_date === undefined || info.exp_date === '0') {
        return { text: 'Active - Unlimited', danger: false };
      }
      return fmt(new Date(parseInt(info.exp_date) * 1000));
    } catch (e) { return null; }
  },
  addPlaylist: () => {
    try { playerInstance.stop(); } catch (e) {}
    exitTvNative();
    showAddPlaylist();
  },
  // The channel still playing under the shell (Back from fullscreen keeps the
  // stream running) — lets the Live screen offer a "return to player" jump.
  nowPlayingChannel: () =>
    (playerInstance && playerInstance.hasStream &&
     !document.body.classList.contains('vod-mode') && state.activeChannel)
      ? state.activeChannel : null,
  returnToPlayer: () => { try { playerInstance.autoFullscreen(); } catch (e) {} },
  // 7.1 shell OSD "Back to channels": drop out of fullscreen playback — the
  // playback-state observer then restores the shell (stream keeps running).
  exitPlayerFs: () => { try { playerInstance.exitFullscreen(); } catch (e) {} },
  logout: async () => {
    try { playerInstance.stop(); } catch (e) {}
    await logout();
    state.user = null;
    exitTvNative();
    try {
      const { playlists } = await getPlaylists();
      if (playlists && playlists.length > 0) showPlaylistSelect(playlists);
      else showLogin();
    } catch (err) {
      showLogin();
    }
  }
};

// Document Ready
// Global crash reporter: if anything in the renderer throws uncaught (which on
// some packaged-Electron setups manifests as a silent black screen), surface the
// error on-screen instead of leaving a blank window. Diagnostic + last resort.
function showFatalOverlay(label, detail) {
  try {
    let el = document.getElementById('fatal-error-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fatal-error-overlay';
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0b0f19;color:#f3f4f6;' +
        'font:13px/1.5 monospace;padding:24px;overflow:auto;white-space:pre-wrap;';
      document.body.appendChild(el);

      // The overlay must always be escapable — the app underneath may be fine.
      // Dismiss via the button, Escape, or the hardware/Android back button
      // (Capacitor routes hardware back to a popstate, so we push a history entry
      // on open and pop it to close).
      const onKey = (ev) => {
        if (ev.key === 'Escape' || ev.key === 'Backspace' || ev.key === 'GoBack') dismissOverlay();
      };
      const onPop = () => dismissOverlay();
      function dismissOverlay() {
        try { document.removeEventListener('keydown', onKey, true); } catch (_) {}
        try { window.removeEventListener('popstate', onPop); } catch (_) {}
        try { el.remove(); } catch (_) {}
      }
      try { history.pushState({ fatalOverlay: 1 }, ''); } catch (_) {}
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('popstate', onPop);

      const btn = document.createElement('button');
      btn.textContent = 'Dismiss';
      btn.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#2b6fff;' +
        'color:#fff;border:none;border-radius:8px;padding:8px 16px;font:600 13px system-ui;cursor:pointer;';
      btn.addEventListener('click', dismissOverlay);
      el.appendChild(btn);
    }
    let pre = el.querySelector('.fatal-text');
    if (!pre) {
      pre = document.createElement('div');
      pre.className = 'fatal-text';
      pre.style.cssText = 'white-space:pre-wrap;';
      el.appendChild(pre);
    }
    pre.textContent = `ZIPTV Pro — startup error\n\n${label}\n${detail || ''}`.slice(0, 4000);
  } catch (e) { /* nothing more we can do */ }
}
// Benign, non-fatal errors that must NOT trigger the full-screen crash overlay.
// The classic one is the HTMLMediaElement AbortError — play() rejects when a new
// load()/src interrupts a pending play() (happens constantly on channel/VOD
// switches, catch-up replay, deinterlace re-tune, etc.). These are harmless races,
// not startup crashes, so swallow them instead of bricking the whole UI.
function isBenignError(r) {
  if (!r) return false;
  if (r.name === 'AbortError' || r.name === 'NotAllowedError') return true;
  const msg = String((r && (r.message || r.reason)) || r || '');
  // mpegts.js teardown race: destroy() nulls its internals (_emitter,
  // _loading_controller) while already-queued Promise/event callbacks still
  // fire → TypeError "Cannot read properties of null (reading 'emit')"
  // (7.1.2) or "... (reading 'notifyBufferedPositionChanged')" and friends —
  // the loading-controller notify* methods (7.1.5). The player is already
  // torn down (engine switch / channel zap) — nothing is actually broken.
  if (/reading\s+'(emit|notify\w+)'|null.*\.emit\b/i.test(msg)) return true;
  return /play\(\)\s*request|interrupted by a new load|request was interrupted|media was removed|removed from the document|The operation was aborted/i.test(msg);
}
window.addEventListener('error', (e) => {
  if (isBenignError(e.error) || isBenignError(e)) return;
  showFatalOverlay(e.message || 'Uncaught error',
    (e.filename ? `${e.filename}:${e.lineno}:${e.colno}\n` : '') + (e.error && e.error.stack ? e.error.stack : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  // A background promise rejection (a fetch failing over a flaky mobile
  // connection, etc.) must never cover the whole app. Log it for the console and
  // move on — genuine boot failures are still surfaced by initApp()'s .catch and
  // the uncaught-'error' handler below.
  const r = e.reason;
  try {
    const head = r ? ([r.name, r.message].filter(Boolean).join(': ') || String(r)) : String(r);
    console.error('[unhandledrejection]', head, (r && r.stack) ? r.stack : '');
  } catch (_) {}
  e.preventDefault();
});

document.addEventListener('DOMContentLoaded', () => {
  try {
    const p = initApp();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => showFatalOverlay('initApp() failed', err && err.stack ? err.stack : String(err)));
    }
  } catch (err) {
    showFatalOverlay('initApp() threw', err && err.stack ? err.stack : String(err));
  }
});

async function initApp() {
  // 1. Initialize time clock
  startClock();

  // Phone-sharing (Electron only): exposes window.openShareTunnel() and reveals the
  // header button. No-op on web/Android where the tunnel/appHost.share is absent.
  try {
    initShareTunnel();
    const phoneShareBtn = document.getElementById('phone-share-btn');
    if (phoneShareBtn && !(window.appHost && window.appHost.share)) {
      phoneShareBtn.style.display = 'none';
    } else if (phoneShareBtn) {
      phoneShareBtn.style.display = '';
    }
  } catch (e) {}

  try {
    const path = (window.location.pathname || '').replace(/\/+$/, '');
    const isTvPath = /(^|\/)tv$/i.test(path);
    const tvParam = new URLSearchParams(window.location.search).get('tv');
    const ua = (navigator.userAgent || '').toLowerCase();
    let isTV = /aft|tizen|web0s|webos|smart-?tv|googletv|android tv|bravia|netcast/.test(ua);
    // UA sniffing misses some TV WebViews (seen on a Fire TV whose UA looks
    // like a phone → desktop layout, light theme, dead D-pad). On Android ask
    // the OS directly: UiModeManager / leanback / fire_tv feature flags.
    if (!isTV && Capacitor.isNativePlatform()) {
      try { isTV = await nativeIsTv(); } catch (e) {}
    }

    // 7.0: resolve the interface (Mobile vs the native TV shell).
    //  - explicit /tv path or ?tv= override always wins (Electron TV mode,
    //    "open on your TV" links);
    //  - then the user's stored choice (Settings can flip it any time);
    //  - first APK boot asks the user before login, pre-selecting whatever
    //    the device detection says;
    //  - web/TV webviews with no stored choice auto-select by detection.
    let uiMode = null;
    // TV-only build (tv.apk): always the native TV shell — ignore stored
    // choice, URL overrides and the first-boot chooser.
    if (typeof __TV_ONLY__ !== 'undefined' && __TV_ONLY__) uiMode = 'tv';
    if (!uiMode && (isTvPath || tvParam === 'true' || tvParam === '1')) uiMode = 'tv';
    if (!uiMode) uiMode = getStoredUiMode();
    if (!uiMode && Capacitor.isNativePlatform()) {
      uiMode = await showDeviceChooser(isTV);
    }
    if (!uiMode) uiMode = isTV ? 'tv' : 'mobile';

    if (uiMode === 'tv') {
      document.body.classList.add('tv-layout');
      document.documentElement.classList.add('tv-layout');
      window.__TV_PREVIEW__ = true;

      // Register the native TV shell (renders after login via showDashboard).
      initTvNative(tvNativeHandlers);

      // Desktop app in TV mode = 10-foot experience: borderless fullscreen.
      try { window.appHost?.setFullscreen?.(true); } catch (e) {}

      // Resolution-proof 10-foot rendering: pin the layout viewport to 1920
      // CSS px. TV webviews at 720p (1280×720) or with DPR-scaled CSS
      // viewports (e.g. 960×540) then scale the whole UI uniformly instead
      // of rendering it oversized and cropped off-screen. Desktop browsers
      // ignore the viewport meta; redesign.css's vw-based root font-size
      // covers scaling there.
      let vp = document.querySelector('meta[name="viewport"]');
      if (!vp) {
        vp = document.createElement('meta');
        vp.name = 'viewport';
        document.head.appendChild(vp);
      }
      vp.setAttribute('content', 'width=1920, user-scalable=no');
    }
  } catch (e) {}

  // Performance (lite) mode — strips GPU-heavy glass effects (backdrop blurs,
  // ambient glows, heavy shadows, transition:all) so the UI stays smooth on
  // low-power devices (Fire TV / Tizen / WebOS / Android projectors). Auto-on
  // for those targets; a Settings toggle (stored in localStorage) overrides.
  applyPerfMode();

  // Light/dark theme (Auto follows the OS; TVs stay dark).
  applyTheme();

  // Initialize device code (identity for the /connect dashboard).
  deviceCode = getDeviceCode();
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
      dlBtn.href = 'https://ziptvpro.pages.dev/latest.exe';
      dlBtn.removeAttribute('download'); // cross-origin redirect handles the download
      if (dlLabel) dlLabel.textContent = 'Download Latest Version (PC)';
    } else {
      dlBtn.href = 'https://ziptvpro.pages.dev/app.apk';
      if (dlLabel) dlLabel.textContent = 'Download Latest Version';
    }

    // On Android (Fire TV's browser can't install APKs) download + install in
    // app via the native installer instead of opening the link.
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      dlBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const label = dlLabel ? dlLabel.textContent : '';
        if (dlLabel) dlLabel.textContent = 'Downloading…';
        const res = await downloadApp('https://ziptvpro.pages.dev/app.apk', (m) => { if (dlLabel) dlLabel.textContent = m; });
        if (dlLabel) dlLabel.textContent = res.needsPermission
          ? 'Allow "Install unknown apps", then retry'
          : (res.ok ? label : 'Download failed — retry');
      });
    }
  }

  // 2. Initialize Core Components
  playerInstance = new VideoPlayer();
  window.playerInstance = playerInstance;
  try { playerInstance.restoreUpscalerPref(); } catch (e) {}
  updateRecordingsCount();

  // Electron close-to-tray: the window keeps running in the tray (recordings),
  // but nothing the USER was watching may keep playing — stop the player and
  // silence every custom web tab the moment the window hides.
  if (window.appHost && window.appHost.onHideToTray) {
    window.appHost.onHideToTray(() => {
      // Exception: an active cast plays on the TV, not here — leave it alone
      // (player.stop() while casting would end the cast session).
      const casting = !!(window.castControls && window.castControls.isActive && window.castControls.isActive());
      if (!casting) { try { playerInstance.stop(); } catch (e) {} }
      try { if (window.stopAllWebtabPlayback) window.stopAllWebtabPlayback(); } catch (e) {}
    });
  }

  // Set player skip handlers
  playerInstance.setOnPrevChannel(() => playPreviousChannel());
  playerInstance.setOnNextChannel(() => playNextChannel());
  playerInstance.onExitVod = exitVodPlayer;
  playerInstance.onVodProgress = saveCurrentProgress;
  initWatchTogether();

  epgGridInstance = new EPGGrid(
    (channel, program) => {
      selectAndPlayChannel(channel, program);
    },
    (channel, program) => {
      updateDetailsPanel(channel, program);
    }
  );
  // Exposed for the player's zap OSD (per-row now-playing lookup via getNowNext).
  window.epgGridInstance = epgGridInstance;

  // Provide global function for EPG stars updates
  window.isChannelFavorite = (type, id) => {
    return state.favorites[type]?.includes(String(id)) || false;
  };
  window.toggleChannelFavorite = toggleChannelFavorite;

  // Settings acts like a tab, not a popup: host its panel inside <main> so it
  // fills the content area and the side rail stays visible/clickable. The
  // markup keeps its #settings-modal id + .modal-overlay class so all existing
  // bindings and TV D-pad handling keep working; CSS (redesign.css "settings
  // as a tab") repositions it from fixed fullscreen to absolute-in-main.
  try {
    const mainEl = document.querySelector('.app-main main');
    const settingsPanel = document.getElementById('settings-modal');
    if (mainEl && settingsPanel) mainEl.appendChild(settingsPanel);
  } catch (e) {}

  // 3. Bind Global UI Events (Tabs, Logins, Settings, Modal Closers)
  bindGlobalEvents();
  initGlobalSearch();

  // Custom web tabs (Electron in-app browser) + tab visibility + ad blocker.
  initWebTabs({ onSwitchTab: switchTab, onRefreshTiles: refreshSettingsTiles });

  // Grab LAN IP(s) from the local server (if any) for the Smart TV Access link.
  loadLanInfo();

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
  } else {
    // Desktop: electron-updater handles downloads in the background; surface its
    // progress + restart prompt via the in-app updater toast.
    initElectronUpdaterUI();
  }

  // (Settings update check is wired on the Updates tile — see bindGlobalEvents.)

  // 4. Check Saved Playlists on Boot
  try {
    const { playlists, activeId } = await getPlaylists();
    if (!playlists || playlists.length === 0) {
      showLogin();
    } else {
      // Always boot straight into the last-used playlist (falling back to the
      // active one, then the first) and skip the picker. The picker is now
      // reachable on demand via Settings → Switch Playlist.
      const lastId = localStorage.getItem('last_playlist_id');
      const target = playlists.find(p => String(p.id) === String(lastId))
                  || playlists.find(p => String(p.id) === String(activeId))
                  || playlists[0];
      await autoEnterSinglePlaylist(target.id, activeId);
    }
  } catch (err) {
    console.error('Failed to initialize app session:', err);
    showLogin();
  }

  // 5. Start the cloud sync loop (heartbeat + mirror dashboard state + enforce
  // expiry). Runs for the whole app lifetime, on launch + every few minutes +
  // on resume. Started after the boot playlist check to avoid a double-enter race.
  startCloudSync();
}

// ==========================================================================
// TABS & VIEW ROUTER
// ==========================================================================
async function switchTab(tabId) {
  // TV shell active: it renders its own screens from the cache, so building
  // the legacy tab UI underneath it is pure hidden work (DOM + poster fetches
  // on every boot) that crawls on weak TV devices. Data sync still runs; only
  // the invisible render is skipped. Leaving the shell always reloads the
  // page, so the legacy UI never misses a paint it actually needs.
  if (isTvNativeActive()) { state.activeTab = tabId; return; }
  if (tabId !== 'series' || state.activeTab === 'series') {
    exitSeriesPlaybackDashboard();
  }
  state.activeTab = tabId;
  state.activeCategory = null;

  // Always collapse the mobile category drawer when changing tabs — otherwise a
  // drawer opened on Live can linger (or show empty) after moving to Home.
  document.getElementById('app-container')?.classList.remove('sidebar-open');
  document.getElementById('sidebar-backdrop')?.classList.add('hidden');

  // Settings acts like a tab: navigating to any real tab leaves it.
  document.getElementById('settings-modal')?.classList.add('hidden');
  document.getElementById('settings-btn')?.classList.remove('active');
  document.body.classList.remove('settings-tab');

  // Toggle tab buttons class (header pill + mobile bottom bar stay in sync)
  document.querySelectorAll('.nav-tab, .mobile-tab-btn[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Custom web tabs ("web:<id>") render into the shared #webtab-view panel.
  const isWebTab = tabId.startsWith('web:');

  // Toggle visible panels
  document.querySelectorAll('.view-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === (isWebTab ? 'webtab-view' : `${tabId}-view`));
  });

  // Web tabs are a full-bleed browser: no category sidebar either.
  document.body.classList.toggle('webtab-tab', isWebTab);
  // Home dashboard: full-bleed rows, no category sidebar.
  document.body.classList.toggle('home-tab', tabId === 'home');

  if (isWebTab) {
    openWebTab(tabId.slice(4));
    return;
  }

  // Home dashboard — rendered fresh on every visit so rows track activity.
  if (tabId === 'home') {
    await renderHome(homeHandlers);
    navigation.focusDefault('home');
    return;
  }

  // Header search placeholder follows the active view
  const headerSearch = document.getElementById('header-search-input');
  if (headerSearch) {
    headerSearch.placeholder = tabId === 'movies' ? 'Search movies'
      : tabId === 'series' ? 'Search series'
      : 'Search live channels';
  }

  // Load left categories and main content area
  await loadTabCategoriesAndContent();
}

async function loadTabCategoriesAndContent() {
  // See switchTab: no legacy sidebar/grid renders while the TV shell is up.
  if (isTvNativeActive()) return;
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
window.switchTab = switchTab;

// ---- Performance (lite) mode -------------------------------------------
// Returns true if this device should default to lite mode (weak GPU).
function shouldAutoLite() {
  try {
    const ua = (navigator.userAgent || '').toLowerCase();
    // Fire TV (AFT*), Tizen (Samsung TV), WebOS (LG TV), generic SMART-TV,
    // Android TV / projectors running the native APK.
    if (/aft|tizen|web0s|webos|smart-?tv|googletv|android tv|bravia|netcast/.test(ua)) return true;
    if (document.body.classList.contains('tv-layout')) return true;
    if (typeof Capacitor !== 'undefined' &&
        Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return true;
  } catch (e) {}
  return false;
}

// Resolve the effective setting: explicit user choice wins, else auto-detect.
function isPerfLiteEnabled() {
  const saved = (() => { try { return localStorage.getItem('perfLite'); } catch (e) { return null; } })();
  if (saved === 'on') return true;
  if (saved === 'off') return false;
  return shouldAutoLite();
}

// Apply (or remove) the body.perf-lite class based on the resolved setting.
function applyPerfMode() {
  document.body.classList.toggle('perf-lite', isPerfLiteEnabled());
}

// ---- Appearance (light / dark theme) -------------------------------------
// localStorage 'theme': 'light' | 'dark' | absent (= Auto, follows the OS).
// TVs never get light mode — 10-foot UIs stay dark (glare/contrast), so
// body.tv-layout short-circuits to dark regardless of the setting.
function getThemePref() {
  try { return localStorage.getItem('theme'); } catch (e) { return null; }
}
function isLightEnabled() {
  if (document.body.classList.contains('tv-layout')) return false;
  // Native Android (phone APK) stays dark too: theme-light.css was styled
  // against the desktop surfaces and renders inconsistently on the mobile
  // layout. Re-enable here only after a dedicated mobile light-mode pass.
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') return false;
  } catch (e) {}
  // Dark is the default everywhere — light mode only when explicitly chosen.
  // (Previously "Auto" followed the OS, which surprised users whose device
  // reported a light preference.)
  return getThemePref() === 'light';
}
function applyTheme() {
  document.body.classList.toggle('light-mode', isLightEnabled());
}
function setTheme(value) {
  try {
    if (value === null) localStorage.removeItem('theme');
    else localStorage.setItem('theme', value);
  } catch (e) {}
  applyTheme();
}
window.setTheme = setTheme;
// Auto mode tracks the OS preference live.
try {
  window.matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', () => { if (getThemePref() === null) applyTheme(); });
} catch (e) {}

// Persist an explicit choice and re-apply. Pass null to clear back to auto.
function setPerfLite(value) {
  try {
    if (value === null) localStorage.removeItem('perfLite');
    else localStorage.setItem('perfLite', value ? 'on' : 'off');
  } catch (e) {}
  applyPerfMode();
}
window.setPerfLite = setPerfLite;

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

  // Add "All" node — movies/series only. Live gets no "All channels": with
  // thousands of channels it's useless noise, the provider categories cover
  // everything already.
  if (state.activeTab !== 'live') {
    const allNode = document.createElement('div');
    allNode.className = `category-item ${state.activeCategory === 'all' ? 'active' : ''}`;
    allNode.dataset.category = 'all';
    allNode.setAttribute('role', 'button');
    allNode.tabIndex = 0;

    let totalStreams = 0;
    categories.forEach(c => totalStreams += (c.count || 0));

    allNode.innerHTML = `
      <span class="cat-label">All ${state.activeTab === 'movies' ? 'movies' : 'series'}</span>
      <span class="cat-count">${totalStreams}</span>
    `;
    container.appendChild(allNode);
  }

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

  // VOD on desktop: offer an online subtitle search (OpenSubtitles via the
  // local server proxy) — TS streams rarely carry usable subs.
  if (p.isVod && (window.appHost || window.electronCast)) {
    options.push({ value: 'os:search', label: 'Search online subtitles…' });
  }

  if (options.length === 0) {
    showToast('No alternate audio or subtitle tracks', 'info');
    return;
  }

  openSortDropdown({
    title: 'Audio & Subtitles',
    options,
    onSelect: (v) => {
      if (v === 'os:search') { searchOnlineSubtitles(); return; }
      p.applyTrack(v);
      navigation.focusDefault('player');
    }
  });
};

// ==========================================================================
// ONLINE SUBTITLES (OpenSubtitles) — search by title, download, convert
// SRT→VTT, attach to the video. Needs a free API key (opensubtitles.com).
// ==========================================================================
function srtToVtt(srt) {
  const body = String(srt)
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}

function searchOnlineSubtitles() {
  const key = (localStorage.getItem('osApiKey') || '').trim();
  if (!key) {
    let typed = '';
    openSearchKeyboard({
      title: 'Enter OpenSubtitles API key (free at opensubtitles.com/consumers)',
      initial: '',
      onChange: (v) => { typed = v; },
      onClose: () => {
        if (typed && typed.trim()) {
          localStorage.setItem('osApiKey', typed.trim());
          searchOnlineSubtitles(); // continue straight into the search
        }
      }
    });
    return;
  }
  let typed = playerInstance.currentChannelName || '';
  openSearchKeyboard({
    title: 'Search online subtitles',
    initial: typed,
    onChange: (v) => { typed = v; },
    onClose: async () => {
      const query = (typed || '').trim();
      if (!query) return;
      try {
        showToast('Searching subtitles…', 'info', 2000);
        const r = await fetch(`/api/subs/search?q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`);
        if (!r.ok) {
          const err = (await r.json().catch(() => ({}))).error || r.statusText;
          if (/401|bad api key/i.test(err)) localStorage.removeItem('osApiKey'); // re-prompt next time
          throw new Error(err);
        }
        const items = await r.json();
        if (!items.length) { showToast('No subtitles found', 'info', 3000); return; }
        openSortDropdown({
          title: 'Subtitles',
          options: items.map(it => ({ value: String(it.fileId), label: it.label })),
          onSelect: async (fileId) => {
            try {
              const dl = await fetch('/api/subs/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileId: +fileId, key }),
              });
              if (!dl.ok) throw new Error((await dl.json().catch(() => ({}))).error || dl.statusText);
              playerInstance.addExternalSubtitle(srtToVtt(await dl.text()), 'OpenSubtitles');
              showToast('Subtitles loaded', 'success', 3000);
            } catch (e) {
              showToast(`Subtitle download failed: ${e.message}`, 'error', 5000);
            }
          }
        });
      } catch (e) {
        showToast(`Subtitle search failed: ${e.message}`, 'error', 5000);
      }
    }
  });
}

// ==========================================================================
// SLEEP TIMER — stop playback after a chosen number of minutes.
// ==========================================================================
let sleepTimerId = null;
let currentSleepMinutes = 0;
function setSleepTimer(minutes) {
  clearTimeout(sleepTimerId);
  sleepTimerId = null;
  currentSleepMinutes = minutes || 0;
  const valEl = document.getElementById('tile-sleep-val');
  if (!minutes) {
    if (valEl) valEl.textContent = 'Off';
    return;
  }
  sleepTimerId = setTimeout(() => {
    try { if (playerInstance) playerInstance.stop(); } catch (e) {}
    showToast('Sleep timer: playback stopped', 'info', 6000);
    currentSleepMinutes = 0;
    if (valEl) valEl.textContent = 'Off';
    sleepTimerId = null;
  }, minutes * 60000);
  const endsAt = new Date(Date.now() + minutes * 60000)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (valEl) valEl.textContent = `On · stops ${endsAt}`;
  showToast(`Sleep timer set for ${minutes} min`, 'success');
}

// Refresh the Settings tile values from current credentials / app state.
function refreshStartupTiles(s) {
  const setBadge = (id, on) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = on ? 'On' : 'Off';
    el.classList.toggle('tile-badge-off', !on);
  };
  setBadge('tile-startup-val', !!(s && s.openAtLogin));
  setBadge('tile-startminimized-val', !!(s && s.startMinimized));
}

function refreshSettingsTiles() {
  const creds = (state.user && state.user.credentials) || {};

  const fmtEl = document.getElementById('tile-stream-format-val');
  if (fmtEl) fmtEl.textContent = (creds.stream_format === 'm3u8') ? 'HLS (.m3u8)' : 'MPEG-TS (.ts)';

  const engineTile = document.getElementById('tile-player-engine');
  const engineValEl = document.getElementById('tile-player-engine-val');
  if (engineTile) {
    const nativeAvail = isNativeAvailable();
    engineTile.style.display = nativeAvail ? 'flex' : 'none';
    if (nativeAvail && engineValEl) {
      const saved = localStorage.getItem('playerEngine') || 'native';
      if (saved === 'web') {
        engineValEl.textContent = 'Web Player';
      } else {
        engineValEl.textContent = 'Native Player';
      }
    }
  }

  // Desktop (Electron) player engine: FFmpeg server transcode vs HTML5 browser
  // player. Only shown in the Electron app — web/Android have no ffmpeg host.
  const desktopEngineTile = document.getElementById('tile-desktop-engine');
  const desktopEngineValEl = document.getElementById('tile-desktop-engine-val');
  if (desktopEngineTile) {
    const isElectronApp = !!(window.appHost || window.electronCast);
    desktopEngineTile.style.display = isElectronApp ? 'flex' : 'none';
    if (isElectronApp && desktopEngineValEl) {
      const saved = localStorage.getItem('electronEngine') || 'ffmpeg';
      const labels = { ffmpeg: 'Auto (Direct + FFmpeg fallback)', external: 'External Player', html5: 'HTML5 Player' };
      desktopEngineValEl.textContent = labels[saved] || 'Auto (Direct + FFmpeg fallback)';
    }
  }

  const proxyOn = creds.proxy_streams ?? true;
  const proxyEl = document.getElementById('tile-proxy-val');
  if (proxyEl) {
    proxyEl.textContent = proxyOn ? 'On' : 'Off';
    proxyEl.classList.toggle('tile-badge-off', !proxyOn);
  }

  let perfSaved = null;
  try { perfSaved = localStorage.getItem('perfLite'); } catch (e) {}
  const perfEl = document.getElementById('tile-perf-val');
  if (perfEl) {
    const on = document.body.classList.contains('perf-lite');
    perfEl.textContent = perfSaved === null ? `Auto (${on ? 'On' : 'Off'})` : (perfSaved === 'on' ? 'On' : 'Off');
    perfEl.classList.toggle('tile-badge-off', !on);
  }

  // Appearance tile (Dark default / Light). Hidden on TV and the Android app —
  // both are forced dark (see isLightEnabled).
  const themeTile = document.getElementById('tile-theme');
  if (themeTile) {
    const forcedDark = document.body.classList.contains('tv-layout') ||
      (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android');
    themeTile.style.display = forcedDark ? 'none' : '';
    const themeEl = document.getElementById('tile-theme-val');
    if (themeEl) {
      themeEl.textContent = getThemePref() === 'light' ? 'Light' : 'Dark';
    }
  }

  // Upscaler tile: works on the Chromium <video> path (Electron/web). Hidden on
  // Android native, where libVLC renders the picture behind the WebView and a
  // canvas overlay can't touch it (and would cover the video).
  const upscalerTile = document.getElementById('tile-upscaler');
  if (upscalerTile) {
    let isNative = false;
    try { isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch (e) {}
    upscalerTile.style.display = isNative ? 'none' : '';
    const upEl = document.getElementById('tile-upscaler-val');
    if (upEl) {
      let mode = 'off';
      try {
        if (window.playerInstance && window.playerInstance.getUpscalerMode) {
          mode = window.playerInstance.getUpscalerMode();
        } else {
          mode = localStorage.getItem('upscaler_mode') || (localStorage.getItem('upscaler_enabled') === '1' ? 'fsr' : 'off');
        }
      } catch (e) {}
      const modeNames = { anime4k: 'Anime4K', fsr: 'AMD FSR', bicubic: 'Bicubic', off: 'Off' };
      upEl.textContent = modeNames[mode] || 'Off';
      upEl.classList.toggle('tile-badge-off', mode === 'off');
    }
  }

  // Startup tiles (Run at Startup / Start Minimized): desktop app only.
  const isElectronApp = !!(window.appHost && window.appHost.isElectron);
  const startupTile = document.getElementById('tile-startup');
  const startMinTile = document.getElementById('tile-startminimized');
  if (startupTile) startupTile.style.display = isElectronApp ? '' : 'none';
  if (startMinTile) startMinTile.style.display = isElectronApp ? '' : 'none';
  if (isElectronApp && window.appHost.getStartupSettings) {
    window.appHost.getStartupSettings().then(refreshStartupTiles).catch(() => {});
  }

  // Ad Blocker tile: Electron-only (webview traffic is filtered in the main
  // process; the web/Android builds have nothing to hook it into).
  const adblockTile = document.getElementById('tile-adblock');
  if (adblockTile) {
    const electron = !!(window.appHost && window.appHost.isElectron);
    adblockTile.style.display = electron ? '' : 'none';
    const adEl = document.getElementById('tile-adblock-val');
    if (adEl) {
      const on = isAdblockOn();
      adEl.textContent = on ? 'On' : 'Off';
      adEl.classList.toggle('tile-badge-off', !on);
    }
  }

  const verEl = document.getElementById('tile-update-val');
  if (verEl && typeof __APP_VERSION__ !== 'undefined') verEl.textContent = `v${__APP_VERSION__}`;

  const logoutEl = document.getElementById('tile-logout-val');
  if (logoutEl) {
    // Show the active playlist's name (fall back to the server hostname, then a
    // generic label) so users identify which account they'd be logging out of.
    let logoutLabel = creds.playlistName || '';
    if (!logoutLabel && creds.server_url) {
      try { logoutLabel = new URL(creds.server_url).hostname; } catch (e) {}
    }
    logoutEl.textContent = logoutLabel || 'Disconnect';
  }

  const netEl = document.getElementById('tile-network-val');
  if (netEl) {
    const links = getTvLinks();
    netEl.textContent = links.length ? links[0].label : 'No link available';
  }
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
  if (epgGridInstance) epgGridInstance.render(false);
}

// Pin/unpin menu for a focused/right-clicked channel row in the live guide.
window.openChannelPinMenu = function (rowEl) {
  if (!rowEl) return;
  const id = rowEl.dataset.streamId;
  if (!id) return;
  const name = rowEl.querySelector('.epg-channel-name-text')?.textContent?.trim() || 'Channel';
  const pinned = isChannelPinned(id);
  const options = [{ value: 'toggle', label: pinned ? 'Unpin from top' : 'Pin to top' }];
  // Desktop: also offer to record the show airing now (D-pad can't focus a future
  // cell, so the remote records the current programme; mouse can right-click any).
  const now = (window.appHost || window.electronCast)
    ? epgGridInstance?.getNowNext(id)?.current : null;
  if (now) options.push({ value: 'record', label: `Record now: ${now.title || 'current show'}` });
  openSortDropdown({
    title: name,
    options,
    onSelect: (value) => {
      if (value === 'record') {
        const channel = epgGridInstance?.channels?.find(c => String(c.stream_id) === String(id));
        if (channel) window.scheduleRecordProgram(channel, now);
        return;
      }
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

// Guards against the same tab+category being loaded twice back-to-back (e.g. a
// tab switch that auto-selects "All" while another trigger also fires), which
// showed up as the grid loading its content twice. Direct reloads from
// pagination / search / sort bypass this since they call the grid loaders.
let _lastContentKey = '';
let _lastContentAt = 0;

async function loadCategoryContent() {
  const key = `${state.activeTab}:${state.activeCategory}`;
  const now = Date.now();
  if (key === _lastContentKey && now - _lastContentAt < 800) return;
  _lastContentKey = key;
  _lastContentAt = now;

  if (state.activeTab === 'live') {
    // Live view: Fetch all streams for selected category and feed to EPG Grid
    // (EPG doesn't paginate internally because guide requires full list of active channels in timeline)
    const res = await getStreams({
      type: 'live',
      categoryId: state.activeCategory,
      page: 1,
      // Load the full category. Rendering thousands of rows used to crash
      // layout, so the list is capped here — but each .epg-channel-row now uses
      // CSS `content-visibility: auto` (see style.css), which lets the browser
      // skip layout/paint for off-screen cards. That makes large lists cheap, so
      // the cap is only a generous safety ceiling rather than a hard 1000 limit.
      limit: 100000,
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
  // Catch-up: a past programme on an archive-capable channel replays from the
  // provider's timeshift archive instead of going live.
  const progEndMs = programBlock?.end_timestamp ? parseInt(programBlock.end_timestamp, 10) * 1000 : 0;
  const progStartMs = programBlock?.start_timestamp ? parseInt(programBlock.start_timestamp, 10) * 1000 : 0;
  if (channel.tv_archive && progStartMs && progEndMs && progEndMs < Date.now()) {
    return playCatchup(channel, programBlock);
  }

  // Last-channel zap: remember the channel we're leaving so Backspace can
  // jump straight back to it (classic cable-box behavior).
  if (state.activeChannel && String(state.activeChannel.stream_id) !== String(channel.stream_id)) {
    state.lastChannel = state.activeChannel;
  }

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

    // Load to player. On desktop, route live through the 30-min timeshift buffer
    // so the user can pause/rewind; fall back to direct play if it can't start.
    // Don't await the buffer spin-up — loadLiveTimeshift paints the player +
    // spinner immediately, and we run the UI (fullscreen, banners) right away so
    // the click feels instant instead of waiting on ffmpeg's first segments.
    playerInstance.setSeriesMode(false);
    // The external player manages its own buffering and needs the real upstream
    // URL — never the app's local timeshift HLS buffer (which it can't open).
    // So skip timeshift entirely when the Desktop Player is set to "external".
    const usingExternalPlayer = (() => {
      try { return localStorage.getItem('electronEngine') === 'external'; } catch (e) { return false; }
    })();
    // DIAGNOSTIC (7.0 skip-back hunt): timeshift/replay is OPT-IN for now —
    // live always plays direct unless localStorage 'timeshift' is set to 'on'.
    // The DVR buffer (hls.js error-recovery re-seeking into it) is the prime
    // suspect for live playback skipping backwards. Revert to `!== 'off'`
    // once the culprit is confirmed.
    const wantTimeshift = (window.appHost || window.electronCast)
      && localStorage.getItem('timeshift') === 'on'
      && !usingExternalPlayer;
    if (wantTimeshift) {
      // Paint the player shell now (synchronously) so autoFullscreen() below has
      // something to fullscreen and the click is instant.
      playerInstance._enterLiveUi(channel.name, channel.stream_icon, epgTitle);
      // Feed the segmenter the continuous .ts (never ends, so ffmpeg keeps
      // running). An m3u8 source is a finite playlist ffmpeg reads to the end and
      // exits, which caused a freeze/restart cycle. Decode flicker is handled by
      // transcoding audio to AAC server-side, not by the input format.
      getStreamUrl(channel.stream_id, 'live', '', 'ts')
        .then((tsSource) => playerInstance.loadLiveTimeshift(tsSource, channel.stream_id, channel.name, channel.stream_icon, epgTitle))
        .then((ok) => { if (!ok) playerInstance.loadStream(streamUrl, channel.name, channel.stream_icon, epgTitle); })
        .catch(() => playerInstance.loadStream(streamUrl, channel.name, channel.stream_icon, epgTitle));
    } else {
      playerInstance.loadStream(streamUrl, channel.name, channel.stream_icon, epgTitle);
    }

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

// ==========================================================================
// LAST-CHANNEL ZAP — Backspace jumps between the two most recent channels.
// ==========================================================================
window.zapLastChannel = function () {
  const prev = state.lastChannel;
  if (!prev) { window.showToast?.('No previous channel yet', 'info', 2000); return; }
  const nn = (window.epgGridInstance && epgGridInstance.getNowNext)
    ? epgGridInstance.getNowNext(prev.stream_id) : null;
  selectAndPlayChannel(prev, (nn && nn.current) || null);
};

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Backspace') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  // TV remotes map Back to Backspace — that's navigation, not zap.
  if (document.body.classList.contains('tv-layout')) return;
  if (!state.lastChannel) return;
  e.preventDefault();
  window.zapLastChannel();
});

// ==========================================================================
// EPG REMINDERS — bell a future programme; a banner pops when it starts,
// with one-click tune-in. Persisted in localStorage.
// ==========================================================================
const REMINDERS_KEY = 'epgReminders';
function getReminders() {
  try { return JSON.parse(localStorage.getItem(REMINDERS_KEY)) || []; } catch (e) { return []; }
}
function saveReminders(rems) {
  try { localStorage.setItem(REMINDERS_KEY, JSON.stringify(rems)); } catch (e) {}
}
window.isReminderSet = (streamId, startTs) =>
  getReminders().some(r => String(r.sid) === String(streamId) && +r.start === +startTs);

window.toggleReminder = function (streamId, channelName, progTitle, startTs) {
  const rems = getReminders();
  const i = rems.findIndex(r => String(r.sid) === String(streamId) && +r.start === +startTs);
  if (i >= 0) {
    rems.splice(i, 1);
    window.showToast?.('Reminder removed', 'info', 2000);
  } else {
    rems.push({ sid: streamId, ch: channelName || '', title: progTitle || 'Programme', start: +startTs });
    const t = new Date(startTs * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    window.showToast?.(`Reminder set: ${progTitle} at ${t}`, 'success', 3000);
  }
  saveReminders(rems);
};

function showReminderBanner(rem) {
  document.getElementById('reminder-banner')?.remove();
  const el = document.createElement('div');
  el.id = 'reminder-banner';
  const text = document.createElement('div');
  text.className = 'reminder-banner-text';
  const strong = document.createElement('strong');
  strong.textContent = rem.title;
  text.appendChild(strong);
  text.appendChild(document.createTextNode(` is starting on ${rem.ch}`));
  const watch = document.createElement('button');
  watch.className = 'reminder-banner-watch';
  watch.textContent = 'Watch';
  watch.addEventListener('click', () => {
    el.remove();
    const ch = (epgGridInstance?.channels || []).find(c => String(c.stream_id) === String(rem.sid));
    if (!ch) { window.showToast?.('Channel not found in the current list', 'error', 3000); return; }
    const nn = epgGridInstance?.getNowNext ? epgGridInstance.getNowNext(ch.stream_id) : null;
    selectAndPlayChannel(ch, (nn && nn.current) || null);
  });
  const close = document.createElement('button');
  close.className = 'reminder-banner-close';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => el.remove());
  el.appendChild(text);
  el.appendChild(watch);
  el.appendChild(close);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 60000); // self-clears after a minute
}

function checkReminders() {
  const now = Date.now();
  const rems = getReminders();
  if (!rems.length) return;
  const due = [];
  const keep = [];
  rems.forEach(r => {
    const startMs = r.start * 1000;
    if (startMs - now <= 60000) due.push(r); // fires up to 1 min early
    else keep.push(r);
  });
  if (!due.length) return;
  saveReminders(keep);
  // Fire only reminders that aren't stale (missed by >10 min, e.g. app closed).
  due.filter(r => now - r.start * 1000 < 10 * 60000).forEach(showReminderBanner);
  // Refresh any visible bells so their active state matches storage.
  if (state.activeChannel) renderUpcomingPrograms(state.activeChannel);
}
setInterval(checkReminders, 30000);

// Replay a past programme from the provider's catch-up archive. The timeshift
// stream is a finite, seekable segment, so we play it as VOD (scrubbable bar)
// rather than live. On desktop the FFmpeg engine transcodes it to a seekable
// fMP4; the HTML5 engine plays it via the mpegts.js fallback.
async function playCatchup(channel, prog) {
  state.activeChannel = channel;
  state.activeProgram = prog;
  document.body.classList.remove('vod-mode');
  try {
    const start = parseInt(prog.start_timestamp, 10);
    const end = parseInt(prog.end_timestamp, 10);
    const duration = Math.max(1, Math.round((end - start) / 60)); // minutes
    const url = await getCatchupUrl(channel.stream_id, start, duration);
    const title = prog.title || 'Catch-up';
    const label = `${channel.name} — ${title}`;

    incrementChannelView(channel.stream_id);

    playerInstance.setSeriesMode(false);
    // isVod = true → seekable player UI with the real programme duration.
    playerInstance.loadStream(url, label, channel.stream_icon, title, true);
    setCastContext({ streamId: channel.stream_id, type: 'live', title: label, isLive: false });
    updateDetailsPanel(channel, prog);
    playerInstance.autoFullscreen();
    navigation.focusDefault('player');
  } catch (err) {
    console.error('Catch-up playback failed:', err);
    showToast('Catch-up is not available for this programme', 'error', 4000);
  }
}

// Toggle deinterlace-to-60fps (server ffmpeg field-doubling) from the player
// control bar, and re-apply it to whatever's playing right now.
function toggleDeinterlace() {
  if (!(window.appHost || window.electronCast)) {
    showToast('Deinterlace is available on the desktop app.', 'error', 3000);
    return;
  }
  const on = localStorage.getItem('deinterlace') === '1';
  const next = on ? '0' : '1';
  try { localStorage.setItem('deinterlace', next); } catch (e) {}
  playerInstance.reflectDeinterlace(next === '1');
  showToast(next === '1' ? 'Deinterlace On — 60fps' : 'Deinterlace Off', 'success', 2500);

  // Re-apply to the current stream so the change is visible immediately.
  if (!playerInstance.hasStream) return;
  if (playerInstance.isVod) {
    playerInstance.reloadCurrent(); // VOD / catch-up → rebuild the transcode
  } else if (state.activeChannel) {
    // Live → re-tune with the now-playing programme (never catch-up) so the
    // timeshift segmenter restarts with the new deinterlace setting.
    const nn = (window.epgGridInstance && epgGridInstance.getNowNext)
      ? epgGridInstance.getNowNext(state.activeChannel.stream_id) : null;
    selectAndPlayChannel(state.activeChannel, (nn && nn.current) || null);
  }
}

// ==========================================================================
// DVR / RECORDINGS (desktop only — the server records via the bundled ffmpeg)
// ==========================================================================
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(0, Math.round(b / 1e6)) + ' MB';

// Record the channel that's playing now. Records the rest of the current EPG
// programme when its end time is known, otherwise a default 2-hour block.
async function recordCurrentChannel() {
  const ch = state.activeChannel;
  if (!ch) { window.showToast?.('Start a channel first, then record.', 'error', 3000); return; }
  try {
    // Force the continuous .ts stream (not the account's default format, which may
    // be m3u8) so ffmpeg records the full duration instead of stopping at the end
    // of a finite HLS playlist.
    const target = playerInstance._transcodeTarget(await getStreamUrl(ch.stream_id, 'live', '', 'ts'));
    let durationMins = 120;
    const end = state.activeProgram?.end || state.activeProgram?.stop_timestamp;
    if (end) {
      const endMs = String(end).length > 12 ? +end : +end * 1000;
      const left = Math.round((endMs - Date.now()) / 60000);
      if (left > 0 && left < 720) durationMins = left + 2; // pad 2 min
    }
    const res = await fetch('/api/record', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target, name: ch.name, channel: ch.name, durationMins }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    window.showToast?.(`Recording "${ch.name}" for ${durationMins} min`, 'success', 4000);
    updateRecordingsCount();
  } catch (e) {
    window.showToast?.(`Could not start recording: ${e.message}`, 'error', 5000);
  }
}

// Right-click a programme in the EPG guide → record it. Future show = scheduled
// recording (server arms a timer); currently-airing = record the rest now.
// Desktop only (recording needs the bundled ffmpeg).
window.scheduleRecordProgram = (channel, prog) => {
  if (!(window.appHost || window.electronCast)) {
    window.showToast?.('Recording is available on the desktop app.', 'error', 3500);
    return;
  }
  if (!channel || !prog) return;
  const endMs = parseInt(prog.end_timestamp) * 1000;
  if (!endMs || endMs <= Date.now()) { window.showToast?.('That programme has already aired.', 'error', 3000); return; }
  // One click = record (if airing) or schedule (if upcoming). No intermediate menu.
  doScheduleRecord(channel, prog);
};

// Bulletproof EPG record: a single capture-phase listener on document. It runs
// BEFORE the programme block's own click handler, so stopping propagation here
// guarantees the click can't fall through to a channel switch — regardless of
// per-block listener timing or re-renders. Channel/programme are reconstructed
// from the block's data-* attributes (set in epg.js render).
document.addEventListener('click', (e) => {
  const recBtn = e.target.closest && e.target.closest('.epg-rec-btn');
  if (!recBtn) return;
  e.stopPropagation();
  e.preventDefault();
  const block = recBtn.closest('.epg-program-block');
  if (!block) return;
  const channel = {
    stream_id: block.dataset.streamId,
    name: block.dataset.channelName,
    stream_icon: block.dataset.channelIcon,
  };
  const prog = {
    start_timestamp: block.dataset.progStart,
    end_timestamp: block.dataset.progEnd,
    title: block.dataset.progTitle,
  };
  window.scheduleRecordProgram?.(channel, prog);
}, true);

async function doScheduleRecord(channel, prog) {
  try {
    // Record from the continuous .ts stream, NOT m3u8: an HLS playlist is finite,
    // so ffmpeg reads it to the end and exits early (the truncated-recording bug).
    // The raw .ts never ends, so -t controls the real recording length.
    const target = playerInstance._transcodeTarget(await getStreamUrl(channel.stream_id, 'live', '', 'ts'));
    const startMs = parseInt(prog.start_timestamp) * 1000;
    const endMs = parseInt(prog.end_timestamp) * 1000;
    const now = Date.now();
    const name = `${channel.name} - ${prog.title || 'Recording'}`;
    const post = (path, body) => fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); });
    if (now < startMs) {
      const durationMins = Math.max(1, Math.round((endMs - startMs) / 60000)) + 2; // pad 2 min
      await post('/api/recordings/schedule', { url: target, name, channel: channel.name, startAt: new Date(startMs).toISOString(), durationMins });
      window.showToast?.(`Scheduled: ${name}`, 'success', 4000);
    } else {
      const durationMins = Math.max(1, Math.round((endMs - now) / 60000)) + 2;
      await post('/api/record', { url: target, name, channel: channel.name, durationMins });
      window.showToast?.(`Recording now: ${name}`, 'success', 4000);
    }
    updateRecordingsCount();
  } catch (e) {
    window.showToast?.(`Could not record: ${e.message}`, 'error', 5000);
  }
}

// Keep the sidebar "Recordings" badge in sync with finished + scheduled counts.
// Called on boot and after any record/schedule/cancel/delete.
async function updateRecordingsCount() {
  const el = document.getElementById('count-recordings');
  if (!el) return;
  try {
    const [recs, sched] = await Promise.all([
      fetch('/api/recordings').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/recordings/schedule').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    el.textContent = (Array.isArray(recs) ? recs.length : 0) + (Array.isArray(sched) ? sched.length : 0);
  } catch (e) {}
}

function openRecordingsModal() {
  const modal = document.getElementById('recordings-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  renderRecordings();
}
function closeRecordingsModal() {
  document.getElementById('recordings-modal')?.classList.add('hidden');
}

async function renderRecordings() {
  const list = document.getElementById('recordings-list');
  if (!list) return;
  list.innerHTML = '<div class="recordings-empty">Loading…</div>';
  let recs = [], sched = [];
  try { recs = await (await fetch('/api/recordings')).json(); } catch (e) {}
  try { sched = await (await fetch('/api/recordings/schedule')).json(); } catch (e) {}
  if (!Array.isArray(recs)) recs = [];
  if (!Array.isArray(sched)) sched = [];

  const cEl = document.getElementById('count-recordings');
  if (cEl) cEl.textContent = recs.length + sched.length;

  if (recs.length === 0 && sched.length === 0) {
    list.innerHTML = '<div class="recordings-empty">No recordings yet. In the TV Guide, hover a programme and hit REC — upcoming shows are scheduled, current ones record now.</div>';
    return;
  }
  list.innerHTML = '';

  // Scheduled (upcoming) recordings — the server arms a timer for each and
  // re-arms them on reboot; this section lets you see and cancel them.
  if (sched.length) {
    const hdr = document.createElement('div');
    hdr.className = 'recordings-section-hdr';
    hdr.style.cssText = 'font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:rgba(255,255,255,0.5);margin:4px 4px 8px;';
    hdr.textContent = 'Scheduled';
    list.appendChild(hdr);
    sched.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    for (const j of sched) {
      const row = document.createElement('div');
      row.className = 'recording-row';
      const when = new Date(j.startAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
      row.innerHTML = `
        <i data-lucide="clock"></i>
        <div class="rec-meta">
          <div class="rec-name">${j.name}</div>
          <div class="rec-sub">Scheduled · ${when} · ${j.durationMins} min</div>
        </div>
        <div class="rec-actions">
          <button data-act="cancel" title="Cancel scheduled recording"><i data-lucide="x"></i></button>
        </div>`;
      row.querySelector('[data-act="cancel"]')?.addEventListener('click', async () => {
        await fetch(`/api/recordings/schedule/${j.id}`, { method: 'DELETE' }).catch(() => {});
        renderRecordings();
      });
      list.appendChild(row);
    }
    if (recs.length) {
      const rhdr = document.createElement('div');
      rhdr.className = 'recordings-section-hdr';
      rhdr.style.cssText = hdr.style.cssText + 'margin-top:16px;';
      rhdr.textContent = 'Recordings';
      list.appendChild(rhdr);
    }
  }
  for (const r of recs) {
    const row = document.createElement('div');
    row.className = 'recording-row';
    const when = new Date(r.createdAt).toLocaleString();
    const recording = r.status === 'recording';
    const sub = recording ? `● Recording… · ${when}` : `${r.status === 'failed' ? 'Failed' : fmtSize(r.size)} · ${when}`;
    row.innerHTML = `
      <i data-lucide="${recording ? 'circle-dot' : 'play'}" class="${recording ? 'rec-dot' : ''}"></i>
      <div class="rec-meta">
        <div class="rec-name">${r.name}</div>
        <div class="rec-sub">${sub}</div>
      </div>
      <div class="rec-actions">
        ${recording ? '<button data-act="stop" title="Stop recording"><i data-lucide="square"></i></button>'
                    : '<button data-act="delete" title="Delete"><i data-lucide="trash-2"></i></button>'}
      </div>`;
    // Play a finished recording by clicking the row (VOD playback of the .ts file).
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (r.status === 'failed' || recording) return;
      closeRecordingsModal();
      document.body.classList.add('vod-mode');
      playerInstance.setSeriesMode(false);
      playerInstance.loadStream(r.playUrl, r.name, '', '', true);
    });
    row.querySelector('[data-act="stop"]')?.addEventListener('click', async () => {
      await fetch(`/api/recordings/${r.id}/stop`, { method: 'POST' }).catch(() => {});
      renderRecordings();
    });
    row.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      await fetch(`/api/recordings/${r.id}`, { method: 'DELETE' }).catch(() => {});
      renderRecordings();
    });
    list.appendChild(row);
  }
  window.lucide?.createIcons();
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
    channelIcon.src = proxifyImage(channel.stream_icon);
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

  // Channel-specific "Up Next" schedule (fills the details panel's lower area)
  renderUpcomingPrograms(channel);
}

// Render the next few upcoming programs for a channel into the details panel.
function renderUpcomingPrograms(channel) {
  const wrap = document.getElementById('detail-upcoming');
  const list = document.getElementById('detail-upcoming-list');
  if (!wrap || !list) return;

  const upcoming = (epgGridInstance?.getNowNext(channel.stream_id)?.upcoming) || [];
  if (!upcoming.length) {
    wrap.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  const canRecord = !!(window.appHost || window.electronCast); // DVR is desktop-only
  list.innerHTML = upcoming.map(prog => {
    const startMs = parseInt(prog.start_timestamp) * 1000;
    const time = new Date(startMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const title = prog.title || 'No information';
    const remOn = window.isReminderSet(channel.stream_id, +prog.start_timestamp);
    return `
      <div class="upcoming-item">
        <span class="upcoming-time">${time}</span>
        <span class="upcoming-title">${title}</span>
        <span class="upcoming-actions">
          <button class="upcoming-act upcoming-remind${remOn ? ' active' : ''}" title="${remOn ? 'Remove reminder' : 'Remind me'}"><i data-lucide="bell"></i></button>
          ${canRecord ? '<button class="upcoming-act upcoming-rec" title="Record this programme"><i data-lucide="circle-dot"></i></button>' : ''}
        </span>
      </div>`;
  }).join('');
  list.querySelectorAll('.upcoming-remind').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const prog = upcoming[i];
      window.toggleReminder(channel.stream_id, channel.name, prog.title || 'Programme', +prog.start_timestamp);
      renderUpcomingPrograms(channel); // re-render to reflect the new bell state
    });
  });
  list.querySelectorAll('.upcoming-rec').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.scheduleRecordProgram(channel, upcoming[i]);
    });
  });
  if (window.lucide) lucide.createIcons({ scope: list });
  wrap.classList.remove('hidden');
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
  // 7.0 TV shell: zap within the channel list the shell played from (the
  // legacy EPG-grid rows below aren't rendered under the shell).
  if (window.__tvNativeZap && window.__tvNativeZap(1)) return;
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
  if (window.__tvNativeZap && window.__tvNativeZap(-1)) return;
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
    card.dataset.streamId = movie.stream_id;

    const rating = parseFloat(movie.rating) || 0;
    const year = movie.year || movie.releaseDate || 'N/A';
    const logo = proxifyImage(movie.stream_icon || '');
    const watched = isCompleted(movie.stream_id);
    if (watched) card.classList.add('watched');

    card.innerHTML = `
      <div class="vod-poster-wrapper">
        ${logo ? `<img src="${logo}" alt="" loading="lazy" decoding="async" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22150%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%221%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%222%22/></svg>'">` : '<div class="poster-placeholder"><i data-lucide="film"></i></div>'}
        <div class="vod-card-overlay">
          <span class="vod-card-year">${year}</span>
          ${rating > 0 ? `<span class="vod-rating-badge"><i data-lucide="star"></i>${rating.toFixed(1)}</span>` : ''}
        </div>
        ${watched ? '<div class="watch-again-badge"><i data-lucide="rotate-ccw"></i><span>Watch again</span></div>' : ''}
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
    const logo = proxifyImage(series.stream_icon || series.cover || series.cover_big || '');

    card.innerHTML = `
      <div class="vod-poster-wrapper">
        ${logo ? `<img src="${logo}" alt="" loading="lazy" decoding="async" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22150%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234b5563%22 stroke-width=%221%22><rect x=%222%22 y=%222%22 width=%2220%22 height=%2220%22 rx=%222%22/></svg>'">` : '<div class="poster-placeholder"><i data-lucide="tv"></i></div>'}
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
  if (coverImg) coverImg.src = proxifyImage(series.stream_icon || series.cover || series.cover_big || '');
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
      markCurrentWatched();
      playNextEpisode();
    };
  }
  
  try {
    const info = await getStreamInfo(series.series_id, 'series');
    const infoMeta = info.info || {};
    
    // Save backdrop image to currentSeriesMeta
    let backdrop = '';
    if (infoMeta.backdrop_path) {
      if (Array.isArray(infoMeta.backdrop_path) && infoMeta.backdrop_path.length > 0) {
        backdrop = infoMeta.backdrop_path[0];
      } else if (typeof infoMeta.backdrop_path === 'string') {
        backdrop = infoMeta.backdrop_path;
      }
    }
    if (state.currentSeriesMeta) {
      state.currentSeriesMeta.backdrop = backdrop;
    }

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
        const epW = getWatchInfo(ep.id);
        if (epW.completed) row.classList.add('watched');
        row.innerHTML = `
          <div class="episode-row-left-details">
            <span class="episode-row-title-text">Ep ${ep.episode_num || '0'}: ${ep.title || 'Episode'}</span>
            <span class="episode-row-duration-text">Duration: ${ep.info?.duration || 'N/A'}</span>
          </div>
          ${epW.completed
            ? '<span class="episode-row-watched"><i data-lucide="rotate-ccw"></i>Watch again</span>'
            : '<i data-lucide="play-circle" class="episode-row-play-icon"></i>'}
          ${(!epW.completed && epW.pct > 0)
            ? `<div class="episode-row-progress"><div style="width:${epW.pct}%"></div></div>`
            : ''}
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

    // Opened from Continue Watching → jump to that episode's season and
    // highlight/focus it, but DON'T auto-play. A grouped CW card represents the
    // series, so a click lands you in the detail screen on the episode you left
    // off; you press play from there.
    if (resumeOpts && resumeOpts.episodeId) {
      const rSeason = episodesMap[resumeOpts.season] ? String(resumeOpts.season) : seasons[0];
      if (select) select.value = rSeason;
      loadSeasonEpisodes(rSeason);
      const targetRow = document.querySelector(`.episode-list-row[data-episode-id="${resumeOpts.episodeId}"]`);
      if (targetRow) {
        document.querySelectorAll('.episode-list-row').forEach(r => r.classList.remove('active'));
        targetRow.classList.add('active');
        try { targetRow.scrollIntoView({ block: 'center' }); } catch (e) {}
        try { navigation.setFocus('series-episodes', targetRow); } catch (e) {}
      } else {
        navigation.focusDefault('series-episodes');
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
    episodeLabel: `S${seasonNum}E${ep.episode_num || (epIndex + 1)}`,
    backdrop: sm.backdrop || ''
  };
  lastProgressSave = 0;

  // Feed the TV-shell playback OSD (no-op outside the shell). Done here — not
  // in the shell's own handlers — because auto-next on episode end and >>/<<
  // episode zapping also funnel through this function, keeping the OSD title
  // card and its "Up next" line fresh on every episode change.
  try {
    if (typeof window.__tvnOsdVod === 'function') {
      const nx = episodesListForSeason[epIndex + 1];
      window.__tvnOsdVod({
        title: ep.title || `Episode ${ep.episode_num || epIndex + 1}`,
        sub: `${sm.name || seriesInfo.info?.name || 'Series'} · Season ${seasonNum} · Episode ${ep.episode_num || (epIndex + 1)}`,
        next: nx ? (nx.title || `Episode ${nx.episode_num || (epIndex + 2)}`) : '',
        logo: sm.cover || logo || '',
        series: true // OSD shows prev/next episode without waiting for series-mode
      });
    }
  } catch (e) {}

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

// 7.0 TV shell: play a series episode with full series context (auto-advance
// on end, remote >>/<< episode zap) but WITHOUT the legacy series page — the
// shell has no catalog behind the player, so it runs in the same vod-mode
// overlay movies use. Handlers are restored on exit so live-channel zapping
// and movie playback aren't left pointing at a dead series session.
async function playSeriesEpisodeTv(seriesItem, info, seasonNum, epIndex, resumeTime = 0, backdrop = '') {
  const episodes = (info?.episodes || {})[String(seasonNum)] || [];
  const ep = episodes[epIndex];
  if (!ep || !playerInstance) return;

  // Series metadata for Continue Watching entries (playSeriesEpisode reads it).
  state.currentSeriesMeta = {
    id: seriesItem.series_id,
    name: info.info?.name || seriesItem.name || 'Series',
    cover: info.info?.cover || seriesItem.cover || seriesItem.stream_icon || '',
    backdrop
  };

  // Same overlay environment playVODStream sets up.
  document.body.classList.add('vod-mode');
  document.querySelector('.sidebar')?.classList.add('hidden');
  document.querySelector('.top-header')?.classList.add('hidden');
  document.querySelector('.epg-section-container')?.classList.add('hidden');
  document.querySelector('.program-details-panel')?.classList.add('hidden');

  playerInstance.setOnPrevChannel(() => playPreviousEpisode());
  playerInstance.setOnNextChannel(() => playNextEpisode());
  playerInstance.onVideoEnded = () => { markCurrentWatched(); playNextEpisode(); };
  playerInstance.onExitVod = () => {
    playerInstance.setOnPrevChannel(() => playPreviousChannel());
    playerInstance.setOnNextChannel(() => playNextChannel());
    playerInstance.onVideoEnded = null;
    playerInstance.onExitVod = exitVodPlayer;
    state.seriesPlayback = null;
    exitVodPlayer();
  };

  const epExt = ep.container_extension || ep.info?.container_extension || '';
  const epName = `${state.currentSeriesMeta.name} - S${seasonNum}E${ep.episode_num}: ${ep.title || ''}`;
  await playSeriesEpisode(ep.id, epName, state.currentSeriesMeta.cover, ep.info?.plot || '', epExt, epIndex, episodes, seasonNum, info, resumeTime);
}

// 7.0 TV shell: resume a series episode from Continue Watching without
// opening the legacy series dashboard (which would bleed the old UI through
// under the shell).
async function resumeSeriesEpisodeTv(item) {
  try {
    const info = await getStreamInfo(item.seriesId, 'series');
    const episodesMap = info?.episodes || {};
    const season = episodesMap[String(item.season)] ? String(item.season) : Object.keys(episodesMap)[0];
    const eps = episodesMap[season] || [];
    let idx = eps.findIndex(e => String(e.id) === String(item.id));
    let resume = item.position || 0;
    if (idx === -1) { idx = 0; resume = 0; } // episode gone from provider — start at S1E1 of that season
    if (!eps.length) throw new Error('No episodes');
    await playSeriesEpisodeTv(
      { series_id: item.seriesId, name: item.seriesName, cover: item.logo },
      info, season, idx, resume, item.backdrop || ''
    );
  } catch (err) {
    console.error('TV resume failed:', err);
    showToast('Failed to resume episode', 'error');
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
    const finishedId = currentVodItem?.id;
    currentVodItem = null;
    playbackContainer.classList.add('hidden');
    if (catalogContainer) catalogContainer.classList.remove('hidden');
    refreshContinueWatching();
    reflectWatchInView(finishedId);

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
  const wtBtn = document.getElementById('vod-modal-wt-btn');
  const seriesEpisodesContainer = document.getElementById('vod-series-episodes-container');

  // Clear modal values first
  title.textContent = vodData.name;
  rating.innerHTML = `<i data-lucide="star"></i> ${parseFloat(vodData.rating)?.toFixed(1) || 'N/A'}`;
  poster.src = proxifyImage(vodData.stream_icon || vodData.cover || vodData.cover_big || '');
  genre.textContent = 'General';
  release.textContent = vodData.releaseDate || vodData.year || 'N/A';
  duration.textContent = 'N/A';
  plot.textContent = 'Loading description details...';
  director.textContent = 'Loading...';
  cast.textContent = 'Loading...';

  playBtn.classList.remove('hidden');
  wtBtn.classList.add('hidden');   // movies only — shown once the metadata lands
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

      const resolveBackdrop = () => {
        const b = infoMeta.backdrop_path;
        if (Array.isArray(b) && b.length > 0) return b[0];
        if (typeof b === 'string') return b;
        return '';
      };

      playBtn.onclick = async () => {
        modal.classList.add('hidden');
        await playVODStream(queryId, 'movie', vodData.name, vodData.stream_icon, plot.textContent, movieExt, resumeTime, resolveBackdrop());
      };

      // Watch Together. The session carries identifiers only — every device
      // rebuilds its own stream URL from its own credentials.
      wtBtn.classList.remove('hidden');
      lucide.createIcons({ scope: wtBtn });
      wtBtn.onclick = async () => {
        modal.classList.add('hidden');
        await hostWatchSession({
          type: 'movie',
          streamId: String(queryId),
          ext: movieExt,
          name: vodData.name,
          logo: vodData.stream_icon || '',
          backdrop: resolveBackdrop()
        });
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
      row.dataset.episodeId = ep.id;
      const epW = getWatchInfo(ep.id);
      if (epW.completed) row.classList.add('watched');
      row.innerHTML = `
        <div class="episode-row-left">
          <span class="episode-title">Ep ${ep.episode_num || '0'}: ${ep.title || 'Episode'}</span>
          <span class="episode-meta">Duration: ${ep.info?.duration || 'N/A'}</span>
        </div>
        ${epW.completed
          ? '<span class="episode-row-watched"><i data-lucide="rotate-ccw"></i>Watch again</span>'
          : '<i data-lucide="play-circle" class="episode-play-icon"></i>'}
        ${(!epW.completed && epW.pct > 0)
          ? `<div class="episode-row-progress"><div style="width:${epW.pct}%"></div></div>`
          : ''}
      `;
      row.addEventListener('click', async () => {
        document.getElementById('vod-modal').classList.add('hidden');
        
        // Each episode is its own stream: identified by ep.id and played from a
        // file with its own container extension (mp4/mkv/…).
        const epStreamId = ep.id;
        const epExt = ep.container_extension || ep.info?.container_extension || '';
        const epName = `${seriesInfo.info?.name || 'Series'} - S${seasonNum}E${ep.episode_num}: ${ep.title}`;
        let backdrop = '';
        const infoMeta = seriesInfo.info || {};
        if (infoMeta.backdrop_path) {
          if (Array.isArray(infoMeta.backdrop_path) && infoMeta.backdrop_path.length > 0) {
            backdrop = infoMeta.backdrop_path[0];
          } else if (typeof infoMeta.backdrop_path === 'string') {
            backdrop = infoMeta.backdrop_path;
          }
        }
        await playVODStream(epStreamId, 'series', epName, seriesInfo.info?.cover, ep.info?.plot || '', epExt, 0, backdrop);
      });
      episodesList.appendChild(row);
    });

    lucide.createIcons({ scope: episodesList });
  };

  select.onchange = (e) => loadSeasonEpisodes(e.target.value);
  
  // Initial load season 1
  loadSeasonEpisodes(seasons[0]);
}

async function playVODStream(streamId, type, name, logo, description, containerExtension = '', resumeTime = 0, backdrop = '') {
  // Track this movie for Continue Watching.
  currentVodItem = { id: String(streamId), type: type || 'movie', name, cardTitle: name, logo, containerExtension, backdrop };
  lastProgressSave = 0;

  // Feed the TV-shell playback OSD (no-op outside the shell).
  try {
    if (typeof window.__tvnOsdVod === 'function') {
      window.__tvnOsdVod({
        title: name || 'Now playing',
        sub: (type || 'movie') === 'series' ? 'Series' : 'Movie',
        next: '',
        logo: logo || ''
      });
    }
  } catch (e) {}

  // Clear stale series auto-advance wiring — a previous series session would
  // otherwise auto-play ITS next episode when this stream ends. A movie that
  // plays to the end is marked watched, then the player closes.
  state.seriesPlayback = null;
  if (playerInstance) playerInstance.onVideoEnded = () => { markCurrentWatched(); exitVodPlayer(); };

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

// After playback, reflect a just-completed title in whatever screen the user
// backs out to — the movie card greys out, the episode row flips to "Watch
// again" — without waiting for a re-navigation. Also updates an in-progress
// episode's bottom progress bar. DOM-surgical so it doesn't rebuild the grid.
function reflectWatchInView(id) {
  if (id == null) return;
  const sid = String(id);
  const info = getWatchInfo(sid);

  // Movie catalog cards.
  document.querySelectorAll(`.vod-card[data-stream-id="${sid}"]`).forEach(card => {
    if (!info.completed || card.classList.contains('watched')) return;
    card.classList.add('watched');
    const wrap = card.querySelector('.vod-poster-wrapper');
    if (wrap && !wrap.querySelector('.watch-again-badge')) {
      wrap.insertAdjacentHTML('beforeend',
        '<div class="watch-again-badge"><i data-lucide="rotate-ccw"></i><span>Watch again</span></div>');
    }
  });

  // Episode rows (series detail + VOD-modal variants).
  document.querySelectorAll(
    `.episode-list-row[data-episode-id="${sid}"], .episode-row[data-episode-id="${sid}"]`
  ).forEach(row => {
    row.querySelector('.episode-row-progress')?.remove();
    if (info.completed) {
      row.classList.add('watched');
      const icon = row.querySelector('.episode-row-play-icon, .episode-play-icon');
      if (icon && !row.querySelector('.episode-row-watched')) {
        icon.outerHTML = '<span class="episode-row-watched"><i data-lucide="rotate-ccw"></i>Watch again</span>';
      }
    } else if (info.pct > 0) {
      row.insertAdjacentHTML('beforeend',
        `<div class="episode-row-progress"><div style="width:${info.pct}%"></div></div>`);
    }
  });

  if (window.lucide) { try { lucide.createIcons(); } catch (e) {} }
}

// Leave the VOD player overlay and return to the catalog grid.
function exitVodPlayer() {
  flushProgress();
  const finishedId = currentVodItem?.id;
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
  reflectWatchInView(finishedId);

  // Leaving the player leaves the watch session — otherwise a host who backs out
  // would keep broadcasting a dead position at their guests.
  if (watchTogether.active) leaveWatchSession();

  // 7.0 TV shell: hand the screen back to the 10-foot UI instead of the grid.
  if (window.__tvNativeOnPlayerExit && window.__tvNativeOnPlayerExit()) return;
  navigation.focusDefault('grid');
}

// ==========================================================================
// WATCH TOGETHER (7.2)
// ==========================================================================
// The host opens a title, gets a 4-letter code, and guests on the same
// provider join with it. The host is authoritative: their pause/seek is
// broadcast; guests apply it and have their own transport controls locked.
//
// Session transport and clock-skew correction live in watch-together.js. This is
// the bridge between that and the player — plus the PC/phone modal. The TV shell
// drives the same functions through the window.__wt* hooks at the bottom.

// How far a guest may drift from the host before we hard-seek them. Below this,
// leave it alone: continuous micro-seeks judder far worse than being a second off.
const WT_DRIFT_TOLERANCE = 2;

// Set while we're applying state that came FROM the host. The local 'pause' /
// 'seeked' events that our own calls raise must not be broadcast back, or the two
// devices bounce events off each other forever.
let wtApplyingRemote = false;
let wtHostTick = null;
let wtSeekDebounce = null;
let wtLastSent = null;         // {cur, paused, at} — what the guests believe
let wtSettleUntil = 0;         // guest: skip drift checks while a seek/load settles
let wtBoundPlayer = false;

function initWatchTogether() {
  watchTogether.onGuestsChanged = () => renderWatchModal();
  watchTogether.onStateChanged = (s) => {
    if (s === 'playing' && watchTogether.isGuest) startGuestPlayback();
    else if (s === 'ended' && watchTogether.isGuest) endWatchSession('The host ended the session.');
    else renderWatchModal();
  };
  watchTogether.onRemoteState = applyRemoteState;
  bindHostPlayerEvents();
}

/* -------------------------------------------------------------- host: send */

/**
 * Broadcast the host's transport state. The 1s tick is the backbone — it's the
 * only thing that works on the native (libVLC) path, where the <video> element is
 * a dummy that fires no events at all. It sends only on a real change, plus a 3s
 * heartbeat so a guest's projection can't drift indefinitely.
 */
function pushHostState(force = false) {
  if (!watchTogether.isHost || watchTogether.state !== 'playing') return;
  if (!playerInstance || !document.body.classList.contains('vod-mode')) return;

  const { cur, paused } = playerInstance.getClock();
  const now = Date.now();

  if (!force && wtLastSent) {
    const elapsed = (now - wtLastSent.at) / 1000;
    // Where the guests currently think we are, if nothing unusual happened.
    const projected = wtLastSent.paused ? wtLastSent.cur : wtLastSent.cur + elapsed;
    const seeked = Math.abs((cur || 0) - projected) > 1;
    const toggled = !!paused !== wtLastSent.paused;
    const stale = elapsed >= 3;
    if (!seeked && !toggled && !stale) return;
  }

  wtLastSent = { cur: cur || 0, paused: !!paused, at: now };
  watchTogether.broadcast(cur || 0, !!paused).catch(() => {});
}

function startHostBroadcast() {
  stopHostBroadcast();
  wtLastSent = null;
  wtHostTick = setInterval(() => pushHostState(), 1000);
}

function stopHostBroadcast() {
  if (wtHostTick) clearInterval(wtHostTick);
  wtHostTick = null;
  clearTimeout(wtSeekDebounce);
  wtSeekDebounce = null;
  wtLastSent = null;
}

// Latency shortcut for the browser path: react to the host's own pause/seek the
// moment it happens rather than waiting up to a second for the tick.
function bindHostPlayerEvents() {
  if (wtBoundPlayer || !playerInstance || !playerInstance.video) return;
  wtBoundPlayer = true;
  const v = playerInstance.video;

  const immediate = () => { if (!wtApplyingRemote) pushHostState(true); };
  v.addEventListener('play', immediate);
  v.addEventListener('pause', immediate);

  // A scrub fires a burst of 'seeked' events, and on PC a premium-VOD seek
  // restarts the ffmpeg transcode — so an undebounced scrub would thrash every
  // guest. Only the position they land on matters.
  v.addEventListener('seeked', () => {
    if (wtApplyingRemote) return;
    clearTimeout(wtSeekDebounce);
    wtSeekDebounce = setTimeout(() => pushHostState(true), 400);
  });
}

/* ------------------------------------------------------------- guest: apply */

/** Apply the host's transport state to this device. Guests only. */
function applyRemoteState({ paused, expected }) {
  if (!watchTogether.isGuest || !playerInstance) return;
  if (!document.body.classList.contains('vod-mode')) return;   // not playing yet

  wtApplyingRemote = true;
  try {
    playerInstance.setPaused(!!paused);

    // While a seek or the initial load is still settling the clock reads 0 (or
    // the old position), which looks like enormous drift and would trigger a
    // seek storm. Let it settle first.
    if (Date.now() < wtSettleUntil) return;
    if (playerInstance.video && playerInstance.video.seeking) return;

    const cur = playerInstance.getClock().cur || 0;
    if (Math.abs(cur - expected) > WT_DRIFT_TOLERANCE) {
      playerInstance.seekTo(expected);
      wtSettleUntil = Date.now() + 4000;
    }
  } finally {
    // Our own calls raise their events asynchronously, so the guard has to
    // outlive this tick.
    setTimeout(() => { wtApplyingRemote = false; }, 250);
  }
}

/** Guest: the host pressed Start (or we joined a session already in progress). */
async function startGuestPlayback() {
  const c = watchTogether.content;
  if (!c) return;
  closeWatchModal();
  wtSettleUntil = Date.now() + 6000;   // let the stream open before policing drift
  playerInstance.setTransportLocked(true);
  await playVODStream(c.streamId, c.type, c.name, c.logo, '', c.ext, watchTogether.expectedNow(), c.backdrop);
}

/* ----------------------------------------------------------- session control */

/** Host: open a session for a title and show the code. `content` is the payload. */
async function hostWatchSession(content) {
  try {
    const code = await watchTogether.host(content);
    openWatchModal('host');
    renderWatchModal();
    return code;
  } catch (err) {
    showToast(err.message, 'error');
    return null;
  }
}

/** Guest: redeem a 4-letter code. Returns true on success. */
async function joinWatchSession(code) {
  try {
    await watchTogether.join(code);
    // Joining a session that's already playing skips the lobby entirely.
    if (watchTogether.state === 'playing') startGuestPlayback();
    else renderWatchModal();
    return true;
  } catch (err) {
    return err;   // the caller renders it — the mismatch message is the point
  }
}

/** Host: release the guests and start playing. */
async function startWatchSession() {
  const c = watchTogether.content;
  if (!c || !watchTogether.isHost) return;
  closeWatchModal();
  await watchTogether.start(0);
  startHostBroadcast();
  await playVODStream(c.streamId, c.type, c.name, c.logo, '', c.ext, 0, c.backdrop);
}

/** Leave the session without tearing down playback. */
function leaveWatchSession() {
  stopHostBroadcast();
  wtSettleUntil = 0;
  if (playerInstance) playerInstance.setTransportLocked(false);
  watchTogether.leave().catch(() => {});
}

/** Leave the session AND drop out of the player (used when the host ends it). */
function endWatchSession(message) {
  leaveWatchSession();
  closeWatchModal();
  if (message) showToast(message, 'info');
  if (document.body.classList.contains('vod-mode')) exitVodPlayer();
}

/* ---------------------------------------------------------------- PC modal */

let wtModalMode = null;   // 'host' | 'guest' | null
let wtJoinError = '';

// The TV shell has its own 10-foot lobby (screenWatch) and drives the session
// through the __wt* hooks, so the mouse modal must stay out of its way — a
// .modal-overlay left visible would also make shellHasKeys() surrender the D-pad.
function openWatchModal(mode) {
  if (isTvNativeActive()) return;
  wtModalMode = mode;
  wtJoinError = '';
  document.getElementById('watch-modal')?.classList.remove('hidden');
  renderWatchModal();
  navigation.focusDefault('modal');
}

function closeWatchModal() {
  if (isTvNativeActive()) return;
  wtModalMode = null;
  document.getElementById('watch-modal')?.classList.add('hidden');
}

function renderWatchModal() {
  if (isTvNativeActive()) {
    try { if (window.__tvnWatchUpdate) window.__tvnWatchUpdate(); } catch (e) {}
    return;
  }
  const body = document.getElementById('watch-modal-body');
  if (!body || !wtModalMode) return;

  const c = watchTogether.content;
  const guests = watchTogether.guests || [];

  if (wtModalMode === 'host') {
    const n = guests.length;
    body.innerHTML = `
      <h2 class="wt-heading">Watch Together</h2>
      <p class="wt-sub">${escapeHtml(c?.name || '')}</p>
      <div class="wt-code">${escapeHtml(watchTogether.code || '····')}</div>
      <p class="wt-hint">Share this code. They'll need to be on the same provider.</p>
      <div class="wt-guests ${n ? 'is-ready' : ''}">
        <i data-lucide="${n ? 'user-check' : 'loader'}"></i>
        <span>${n ? `${n} guest${n > 1 ? 's' : ''} joined` : 'Waiting for guests…'}</span>
      </div>
      <div class="wt-actions">
        <button class="wt-btn wt-btn-primary" id="wt-start-btn" ${n ? '' : 'disabled'}>
          <i data-lucide="play"></i> Start
        </button>
        <button class="wt-btn" id="wt-cancel-btn">Cancel</button>
      </div>`;
    body.querySelector('#wt-start-btn').onclick = () => startWatchSession();
    body.querySelector('#wt-cancel-btn').onclick = () => { leaveWatchSession(); closeWatchModal(); };
  } else if (watchTogether.active) {
    // Guest, joined, waiting in the lobby.
    body.innerHTML = `
      <h2 class="wt-heading">Watch Together</h2>
      <div class="wt-joined">
        ${c?.logo ? `<img class="wt-poster" src="${escapeHtml(proxifyImage(c.logo))}" alt="">` : ''}
        <div>
          <p class="wt-title">${escapeHtml(c?.name || '')}</p>
          <p class="wt-waiting"><i data-lucide="loader"></i> Waiting for host to start…</p>
        </div>
      </div>
      <div class="wt-actions">
        <button class="wt-btn" id="wt-leave-btn">Leave</button>
      </div>`;
    body.querySelector('#wt-leave-btn').onclick = () => { leaveWatchSession(); closeWatchModal(); };
  } else {
    // Guest, entering a code.
    body.innerHTML = `
      <h2 class="wt-heading">Join Watch Session</h2>
      <p class="wt-hint">Enter the 4-letter code from the host.</p>
      <input id="wt-code-input" class="wt-code-input" type="text" maxlength="4"
             autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD">
      <p class="wt-error ${wtJoinError ? '' : 'hidden'}">${escapeHtml(wtJoinError)}</p>
      <div class="wt-actions">
        <button class="wt-btn wt-btn-primary" id="wt-join-btn">Join</button>
        <button class="wt-btn" id="wt-cancel-btn">Cancel</button>
      </div>`;

    const input = body.querySelector('#wt-code-input');
    const btn = body.querySelector('#wt-join-btn');
    input.oninput = () => { input.value = input.value.toUpperCase().replace(/[^A-Z]/g, ''); };
    input.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
    btn.onclick = async () => {
      const code = input.value.trim().toUpperCase();
      if (code.length !== 4) { wtJoinError = 'Enter all 4 letters.'; renderWatchModal(); return; }
      btn.disabled = true;
      const r = await joinWatchSession(code);
      if (r !== true) { wtJoinError = r.message; renderWatchModal(); }
    };
    body.querySelector('#wt-cancel-btn').onclick = () => closeWatchModal();
    setTimeout(() => input.focus(), 0);
  }

  lucide.createIcons({ scope: body });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ==========================================================================
// ABOUT
// ==========================================================================
// App/device facts plus the support contact. The rows come from about.js so the
// PC modal and the TV shell's popout can never drift out of sync.

function openAboutModal() {
  const modal = document.getElementById('about-modal');
  const body = document.getElementById('about-modal-body');
  if (!modal || !body) return;

  body.innerHTML = `
    <div class="about-head">
      <img src="${logoUrl}" alt="" class="about-logo">
      <div>
        <h2 class="about-title">ZIPTV Pro</h2>
        <p class="about-tagline">Premium IPTV Player</p>
      </div>
    </div>
    <dl class="about-rows">
      ${getAboutRows().map(r => `
        <div class="about-row">
          <dt>${escapeHtml(r.label)}</dt>
          <dd>${escapeHtml(r.value)}</dd>
        </div>`).join('')}
    </dl>
    <div class="about-dev">
      <span class="about-dev-label">Developer &amp; Support</span>
      <p class="about-dev-name">${escapeHtml(DEVELOPER.name)}</p>
      <a class="about-dev-line" href="mailto:${escapeHtml(DEVELOPER.email)}">
        <i data-lucide="mail"></i> ${escapeHtml(DEVELOPER.email)}
      </a>
      <a class="about-dev-line" href="tel:${escapeHtml(DEVELOPER.phone.replace(/\s/g, ''))}">
        <i data-lucide="phone"></i> ${escapeHtml(DEVELOPER.phone)}
      </a>
    </div>`;

  modal.classList.remove('hidden');
  lucide.createIcons({ scope: body });
  navigation.focusDefault('modal');
}

function closeAboutModal() {
  document.getElementById('about-modal')?.classList.add('hidden');
}

// Hooks the TV shell drives the same session through (tv-native.js has its own
// 10-foot lobby UI, but the session logic is shared).
window.__wtHost = hostWatchSession;
window.__wtJoin = joinWatchSession;
window.__wtStart = startWatchSession;
window.__wtLeave = leaveWatchSession;
window.__wtSession = watchTogether;

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
  const dur = isFinite(duration) ? duration : 0;
  // Finished → mark completed (dimmed "Watch again" tile) and drop from Continue
  // Watching. "Finished" = under 5 minutes remaining (past the halfway point so a
  // short clip isn't completed on contact), or effectively at the end (>95%).
  const nearEnd = dur > 0 && (dur - currentTime) <= 300 && currentTime >= dur * 0.5;
  if (dur > 0 && (nearEnd || currentTime / dur > 0.95)) {
    removeWatchProgress(currentVodItem.id);
    markCompleted({ ...currentVodItem, position: dur, duration: dur });
    return;
  }
  saveWatchProgress({
    ...currentVodItem,
    position: currentTime,
    duration: dur
  });
}

function flushProgress() {
  if (!currentVodItem || !playerInstance || !playerInstance.video) return;
  persistProgress(playerInstance.video.currentTime, playerInstance.video.duration);
}

// Definitive "watched" signal: the video reached its end. The <5-min rule in
// persistProgress depends on timeupdate firing near the end and a valid
// duration; on natural end (and series auto-advance) that isn't guaranteed, so
// the ended event marks it explicitly. Call BEFORE advancing to the next item,
// while currentVodItem still points at the one that just finished.
function markCurrentWatched() {
  const it = currentVodItem;
  if (!it || it.id == null) return;
  const dur = playerInstance?.video?.duration;
  removeWatchProgress(it.id);
  markCompleted({ ...it, position: isFinite(dur) ? dur : (it.duration || 0), duration: isFinite(dur) ? dur : (it.duration || 0) });
}

function refreshContinueWatching() {
  renderContinueWatching('movie');
  renderContinueWatching('series');
}

function renderContinueWatching(type) {
  const container = document.getElementById(type === 'movie' ? 'movies-continue' : 'series-continue');
  if (!container) return;
  let items = getContinueWatching(type);
  // For series, collapse to one card per show — the most recently watched
  // episode. getContinueWatching() is sorted by lastWatched (newest first), so
  // keeping the first occurrence per series keeps the latest episode. This is
  // display-only; every episode's progress stays saved in storage.
  if (type === 'series') {
    const seen = new Set();
    items = items.filter(it => {
      const key = String(it.seriesId || it.seriesName || it.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
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
      <div class="continue-card" data-id="${it.id}" data-serieskey="${it.seriesId || it.seriesName || it.id}" tabindex="-1">
        <div class="continue-poster">
          ${it.logo ? `<img src="${proxifyImage(it.logo)}" alt="" loading="lazy">` : `<div class="poster-placeholder"><i data-lucide="${icon}"></i></div>`}
          <button class="cw-remove" title="Remove from Continue Watching" aria-label="Remove"><i data-lucide="x"></i></button>
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
  container.querySelectorAll('.cw-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.continue-card');
      if (!card) return;
      if (type === 'series') {
        removeSeriesWatchProgress(card.dataset.serieskey);
      } else {
        removeWatchProgress(card.dataset.id);
      }
      renderContinueWatching(type);
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
const getVodSortSymbol = (v) => {
  if (v === 'name') return 'A-Z';
  if (v === 'rating') return '★';
  return '—';
};

// Wire the TV-navigable Search + Sort buttons for a VOD catalog (movies/series).
function wireVodFilters(kind, reload) {
  const st = kind === 'movies' ? state.movies : state.series;
  const searchBtn = document.getElementById(`${kind}-search-btn`);
  const searchLabel = document.getElementById(`${kind}-search-label`);
  const sortBtn = document.getElementById(`${kind}-sort-btn`);
  const sortLabel = document.getElementById(`${kind}-sort-label`);

  if (sortLabel) sortLabel.textContent = getVodSortSymbol(st.sort);

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
          if (sortLabel) sortLabel.textContent = getVodSortSymbol(v);
          reload();
          navigation.setFocus('grid', sortBtn);
        }
      });
    });
  }
}

// Home dashboard tile actions — all reuse the existing playback/detail flows
// (same routing the global search uses).
const homeHandlers = {
  onPlayChannel: async (channel) => {
    await switchTab('live');
    await selectAndPlayChannel(channel, null);
  },
  onResumeItem: async (item) => {
    if (item.type === 'series') {
      await switchTab('series');
      openSeriesPlaybackDashboard(
        { series_id: item.seriesId, name: item.seriesName, cover: item.logo },
        { episodeId: item.id, season: item.season, position: item.position }
      );
    } else {
      await switchTab('movies');
      openVODDetailsModal({ stream_id: item.id, name: item.name, stream_icon: item.logo }, 'movie', item.position);
    }
  },
  onOpenMovie: async (m) => {
    await switchTab('movies');
    openVODDetailsModal(m, 'movie');
  },
  onOpenSeries: async (s) => {
    await switchTab('series');
    openSeriesPlaybackDashboard(s);
  },
  onGoTab: (tab) => switchTab(tab)
};

// Route a global-search result to the right view + action. Live plays straight
// away; movies/series open their existing details surfaces.
async function routeGlobalSearchPick(type, item) {
  const headerInput = document.getElementById('global-search-input');
  if (headerInput) headerInput.value = '';
  try {
    if (type === 'live') {
      await switchTab('live');
      await selectAndPlayChannel(item, null);
    } else if (type === 'movies') {
      await switchTab('movies');
      openVODDetailsModal(item, 'movie');
    } else if (type === 'series') {
      await switchTab('series');
      openSeriesPlaybackDashboard(item);
    }
  } catch (err) {
    console.error('Global search routing failed:', err);
  }
}

// Show the right global-search control for the platform: a live text field on
// PC/web (physical keyboard), a D-pad button that opens the on-screen keyboard
// on the APK/TV — matching the per-view search buttons.
function initGlobalSearch() {
  // Button + on-screen keyboard whenever D-pad is the input model: the native
  // APK/TV build, or the /tv (?tv=true) "10-foot" layout on PC/web.
  const onTv = Capacitor.isNativePlatform() || window.__TV_PREVIEW__;
  const field = document.getElementById('global-search-field');
  const btn = document.getElementById('global-search-btn');
  const railBtn = document.getElementById('rail-search-btn');

  if (onTv) {
    if (btn) {
      btn.style.display = 'inline-flex';
      btn.addEventListener('click', () => openGlobalSearch({ tvInput: true, onPick: routeGlobalSearchPick }));
    }
    // Side-rail Search item (TV D-pad / phone landscape): same overlay.
    railBtn?.addEventListener('click', () => openGlobalSearch({ tvInput: true, onPick: routeGlobalSearchPick }));
  } else {
    if (field) field.style.display = 'flex';
    const input = document.getElementById('global-search-input');
    if (input) {
      let debounce = null;
      input.addEventListener('input', () => {
        clearTimeout(debounce);
        const q = input.value || '';
        debounce = setTimeout(() => setGlobalSearchQuery(q, routeGlobalSearchPick), 250);
      });
    }
    // On desktop the rail Search item drops the cursor into the header field.
    railBtn?.addEventListener('click', () => input?.focus());
  }
}

function bindGlobalEvents() {
  // Remote manual login button handler
  document.getElementById('remote-manual-login-btn')?.addEventListener('click', () => {
    showManualLoginForm();
  });

  // Hidden escape hatch: triple-click any app logo (login screen, side-rail, or top header)
  // to reach the manual Xtream login form directly (5.0 hides the manual button —
  // playlists are normally dashboard-managed — but this stays reachable as a fallback
  // for when cloud sync or device pairing itself has issues).
  const attachTripleClick = (el, cb) => {
    if (!el) return;
    let clicks = 0;
    let clickTimer = null;
    el.addEventListener('click', () => {
      clicks++;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { clicks = 0; }, 1200);
      if (clicks >= 3) {
        clicks = 0;
        clearTimeout(clickTimer);
        cb();
      }
    });
  };

  attachTripleClick(document.querySelector('.rail-logo'), showManualLoginForm);
  attachTripleClick(document.querySelector('.login-logo-header'), showManualLoginForm);
  attachTripleClick(document.querySelector('.logo-container'), showManualLoginForm);

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
        // Push this manually-added playlist to the cloud device record so it
        // shows up in admin and survives the heartbeat's reconcile (it's no
        // longer "missing from remote"). Best-effort: this hidden form exists
        // specifically as a fallback for when cloud sync itself is having
        // issues, so a login must succeed even if this push doesn't.
        if (deviceCode) {
          try {
            const cloudId = await addPlaylistToCloud(deviceCode, {
              name: playlistName || 'My Xtream Playlist',
              type: 'xtream',
              server_url: hostUrl,
              username,
              password
            });
            if (cloudId) await setPlaylistCloudId(hostUrl, username, cloudId);
          } catch (e) {
            console.warn('Could not sync manually-added playlist to cloud:', e.message);
          }
        }

        const status = await getStatus();
        state.user = status;
        if (status.favorites) {
          state.favorites = status.favorites;
        }
        showDashboard();

        // Initial sync: Live TV paints as soon as its data is cached; movies
        // and series finish downloading behind the live UI.
        state.activeCategory = null;
        await triggerFullSync({
          onLiveReady: async () => { await loadTabCategoriesAndContent(); }
        });
        if (!state.activeCategory) await loadTabCategoriesAndContent();
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
  // Header "Playlists" button → same slide-over drawer
  document.getElementById('header-playlists-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlaylistDropdown();
  });

  // Header search field → route to the active view's search (no dead UI).
  const headerSearch = document.getElementById('header-search-input');
  if (headerSearch) {
    let searchDebounce = null;
    headerSearch.addEventListener('input', () => {
      const q = headerSearch.value || '';
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        if (state.activeTab === 'live') {
          if (epgGridInstance) epgGridInstance.setChannelFilter(q);
        } else if (state.activeTab === 'movies') {
          state.movies.search = q;
          state.movies.page = 1;
          loadMoviesGrid();
        } else if (state.activeTab === 'series') {
          state.series.search = q;
          state.series.page = 1;
          loadSeriesGrid();
        }
      }, state.activeTab === 'live' ? 120 : 350);
    });
  }
  document.getElementById('playlist-add-btn')?.addEventListener('click', showAddPlaylist);
  // Drawer close affordances (the scrim is a DOM child of .profile-wrap, so the
  // generic outside-click handler below won't catch it — close it explicitly).
  document.getElementById('playlist-drawer-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closePlaylistDropdown();
  });
  document.getElementById('playlist-drawer-scrim')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closePlaylistDropdown();
  });
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
    if (dd && !dd.classList.contains('hidden')
        && !e.target.closest('.profile-wrap')
        && !e.target.closest('.playlist-drawer-panel')) {
      dd.classList.add('hidden');
    }
  });

  // Settings Binds
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close-btn');

  // Settings behaves like a tab: opening it highlights the rail button like an
  // active tab; leaving it (X / Back / picking another tab) restores the
  // highlight on whichever real tab is still active underneath.
  const setSettingsActive = (on) => {
    // No category sidebar on the settings page.
    document.body.classList.toggle('settings-tab', on);
    settingsBtn.classList.toggle('active', on);
    const t = state.activeTab || 'home';
    document.querySelectorAll(`.nav-tab[data-tab="${t}"], .mobile-tab-btn[data-tab="${t}"]`)
      .forEach(b => b.classList.toggle('active', !on));
    if (on) {
      document.querySelectorAll('.nav-tab, .mobile-tab-btn[data-tab]')
        .forEach(b => { if (b.dataset.tab !== t) b.classList.remove('active'); });
    }
  };
  const closeSettingsPanel = () => {
    settingsModal.classList.add('hidden');
    setSettingsActive(false);
  };
  window.closeSettingsPanel = closeSettingsPanel;

  settingsBtn.addEventListener('click', () => {
    refreshSettingsTiles();
    // Smart TV access tile: always show — we can derive a /tv link (LAN IP,
    // local server, or the hosted domain) in every environment.
    const netTile = document.getElementById('tile-network');
    if (netTile) {
      netTile.style.display = '';
    }
    settingsModal.classList.remove('hidden');
    setSettingsActive(true);
    // D-pad: land on the section menu first (tabbed layout), tiles second.
    const firstFocus = settingsModal.querySelector('.settings-menu-item') ||
                       settingsModal.querySelector('.settings-tile');
    if (firstFocus) navigation.setFocus('modal', firstFocus);
  });

  settingsClose.addEventListener('click', () => {
    closeSettingsPanel();
    navigation.focusDefault('tabs');
  });

  // --- Tile: Switch Playlist (opens the playlist picker drawer) ---
  document.getElementById('tile-switch-playlist')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSettingsPanel();
    togglePlaylistDropdown();
  });

  // --- Tile: Stream Format ---
  document.getElementById('tile-stream-format')?.addEventListener('click', () => {
    const creds = (state.user && state.user.credentials) || {};
    openSortDropdown({
      title: 'Stream Format',
      options: [
        { value: 'ts', label: 'MPEG-TS (.ts) — Recommended' },
        { value: 'm3u8', label: 'HLS (.m3u8) — Fallback' }
      ],
      current: creds.stream_format || 'ts',
      onSelect: async (v) => {
        await updatePreferences({ stream_format: v });
        if (state.user && state.user.credentials) state.user.credentials.stream_format = v;
        refreshSettingsTiles();
        navigation.setFocus('modal', document.getElementById('tile-stream-format'));
      }
    });
  });

  // --- Tile: Player Engine ---
  document.getElementById('tile-player-engine')?.addEventListener('click', () => {
    openSortDropdown({
      title: 'Player Engine',
      options: [
        { value: 'native', label: 'Native Player' },
        { value: 'web', label: 'Web Player (HTML5 / Built-in)' }
      ],
      current: localStorage.getItem('playerEngine') === 'web' ? 'web' : 'native',
      onSelect: (v) => {
        localStorage.setItem('playerEngine', v);
        refreshSettingsTiles();
        const activeLabel = v === 'web' ? 'Web Player' : 'Native Player';
        showToast(`Player engine set to ${activeLabel}`, 'success');
        navigation.setFocus('modal', document.getElementById('tile-player-engine'));
      }
    });
  });

  // --- Tile: Desktop Player (FFmpeg transcode vs HTML5) ---
  document.getElementById('tile-desktop-engine')?.addEventListener('click', () => {
    openSortDropdown({
      title: 'Desktop Player',
      options: [
        { value: 'html5', label: 'HTML5 Player (Built-in)' },
        { value: 'ffmpeg', label: 'Auto (Direct + FFmpeg fallback)' },
        { value: 'external', label: 'External Player (default app)' }
      ],
      current: ['html5', 'external'].includes(localStorage.getItem('electronEngine'))
        ? localStorage.getItem('electronEngine') : 'ffmpeg',
      onSelect: (v) => {
        localStorage.setItem('electronEngine', v);
        refreshSettingsTiles();
        const labels = { ffmpeg: 'Auto (Direct + FFmpeg fallback)', external: 'External Player', html5: 'HTML5 Player' };
        const activeLabel = labels[v] || 'HTML5 Player';
        showToast(`Desktop player set to ${activeLabel}`, 'success');
        navigation.setFocus('modal', document.getElementById('tile-desktop-engine'));
      }
    });
  });

  // --- Tile: CORS Proxy (toggle) ---
  document.getElementById('tile-proxy')?.addEventListener('click', async () => {
    const creds = (state.user && state.user.credentials) || {};
    const next = !(creds.proxy_streams ?? true);
    await updatePreferences({ proxy_streams: next });
    if (state.user && state.user.credentials) state.user.credentials.proxy_streams = next;
    refreshSettingsTiles();
    showToast(`CORS Proxy ${next ? 'enabled' : 'disabled'}`, 'success');
  });

  // --- Tile: Appearance (cycles Auto → Light → Dark) ---
  document.getElementById('tile-theme')?.addEventListener('click', () => {
    // Two-state toggle: dark (default) ↔ light.
    const next = getThemePref() === 'light' ? 'dark' : 'light';
    setTheme(next);
    refreshSettingsTiles();
    showToast(`Theme: ${next === 'light' ? 'Light' : 'Dark'}`, 'success');
  });

  // --- Tile: Performance Mode (cycles Auto → On → Off) ---
  document.getElementById('tile-perf')?.addEventListener('click', () => {
    let saved = null;
    try { saved = localStorage.getItem('perfLite'); } catch (e) {}
    // Auto(null) → On → Off → Auto
    const next = saved === null ? true : (saved === 'on' ? false : null);
    setPerfLite(next);
    refreshSettingsTiles();
    const label = next === null ? 'Auto' : (next ? 'On' : 'Off');
    showToast(`Performance mode: ${label}`, 'success');
  });

  // --- Upscaler Options Modal ---
  function openUpscalerModal() {
    const modal = document.getElementById('upscaler-modal');
    if (!modal) return;

    const p = window.playerInstance;
    const currentMode = (p && p.getUpscalerMode) ? p.getUpscalerMode() : (localStorage.getItem('upscaler_mode') || 'off');
    const currentSharp = parseFloat(localStorage.getItem('upscaler_sharpness') || '0.4');

    // Update radios & card highlight
    const radios = modal.querySelectorAll('input[name="upscaler-mode-radio"]');
    radios.forEach(radio => {
      radio.checked = (radio.value === currentMode);
    });

    const cards = modal.querySelectorAll('.upscaler-option-card');
    cards.forEach(card => {
      const mode = card.dataset.mode;
      card.classList.toggle('active', mode === currentMode);
    });

    // Update sharpness slider
    const slider = document.getElementById('upscaler-sharpness-slider');
    const valReadout = document.getElementById('upscaler-sharpness-val');
    if (slider) {
      slider.value = isNaN(currentSharp) ? 0.4 : currentSharp;
      if (valReadout) valReadout.textContent = `${Math.round(slider.value * 100)}%`;
    }

    modal.classList.remove('hidden');
    if (window.lucide) {
      try { window.lucide.createIcons({ scope: modal }); } catch (e) {}
    }
  }

  function closeUpscalerModal() {
    const modal = document.getElementById('upscaler-modal');
    if (modal) modal.classList.add('hidden');
  }

  window.openUpscalerModal = openUpscalerModal;

  // Event handlers for Upscaler modal
  document.getElementById('upscaler-modal-close')?.addEventListener('click', closeUpscalerModal);
  document.getElementById('upscaler-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'upscaler-modal') closeUpscalerModal();
  });

  document.querySelectorAll('input[name="upscaler-mode-radio"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const mode = e.target.value;
      const p = window.playerInstance;
      if (p) p.setUpscalerMode(mode);

      document.querySelectorAll('.upscaler-option-card').forEach(card => {
        card.classList.toggle('active', card.dataset.mode === mode);
      });

      refreshSettingsTiles();
      const labels = {
        anime4k: 'Anime4K Line Reconstruction',
        fsr: 'AMD FSR / CAS Spatial Upscaling',
        bicubic: 'Bicubic Smooth',
        off: 'Upscaler disabled'
      };
      showToast(`Upscaler mode: ${labels[mode] || mode}`, 'success');
    });
  });

  document.getElementById('upscaler-sharpness-slider')?.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    const p = window.playerInstance;
    if (p) p.setUpscalerSharpness(val);
    const valReadout = document.getElementById('upscaler-sharpness-val');
    if (valReadout) valReadout.textContent = `${Math.round(val * 100)}%`;
  });

  // --- Tile: Upscaler ---
  document.getElementById('tile-upscaler')?.addEventListener('click', () => {
    openUpscalerModal();
  });

  // --- Player control bar Upscaler button ---
  document.getElementById('player-upscaler-btn')?.addEventListener('click', () => {
    openUpscalerModal();
  });

  // --- Tile: Manage Tabs (show/hide/edit custom web tabs) ---
  document.getElementById('tile-tabs')?.addEventListener('click', () => {
    openManageTabs();
  });

  // --- Tile: Ad Blocker (built-in uBlock-style engine, web tabs only) ---
  document.getElementById('tile-adblock')?.addEventListener('click', () => {
    toggleAdblock();
  });

  // --- Header button: Watch on Your Phone (Cloudflare Quick Tunnel share panel) ---
  document.getElementById('phone-share-btn')?.addEventListener('click', () => {
    openShareTunnel();
  });

  // --- Tile: Sleep Timer ---
  document.getElementById('tile-sleep')?.addEventListener('click', () => {
    openSortDropdown({
      title: 'Sleep Timer — stop playback after',
      options: [
        { value: '0', label: 'Off' },
        { value: '15', label: '15 minutes' },
        { value: '30', label: '30 minutes' },
        { value: '45', label: '45 minutes' },
        { value: '60', label: '1 hour' },
        { value: '90', label: '1.5 hours' },
        { value: '120', label: '2 hours' }
      ],
      current: String(currentSleepMinutes),
      onSelect: (v) => {
        setSleepTimer(parseInt(v, 10) || 0);
        navigation.setFocus('modal', document.getElementById('tile-sleep'));
      }
    });
  });

  // --- Tile: Companion Device (cross-device Continue Watching) ---
  document.getElementById('tile-companion')?.addEventListener('click', () => openCompanionModal());
  document.getElementById('companion-modal-close')?.addEventListener('click', closeCompanionModal);
  updateCompanion(companionInfo);   // show the cached link state on boot

  // --- Tile: Sync & Cache ---
  document.getElementById('tile-sync')?.addEventListener('click', async () => {
    settingsModal.classList.add('hidden');
    await triggerFullSync();
    await loadTabCategoriesAndContent();
  });

  // --- Tile: Updates ---
  document.getElementById('tile-update')?.addEventListener('click', () => {
    checkForUpdate({ manual: true, onStatus: (m) => showToast(m, 'info', 4000) });
  });

  // --- Tile: TV Interface (7.0) — switch this device to the 10-foot UI. On
  // the desktop app it also goes borderless fullscreen; a reload boots the
  // native TV shell (Settings → "Switch to Desktop/Mobile interface" undoes it).
  document.getElementById('tile-tv-ui')?.addEventListener('click', () => {
    setStoredUiMode('tv');
    try { window.appHost?.setFullscreen?.(true); } catch (e) {}
    window.location.reload();
  });

  // --- Settings category menu: switch the visible pane ---
  document.getElementById('settings-menu')?.addEventListener('click', (e) => {
    const item = e.target.closest('.settings-menu-item');
    if (!item) return;
    const pane = item.dataset.pane;
    document.querySelectorAll('.settings-menu-item').forEach(m => m.classList.toggle('active', m === item));
    document.querySelectorAll('.settings-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === pane));
  });

  // --- Tiles: Run at Startup / Start Minimized (desktop only) ---
  async function toggleStartup(key) {
    if (!window.appHost?.setStartupSettings) { showToast('Available on the desktop app.', 'error', 3000); return; }
    try {
      const cur = await window.appHost.getStartupSettings();
      const next = !cur[key];
      const s = await window.appHost.setStartupSettings({ [key]: next });
      refreshStartupTiles(s);
      const msg = key === 'openAtLogin'
        ? (next ? 'Will launch at startup' : 'Startup launch off')
        : (next ? 'Will start minimized to tray' : 'Start minimized off');
      showToast(msg, 'success', 3000);
    } catch (e) { showToast('Could not update startup setting', 'error', 3000); }
  }
  document.getElementById('tile-startup')?.addEventListener('click', () => toggleStartup('openAtLogin'));
  document.getElementById('tile-startminimized')?.addEventListener('click', () => toggleStartup('startMinimized'));

  // --- Tile: Smart TV Access ---
  document.getElementById('tile-network')?.addEventListener('click', () => {
    const links = getTvLinks();
    if (!links.length) { showToast('No TV link available', 'info'); return; }
    openSortDropdown({
      title: 'Open this on your TV browser (select to copy)',
      options: links.map(l => ({ value: l.url, label: l.label })),
      onSelect: (url) => {
        if (url && navigator.clipboard) {
          navigator.clipboard.writeText(url)
            .then(() => showToast('TV link copied', 'success'))
            .catch(() => {});
        }
        navigation.setFocus('modal', document.getElementById('tile-network'));
      }
    });
  });

  // --- Tile: Log Out ---
  document.getElementById('tile-logout')?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect this playlist? This will erase local cache.')) {
      closeSettingsPanel();
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

  document.getElementById('tile-about')?.addEventListener('click', () => {
    if (window.closeSettingsPanel) window.closeSettingsPanel();
    openAboutModal();
  });
  document.getElementById('about-modal-close')?.addEventListener('click', closeAboutModal);

  // Watch Together: the header icon is the guest's way in.
  document.getElementById('watch-join-btn')?.addEventListener('click', () => openWatchModal('guest'));
  document.getElementById('watch-modal-close')?.addEventListener('click', () => {
    // Dismissing the lobby means leaving it — otherwise a host would sit there
    // broadcasting an invisible session at their guests.
    if (watchTogether.active) leaveWatchSession();
    closeWatchModal();
  });

  // Close modals on background overlay click. Settings is exempt — it acts
  // like a tab page now, so clicking its empty space must not close it.
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay') && e.target.id !== 'settings-modal') {
      e.target.classList.add('hidden');
    }
  });

  // Navigation tab binds
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Mobile bottom-tab bar binds (view tabs + Sources/Settings actions)
  document.querySelectorAll('.mobile-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (btn.dataset.tab) {
        switchTab(btn.dataset.tab);
      } else if (btn.dataset.action === 'playlists') {
        e.stopPropagation();
        togglePlaylistDropdown();
      } else if (btn.dataset.action === 'settings') {
        document.getElementById('settings-btn')?.click();
      }
    });
  });

  // Sidebar Pins Binds
  document.querySelectorAll('.pin-item').forEach(pin => {
    pin.addEventListener('click', () => {
      const cat = pin.dataset.category;
      if (cat === 'recordings') { openRecordingsModal(); return; }  // DVR list, not a channel category
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

  // ---- DVR / timeshift controls (desktop only) ----
  if (window.appHost || window.electronCast) document.body.classList.add('desktop-dvr');
  document.getElementById('player-golive-btn')?.addEventListener('click', () => playerInstance.goLive());
  document.getElementById('player-live-badge')?.addEventListener('click', () => playerInstance.goLive());
  document.getElementById('player-rewind-10')?.addEventListener('click', () => playerInstance.skipBy(-10));
  document.getElementById('player-forward-10')?.addEventListener('click', () => playerInstance.skipBy(10));
  document.getElementById('player-record-btn')?.addEventListener('click', recordCurrentChannel);
  document.getElementById('player-deint-btn')?.addEventListener('click', toggleDeinterlace);
  playerInstance.reflectDeinterlace(localStorage.getItem('deinterlace') === '1');
  document.getElementById('recordings-close-btn')?.addEventListener('click', closeRecordingsModal);
  document.getElementById('recordings-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'recordings-modal') closeRecordingsModal();
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
  const getCatSortSymbol = (v) => {
    if (v === 'name') return 'A-Z';
    if (v === 'count') return '#';
    return '—';
  };
  // Restore the saved sort preference.
  state.categorySort = localStorage.getItem('category_sort') || 'default';
  if (catSortLabel) {
    catSortLabel.textContent = getCatSortSymbol(state.categorySort);
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
            catSortLabel.textContent = getCatSortSymbol(value);
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
      // Enter is handled by tv-navigation (it calls .click() on this element),
      // so handling Enter here too would toggle twice = no net change. Only
      // take Space here (the D-pad OK button sends Enter, not Space).
      if (e.key === ' ') {
        e.preventDefault();
        togglePinSection();
      }
    });
  }

  // TV-navigable Search + Sort (on-screen keyboard / dropdown — no input fields)
  wireVodFilters('movies', loadMoviesGrid);
  wireVodFilters('series', loadSeriesGrid);

  // Live channel filter — inline search field on desktop/mobile; on TV the
  // icon button opens the on-screen keyboard (real inputs don't D-pad well).
  const liveFilterBtn = document.getElementById('epg-channels-filter-btn');
  const liveSearchInput = document.getElementById('epg-channels-search-input');
  const syncLiveFilterUi = (q) => {
    liveFilterBtn?.classList.toggle('filter-active', !!(q && q.trim()));
  };
  if (liveSearchInput) {
    liveSearchInput.addEventListener('input', () => {
      const q = liveSearchInput.value;
      if (epgGridInstance) epgGridInstance.setChannelFilter(q);
      syncLiveFilterUi(q);
    });
    liveSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && liveSearchInput.value) {
        liveSearchInput.value = '';
        if (epgGridInstance) epgGridInstance.setChannelFilter('');
        syncLiveFilterUi('');
      }
      if (e.key === 'Enter' || e.key === 'Escape') liveSearchInput.blur();
    });
  }
  if (liveFilterBtn) {
    liveFilterBtn.addEventListener('click', () => {
      // Desktop/touch: the field is right there — just focus it.
      if (!document.body.classList.contains('tv-layout') && liveSearchInput) {
        liveSearchInput.focus();
        return;
      }
      openSearchKeyboard({
        title: 'Filter Channels',
        initial: (epgGridInstance && epgGridInstance.channelFilterQuery) || '',
        onChange: (q) => {
          if (epgGridInstance) epgGridInstance.setChannelFilter(q);
          if (liveSearchInput) liveSearchInput.value = q; // keep in sync
        },
        onClose: (q) => {
          syncLiveFilterUi(q);
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

  // Right-click a programme cell in the guide → record that specific show.
  // Document-level so no intermediate container can swallow it; reads straight
  // from the block's dataset so there's no lookup to miss. (The hover REC button
  // on each cell is the primary, mouse-obvious path.)
  document.addEventListener('contextmenu', (e) => {
    const block = e.target.closest?.('.epg-program-block');
    if (!block || !block.dataset.progStart) return;
    e.preventDefault();
    window.scheduleRecordProgram(
      { stream_id: block.dataset.streamId, name: block.dataset.channelName, stream_icon: block.dataset.channelIcon },
      { start_timestamp: block.dataset.progStart, end_timestamp: block.dataset.progEnd, title: block.dataset.progTitle }
    );
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
    const getLiveSortSymbol = (v) => {
      if (v === 'name') return 'Sort: A-Z';
      if (v === 'name_desc') return 'Sort: Z-A';
      if (v === 'most_viewed') return 'Sort: Most Viewed';
      return 'Sort';
    };
    // Initialize label
    if (liveSortLabel && epgGridInstance) {
      liveSortLabel.textContent = getLiveSortSymbol(epgGridInstance.channelsSort || 'added');
    }
    liveSortBtn.addEventListener('click', () => {
      openSortDropdown({
        title: 'Sort Channels',
        options: LIVE_SORT_OPTIONS,
        current: (epgGridInstance && epgGridInstance.channelsSort) || 'added',
        onSelect: (v) => {
          if (epgGridInstance) epgGridInstance.setChannelsSort(v);
          if (liveSortLabel) liveSortLabel.textContent = getLiveSortSymbol(v);
          navigation.setFocus('channels', liveSortBtn);
        }
      });
    });
  }

  // Channel cards: grid ⇄ list view toggle (persisted). Pure CSS re-layout —
  // .epg-list-view on the section flips the card grid into slim rows.
  const viewToggleBtn = document.getElementById('epg-view-toggle-btn');
  if (viewToggleBtn) {
    const epgSection = document.querySelector('.epg-section-container');
    const applyChannelsView = (mode) => {
      epgSection?.classList.toggle('epg-list-view', mode === 'list');
      // Icon shows the view you'd switch TO.
      viewToggleBtn.innerHTML = mode === 'list'
        ? '<i data-lucide="layout-grid"></i>'
        : '<i data-lucide="list"></i>';
      const label = mode === 'list' ? 'Switch to grid view' : 'Switch to list view';
      viewToggleBtn.title = label;
      viewToggleBtn.setAttribute('aria-label', label);
      if (window.lucide) lucide.createIcons({ scope: viewToggleBtn });
    };
    applyChannelsView(localStorage.getItem('live_channels_view') || 'grid');
    viewToggleBtn.addEventListener('click', () => {
      const next = epgSection?.classList.contains('epg-list-view') ? 'grid' : 'list';
      localStorage.setItem('live_channels_view', next);
      applyChannelsView(next);
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
async function triggerFullSync({ onLiveReady = null } = {}) {
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
    }, {
      // As soon as live channels are cached, drop the blocker and let the
      // caller paint Live TV — movies/series keep downloading behind the UI.
      // Cuts perceived first-run load to roughly a third on big playlists.
      onLiveReady: onLiveReady ? async (info) => {
        syncBlocker.remove();
        try { await onLiveReady(info); } catch (e) { console.warn(e); }
        showToast('Live TV ready — movies & series still loading…', 'info', 4000);
      } : null
    });
    console.log('Sync completed! Channels cached:', res.counts);
    if (onLiveReady) showToast('Movies & series updated', 'success', 3000);
  } catch (err) {
    console.error('Playlist sync failed:', err);
    alert(`Sync Warning: Could not download latest channels list. Using previously cached data if available. (${err.message})`);
  } finally {
    syncBlocker.remove();
  }
}

// Background refresh gate: skip the automatic full re-download when the cache
// is fresh. On Fire TV / smart TVs the every-boot background sync (huge JSON
// downloads + parsing) competed with the UI right at startup and made the
// whole app feel slow even though content was already cached.
const BG_SYNC_TTL_MS = 12 * 60 * 60 * 1000; // 12h; manual Refresh always syncs
function maybeBackgroundSync() {
  if (getLastSyncAge() < BG_SYNC_TTL_MS) return;
  syncPlaylist()
    .then(() => loadTabCategoriesAndContent())
    .catch(() => {});
}
// Exposed so web-tabs.js can trigger a backfill sync after unhiding a tab.
window.maybeBackgroundSync = maybeBackgroundSync;

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

  // 5.0 is dashboard-managed: hide the in-app manual login. Playlists are added
  // from the /connect dashboard and arrive via cloud sync.
  document.getElementById('remote-manual-login-btn')?.classList.add('hidden');

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
    const pname = p.playlistName || 'Playlist';
    const words = pname.trim().split(/[\s._-]+/).filter(Boolean);
    const mono = (words.length >= 2 ? words[0][0] + words[1][0] : pname.slice(0, 2)).toUpperCase();
    row.innerHTML = `
      <div class="playlist-tile-mono">${mono}</div>
      ${isLastUsed ? '<span class="playlist-row-badge">Last used</span>' : ''}
      <div class="playlist-row-main">
        <span class="playlist-row-name">${pname}</span>
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
    let cloudId = null;
    try {
      const { playlists } = await getPlaylists();
      cloudId = (playlists || []).find(p => p.id === id)?.cloudId || null;
    } catch (e) {}

    const res = await removePlaylist(id);
    if (cloudId && deviceCode) {
      try { await removePlaylistFromCloud(deviceCode, cloudId); } catch (e) { console.warn('Could not remove playlist from cloud:', e.message); }
    }
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
    const subEl = document.getElementById('playlist-drawer-sub');
    if (subEl) {
      const n = (playlists || []).length;
      subEl.textContent = `${n} connected ${n === 1 ? 'source' : 'sources'}`;
    }
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
    // Show the drawer immediately, THEN populate it. Un-hiding after an awaited
    // network render means a slow/hanging /api/playlists call leaves the drawer
    // invisible — which looked like the button "doing nothing" on mobile.
    dd.classList.remove('hidden');
    renderPlaylistDropdown();
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
    applyHiddenTabs();

    // Detect an existing cache cheaply (index count — no table scan).
    const hasCache = await hasCachedData();

    if (hasCache) {
      // Land on the Home dashboard (its rows come straight from cache/CW
      // storage); Live TV data loads on first visit to that tab.
      await switchTab('home');
      // Silent background refresh only when the cache is stale (12h TTL) —
      // re-downloading everything on every boot crushed weak devices.
      maybeBackgroundSync();
    } else {
      // First run: sync, then land on Home (it'll mostly show the "recently
      // added" rows until the user has watched something).
      state.activeCategory = null;
      await triggerFullSync({
        onLiveReady: async () => { await switchTab('home'); }
      });
      if (state.activeTab === 'home') await switchTab('home'); // repaint with full data
    }
  } catch (err) {
    console.error('Auto-enter single playlist failed:', err);
    showLogin();
  }
}

async function switchToPlaylist(id) {
  closePlaylistDropdown();
  // Stop the current stream up front — tearing down the old playback before the
  // heavy switch keeps the UI responsive (no decoding in the background).
  try { playerInstance.stop(); } catch (e) {}
  state.activePlaylistId = id;
  try { localStorage.setItem('last_playlist_id', String(id)); } catch (e) {}
  try {
    exitSeriesPlaybackDashboard();
    await switchPlaylist(id);
    const status = await getStatus();
    state.user = status;
    if (status.favorites) state.favorites = status.favorites;
    showDashboard();
    applyHiddenTabs();

    // Load instantly from cache when this playlist already has one (e.g. the
    // last-used playlist), and refresh in the background. Only do a blocking
    // full sync on first use when nothing is cached yet.
    const hasCache = await hasCachedData();

    state.activeCategory = null;
    if (hasCache) {
      await loadTabCategoriesAndContent();
      // Background refresh only when stale (12h TTL) — full re-downloads on
      // every switch made weak devices crawl.
      maybeBackgroundSync();
    } else {
      await triggerFullSync({
        onLiveReady: async () => { await loadTabCategoriesAndContent(); }
      });
      if (!state.activeCategory) await loadTabCategoriesAndContent();
    }
  } catch (err) {
    console.error('Failed to switch playlist:', err);
    throw err; // Re-throw so the caller can handle it
  }
}

async function deletePlaylist(id) {
  if (!confirm('Remove this playlist?')) return;
  try {
    // Look this up before removing locally — a playlist added via the hidden
    // manual-login form carries a cloudId (the row this device pushed to the
    // cloud device record), which needs deleting there too. Admin-provisioned
    // playlists have no cloudId, so this is a no-op for them.
    let cloudId = null;
    try {
      const { playlists } = await getPlaylists();
      cloudId = (playlists || []).find(p => p.id === id)?.cloudId || null;
    } catch (e) {}

    const res = await removePlaylist(id);
    if (cloudId && deviceCode) {
      try { await removePlaylistFromCloud(deviceCode, cloudId); } catch (e) { console.warn('Could not remove playlist from cloud:', e.message); }
    }
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

    document.getElementById('nav-playlist-name').textContent = `${creds.playlistName}`;

    // Account avatar initials (from the playlist name; fall back to host)
    const avatarEl = document.getElementById('profile-avatar');
    if (avatarEl) {
      const src = (creds.playlistName || domain || 'ZP').trim();
      const words = src.split(/[\s._-]+/).filter(Boolean);
      const initials = (words.length >= 2
        ? words[0][0] + words[1][0]
        : src.slice(0, 2)).toUpperCase();
      avatarEl.textContent = initials;
    }
  }

  // Set expiry text. Prefer the admin-set device expiry (from the /connect
  // dashboard, stored by the cloud sync). Fall back to the provider's Xtream
  // expiry only when no device expiry has been set (e.g. unmanaged device).
  const expiryEl = document.getElementById('expiry-text');
  if (expiryEl) {
    const deviceExpiry = localStorage.getItem(DEVICE_EXPIRY_KEY);
    if (deviceExpiry) {
      const expDate = new Date(deviceExpiry);
      const diffDays = Math.ceil((expDate - Date.now()) / (1000 * 60 * 60 * 24));
      if (diffDays <= 0) {
        expiryEl.textContent = 'Expired';
        expiryEl.parentElement.classList.replace('gold-badge', 'danger-badge');
      } else if (diffDays <= 7) {
        expiryEl.textContent = `${diffDays} days left`;
      } else {
        expiryEl.textContent = `Expires ${expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
      }
    } else if (state.user && state.user.user_info) {
      const info = state.user.user_info;
      if (info.exp_date === null || info.exp_date === undefined || info.exp_date === '0') {
        expiryEl.textContent = 'Active - Unlimited';
      } else {
        const expDate = new Date(parseInt(info.exp_date) * 1000);
        const diffDays = Math.ceil((expDate - Date.now()) / (1000 * 60 * 60 * 24));
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
  }

  // Set SVG lucide icons
  lucide.createIcons();

  // Update TV Connection IP badge in the top header
  updateHeaderTvIpBadge(state.user);

  // 7.0 native TV shell: in TV mode the launcher takes over the screen once
  // the session is live (the legacy layout stays underneath for playback).
  if (document.body.classList.contains('tv-native')) {
    enterTvNative();
    return;
  }

  // TV preview (?tv=true): drop initial D-pad focus into the categories column
  // so arrow-key navigation is immediately live without a first "priming" press.
  if (window.__TV_PREVIEW__) {
    setTimeout(() => navigation.focusDefault('categories'), 400);
  }
}

// Build the list of "open on your TV" URLs for the current environment:
//  - LAN IP(s) from the local server (best for a separate TV on the network)
//  - the local server URL straight from window.location (reliable in the
//    desktop app, e.g. http://localhost:56789/tv, even if IP detection failed)
//  - the hosted domain (the Vercel web build)
// LAN IPs + port for the "open on your TV" link. Fetched once from the local
// server (always running in the desktop app) so the link resolves even when the
// Xtream layer is in client mode and getStatus() carries no local_ips.
let lanInfo = { ips: [], port: null };
async function loadLanInfo() {
  try {
    const res = await fetch('/api/status', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return;
    const data = await res.json();
    if (Array.isArray(data.local_ips)) lanInfo.ips = data.local_ips;
    if (data.server_port) lanInfo.port = data.server_port;
    refreshSettingsTiles();
    // Now that real LAN IPs are known, (re)render the header pill — it no
    // longer depends on the app being in server mode.
    updateHeaderTvIpBadge(state.user);
  } catch (e) { /* no local server (e.g. hosted web build) */ }
}

// True when the app is being viewed from OUTSIDE the PC's local network — i.e.
// a phone opening the Cloudflare tunnel URL (or the hosted web build). In that
// case the server's LAN IPs (192.168.x, 10.x …) are unreachable, so we must not
// surface them as "open on your TV" links — fall back to the current origin.
function isRemoteAccess() {
  const h = (window.location.hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false; // on the LAN
  return true; // public host (tunnel / hosted build)
}

function getTvLinks() {
  const links = [];
  const seen = new Set();
  const add = (label, url) => { if (url && !seen.has(url)) { seen.add(url); links.push({ label, url }); } };

  const port = lanInfo.port || (state.user && state.user.server_port) || null;
  const ips = isRemoteAccess() ? [] : ((lanInfo.ips && lanInfo.ips.length)
    ? lanInfo.ips
    : ((state.user && state.user.local_ips) || []));

  // Preferred: real LAN IP(s) — reachable from a separate TV on the network.
  // Skipped for remote access (the phone can't reach the PC's LAN IP over LTE).
  for (const ip of ips) {
    add(`${ip}:${port || 80}/tv`, `http://${ip}:${port || 80}/tv`);
  }

  try {
    const host = window.location.host;          // includes port, e.g. localhost:56789
    const hostname = window.location.hostname;
    const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
    if (!isLocal && window.location.protocol !== 'file:' && host) {
      // Hosted web build (e.g. ziptvpro-nu.vercel.app).
      add(`${host}/tv`, `${window.location.origin.replace(/\/+$/, '')}/tv`);
    } else if (!ips.length && port) {
      // Desktop app but LAN IP detection failed — at least offer the same-machine link.
      add(`localhost:${port}/tv`, `http://localhost:${port}/tv`);
    }
  } catch (e) {}

  return links;
}

function updateHeaderTvIpBadge(status) {
  const badge = document.getElementById('header-tv-ip');
  const text = document.getElementById('header-tv-ip-text');
  
  if (Capacitor.isNativePlatform()) {
    if (badge) badge.style.display = 'none';
    return;
  }
  
  // Prefer a LAN IP; otherwise fall back to this site's public /tv URL so the
  // hosted web app (e.g. ziptvpro-nu.vercel.app) still shows a usable link.
  //
  // LAN IPs come from whichever source has them: the status object (populated
  // only in server mode) or `lanInfo`, which loadLanInfo() fetches straight
  // from the local server in any mode. Relying on `status` alone meant the
  // pill vanished in client mode (getStatus carries no local_ips) and only
  // reappeared when something flipped the app into server mode.
  let url = null;
  let label = null;
  // Remote (tunnel / hosted) viewers can't reach the PC's LAN IP, so ignore it
  // and let the fallback below surface the current origin's /tv instead.
  const lanIps = isRemoteAccess() ? [] : ((status && status.local_ips && status.local_ips.length > 0)
    ? status.local_ips
    : (lanInfo.ips && lanInfo.ips.length > 0 ? lanInfo.ips : []));
  if (lanIps.length > 0) {
    const ip = lanIps[0];
    const port = (status && status.server_port) || lanInfo.port || 3000;
    url = `http://${ip}:${port}/tv`;
    label = `TV: ${ip}:${port}/tv`;
  } else {
    try {
      const host = window.location.hostname || '';
      // Only a real hosted domain is useful here — a localhost/file origin (the
      // desktop app's own window) can't be opened from a separate TV.
      const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || window.location.protocol === 'file:';
      if (!isLocal) {
        url = `${window.location.origin.replace(/\/+$/, '')}/tv`;
        label = `TV: ${window.location.host}/tv`;
      }
    } catch (e) {}
  }

  if (badge && text && url) {
    text.textContent = label;
    badge.title = `Open on your TV's browser · ${url} (click to copy)`;
    badge.dataset.tvUrl = url;
    badge.style.display = 'inline-flex';

    // Click to copy the link (bind once).
    if (!badge.dataset.bound) {
      badge.dataset.bound = '1';
      badge.addEventListener('click', () => {
        const u = badge.dataset.tvUrl || '';
        if (u && navigator.clipboard) {
          navigator.clipboard.writeText(u)
            .then(() => showToast('TV link copied', 'success'))
            .catch(() => {});
        }
      });
    }

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

// ==========================================================================
// CLOUD SYNC (5.0) — the /connect dashboard is the source of truth. The app
// heartbeats to /api/device, mirrors the device's playlists, shows the admin's
// expiration, and wipes everything when the device expires.
// ==========================================================================
const CLOUD_SYNC_MS = 15 * 1000;      // reconcile every 15 seconds while open
const DEVICE_EXPIRY_KEY = 'ziptv_device_expiry';
let cloudSyncBusy = false;

// Signature of the last remote playlist state we fully reconciled. The heartbeat
// fires every 15s; without this, a single mismatch between the cloud record and
// the local playlist (a differing name, hidden-category set, or a server_url
// that normalizes differently) makes reconcile think "something changed" on
// EVERY cycle and re-run its destructive UI work — reloading categories or
// switching playlists — which yanks the user out of whatever they're browsing.
// Gating reconcile on this signature makes a steady cloud state a true no-op:
// work runs once when the cloud actually changes, never again until it changes.
let _lastCloudSig = null;
function cloudPlaylistSig(state) {
  try {
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');
    const rows = (state.playlists || []).map(p => [
      norm(p.server_url),
      String(p.username || '').toLowerCase(),
      p.playlistName || '',
      p.password || '',
      (p.hidden_tabs || []).slice().sort().join(','),
      (p.hidden_categories || []).map(String).slice().sort().join(',')
    ].join('|')).sort();
    return (state.status || '') + '::' + rows.join('~~');
  } catch (e) { return null; }
}

// Back-compat shims: the login/activation screens call these. With 5.0 the sync
// loop runs continuously for the whole app lifetime, so "start" just guarantees
// it's running and "stop" is a no-op (we never want to stop mirroring).
function startRemoteLoginPolling() { startCloudSync(); }
function stopRemoteLoginPolling() { /* cloud sync runs continuously now */ }

function appVersion() {
  return (typeof __APP_VERSION__ !== 'undefined') ? __APP_VERSION__ : null;
}

// Idempotent: starts the persistent heartbeat/reconcile loop + resume triggers.
function startCloudSync() {
  runCloudSync();
  if (cloudSyncInterval) return;
  cloudSyncInterval = setInterval(runCloudSync, CLOUD_SYNC_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) runCloudSync(); });
  window.addEventListener('online', runCloudSync);
}

// One sync cycle. On network failure, fall back to the cached state and only
// enforce a known expiry locally — never delete playlists over a blip (grace).
async function runCloudSync() {
  if (cloudSyncBusy) return;
  cloudSyncBusy = true;
  try {
    let state;
    try {
      state = await syncDevice(deviceCode, appVersion());
    } catch (netErr) {
      setActivationStatus('fail');
      const cached = readCachedState();
      if (cached && isStateExpired(cached)) await enforceDeviceExpiry(cached);
      return;
    }
    setActivationStatus('ok');
    await applyCloudState(state);
    // Piggyback the companion Continue Watching pull on the heartbeat
    // (internally throttled — it does not hit the network every 15s).
    await syncCompanionHistory();
  } catch (err) {
    console.warn('Cloud sync error:', err);
  } finally {
    cloudSyncBusy = false;
  }
}

// Setup-screen registration status, next to the device code. A device whose
// heartbeat can't reach the server must SAY so — a code that displays but never
// registers is indistinguishable from a working one otherwise.
function setActivationStatus(state) {
  const el = document.getElementById('remote-login-status');
  if (!el) return;
  el.dataset.state = state;
  el.textContent = state === 'ok'
    ? '✓ Registered — visible to your provider'
    : '⚠ Not connected — check the internet connection (retrying…)';
}

// Apply a fresh state from /api/device.
async function applyCloudState(state) {
  if (!state) return;

  // Expired → wipe + notice.
  if (state.expired || isStateExpired(state)) { await enforceDeviceExpiry(state); return; }

  // Remember the admin-set expiry for the in-app badge (or clear it).
  if (state.expires_at) localStorage.setItem(DEVICE_EXPIRY_KEY, state.expires_at);
  else localStorage.removeItem(DEVICE_EXPIRY_KEY);

  // The heartbeat is the source of truth for the companion link (it also heals
  // one-sided links server-side, e.g. after the other device re-pairs).
  updateCompanion(state.companion);

  // Nothing changed since the last full reconcile → do no reconcile work. This
  // is the common case on the 15s heartbeat, and skipping it here is what keeps
  // a background sync from interrupting the user's browsing (see _lastCloudSig).
  const sig = cloudPlaylistSig(state);
  if (sig !== null && sig === _lastCloudSig) return;

  // A brand-new ('pending') device that the admin hasn't provisioned yet keeps
  // whatever the user may already have locally — we only mirror (incl. removals)
  // once the device is managed. This protects existing users during migration.
  const managed = state.status && state.status !== 'pending';
  const { activeChanged, incomplete } = await reconcilePlaylists(state.playlists || [], { allowRemovals: managed });

  // Only remember this state as "done" once it fully reconciled. A transient
  // add failure leaves it unmemoized so the next heartbeat retries — but a
  // clean cycle memoizes, so a steady cloud state stops re-running forever.
  if (!incomplete) _lastCloudSig = sig;

  // Managed device whose playlists were ALL removed from the dashboard → treat
  // like an expired subscription: stop playback, return to the login screen and
  // show the notice. Gated on the REMOTE list being empty (the admin's actual
  // intent), not on the local reconcile result — a transient add failure (e.g.
  // the provider briefly unreachable) must never be mistaken for a deliberate
  // removal and log the user out.
  if (managed && (!state.playlists || state.playlists.length === 0)) {
    try {
      const { playlists } = await getPlaylists();
      if (!playlists || playlists.length === 0) { await deactivateToLogin(state.notice); return; }
    } catch (e) {}
  }

  // Healthy + active: clear any lingering expiry banner.
  const banner = document.getElementById('expiry-banner');
  if (banner) banner.remove();

  // Apply hidden tabs and refresh current categories/content dynamically on changes
  if (activeChanged) {
    applyHiddenTabs();
    const onLoginScreen = !document.getElementById('app-container') ||
      document.getElementById('app-container').classList.contains('hidden');
    if (!onLoginScreen) {
      await loadTabCategoriesAndContent();
    }
  }
}

// ==========================================================================
// COMPANION DEVICE (8.3) — cross-device Continue Watching hand-off.
// Settings → Companion Device links this device with ONE other device of the
// opposite platform (PC ↔ mobile, enforced server-side). Each device keeps
// backing up its own history as before; a throttled pull fetches the
// companion's rows and merges them into the local store, newest-wins per
// title — start a movie on the PC, pick it up on the phone, and back.
// ==========================================================================
const COMPANION_KEY = 'ziptv_companion';
const COMPANION_PULL_MS = 60 * 1000;   // history pull throttle (heartbeat is 15s)
let companionInfo = null;
try { companionInfo = JSON.parse(localStorage.getItem(COMPANION_KEY) || 'null'); } catch (e) {}
let lastCompanionPull = 0;

function companionPlatformLabel(p) {
  return p === 'pc' ? 'PC' : p === 'apk' ? 'Mobile' : 'Device';
}

// Keep state + the Settings tile in step. Cached in localStorage so the tile
// is right immediately on boot, before the first heartbeat answers.
//
// Pairing happens on ONE device but must show on BOTH: the other side learns
// via the heartbeat, so when the link changes here without local action
// (opts.quiet is only set by this device's own Link/Unlink buttons) announce
// it — toast, flip the Companion modal if it's open, and pull history now.
function updateCompanion(info, opts = {}) {
  const prev = companionInfo ? companionInfo.device_id : null;
  companionInfo = info || null;
  const next = companionInfo ? companionInfo.device_id : null;
  try {
    if (companionInfo) localStorage.setItem(COMPANION_KEY, JSON.stringify(companionInfo));
    else localStorage.removeItem(COMPANION_KEY);
  } catch (e) {}
  const sub = document.getElementById('tile-companion-val');
  if (sub) {
    sub.textContent = companionInfo
      ? `Linked with ${companionInfo.device_id} · ${companionPlatformLabel(companionInfo.platform)}`
      : 'Continue watching across PC & mobile';
  }

  if (!opts.quiet && next !== prev) {
    if (next) showToast(`Companion device linked: ${next} — Continue Watching will sync`, 'success', 4500);
    else if (prev) showToast('Companion device unlinked', 'info', 4000);
    const modal = document.getElementById('companion-modal');
    if (modal && !modal.classList.contains('hidden')) renderCompanionModal();
    if (next) syncCompanionHistory(true);
  }
}

// Pull the companion's history and fold it into local Continue Watching.
// Throttled; pass force=true right after pairing for instant gratification.
async function syncCompanionHistory(force = false) {
  if (!companionInfo || !deviceCode) return;
  const now = Date.now();
  if (!force && now - lastCompanionPull < COMPANION_PULL_MS) return;
  lastCompanionPull = now;
  const { companion, entries } = await fetchCompanionHistory(deviceCode);
  if (!companion) return;   // unlinked remotely — the next heartbeat clears the tile
  const changed = mergeCompanionHistory(entries);
  if (changed > 0) {
    try { refreshContinueWatching(); } catch (e) {}
  }
}

function openCompanionModal() {
  renderCompanionModal();
  document.getElementById('companion-modal')?.classList.remove('hidden');
}
function closeCompanionModal() {
  document.getElementById('companion-modal')?.classList.add('hidden');
}

function renderCompanionModal() {
  const body = document.getElementById('companion-modal-body');
  if (!body) return;
  const plat = detectPlatform();
  const otherKind = plat === 'pc' ? 'phone' : plat === 'apk' ? 'computer' : 'other device';

  if (companionInfo) {
    body.innerHTML = `
      <h3 class="wt-heading">Companion Device</h3>
      <p class="wt-sub">Continue Watching syncs both ways with</p>
      <p class="wt-code" style="font-size:2.4rem;">${companionInfo.device_id}</p>
      <p class="wt-hint">${companionPlatformLabel(companionInfo.platform)}${companionInfo.label ? ' · ' + escapeHtml(companionInfo.label) : ''} — start on one device, pick up on the other within a minute.</p>
      <div class="wt-actions">
        <button class="wt-btn" id="companion-unlink-btn">Unlink devices</button>
      </div>`;
    body.querySelector('#companion-unlink-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Unlinking…';
      try {
        await unpairCompanion(deviceCode);
        updateCompanion(null, { quiet: true });
        showToast('Companion unlinked', 'success');
        renderCompanionModal();
      } catch (ex) {
        btn.disabled = false; btn.textContent = 'Unlink devices';
        showToast(ex.message, 'error', 4000);
      }
    });
    return;
  }

  body.innerHTML = `
    <h3 class="wt-heading">Companion Device</h3>
    <p class="wt-sub">Link this device with your ${otherKind} to sync Continue Watching both ways — start a movie here, pick it up there. Works between a PC and a mobile device only.</p>
    <p class="wt-hint">This device's code: <strong>${deviceCode || '—'}</strong>. On the other device, open Settings → Companion Device to find its code.</p>
    <input class="wt-code-input" id="companion-code-input" maxlength="8" placeholder="CODE" autocomplete="off" spellcheck="false" style="font-size:1.7rem;" />
    <p class="wt-error" id="companion-error"></p>
    <div class="wt-actions">
      <button class="wt-btn wt-btn-primary" id="companion-link-btn">Link devices</button>
    </div>`;

  const input = body.querySelector('#companion-code-input');
  const errEl = body.querySelector('#companion-error');
  const linkBtn = body.querySelector('#companion-link-btn');

  const doLink = async () => {
    const code = (input.value || '').trim().toUpperCase();
    errEl.textContent = '';
    if (!/^[A-Z0-9]{4,12}$/.test(code)) { errEl.textContent = 'Enter the code shown on the other device.'; return; }
    linkBtn.disabled = true; linkBtn.textContent = 'Linking…';
    try {
      const comp = await pairCompanion(deviceCode, code);
      updateCompanion(comp, { quiet: true });
      showToast(`Linked with ${comp.device_id} — history will sync`, 'success', 4000);
      renderCompanionModal();
      syncCompanionHistory(true);
    } catch (ex) {
      linkBtn.disabled = false; linkBtn.textContent = 'Link devices';
      errEl.textContent = ex.message;
    }
  };
  linkBtn?.addEventListener('click', doLink);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLink(); });
  setTimeout(() => input?.focus(), 50);
}

// Make the local playlists match the dashboard's list (match on host+username).
async function reconcilePlaylists(remote, { allowRemovals } = {}) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\/+$/, '').replace(/^https?:\/\//, '');
  const key = (p) => norm(p.server_url) + '|' + String(p.username || '').toLowerCase();

  const { playlists: local, activeId } = await getPlaylists();
  const localKeys = new Set((local || []).map(key));
  const remoteKeys = new Set((remote || []).map(key));

  let added = false;
  let addedKey = null;
  let activeChanged = false;
  let incomplete = false; // an add/update failed → don't memoize; retry next cycle
  for (const r of remote) {
    const k = key(r);
    if (!localKeys.has(k)) {
      try {
        await login(r.server_url, r.username, r.password, r.playlistName || 'Playlist', { skipAccountCheck: true });
        added = true;
        addedKey = k;
      } catch (e) {
        incomplete = true;
        console.warn('Could not add synced playlist:', r.playlistName, e.message);
      }
    }
    // Update local settings with remote configurations
    try {
      const res = await updatePlaylistByServerAndUser(r.server_url, r.username, {
        playlistName: r.playlistName || 'Playlist',
        hidden_tabs: r.hidden_tabs || [],
        hidden_categories: r.hidden_categories || []
      });
      if (res && res.changed && res.id === activeId) {
        activeChanged = true;
        // Something was unhidden remotely — its catalog was skipped during
        // sync, so backfill it.
        if (res.unhid) {
          markSyncStale();
          maybeBackgroundSync();
        }
      }
    } catch (e) {
      incomplete = true;
      console.warn('Failed to update synced playlist settings:', r.playlistName, e.message);
    }
  }

  if (allowRemovals) {
    for (const l of (local || [])) {
      if (!remoteKeys.has(key(l))) {
        try { await removePlaylist(l.id); } catch (e) { console.warn('Could not remove playlist:', e.message); }
      }
    }
  }

  // A playlist arrived from the dashboard. Behaviour depends on where the user is:
  //   - On the activation screen  -> enter the app with it.
  //   - Already watching          -> switch to the new playlist and sync it now.
  const onLoginScreen = !document.getElementById('app-container') ||
    document.getElementById('app-container').classList.contains('hidden');
  if (added) {
    try {
      const { playlists, activeId } = await getPlaylists();
      if (playlists && playlists.length > 0) {
        if (onLoginScreen) {
          showToast('Playlist connected', 'success');
          await autoEnterSinglePlaylist(playlists[0].id, activeId);
        } else {
          // Switch to the newly added playlist (fall back to the active one) and
          // let switchToPlaylist run the full sync + repaint.
          const target = playlists.find(p => key(p) === addedKey) || playlists[0];
          showToast('New playlist added — switching…', 'success');
          await switchToPlaylist(target.id);
        }
      }
    } catch (e) { console.warn('Auto-enter after sync failed:', e.message); }
  }
  return { activeChanged, incomplete };
}

// Wipe all local playlists, stop playback and bounce to the login screen.
async function enforceDeviceExpiry(state) {
  localStorage.setItem(DEVICE_EXPIRY_KEY, state.expires_at || '');
  try {
    const { playlists } = await getPlaylists();
    for (const p of (playlists || [])) {
      try { await removePlaylist(p.id); } catch (e) {}
    }
  } catch (e) {}
  await deactivateToLogin(state.notice);
}

// Log the user out (stop playback, clear session) and show the expired notice on
// the activation screen. The toast fires only on the active->login transition so
// it doesn't repeat every sync while parked on the login screen.
async function deactivateToLogin(noticeText) {
  const appC = document.getElementById('app-container');
  const wasActive = appC && !appC.classList.contains('hidden');
  try { if (playerInstance) playerInstance.stop(); } catch (e) {}
  state.user = null;
  localStorage.removeItem('last_playlist_id');
  showLogin();
  showExpiryNotice(noticeText, { toast: wasActive });
}

function showExpiryNotice(text, { toast = true } = {}) {
  const msg = (text && String(text).trim()) || 'Your subscription has expired. Please contact your provider to renew.';
  if (toast) { try { showToast(msg, 'error', 8000); } catch (e) {} }
  const codeEl = document.getElementById('remote-device-code');
  if (codeEl && codeEl.parentElement) {
    let banner = document.getElementById('expiry-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'expiry-banner';
      banner.style.cssText = 'margin:12px 0;padding:12px 14px;border-radius:10px;background:rgba(239,68,68,.12);' +
        'border:1px solid rgba(239,68,68,.35);color:#fecaca;font-size:.9rem;white-space:pre-wrap;text-align:center;';
      codeEl.parentElement.insertBefore(banner, codeEl.parentElement.firstChild);
    }
    banner.textContent = msg;
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
