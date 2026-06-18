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
  // { deviceId, action: 'pause'|'resume'|'stop'|'seek', value? }
  control: (opts) => ipcRenderer.invoke('cast:control', opts),
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
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
