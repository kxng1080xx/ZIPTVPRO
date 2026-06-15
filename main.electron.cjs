const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function startExpressServer() {
  process.env.ELECTRON_RUNNING = 'true';
  process.env.PORT = '3000';
  
  // Since server/index.js is an ES Module, we import it dynamically in CommonJS
  import('./server/index.js')
    .then(() => {
      console.log('[Electron] In-process Express server initialized successfully.');
    })
    .catch((err) => {
      console.error('[Electron] Error initializing in-process Express server:', err);
    });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: '#070a13',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL('http://localhost:3000');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', () => {
  startExpressServer();
  // Wait 2 seconds for Express to boot up before opening the window
  setTimeout(createWindow, 2000);
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
