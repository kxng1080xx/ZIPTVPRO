/**
 * Cloudflare Quick-Tunnel manager (desktop only).
 *
 * Exposes THIS user's in-process server (the same one that serves the UI and the
 * /api/proxy stream proxy) to the internet on a private, per-launch URL like
 *   https://calm-river-1234.trycloudflare.com
 * so they can open their own library on a phone (Safari plays HLS natively, no
 * iOS app needed). Nothing is centrally public: the tunnel points only at THIS
 * machine's localhost, and requests that arrive through it must carry the
 * per-session share token (enforced in server/index.js) — so a leaked URL alone
 * is useless.
 *
 * Quick Tunnels need no Cloudflare account, no domain, no login — just the
 * bundled `cloudflared` binary. The trade-off: the hostname is random and
 * changes every launch, and Cloudflare's free tier isn't meant for heavy public
 * video, so this is a personal "watch my own stuff away from home" feature.
 *
 * The bandwidth rides the user's own home connection, so it never touches the
 * app's metered cloud host.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let child = null;          // the running cloudflared process
let tunnelUrl = '';        // https://xxxx.trycloudflare.com (bare, no token)
let wantRunning = false;   // desired state; drives auto-restart
let restartTimer = null;
let restartDelay = 1000;   // backoff, capped
let cfg = null;            // { getServerPort, getWindow, getToken }

const TRYCF_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

// Locate the cloudflared binary. Packaged: resources/bin (see package.json
// build.extraResources). Dev: extraResources/ next to the repo, else rely on a
// `cloudflared` already on PATH so `electron .` works without bundling.
function cloudflaredPath() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', exe) : null,
    path.join(__dirname, '..', 'extraResources', exe),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return exe; // fall back to PATH lookup
}

function send(channel, payload) {
  try {
    const win = cfg && cfg.getWindow && cfg.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload || {});
  } catch (e) {}
}

// The URL the user actually opens on their phone: bare tunnel URL + the share
// token as a query param. First load sets a cookie (server-side), so later
// requests (playlist, segments) are authorized automatically.
function shareUrl() {
  if (!tunnelUrl) return '';
  const token = cfg && cfg.getToken ? cfg.getToken() : '';
  return token ? `${tunnelUrl}/?t=${encodeURIComponent(token)}` : tunnelUrl;
}

function pushState() {
  send('tunnel:url', {
    running: !!child,
    connecting: wantRunning && !tunnelUrl,
    url: tunnelUrl,
    shareUrl: shareUrl(),
  });
}

function spawnTunnel() {
  const port = cfg.getServerPort();
  if (!port) { scheduleRestart(); return; }

  const bin = cloudflaredPath();
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--url', `http://127.0.0.1:${port}`,
  ];

  try {
    child = spawn(bin, args, { windowsHide: true });
  } catch (err) {
    console.error('[tunnel] spawn failed:', err && err.message ? err.message : err);
    send('tunnel:error', { message: `Could not start cloudflared: ${err && err.message ? err.message : err}` });
    scheduleRestart();
    return;
  }

  // cloudflared prints the assigned URL (and everything else) to stderr.
  const onData = (buf) => {
    const text = buf.toString();
    if (!tunnelUrl) {
      const m = text.match(TRYCF_RE);
      if (m) {
        tunnelUrl = m[0];
        restartDelay = 1000; // healthy connection — reset backoff
        console.log('[tunnel] up:', tunnelUrl);
        pushState();
      }
    }
  };
  if (child.stdout) child.stdout.on('data', onData);
  if (child.stderr) child.stderr.on('data', onData);

  child.on('exit', (code) => {
    console.log('[tunnel] cloudflared exited:', code);
    child = null;
    tunnelUrl = '';
    pushState();
    if (wantRunning) scheduleRestart();
  });

  child.on('error', (err) => {
    console.error('[tunnel] process error:', err && err.message ? err.message : err);
  });

  pushState(); // "connecting…"
}

function scheduleRestart() {
  if (!wantRunning || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (wantRunning && !child) spawnTunnel();
  }, restartDelay);
  restartDelay = Math.min(restartDelay * 2, 30000); // cap at 30s
}

function start() {
  wantRunning = true;
  if (!child) spawnTunnel();
  return getState();
}

function stop() {
  wantRunning = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) {
    try { child.kill(); } catch (e) {}
    child = null;
  }
  tunnelUrl = '';
  pushState();
  return getState();
}

function getState() {
  return {
    running: !!child,
    connecting: wantRunning && !tunnelUrl,
    url: tunnelUrl,
    shareUrl: shareUrl(),
  };
}

/**
 * Wire up IPC. Call once from the main process after the server port is known.
 * @param {object} opts
 * @param {() => number} opts.getServerPort  live server port
 * @param {() => BrowserWindow} opts.getWindow  current main window (for events)
 * @param {() => string} opts.getToken  the per-session share token
 * @param {object} opts.ipcMain  Electron ipcMain
 */
function initTunnel(opts) {
  cfg = opts;
  const { ipcMain } = opts;
  ipcMain.handle('tunnel:start', () => start());
  ipcMain.handle('tunnel:stop', () => stop());
  ipcMain.handle('tunnel:get', () => getState());
}

// Ensure cloudflared doesn't outlive the app.
function shutdown() { stop(); }

module.exports = { initTunnel, shutdown };
