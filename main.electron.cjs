const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog, session } = require('electron');
const net = require('net');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { initCast } = require('./electron/cast-manager.cjs');
const { initTunnel, shutdown: shutdownTunnel } = require('./electron/tunnel-manager.cjs');

// Per-launch secret that authorizes phone access over the Cloudflare tunnel.
// Requests arriving through the tunnel must carry this (see server/index.js);
// desktop + LAN traffic is never gated. Regenerated every launch.
const SHARE_TOKEN = crypto.randomBytes(16).toString('hex');

// ---------------------------------------------------------------------------
// AD BLOCKER (built-in "uBlock-style" engine for custom web tabs)
// Uses @ghostery/adblocker-electron with the same public filter lists uBlock
// Origin Lite ships (EasyList, EasyPrivacy, uBO filters). Scoped to the
// 'persist:webtabs' session, which only the in-app browser <webview>s use —
// IPTV streams / EPG / API traffic on the default session are never touched.
// Toggled from Settings via IPC; the compiled engine is cached on disk so
// startup doesn't re-download lists.
// ---------------------------------------------------------------------------
let adblockBlocker = null;   // ElectronBlocker instance (lazy)
let adblockEnabled = false;  // current wired state
let adblockLoading = null;   // in-flight engine load

function webTabsSession() {
  return session.fromPartition('persist:webtabs');
}

async function loadAdblockEngine() {
  if (adblockBlocker) return adblockBlocker;
  if (adblockLoading) return adblockLoading;
  adblockLoading = (async () => {
    // Optional dependency: the app must still boot if it isn't installed.
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
    adblockBlocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile
    });
    return adblockBlocker;
  })();
  try {
    return await adblockLoading;
  } finally {
    adblockLoading = null;
  }
}

async function setAdblock(enabled) {
  try {
    if (enabled) {
      const blocker = await loadAdblockEngine();
      if (!adblockEnabled) {
        blocker.enableBlockingInSession(webTabsSession());
        adblockEnabled = true;
      }
    } else if (adblockEnabled && adblockBlocker) {
      adblockBlocker.disableBlockingInSession(webTabsSession());
      adblockEnabled = false;
    }
    return { ok: true, enabled: adblockEnabled };
  } catch (err) {
    console.error('[adblock] toggle failed:', err && err.message ? err.message : err);
    return { ok: false, enabled: adblockEnabled, error: String(err && err.message ? err.message : err) };
  }
}

ipcMain.handle('adblock:set', (_e, enabled) => setAdblock(!!enabled));
ipcMain.handle('adblock:get', () => ({ enabled: adblockEnabled }));

// --- Startup behaviour: run at login + start minimized to tray ---------------
// startMinimized is persisted in userData; openAtLogin is owned by the OS and
// read back via app.getLoginItemSettings(). When both are on, the login-item is
// registered with a --minimized arg so an auto-launch opens straight to tray.
function startupFile() { return path.join(app.getPath('userData'), 'startup.json'); }
function readStartup() { try { return JSON.parse(fs.readFileSync(startupFile(), 'utf8')); } catch (e) { return {}; } }
function writeStartup(s) { try { fs.writeFileSync(startupFile(), JSON.stringify(s)); } catch (e) {} }

function getStartupState() {
  let openAtLogin = false;
  try { openAtLogin = app.getLoginItemSettings().openAtLogin; } catch (e) {}
  return { openAtLogin, startMinimized: !!readStartup().startMinimized };
}

ipcMain.handle('startup:get', () => getStartupState());
ipcMain.handle('startup:set', (_e, opts = {}) => {
  const cur = getStartupState();
  const startMinimized = typeof opts.startMinimized === 'boolean' ? opts.startMinimized : cur.startMinimized;
  const openAtLogin = typeof opts.openAtLogin === 'boolean' ? opts.openAtLogin : cur.openAtLogin;
  if (typeof opts.startMinimized === 'boolean') writeStartup({ startMinimized });
  try {
    app.setLoginItemSettings({ openAtLogin, args: startMinimized ? ['--minimized'] : [] });
  } catch (e) {}
  return getStartupState();
});

// --- TV interface (7.0) window controls --------------------------------------
// The 10-foot UI runs borderless fullscreen; the renderer toggles it when the
// user switches Desktop ↔ TV interface, and can quit the app from the TV shell
// (the tray "close to tray" behavior must not swallow an explicit TV exit).
ipcMain.handle('window:set-fullscreen', (_e, on) => {
  try { if (mainWindow) mainWindow.setFullScreen(!!on); } catch (e) {}
  return { ok: true };
});
ipcMain.handle('app:quit', () => {
  isQuitting = true; // bypass close-to-tray: this is an explicit user exit
  app.quit();
});
// TV shell power button (and anything else that wants "close" semantics):
// stop all playback in the renderer, then hide to the tray — same as the X.
ipcMain.handle('app:hide-to-tray', () => {
  hideToTray();
  return { ok: true };
});

// Hide the window to the tray, telling the renderer FIRST to stop all
// playback (video player, custom web tabs). Without the stop event a hidden
// window keeps playing audio in the background — the tray is for keeping
// recordings alive, not the stream you were watching.
function hideToTray() {
  try { if (mainWindow) mainWindow.webContents.send('app:hide-to-tray'); } catch (e) {}
  try { if (mainWindow) mainWindow.hide(); } catch (e) {}
}

// Open download/update links in the user's default browser, not a child window.
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// Hand a stream to the user's default media player (External Player engine).
// shell.openExternal on an http URL would open the browser, so we write a tiny
// .m3u playlist and shell.openPath it — Windows launches whatever app is
// registered for .m3u (VLC / PotPlayer / MPC-HC, etc.). Returns {ok,error?}.
ipcMain.handle('open-in-player', async (_e, opts = {}) => {
  try {
    const url = opts && typeof opts.url === 'string' ? opts.url : '';
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid stream url' };
    const title = String(opts.title || 'Stream').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const file = path.join(require('os').tmpdir(), `ziptv-${Date.now()}.m3u`);
    fs.writeFileSync(file, `#EXTM3U\n#EXTINF:-1,${title}\n${url}\n`, 'utf8');
    const err = await shell.openPath(file); // '' on success, else error string
    return err ? { ok: false, error: err } : { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
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

// ---------------------------------------------------------------------------
// GPU / video overlay flags (must be set before app 'ready').
// NVIDIA/Intel/AMD driver video super-resolution only runs when the decoded
// video reaches a hardware (DirectComposition) overlay. Conservative GPU
// driver-bug workarounds and the blocklist can quietly disable that overlay
// path in a custom Chromium build, so we lift those. Chrome enables these by
// default; Electron does not always. Verify the result at chrome://gpu
// ("Direct composition: Enabled" + a video overlay format like NV12).
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
app.commandLine.appendSwitch('enable-features', 'DirectComposition,ZeroCopyVideoCapture');

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
    // Kill any ffmpeg children the in-process server spawned, so nothing is left
    // running after the app closes. The server sets this global (same process).
    try { if (globalThis.__ziptvKillChildren) globalThis.__ziptvKillChildren(); } catch (e) {}
    // Tear down the Cloudflare tunnel so cloudflared doesn't outlive the app.
    try { shutdownTunnel(); } catch (e) {}
  });

  // Backstop: also clean up right before the process exits, in case quit was
  // triggered by a path that skipped before-quit.
  app.on('will-quit', () => {
    try { if (globalThis.__ziptvKillChildren) globalThis.__ziptvKillChildren(); } catch (e) {}
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
  // The in-process server reads this to gate tunnel (phone) traffic.
  process.env.SHARE_TOKEN = SHARE_TOKEN;
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
  // Start hidden in the tray when "start minimized" is on, or when the OS
  // launched us at login with the --minimized arg. The renderer/server still
  // run so recordings work; the user opens the window from the tray.
  const startHidden = !!readStartup().startMinimized || process.argv.includes('--minimized');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'ZIPTV Pro',
    autoHideMenuBar: true,
    show: !startHidden,
    backgroundColor: '#070a13',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron', 'preload.cjs'),
      // Custom web tabs render sites in <webview> elements (isolated guest
      // processes on the persist:webtabs session).
      webviewTag: true
    }
  });

  // DevTools toggle. The renderer's TV/D-pad key handler (tv-navigation.js)
  // preventDefault()s almost every keydown, which swallows the menu accelerators
  // (Alt, Ctrl+Shift+I). before-input-event fires in the main process BEFORE the
  // renderer sees the key, so it can't be eaten. F12 (or Ctrl+Shift+I) toggles.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    // Ctrl+Shift+G: open chrome://gpu in a plain window to check whether the
    // hardware overlay path (needed for driver Video Super Resolution) is on.
    if (input.control && input.shift && key === 'g') {
      const gpuWin = new BrowserWindow({ width: 1000, height: 800, title: 'GPU status' });
      gpuWin.loadURL('chrome://gpu');
      event.preventDefault();
    }
  });

  // Web-tab hygiene: no window.open() popup chains from guest pages — open
  // target=_blank links in the same webview instead (like a single-tab browser).
  mainWindow.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) guest.loadURL(url);
      return { action: 'deny' };
    });
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
    // Phone-sharing over Cloudflare Quick Tunnel (opt-in from the UI).
    try {
      initTunnel({
        ipcMain,
        getWindow: () => mainWindow,
        getServerPort: () => serverPort,
        getToken: () => SHARE_TOKEN,
      });
    } catch (err) {
      console.error('[Electron] Tunnel init failed:', err);
    }
  }

  createTray();

  // ponytail: minimize prompt removed — minimize goes straight to taskbar (OS default).

  // Close to tray: the X hides the window and keeps the app running in the
  // background so scheduled/active recordings keep going. The app only truly
  // quits from the tray's right-click → Quit (which sets isQuitting via
  // before-quit). before-quit also kills the ffmpeg children.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      hideToTray(); // stop renderer playback, then hide — no ghost audio
    }
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

  // Push updater state to the renderer so the in-app UI can show a download
  // progress bar + a "Restart to update" prompt (see update-check.js
  // initElectronUpdaterUI). Replaces the old native message box.
  const sendUpdate = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data || {});
    }
  };

  autoUpdater.on('update-available', (info) => {
    sendUpdate('update:available', { version: info && info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    sendUpdate('update:progress', {
      percent: p ? p.percent : 0,
      transferred: p ? p.transferred : 0,
      total: p ? p.total : 0,
      bytesPerSecond: p ? p.bytesPerSecond : 0
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdate('update:downloaded', { version: info && info.version });
  });
  // Releases may not always carry updater metadata — never crash on that.
  autoUpdater.on('error', (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('[updater]', msg);
    sendUpdate('update:error', { message: msg });
  });

  // Renderer asks to install once the download is ready (Restart button).
  ipcMain.handle('update:install', () => {
    isQuitting = true;
    try { autoUpdater.quitAndInstall(); } catch (e) { console.error('[updater] install failed:', e); }
    return { success: true };
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
