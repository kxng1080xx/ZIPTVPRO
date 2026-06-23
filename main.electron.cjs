const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { initCast } = require('./electron/cast-manager.cjs');

// Open download/update links in the user's default browser, not a child window.
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

let mainWindow;
let tray = null;
let isQuitting = false;
let serverPort = 0;
let castInitialized = false;

// Native Video Overlay State
let videoWindow = null;
let mpvProcess = null;
let mpvClient = null;
let connectionAttempts = 0;

const ipcServerPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\mpv-ipc-socket'
  : path.join(require('os').tmpdir(), 'mpv-ipc-socket');

// The cast libraries open their own sockets to TVs — Chromecast over TLS (port
// 8009), DLNA over HTTP — and a device dropping a connection (e.g. "socket
// disconnected before secure TLS connection was established") surfaces as an
// error on an internal socket we can't attach a handler to. Don't let those
// transient network errors crash the app with Electron's fatal-error dialog.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (ignored):', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (ignored):', reason && reason.message ? reason.message : reason);
});

// Only allow a single instance. A second launch would otherwise spin up another
// server and fight over the port, which is what caused the EADDRINUSE crash.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.on('ready', async () => {
    await startExpressServer();
    createWindow();
    initAutoUpdate();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // Distinguish a real quit (tray "Quit", app.quit()) from the window being
  // closed/minimized to the tray, so the close/minimize handlers know whether
  // to hide the window or let it be destroyed.
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });
}

// Ask the OS for a free TCP port so we never collide with another app on :3000.
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(0));
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Is a specific TCP port free on all interfaces?
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.on('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}

// Preferred stable port for the in-process server. A fixed port keeps the LAN
// cast URL predictable (testable from a phone, firewall rules stay valid across
// launches) and only falls back to a random free port if it's taken.
const PREFERRED_PORT = 56789;

async function startExpressServer() {
  process.env.ELECTRON_RUNNING = 'true';
  serverPort = (await isPortFree(PREFERRED_PORT)) ? PREFERRED_PORT : ((await getFreePort()) || 3000);
  process.env.PORT = String(serverPort);

  // server/index.js is an ES Module, imported dynamically from CommonJS.
  // NOTE: the app is packaged with asar:false specifically because Node's ESM
  // loader cannot import a module from inside an asar archive — see package.json.
  try {
    await import('./server/index.js');
    console.log(`[Electron] In-process Express server starting on port ${serverPort}.`);
  } catch (err) {
    console.error('[Electron] Error initializing in-process Express server:', err);
    // The whole UI is served by this server, so a failure here = a black window.
    // Surface it instead of failing silently, and log it for the user to send.
    try {
      const logFile = path.join(require('os').homedir(), 'ziptv-server-error.log');
      require('fs').writeFileSync(logFile, String(err && err.stack ? err.stack : err));
      dialog.showErrorBox('ZIPTV Pro — server failed to start',
        `The in-app server could not start, so the window will be blank.\n\n` +
        `${err && err.message ? err.message : err}\n\nDetails saved to:\n${logFile}`);
    } catch (e) {}
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'ZIPTV Pro',
    autoHideMenuBar: true,
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron', 'preload.cjs')
    }
  });

  // Set up casting (Chromecast/Android TV + DLNA) once the window exists. The
  // manager pushes LAN-reachable URLs to receivers, so it needs the live server
  // port (random in the packaged app) and the current window for IPC events.
  if (!castInitialized) {
    castInitialized = true;
    try {
      initCast({ getWindow: () => mainWindow, getServerPort: () => serverPort });
    } catch (err) {
      console.error('[Electron] Cast init failed:', err);
    }
  }

  createTray();

  // Minimize to tray: hide the window instead of leaving a taskbar button.
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });

  // Closing the window asks whether to quit or keep running in the tray. The app
  // only truly exits via this dialog's "Quit" (or the tray's "Quit"), which sets
  // isQuitting.
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Minimize to tray', 'Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Close ZIPTV Pro',
      message: 'Close ZIPTV Pro?',
      detail: 'Keep it running in the system tray, or quit completely.'
    });
    if (choice === 0) {
      mainWindow.hide();
    } else if (choice === 1) {
      isQuitting = true;
      app.quit();
    }
    // choice === 2 (Cancel): leave the window open.
  });

  loadWhenServerReady();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Show (and focus) the main window, restoring it if it was minimized/hidden.
function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Background auto-update (Windows installer). electron-updater reads the GitHub
// release's latest.yml, downloads the new installer in the background, and we
// prompt to restart once it's ready. No-op in dev (unpackaged).
function initAutoUpdate() {
  if (!app.isPackaged) return;
  // Lazy-require: electron-updater instantiates NsisUpdater at require-time and
  // reads app.getVersion(), which throws when run unpackaged (dev). Only load it
  // in the packaged app so `npx electron .` works for debugging.
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Update ready',
      message: `ZIPTV Pro ${info && info.version ? 'v' + info.version : 'update'} is ready`,
      detail: 'Restart now to install the update, or it will install the next time you quit.'
    });
    if (choice === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  // Releases may not always carry updater metadata — never crash on that.
  autoUpdater.on('error', (err) => {
    console.error('[updater]', err && err.message ? err.message : err);
  });

  autoUpdater.checkForUpdates().catch(() => {});
  // Re-check every 3 hours for long-running sessions.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3 * 60 * 60 * 1000);
}

// Create the system-tray icon and its context menu. Double-clicking the tray
// icon restores the window; the menu offers explicit Show/Quit actions.
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  let trayImage = nativeImage.createFromPath(iconPath);
  if (!trayImage.isEmpty()) {
    trayImage = trayImage.resize({ width: 16, height: 16 });
  }
  try {
    tray = new Tray(trayImage.isEmpty() ? iconPath : trayImage);
  } catch (err) {
    console.error('[Electron] Tray init failed:', err);
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show ZIPTV Pro', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('ZIPTV Pro');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', showMainWindow);
}

// Poll the local server until it accepts connections, then load it. More reliable
// than a fixed delay and avoids showing a blank/error page on slower machines.
function loadWhenServerReady(attempt = 0) {
  if (!mainWindow) return;
  const url = `http://localhost:${serverPort}`;
  const sock = net.connect(serverPort, '127.0.0.1');
  sock.on('connect', () => {
    sock.destroy();
    if (mainWindow) mainWindow.loadURL(url);
  });
  sock.on('error', () => {
    sock.destroy();
    if (attempt < 60 && mainWindow) {
      setTimeout(() => loadWhenServerReady(attempt + 1), 100);
    } else if (mainWindow) {
      mainWindow.loadURL(url); // last resort
    }
  });
}

// ==========================================================================
// ELECTRON MPV NATIVE PLAYER BRIDGE IMPLEMENTATION
// ==========================================================================

function findMpv() {
  const isWin = process.platform === 'win32';
  const binaryName = isWin ? 'mpv.exe' : 'mpv';

  // 1. Packaged production path
  if (app.isPackaged) {
    const prodPath = path.join(process.resourcesPath, 'bin', binaryName);
    if (fs.existsSync(prodPath)) return prodPath;
  }

  // 2. Development paths
  const devPaths = [
    path.join(__dirname, 'extraResources', binaryName),
    path.join(__dirname, 'extraResources', process.platform, binaryName),
    path.join(app.getAppPath(), 'extraResources', binaryName),
    path.join(app.getAppPath(), 'extraResources', process.platform, binaryName),
    path.join(__dirname, 'bin', binaryName),
    path.join(app.getAppPath(), 'bin', binaryName),
  ];

  if (isWin) {
    devPaths.push(
      'C:\\Program Files\\mpv\\mpv.exe',
      'C:\\Program Files (x86)\\mpv\\mpv.exe',
      path.join(process.env.LOCALAPPDATA || '', 'mpv', 'mpv.exe')
    );
  } else {
    devPaths.push(
      '/opt/homebrew/bin/mpv',
      '/usr/local/bin/mpv',
      '/usr/bin/mpv'
    );
  }

  for (const p of devPaths) {
    if (fs.existsSync(p)) return p;
  }
  return 'mpv'; // rely on PATH as last resort
}

function sendToRenderer(event, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`native-video:event:${event}`, data);
  }
}

function sendIPCCommand(cmd) {
  if (mpvClient) {
    try {
      mpvClient.write(JSON.stringify(cmd) + '\n');
    } catch (e) {
      console.error('[Electron MPV] Failed to write IPC command:', e);
    }
  }
}

function handleMpvMessage(msg) {
  if (msg.event === 'property-change') {
    if (msg.name === 'time-pos' && msg.data !== null) {
      sendToRenderer('timeupdate', { currentTime: msg.data });
    } else if (msg.name === 'pause') {
      sendToRenderer('state', { state: msg.data ? 'Paused' : 'Playing' });
    } else if (msg.name === 'eof-reached' && msg.data === true) {
      sendToRenderer('ended');
    } else if (msg.name === 'core-idle') {
      sendToRenderer('buffering', { value: msg.data ? 100 : 0 });
    }
  } else if (msg.event === 'file-loaded') {
    sendToRenderer('vout', { active: true });
    sendToRenderer('ready');
  } else if (msg.event === 'end-file') {
    if (msg.reason === 'error') {
      sendToRenderer('error', { message: 'Playback error: ' + (msg.error || 'unknown') });
    }
  }
}

function connectIPC() {
  mpvClient = net.connect(ipcServerPath);
  mpvClient.on('connect', () => {
    console.log('[Electron MPV] Connected to MPV IPC socket');
    sendIPCCommand({ command: ['observe_property', 1, 'time-pos'] });
    sendIPCCommand({ command: ['observe_property', 2, 'pause'] });
    sendIPCCommand({ command: ['observe_property', 3, 'eof-reached'] });
    sendIPCCommand({ command: ['observe_property', 4, 'core-idle'] });
  });
  mpvClient.on('error', (err) => {
    console.log('[Electron MPV] IPC Socket error:', err.message);
    mpvClient.destroy();
    mpvClient = null;
    if (connectionAttempts < 30 && mpvProcess) {
      connectionAttempts++;
      setTimeout(connectIPC, 200);
    } else if (mpvProcess) {
      sendToRenderer('error', { message: 'Failed to connect to player IPC' });
    }
  });

  let buffer = '';
  mpvClient.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleMpvMessage(msg);
      } catch (e) {
        console.error('[Electron MPV] JSON parse error:', e);
      }
    }
  });
}

async function stopMpv() {
  if (mpvClient) {
    mpvClient.destroy();
    mpvClient = null;
  }
  if (mpvProcess) {
    try {
      mpvProcess.kill();
    } catch (e) {}
    mpvProcess = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setParentWindow(null);
    } catch (e) {}
  }
  if (videoWindow && !videoWindow.isDestroyed()) {
    try {
      videoWindow.destroy();
    } catch (e) {}
    videoWindow = null;
  }
}

// Register IPC handlers for the renderer native Video API
ipcMain.handle('native-video:load', async (_e, opts) => {
  await stopMpv();

  const rect = opts.rect || { x: 100, y: 100, width: 800, height: 450 };
  videoWindow = new BrowserWindow({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    frame: false,
    show: false,
    focusable: false,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const wid = videoWindow.getNativeWindowHandle().readInt32LE(0);
  const mpvPath = findMpv();

  if (process.platform !== 'win32' && fs.existsSync(ipcServerPath)) {
    try { fs.unlinkSync(ipcServerPath); } catch (e) {}
  }

  const args = [
    `--wid=${wid}`,
    '--no-border',
    '--keep-open=yes',
    '--idle=yes',
    `--input-ipc-server=${ipcServerPath}`,
    opts.url
  ];

  try {
    mpvProcess = spawn(mpvPath, args);
  } catch (err) {
    console.error('[Electron MPV] Spawn failed:', err);
    videoWindow.destroy();
    videoWindow = null;
    throw err;
  }

  mainWindow.setParentWindow(videoWindow);
  videoWindow.showInactive();

  connectionAttempts = 0;
  connectIPC();

  return { success: true };
});

ipcMain.handle('native-video:play', () => {
  sendIPCCommand({ command: ['set_property', 'pause', false] });
  return { success: true };
});

ipcMain.handle('native-video:pause', () => {
  sendIPCCommand({ command: ['set_property', 'pause', true] });
  return { success: true };
});

ipcMain.handle('native-video:seek', (_e, pos) => {
  sendIPCCommand({ command: ['seek', pos, 'absolute'] });
  return { success: true };
});

ipcMain.handle('native-video:set-volume', (_e, vol) => {
  sendIPCCommand({ command: ['set_property', 'volume', vol] });
  return { success: true };
});

ipcMain.handle('native-video:set-rect', (_e, rect) => {
  if (videoWindow && !videoWindow.isDestroyed()) {
    videoWindow.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    });
  }
  return { success: true };
});

ipcMain.handle('native-video:stop', async () => {
  await stopMpv();
  return { success: true };
});

ipcMain.handle('native-video:get-audio-tracks', () => {
  return { tracks: [] };
});
