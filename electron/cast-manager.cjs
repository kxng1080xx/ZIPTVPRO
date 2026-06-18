/**
 * Electron-side casting manager (PC build).
 *
 * Discovers and controls media receivers directly over the local network from
 * the Node main process — we deliberately do NOT use the browser Google Cast
 * SDK because Electron's Chromium does not ship Chrome's Media Router, so that
 * SDK silently fails. Instead:
 *   - chromecasts: Google Cast (Chromecast / Android TV with Chromecast built-in)
 *   - dlnacasts:   DLNA/UPnP renderers (Samsung TVs, etc.)
 *
 * Both expose the same tiny player API: play(url, opts, cb) / pause / resume /
 * stop / seek and an 'update' event when a device appears.
 *
 * Receivers fetch the media URL themselves, so we hand them a LAN-reachable URL
 * (http://<lan-ip>:<serverPort>/...) rather than the localhost the renderer uses,
 * and the caller is responsible for forcing an HLS/MP4 URL (receivers cannot play
 * raw live MPEG-TS).
 */
const os = require('os');
const { ipcMain } = require('electron');

let chromecasts = null;
let dlnacasts = null;
try { chromecasts = require('chromecasts'); } catch (e) { console.error('[cast] chromecasts unavailable:', e.message); }
try { dlnacasts = require('dlnacasts'); } catch (e) { console.error('[cast] dlnacasts unavailable:', e.message); }

// --- DLNA compatibility shim -------------------------------------------------
// Many renderers (notably Samsung TVs) implement ConnectionManager's optional
// PrepareForConnection action but then reject it — UPnP error 701 "incompatible
// protocol info" or 704 "local restrictions" — and upnp-mediarenderer-client
// treats that as fatal, so nothing ever plays. Mainstream DLNA controllers
// (BubbleUPnP, etc.) skip PrepareForConnection and just drive the default
// connection (InstanceID 0). Short-circuit it so the client proceeds straight
// to SetAVTransportURI. Only affects DLNA; Chromecast uses a different stack.
try {
  const MediaRenderer = require('upnp-mediarenderer-client');
  const origCallAction = MediaRenderer.prototype.callAction;
  MediaRenderer.prototype.callAction = function (service, action, params, cb) {
    if (service === 'ConnectionManager' && action === 'PrepareForConnection') {
      // ENOACTION is the client's "not implemented" signal → it then keeps
      // the default InstanceID 0 and continues.
      return cb({ code: 'ENOACTION' });
    }
    return origCallAction.call(this, service, action, params, cb);
  };
} catch (e) {
  console.error('[cast] could not apply DLNA PrepareForConnection shim:', e.message);
}

const devices = new Map(); // id -> { id, name, type, player }

function makeId(type, player) {
  return `${type}:${player.name || 'device'}:${player.host || ''}`;
}

// All non-internal IPv4 addresses on this host.
function localIpv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

// Pick the local IPv4 the receiver can actually reach. A PC often has several
// adapters (VPN, Hyper-V, VMware, WSL) whose IPs aren't on the TV's network, so
// when we know the receiver's host we prefer our address on the same /24 subnet
// — otherwise the TV reports "resource not found" (UPnP 716) fetching the media.
function lanIpFor(deviceHost) {
  const ips = localIpv4s();
  if (deviceHost && /^\d+\.\d+\.\d+\.\d+$/.test(deviceHost)) {
    const prefix = deviceHost.split('.').slice(0, 3).join('.') + '.';
    const sameSubnet = ips.find((ip) => ip.startsWith(prefix));
    if (sameSubnet) return sameSubnet;
  }
  return ips[0] || '127.0.0.1';
}

function initCast({ getWindow, getServerPort }) {
  let cc = null;
  let dl = null;
  try { if (chromecasts) cc = chromecasts(); } catch (e) { console.error('[cast] chromecasts init failed:', e.message); }
  try { if (dlnacasts) dl = dlnacasts(); } catch (e) { console.error('[cast] dlnacasts init failed:', e.message); }

  function sendDevices() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const list = [...devices.values()].map((d) => ({ id: d.id, name: d.name, type: d.type }));
    win.webContents.send('cast:devices', list);
  }

  const register = (type) => (player) => {
    const id = makeId(type, player);
    devices.set(id, { id, name: player.name || 'Unknown device', type, player });
    console.log(`[cast] discovered ${type}: ${player.name} @ ${player.host}`);
    sendDevices();
  };

  if (cc) cc.on('update', register('chromecast'));
  if (dl) dl.on('update', register('dlna'));

  function baseUrlFor(deviceHost) {
    return `http://${lanIpFor(deviceHost)}:${getServerPort()}`;
  }

  function rescan() {
    try { if (cc && cc.update) cc.update(); } catch (e) {}
    try { if (dl && dl.update) dl.update(); } catch (e) {}
  }

  function currentList() {
    return [...devices.values()].map((d) => ({ id: d.id, name: d.name, type: d.type }));
  }

  ipcMain.handle('cast:list', () => {
    rescan();
    return currentList();
  });

  ipcMain.handle('cast:play', async (_e, { deviceId, path, title, contentType, isLive }) => {
    const d = devices.get(deviceId);
    if (!d) throw new Error('Cast device not found (try rescanning)');

    // Renderer passes a server-relative path (/api/...) or an absolute URL.
    // Relative paths must be made LAN-absolute (on the receiver's own subnet)
    // so the device can fetch them.
    let url = path;
    if (typeof path === 'string' && path.startsWith('/')) url = baseUrlFor(d.player.host) + path;
    console.log(`[cast] play -> ${d.name} (${d.player.host}) : ${url}`);

    const opts = {
      title: title || 'ZIPTV Pro',
      type: contentType || 'video/mp4'
    };
    if (isLive) opts.streamType = 'LIVE';

    return new Promise((resolve, reject) => {
      try {
        d.player.play(url, opts, (err) => (err ? reject(err) : resolve({ ok: true, url })));
      } catch (err) {
        reject(err);
      }
    });
  });

  ipcMain.handle('cast:control', async (_e, { deviceId, action, value }) => {
    const d = devices.get(deviceId);
    if (!d) throw new Error('Cast device not found');
    return new Promise((resolve, reject) => {
      const cb = (err) => (err ? reject(err) : resolve({ ok: true }));
      try {
        switch (action) {
          case 'pause': return d.player.pause(cb);
          case 'resume': return d.player.resume(cb);
          case 'stop': return d.player.stop(cb);
          case 'seek': return d.player.seek(value, cb);
          default: return reject(new Error(`Unknown cast action: ${action}`));
        }
      } catch (err) {
        reject(err);
      }
    });
  });

  // Initial scan kick.
  rescan();
}

module.exports = { initCast };
