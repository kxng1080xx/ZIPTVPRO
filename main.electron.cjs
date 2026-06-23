const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const net = require('net');
const path = require('path');
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
    backgroundColor: '#070a13',
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
