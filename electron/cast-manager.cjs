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
const http = require('http');
const { ipcMain } = require('electron');

// Quick reachability probe of a media URL from this host (the same address the
// TV is asked to use). Returns the HTTP status code, or 0 on failure/timeout.
function preflight(url) {
  return new Promise((resolve) => {
    try {
      const req = http.get(url, { timeout: 5000 }, (res) => {
        res.destroy();
        resolve(res.statusCode || 0);
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
    } catch (e) {
      resolve(0);
    }
  });
}

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

  // Samsung (and many renderers) reject media advertised with a bare
  // protocolInfo "http-get:*:<mime>:*" (→ UPnP 716). They require DLNA.ORG
  // flags describing transfer/seek capabilities. Inject sensible defaults
  // based on whether the stream is live (no seek) or VOD (byte-seek).
  const origLoad = MediaRenderer.prototype.load;
  MediaRenderer.prototype.load = function (url, options, callback) {
    if (options && typeof options === 'object' && !options.dlnaFeatures) {
      const ct = (options.contentType || '').toLowerCase();
      const FLAGS = 'ED100000000000000000000000000000'; // mirror Samsung's advertised flags
      // Use the DLNA.ORG_PN profiles the TV lists as sinks. Kept in sync with
      // the server's dlnaProfile() so the DIDL protocolInfo matches the actual
      // media response. video/mpeg = live MPEG-TS; video/mp4 = AVC MP4 VOD.
      if (ct.includes('mpeg') && !ct.includes('mpegurl')) {
        options.dlnaFeatures = `DLNA.ORG_PN=MPEG_TS_NA_ISO;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${FLAGS}`;
      } else if (ct.includes('mp4')) {
        options.dlnaFeatures = `DLNA.ORG_PN=AVC_MP4_MP_SD_AAC_MULT5;DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${FLAGS}`;
      } else {
        options.dlnaFeatures = 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';
      }
    }
    return origLoad.call(this, url, options, callback);
  };
} catch (e) {
  console.error('[cast] could not apply DLNA renderer shims:', e.message);
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

// Ask a DLNA renderer which protocolInfos it can sink (play). Returns a short
// summary of the video-capable entries so we can match its required profile.
function getDlnaSinks(player) {
  return new Promise((resolve) => {
    try {
      const client = player && player.client;
      if (!client || !client.callAction) return resolve('');
      client.callAction('ConnectionManager', 'GetProtocolInfo', {}, (err, res) => {
        if (err || !res || !res.Sink) return resolve('');
        const all = String(res.Sink).split(',');
        const video = all.filter((s) => /video/i.test(s));
        // Surface the profiles we care about: mp4 (VOD) and mpeg/ts (live).
        const mp4s = video.filter((s) => /mp4/i.test(s)).slice(0, 5);
        const tss = video.filter((s) => /mpeg|tts/i.test(s)).slice(0, 3);
        const pick = [...mp4s, ...tss].join('  ||  ') || (video.length ? video : all).slice(0, 8).join('  ||  ');
        resolve(pick);
      });
    } catch (e) {
      resolve('');
    }
  });
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

    // Preflight: confirm OUR server actually serves this URL on the IP we're
    // handing the TV. If this fails, the problem is our proxy/IP; if it succeeds
    // but the TV still reports 716, the TV simply can't reach us (firewall).
    const pre = await preflight(url);
    console.log(`[cast] preflight ${pre} for ${url}`);

    return new Promise((resolve, reject) => {
      // Guarantee the IPC handler always replies. Some "[Cast]" devices that
      // aren't real Google Cast receivers — notably Amazon Fire TV / Firestick
      // (model AFT*) — accept the TLS connection attempt but never complete the
      // cast, so the play callback never fires. Without this the handler would
      // hang and Electron reports "reply was never sent".
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

      const isFireTv = /\bAFT|fire\s*tv|firestick/i.test(d.name || '');
      const timer = setTimeout(() => {
        const hint = isFireTv
          ? `${d.name} looks like an Amazon Fire TV / Firestick, which can't receive casts (Amazon blocks Google Cast). Install the Android APK on it instead.`
          : `${d.name} didn't respond.`;
        finish(reject, new Error(hint));
      }, 15000);

      const done = (err) => {
        if (!err) return finish(resolve, { ok: true, url });
        const reason = err.message || err.code || 'play failed';
        if (d.type === 'dlna') {
          getDlnaSinks(d.player).then((sinks) => {
            finish(reject, new Error(`${reason} | server ${pre || 'no response'} | ${url} | TV-accepts: ${sinks || 'unknown'}`));
          });
        } else {
          finish(reject, new Error(`${reason} | server ${pre || 'no response'} | ${url}`));
        }
      };

      try {
        d.player.play(url, opts, done);
      } catch (err) {
        done(err);
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
