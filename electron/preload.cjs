/**
 * Preload bridge for the Electron build. Exposes a minimal, safe casting API to
 * the renderer over IPC (contextIsolation is on, nodeIntegration off). Absent on
 * web / Android builds — the renderer feature-detects `window.electronCast`.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronCast', {
  available: true,
  // Trigger a rescan and return the current device list.
  list: () => ipcRenderer.invoke('cast:list'),
  // { deviceId, path, title, contentType, isLive }
  play: (opts) => ipcRenderer.invoke('cast:play', opts),
  // { deviceId, action: 'pause'|'resume'|'stop'|'seek'|'volume', value? }
  control: (opts) => ipcRenderer.invoke('cast:control', opts),
  // { deviceId } → { currentTime, duration, volume } (best-effort; {} if unsupported)
  status: (opts) => ipcRenderer.invoke('cast:status', opts),
  // Subscribe to live device-list updates; returns an unsubscribe fn.
  onDevices: (cb) => {
    const handler = (_e, list) => cb(list);
    ipcRenderer.on('cast:devices', handler);
    return () => ipcRenderer.removeListener('cast:devices', handler);
  }
});

// Host helpers for the renderer (e.g. open a download link in the system browser
// rather than a child Electron window).
contextBridge.exposeInMainWorld('appHost', {
  // Lets the renderer feature-detect the Electron build (custom web tabs +
  // the built-in ad blocker are desktop-only).
  isElectron: true,

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Hand a stream to the user's default media player via a temp .m3u playlist.
  // opts: { url, title } → { ok, error? }.
  openInPlayer: (opts) => ipcRenderer.invoke('open-in-player', opts),

  // MPV engine: play the stream in a standalone hardware-decoding mpv window
  // (no server transcode — lightest path for weak PCs). opts: { url, title,
  // isLive } → { ok, error? }.
  playInMpv: (opts) => ipcRenderer.invoke('open-in-mpv', opts),

  // Built-in ad blocker (uBlock-style filter lists) for custom web tabs.
  // set → { ok, enabled, error? }; get → { enabled }.
  setAdblock: (enabled) => ipcRenderer.invoke('adblock:set', enabled),
  getAdblock: () => ipcRenderer.invoke('adblock:get'),

  // Auto-updater (electron-updater) → in-app UI. Subscribe to update lifecycle
  // events; cb receives { type: 'available'|'progress'|'downloaded'|'error', ... }.
  // Returns an unsubscribe function.
  onUpdate: (cb) => {
    const channels = ['update:available', 'update:progress', 'update:downloaded', 'update:error'];
    const handlers = channels.map((ch) => {
      const handler = (_e, data) => cb({ type: ch.split(':')[1], ...(data || {}) });
      ipcRenderer.on(ch, handler);
      return [ch, handler];
    });
    return () => handlers.forEach(([ch, handler]) => ipcRenderer.removeListener(ch, handler));
  },
  // Trigger install + restart once an update has finished downloading.
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Startup behaviour (run at login / start minimized to tray).
  // get → { openAtLogin, startMinimized }; set(opts) applies + returns the same.
  getStartupSettings: () => ipcRenderer.invoke('startup:get'),
  setStartupSettings: (opts) => ipcRenderer.invoke('startup:set', opts),

  // TV interface (7.0): borderless fullscreen for the 10-foot UI + explicit
  // app exit from the TV shell (bypasses close-to-tray).
  setFullscreen: (on) => ipcRenderer.invoke('window:set-fullscreen', on),
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // Close-to-tray with playback stopped (TV power button / programmatic close).
  hideToTray: () => ipcRenderer.invoke('app:hide-to-tray'),
  // Fires whenever the window is being hidden to the tray (X button or
  // hideToTray). The renderer must stop the player and silence web tabs so
  // nothing keeps playing in the background. Returns an unsubscribe function.
  onHideToTray: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:hide-to-tray', handler);
    return () => ipcRenderer.removeListener('app:hide-to-tray', handler);
  }
});
