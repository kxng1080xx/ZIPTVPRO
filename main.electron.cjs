const { app, BrowserWindow } = require('electron');
const net = require('net');
const path = require('path');
const { initCast } = require('./electron/cast-manager.cjs');

let mainWindow;
let serverPort = 0;
let castInitialized = false;

// Only allow a single instance. A second launch would otherwise spin up another
// server and fight over the port, which is what caused the EADDRINUSE crash.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', async () => {
    await startExpressServer();
    createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
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
  try {
    await import('./server/index.js');
    console.log(`[Electron] In-process Express server starting on port ${serverPort}.`);
  } catch (err) {
    console.error('[Electron] Error initializing in-process Express server:', err);
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

  loadWhenServerReady();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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
