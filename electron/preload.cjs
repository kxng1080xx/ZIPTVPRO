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
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  nativeVideo: {
    load: (opts) => ipcRenderer.invoke('native-video:load', opts),
    play: () => ipcRenderer.invoke('native-video:play'),
    pause: () => ipcRenderer.invoke('native-video:pause'),
    seek: (position) => ipcRenderer.invoke('native-video:seek', position),
    setVolume: (volume) => ipcRenderer.invoke('native-video:set-volume', volume),
    setRect: (rect) => ipcRenderer.invoke('native-video:set-rect', rect),
    stop: () => ipcRenderer.invoke('native-video:stop'),
    getAudioTracks: () => ipcRenderer.invoke('native-video:get-audio-tracks'),
    on: (event, cb) => {
      const channel = `native-video:event:${event}`;
      const handler = (_e, data) => cb(data);
      ipcRenderer.on(channel, handler);
      return {
        remove: () => {
          ipcRenderer.removeListener(channel, handler);
        }
      };
    }
  }
});
