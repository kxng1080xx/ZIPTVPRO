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
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

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
  installUpdate: () => ipcRenderer.invoke('update:install')
});
