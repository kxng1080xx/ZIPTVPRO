/**
 * Electron-side casting manager (PC build) — DLNA + Chromecast.
 * =============================================================
 *
 * Casting from Electron does NOT use the browser Google Cast SDK: Electron's
 * Chromium ships without Chrome's Media Router, so that SDK silently no-ops.
 * Instead we drive receivers directly from the Node main process:
 *
 *   - chromecasts : Google Cast (Chromecast / Android TV / Chromecast built-in)
 *   - dlnacasts   : DLNA / UPnP renderers (Samsung & LG TVs, eShare, Fire TV
 *                   DLNA apps, etc.)
 *
 * Both libraries expose the same tiny player API — play(url, opts, cb) / pause /
 * resume / stop / seek — and emit an 'update' event when a device is found.
 *
 * Receivers FETCH the media themselves, so we hand them a LAN-reachable URL
 * (http://<lan-ip>:<serverPort>/cast/...), never the renderer's localhost. The
 * renderer (src/components/cast.js) decides the format per receiver:
 *   - Samsung / generic DLNA : raw MPEG-TS for live (video/mpeg)
 *   - Chromecast / eShare    : HLS (m3u8) for live
 *   - VOD                    : the container itself (mp4/mkv/…)
 *
 * ── Samsung / DLNA compatibility (hard-won — DO NOT loosen) ──────────────────
 * Samsung TVs are strict UPnP renderers. Two things must hold or playback fails
 * with UPnP 701/704/716 and the picture never starts:
 *   1. ConnectionManager::PrepareForConnection must be short-circuited (Samsung
 *      advertises it but rejects it). See the MediaRenderer shim below.
 *   2. The media must carry DLNA.ORG flags describing transfer/seek caps, and
 *      those flags must match the HTTP response the server returns. The flag
 *      string + MPEG_TS_NA_ISO profile here are mirrored in server/index.js
 *      dlnaProfile(); keep the two in sync.
 */

'use strict';

const os = require('os');
const http = require('http');
const { ipcMain } = require('electron');

// ── DLNA flag constants (mirror server/index.js dlnaProfile) ────────────────
// Samsung advertises exactly these FLAGS; advertising the same value back is
// what finally made Samsung accept our streams. Do not change without testing
// on a real Samsung TV.
const DLNA_FLAGS = 'ED100000000000000000000000000000';
// Live MPEG-TS: generic transport-stream profile, no seek (OP=00). Samsung plays
// the H.264 inside this profile.
const DLNA_FEATURES_LIVE_TS = `DLNA.ORG_PN=MPEG_TS_NA_ISO;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`;
// VOD / HLS: no DLNA.ORG_PN (a wrong PN makes strict TVs reject as "file not
// supported"); byte-seek for VOD files (OP=01).
const DLNA_FEATURES_DEFAULT = `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FLAGS}`;

// ── Cast libraries (optional — log, never throw, if unavailable) ─────────────
let chromecasts = null;
let dlnacasts = null;
try { chromecasts = require('chromecasts'); } catch (e) { console.error('[cast] chromecasts unavailable:', e.message); }
try { dlnacasts = require('dlnacasts'); } catch (e) { console.error('[cast] dlnacasts unavailable:', e.message); }

// ── Samsung / DLNA renderer shims (applied once to upnp-mediarenderer-client) ─
applyDlnaRendererShims();

function applyDlnaRendererShims() {
  let MediaRenderer;
  try {
    MediaRenderer = require('upnp-mediarenderer-client');
  } catch (e) {
    console.error('[cast] could not load upnp-mediarenderer-client for shims:', e.message);
    return;
  }

  // (1) PrepareForConnection short-circuit.
  // Many renderers (notably Samsung) implement ConnectionManager's optional
  // PrepareForConnection action but then reject it (UPnP 701 "incompatible
  // protocol info" / 704 "local restrictions"), and the client treats that as
  // fatal so nothing ever plays. Mainstream controllers (BubbleUPnP, etc.) skip
  // it and drive the default connection (InstanceID 0). Returning ENOACTION is
  // the client's "not implemented" signal → it keeps InstanceID 0 and proceeds
  // straight to SetAVTransportURI.
  if (!MediaRenderer.__ziptvPrepShim) {
    const origCallAction = MediaRenderer.prototype.callAction;
    MediaRenderer.prototype.callAction = function (service, action, params, cb) {
      if (service === 'ConnectionManager' && action === 'PrepareForConnection') {
        return cb({ code: 'ENOACTION' });
      }
      return origCallAction.call(this, service, action, params, cb);
    };
    MediaRenderer.__ziptvPrepShim = true;
  }

  // (2) Inject DLNA.ORG features on load().
  // Samsung (and many renderers) reject media advertised with a bare
  // protocolInfo "http-get:*:<mime>:*" (→ UPnP 716). They require DLNA.ORG flags
  // describing transfer/seek capabilities. Inject sensible defaults based on
  // whether the stream is live MPEG-TS (no seek) or VOD/HLS (byte-seek), unless
  // the caller already supplied dlnaFeatures.
  if (!MediaRenderer.__ziptvLoadShim) {
    const origLoad = MediaRenderer.prototype.load;
    MediaRenderer.prototype.load = function (url, options, callback) {
      if (options && typeof options === 'object' && !options.dlnaFeatures) {
        const ct = (options.contentType || '').toLowerCase();
        // Live MPEG-TS only (video/mpeg, but NOT application/x-mpegurl HLS).
        if (ct.includes('mpeg') && !ct.includes('mpegurl')) {
          options.dlnaFeatures = DLNA_FEATURES_LIVE_TS;
        } else {
          options.dlnaFeatures = DLNA_FEATURES_DEFAULT;
        }
      }
      return origLoad.call(this, url, options, callback);
    };
    MediaRenderer.__ziptvLoadShim = true;
  }
}

// ── Network address selection ───────────────────────────────────────────────
// Adapter-name patterns for virtual/software/VPN interfaces whose IPs a TV on
// the real LAN cannot reach. Kept in sync with server/index.js
// getLocalIpAddresses(). Without this, a dev box with Android tooling / WSL /
// Hyper-V hands the TV a virtual-switch IP and the receiver reports UPnP 716.
const VIRTUAL_PATTERNS = [
  /vethernet/i, /vmware/i, /virtualbox/i, /vbox/i, /docker/i, /wsl/i,
  /loopback/i, /pseudo/i, /teredo/i, /isatap/i, /6to4/i,
  /\btap\b/i, /openvpn/i, /nordvpn/i, /expressvpn/i, /protonvpn/i, /mullvad/i,
  /wireguard/i, /tailscale/i, /zerotier/i, /anyconnect/i, /globalprotect/i,
  /pulse.?secure/i, /fortinet/i, /forticlient/i, /checkpoint/i, /sonicwall/i,
  /citrix/i, /pulsevpn/i, /cloudflare/i, /warp/i, /vpn/i,
];

// Higher = more likely a real LAN address the TV can reach.
function lanScore(ip) {
  if (/^192\.168\./.test(ip)) return 3;                  // home / office LAN
  if (/^10\./.test(ip)) return 2;                        // corporate LAN
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;   // RFC-1918 range B
  return 0;                                              // unknown / VPN tunnel
}

// Real-LAN IPv4 addresses on this host, best first. Skips virtual/VPN adapters
// by name and ranks the rest by LAN range; drops non-LAN (score 0) IPs unless
// nothing else exists (graceful fallback).
function localIpv4s() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    if (VIRTUAL_PATTERNS.some((re) => re.test(name))) continue;
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push({ ip: iface.address, score: lanScore(iface.address) });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const lanOnly = candidates.filter((c) => c.score > 0);
  return (lanOnly.length ? lanOnly : candidates).map((c) => c.ip);
}

// Pick the local IPv4 the receiver can actually reach. When we know the device's
// host we prefer our address on the same /24 subnet; otherwise the best-ranked
// real-LAN IP (localIpv4s already filtered out virtual/VPN adapters).
function lanIpFor(deviceHost) {
  const ips = localIpv4s();
  if (deviceHost && /^\d+\.\d+\.\d+\.\d+$/.test(deviceHost)) {
    const prefix = deviceHost.split('.').slice(0, 3).join('.') + '.';
    const sameSubnet = ips.find((ip) => ip.startsWith(prefix));
    if (sameSubnet) return sameSubnet;
  }
  return ips[0] || '127.0.0.1';
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// Quick reachability probe of a media URL from this host (the same address the
// TV is asked to use). Returns the HTTP status code, or 0 on failure/timeout.
// Lets us distinguish "our server isn't serving" from "the TV can't reach us".
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

// Ask a DLNA renderer which protocolInfos it can sink (play). Returns a short
// summary of the video-capable entries — surfaced in error messages so a failed
// cast tells us what the TV actually accepts.
function getDlnaSinks(player) {
  return new Promise((resolve) => {
    try {
      const client = player && player.client;
      if (!client || !client.callAction) return resolve('');
      client.callAction('ConnectionManager', 'GetProtocolInfo', {}, (err, res) => {
        if (err || !res || !res.Sink) return resolve('');
        const all = String(res.Sink).split(',');
        const video = all.filter((s) => /video/i.test(s));
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

// Parse a DLNA time string ("H:MM:SS" / "HH:MM:SS.mmm") to seconds. Returns null
// for empty / NOT_IMPLEMENTED / unparseable values.
function parseDlnaTime(s) {
  if (!s || typeof s !== 'string' || /not_implemented/i.test(s)) return null;
  const parts = s.trim().split(':').map((p) => parseFloat(p));
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Number.isFinite(sec) ? sec : null;
}

// Ask a DLNA renderer for the current track position + duration via AVTransport
// GetPositionInfo. Drives the VOD seek bar. Best-effort: {} if the renderer
// doesn't implement it (some basic apps report 0:00:00 / NOT_IMPLEMENTED).
function dlnaPositionInfo(player) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    setTimeout(() => done({}), 4000);
    try {
      const client = player && player.client;
      if (!client || !client.callAction) return done({});
      client.callAction('AVTransport', 'GetPositionInfo', { InstanceID: 0 }, (err, res) => {
        if (err || !res) return done({});
        done({
          currentTime: parseDlnaTime(res.RelTime != null ? res.RelTime : res.AbsTime),
          duration: parseDlnaTime(res.TrackDuration),
        });
      });
    } catch (e) {
      done({});
    }
  });
}

// A "[Cast]"-named or AFT* device is usually an Amazon Fire TV / Firestick,
// which accepts the TLS connection but never completes a Google Cast session
// (Amazon blocks Cast). Detect it to give an actionable error instead of a hang.
function isFireTvName(name) {
  return /\bAFT|fire\s*tv|firestick/i.test(name || '');
}

// ── Device registry ─────────────────────────────────────────────────────────
const devices = new Map(); // id -> { id, name, type, player }

function makeId(type, player) {
  return `${type}:${player.name || 'device'}:${player.host || ''}`;
}

// Device shape exposed to the renderer over IPC (must stay stable — the renderer
// UI and cast.js depend on { id, name, type }).
function publicDevice(d) {
  return { id: d.id, name: d.name, type: d.type };
}

// ── Public entry point ──────────────────────────────────────────────────────
function initCast({ getWindow, getServerPort }) {
  let cc = null;
  let dl = null;
  try { if (chromecasts) cc = chromecasts(); } catch (e) { console.error('[cast] chromecasts init failed:', e.message); }
  try { if (dlnacasts) dl = dlnacasts(); } catch (e) { console.error('[cast] dlnacasts init failed:', e.message); }

  function pushDevices() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('cast:devices', [...devices.values()].map(publicDevice));
  }

  const register = (type) => (player) => {
    const id = makeId(type, player);
    devices.set(id, { id, name: player.name || 'Unknown device', type, player });
    console.log(`[cast] discovered ${type}: ${player.name} @ ${player.host}`);
    pushDevices();
  };

  if (cc) cc.on('update', register('chromecast'));
  if (dl) dl.on('update', register('dlna'));

  const baseUrlFor = (deviceHost) => `http://${lanIpFor(deviceHost)}:${getServerPort()}`;

  function rescan() {
    try { if (cc && cc.update) cc.update(); } catch (e) {}
    try { if (dl && dl.update) dl.update(); } catch (e) {}
  }

  // ── IPC: list devices (with a rescan kick) ────────────────────────────────
  ipcMain.handle('cast:list', () => {
    rescan();
    return [...devices.values()].map(publicDevice);
  });

  // ── IPC: play on a device ─────────────────────────────────────────────────
  // opts: { deviceId, path, title, contentType, isLive }
  //  - `path` is a server-relative /cast/... path (made LAN-absolute here) or an
  //    already-absolute URL.
  //  - `contentType` drives both the player opts and (via the load() shim) the
  //    DLNA.ORG features advertised to Samsung.
  ipcMain.handle('cast:play', async (_e, { deviceId, path, title, contentType, isLive }) => {
    const d = devices.get(deviceId);
    if (!d) throw new Error('Cast device not found (try rescanning)');

    let url = path;
    if (typeof path === 'string' && path.startsWith('/')) url = baseUrlFor(d.player.host) + path;
    console.log(`[cast] play -> ${d.name} (${d.player.host}) : ${url}`);

    const opts = { title: title || 'ZIPTV Pro', type: contentType || 'video/mp4' };
    if (isLive) opts.streamType = 'LIVE';

    // Confirm OUR server serves this URL on the IP we hand the TV. If preflight
    // fails, the problem is our proxy/IP; if it succeeds but the TV still 716s,
    // the TV can't reach us (firewall / wrong subnet).
    const pre = await preflight(url);
    console.log(`[cast] preflight ${pre} for ${url}`);

    return new Promise((resolve, reject) => {
      // Guarantee the IPC handler always settles. Some "[Cast]" devices (Fire TV)
      // accept the connection but never fire the play callback; without this the
      // handler hangs and Electron logs "reply was never sent".
      let settled = false;
      const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

      const fireTv = isFireTvName(d.name);
      const timer = setTimeout(() => {
        const hint = fireTv
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

  // ── IPC: transport control ────────────────────────────────────────────────
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
          // volume is 0..1. Not every receiver implements it — resolve quietly
          // (rather than reject) if the player lacks the method, so the UI slider
          // doesn't surface an error on unsupported devices.
          case 'volume':
            if (typeof d.player.volume !== 'function') return resolve({ ok: false, unsupported: true });
            return d.player.volume(value, cb);
          default: return reject(new Error(`Unknown cast action: ${action}`));
        }
      } catch (err) {
        reject(err);
      }
    });
  });

  // ── IPC: playback status (for the VOD seek bar) ───────────────────────────
  // Best-effort: returns { currentTime, duration, volume } or {} if the receiver
  // doesn't report it. DLNA and Chromecast expose position very differently:
  //   - DLNA  : query the renderer's AVTransport GetPositionInfo (TrackDuration /
  //             RelTime are "H:MM:SS" strings). This is how Samsung/Fire-TV apps
  //             report position — they have no chromecasts-style .status().
  //   - Cast  : the player exposes .status(cb) with currentTime + media.duration.
  ipcMain.handle('cast:status', async (_e, { deviceId }) => {
    const d = devices.get(deviceId);
    if (!d || !d.player) return {};

    if (d.type === 'dlna') return dlnaPositionInfo(d.player);

    if (typeof d.player.status === 'function') {
      return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        setTimeout(() => done({}), 4000);
        try {
          d.player.status((err, status) => {
            if (err || !status) return done({});
            const currentTime = status.currentTime != null ? status.currentTime
              : (status.position != null ? status.position : null);
            const duration = (status.media && status.media.duration != null) ? status.media.duration
              : (status.duration != null ? status.duration : null);
            const volume = (status.volume && status.volume.level != null) ? status.volume.level
              : (typeof status.volume === 'number' ? status.volume : null);
            done({ currentTime, duration, volume });
          });
        } catch (e) {
          done({});
        }
      });
    }
    return {};
  });

  // Initial discovery kick.
  rescan();
}

module.exports = { initCast };
