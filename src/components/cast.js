/**
 * Renderer-side casting UI. Two backends:
 *  - Electron (PC): window.electronCast bridge → Node castv2/dlnacasts, casting a
 *    server-relative /cast path that the main process makes LAN-absolute.
 *  - Native phone (Android): the Cast Capacitor plugin → Google Cast SDK, casting
 *    the public provider URL directly (the receiver fetches it).
 *
 * Receivers can't play raw live MPEG-TS, so live is sent as HLS (m3u8); VOD is
 * passed through (mp4/mkv).
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { getStreamUrl } from './xtream-api.js';

const NativeCast = (() => {
  try {
    return (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') ? registerPlugin('Cast') : null;
  } catch (e) {
    return null;
  }
})();

let castCtx = null;        // { streamId, type, title, isLive, ext }
let devices = [];
let activeDeviceId = null;
let overlayEl = null;
let rescanTimer = null;
let castPaused = false;     // play/pause state of the active cast
let lastVolume = 1;         // remembered volume for mute toggle (0..1)
let statusPollTimer = null; // polls receiver position for the VOD seek bar

function getBackend() {
  if (window.electronCast && window.electronCast.available) return 'electron';
  if (NativeCast) return 'native';
  return null;
}

export function isCastAvailable() {
  return getBackend() !== null;
}

// --- Backend operations (dispatch to Electron or native plugin) -------------
async function backendList() {
  const b = getBackend();
  if (b === 'electron') return (await window.electronCast.list()) || [];
  if (b === 'native') { const r = await NativeCast.list(); return (r && r.devices) || []; }
  return [];
}

function backendOnDevices(cb) {
  const b = getBackend();
  if (b === 'electron') return window.electronCast.onDevices(cb);
  if (b === 'native') NativeCast.addListener('devices', (e) => cb((e && e.devices) || []));
}

async function backendPlay({ deviceId, path, mediaUrl, title, contentType, isLive }) {
  const b = getBackend();
  if (b === 'electron') return window.electronCast.play({ deviceId, path, title, contentType, isLive });
  if (b === 'native') return NativeCast.play({ deviceId, url: mediaUrl, title, contentType, isLive });
}

async function backendStop() {
  const b = getBackend();
  if (b === 'electron') return window.electronCast.control({ deviceId: activeDeviceId, action: 'stop' });
  if (b === 'native') return NativeCast.stop();
}

// Generic transport control (pause/resume/seek/volume) for the active cast.
// Best-effort and non-throwing — DLNA receivers vary in what they implement.
async function backendControl(action, value) {
  const b = getBackend();
  try {
    if (b === 'electron') return await window.electronCast.control({ deviceId: activeDeviceId, action, value });
    if (b === 'native' && NativeCast) {
      if (action === 'pause' && NativeCast.pause) return NativeCast.pause();
      if (action === 'resume' && NativeCast.resume) return NativeCast.resume();
      if (action === 'seek' && NativeCast.seek) return NativeCast.seek({ position: value });
      if (action === 'volume' && NativeCast.setVolume) return NativeCast.setVolume({ volume: value });
    }
  } catch (e) {
    console.warn('[cast] control failed:', action, e && e.message);
  }
}

// Best-effort playback status for the seek bar: { currentTime, duration, volume }.
async function backendStatus() {
  const b = getBackend();
  try {
    if (b === 'electron') return (await window.electronCast.status({ deviceId: activeDeviceId })) || {};
  } catch (e) {}
  return {};
}

// Called by the player whenever something starts playing, so the Cast button
// knows what to send. `ext` is the VOD container extension (mp4/mkv/…).
export function setCastContext(ctx) {
  castCtx = ctx;
  // If a cast is already active, follow the new selection to the TV instead of
  // letting it play locally (it just started in loadStream — stop it and recast).
  if (activeDeviceId && window.playerInstance) {
    window.playerInstance.stopLocalPlayback();
    castToDevice(activeDeviceId);
  }
}

export function initCastUI() {
  const btn = document.getElementById('player-cast-btn');
  if (!isCastAvailable()) {
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) {
    btn.style.display = '';
    btn.addEventListener('click', openCastPicker);
  }
  // Transport controls are the player's own #player-controls bar — the player
  // routes its play/pause, seek, volume, and skip to the TV while casting (see
  // window.castControls below). No separate cast control wiring needed here.

  // Push updates as new devices are discovered while the picker is open.
  backendOnDevices((list) => {
    devices = list || [];
    if (overlayEl) render();
  });

  // Listen to background notification controls on native Android
  if (NativeCast) {
    NativeCast.addListener('notificationAction', ({ action }) => {
      console.log('[cast] notification action received:', action);
      if (!action) return;
      if (action === 'com.iptv.player.zero.ACTION_STOP') {
        stopCasting();
      } else if (window.playerInstance) {
        if (action === 'com.iptv.player.zero.ACTION_NEXT') {
          if (window.playerInstance.onNextChannelCallback) {
            window.playerInstance.onNextChannelCallback();
          }
        } else if (action === 'com.iptv.player.zero.ACTION_PREV') {
          if (window.playerInstance.onPrevChannelCallback) {
            window.playerInstance.onPrevChannelCallback();
          }
        }
      }
    });
  }
}

async function openCastPicker() {
  if (!castCtx) {
    alert('Start playing a channel or title first, then cast it to your TV.');
    return;
  }
  buildOverlay();
  render();
  try {
    devices = await backendList();
    render();
  } catch (e) {
    console.error('[cast] device list failed:', e);
  }
  // mDNS/SSDP discovery is lossy — a single query often misses a device that
  // answers late or was asleep. Keep re-querying every few seconds while the
  // picker is open so devices reliably show up; backendOnDevices() pushes any
  // new ones into the list as they're found. Cleared in closeOverlay().
  clearInterval(rescanTimer);
  rescanTimer = setInterval(async () => {
    try { devices = await backendList(); render(); } catch (e) {}
  }, 2500);
}

function buildOverlay() {
  // The video container (not body) is what enters the browser Fullscreen API on
  // desktop, and a fullscreen element only renders its own descendants. Mount the
  // picker INTO the current fullscreen element so it isn't stuck behind the video
  // in fullscreen; fall back to body otherwise. appendChild moves it if needed.
  const parent = document.fullscreenElement || document.body;
  if (overlayEl) {
    if (overlayEl.parentElement !== parent) parent.appendChild(overlayEl);
    overlayEl.classList.remove('hidden');
    return;
  }
  overlayEl = document.createElement('div');
  overlayEl.className = 'cast-modal-overlay';
  overlayEl.innerHTML = `
    <div class="cast-modal">
      <div class="cast-modal-header">
        <span class="cast-modal-title"><i data-lucide="cast"></i> Cast to TV</span>
        <button class="cast-modal-close" title="Close"><i data-lucide="x"></i></button>
      </div>
      <div class="cast-status" id="cast-status"></div>
      <div class="cast-modal-body"></div>
      <div class="cast-modal-footer">
        <button class="cast-rescan-btn"><i data-lucide="refresh-cw"></i> Rescan</button>
        <button class="cast-stop-btn" style="display:none;"><i data-lucide="square"></i> Stop casting</button>
      </div>
    </div>`;
  parent.appendChild(overlayEl);

  overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closeOverlay(); });
  overlayEl.querySelector('.cast-modal-close').addEventListener('click', closeOverlay);
  overlayEl.querySelector('.cast-rescan-btn').addEventListener('click', async () => {
    setStatus('Scanning…');
    try { devices = await backendList(); } catch (e) {}
    setStatus('');
    render();
  });
  overlayEl.querySelector('.cast-stop-btn').addEventListener('click', stopCasting);

  if (window.lucide) lucide.createIcons({ scope: overlayEl });
}

function closeOverlay() {
  clearInterval(rescanTimer);
  rescanTimer = null;
  if (overlayEl) overlayEl.classList.add('hidden');
}

function setStatus(msg, isError) {
  const el = overlayEl && overlayEl.querySelector('#cast-status');
  if (el) {
    el.textContent = msg || '';
    el.style.display = msg ? 'block' : 'none';
    el.style.color = isError ? '#ff6b6b' : '#00f3ff';
  }
}

function render() {
  if (!overlayEl) return;
  const typeLabel = (t) => (t === 'chromecast' ? 'Chromecast / Android TV' : 'DLNA (Samsung, etc.)');
  const typeIcon = (t) => (t === 'chromecast' ? 'cast' : 'tv');

  let listHtml;
  if (!devices.length) {
    listHtml = `<div class="cast-empty"><div class="cast-spinner"></div>Searching for devices on your network…</div>`;
  } else {
    listHtml = devices.map((d) => `
      <button class="cast-device-row ${d.id === activeDeviceId ? 'active' : ''}" data-id="${d.id}">
        <i data-lucide="${typeIcon(d.type)}"></i>
        <span class="cast-device-name">${d.name}</span>
        <span class="cast-device-type">${typeLabel(d.type)}</span>
        ${d.id === activeDeviceId ? '<span class="cast-device-badge">Casting</span>' : ''}
      </button>`).join('');
  }
  overlayEl.querySelector('.cast-modal-body').innerHTML = `<div class="cast-device-list">${listHtml}</div>`;

  const stopBtn = overlayEl.querySelector('.cast-stop-btn');
  if (stopBtn) stopBtn.style.display = activeDeviceId ? '' : 'none';

  overlayEl.querySelectorAll('.cast-device-row').forEach((row) => {
    row.addEventListener('click', () => castToDevice(row.dataset.id));
  });

  if (window.lucide) lucide.createIcons({ scope: overlayEl });
}

const VOD_MIME = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  ts: 'video/mp2t'
};

// Build the media descriptor for the current stream, tuned to the receiver type.
// Uses the short /cast/<kind>/<id>.<ext> endpoint (clean, extension-bearing URL)
// instead of the long /api/proxy?url=… form, which Samsung DLNA truncates / can't
// type-sniff (→ UPnP 716). Chromecast plays HLS for live; DLNA gets MPEG-TS.
async function buildCastMedia(ctx, isDlna, isEShare) {
  // Native phone (Google Cast): cast the PUBLIC provider URL directly — the
  // Chromecast fetches it. Live → HLS; VOD → its container.
  if (getBackend() === 'native') {
    const useHls = ctx.isLive && (!isDlna || isEShare);
    const format = useHls ? 'm3u8' : (ctx.isLive ? 'ts' : '');
    const mediaUrl = await getStreamUrl(ctx.streamId, ctx.type, ctx.ext || '', format);
    const ext = (ctx.ext || 'mp4').toLowerCase();
    const contentType = useHls 
      ? 'application/x-mpegurl'
      : (ctx.isLive ? 'video/mpeg' : (VOD_MIME[ext] || 'video/mp4'));
    return { mediaUrl, contentType };
  }

  // Electron (PC): short /cast/<kind>/<id>.<ext> path served by the local proxy
  // (clean, extension-bearing URL). Chromecast → HLS for live; DLNA → MPEG-TS.
  const kind = ctx.type === 'movie' ? 'movie' : ctx.type === 'series' ? 'series' : 'live';
  let ext;
  let contentType;
  if (ctx.isLive) {
    // Chromecast plays HLS. For DLNA, real UPnP TVs (Samsung) need raw MPEG-TS,
    // but eShare-type renderers can't sustain raw live TS — they buffer forever —
    // and play HLS instead (mirrors the native/Android isEShare branch). Gate HLS
    // to eShare so the proven Samsung/Fire TV TS path is untouched.
    const useHls = !isDlna || isEShare;
    ext = useHls ? 'm3u8' : 'ts';
    contentType = useHls ? 'application/x-mpegurl' : 'video/mpeg';
  } else {
    ext = (ctx.ext || 'mp4').toLowerCase();
    contentType = VOD_MIME[ext] || 'video/mp4';
  }
  const path = `/cast/${kind}/${encodeURIComponent(ctx.streamId)}.${ext}`;
  return { path, contentType };
}

async function castToDevice(deviceId) {
  if (!castCtx) return;

  // Request notifications permission on Android 13+ if using native backend
  if (NativeCast && NativeCast.requestNotificationPermission) {
    try {
      await NativeCast.requestNotificationPermission();
    } catch (e) {
      console.warn('[cast] notification permission request failed:', e);
    }
  }

  const dev = devices.find((d) => d.id === deviceId);
  const name = (dev && dev.name) || 'device';
  const isDlna = !!(dev && dev.type === 'dlna');
  const isEShare = isDlna && /eshare/i.test(name);

  setStatus(`Connecting to ${name}…`);
  markRowBusy(deviceId, true);

  try {
    const { path, mediaUrl, contentType } = await buildCastMedia(castCtx, isDlna, isEShare);
    console.log('[cast] sending to', name, '|', contentType, '|', mediaUrl || path);

    // Don't let an unresponsive receiver hang the UI indefinitely.
    await withTimeout(
      backendPlay({
        deviceId,
        path,
        mediaUrl,
        title: castCtx.title || 'ZIPTV Pro',
        contentType,
        isLive: !!castCtx.isLive
      }),
      20000,
      `${name} didn't respond (is it on and on the same network?)`
    );

    activeDeviceId = deviceId;
    setStatus(`Casting to ${name}`);
    render();
    // Stop the duplicate local stream (the TV is playing it now) and show the
    // "Playing on TV" overlay, then close the picker.
    try {
      if (window.playerInstance) {
        window.playerInstance.stopLocalPlayback();
        window.playerInstance.setCastOverlayDevice(name);
      }
    } catch (e) {}
    refreshCastControls();
    closeOverlay();
  } catch (e) {
    console.error('[cast] play failed:', e);
    markRowBusy(deviceId, false);
    const hint = isDlna ? ' This TV may not support this stream over DLNA.' : '';
    setStatus(`Couldn't cast to ${name}: ${e.message || 'unknown error'}.${hint}`, true);
  }
}

function markRowBusy(deviceId, busy) {
  const row = overlayEl && overlayEl.querySelector(`.cast-device-row[data-id="${CSS.escape(deviceId)}"]`);
  if (row) row.classList.toggle('busy', busy);
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || 'Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function stopCasting() {
  if (!activeDeviceId) return;
  stopStatusPoll();
  try {
    await backendStop();
  } catch (e) {
    console.error('[cast] stop failed:', e);
  }
  activeDeviceId = null;
  castPaused = false;
  // Resume local playback and hide the "Playing on TV" overlay.
  try { if (window.playerInstance) window.playerInstance.resumeLocalPlayback(); } catch (e) {}
  render();
}

// --- Casting drives the real #player-controls bar ---------------------------
let castDuration = 0; // last known media duration (s), for seek-fraction → seconds

// Public API the player's control bar calls while a cast is active. The player
// checks castControls.isActive() in its own handlers and routes play/pause,
// seek, volume, mute, and stop here instead of touching the local <video>.
window.castControls = {
  isActive: () => !!activeDeviceId,
  playPause: () => { toggleCastPlayPause(); },
  // frac is 0..1 from the player's percentage seek bar.
  seekFraction: (frac) => {
    if (!activeDeviceId || !castDuration) return;
    const sec = Math.max(0, Math.min(castDuration, frac * castDuration));
    backendControl('seek', sec);
  },
  setVolume: (v) => {
    if (!activeDeviceId) return;
    const vol = Math.max(0, Math.min(1, v));
    if (vol > 0) lastVolume = vol;
    backendControl('volume', vol);
  },
  toggleMute: () => {
    if (!activeDeviceId) return;
    const slider = document.getElementById('player-volume-slider');
    const cur = slider ? Number(slider.value) : lastVolume;
    if (cur > 0) lastVolume = cur;
    const next = cur > 0 ? 0 : (lastVolume > 0 ? lastVolume : 1);
    if (slider) slider.value = String(next);
    backendControl('volume', next);
  },
  stop: () => { stopCasting(); },
};

// Configure the player bar for a freshly-started cast: reflect "playing" on the
// play/pause button and start the position poll (VOD only — live has no seek,
// and the bar's vod-only seek row is already hidden for live).
function refreshCastControls() {
  castPaused = false;
  castDuration = 0;
  try { if (window.playerInstance) window.playerInstance._setPlayPauseIcon(true); } catch (e) {}
  if (castCtx && castCtx.isLive) stopStatusPoll(); else startStatusPoll();
}

async function toggleCastPlayPause() {
  if (!activeDeviceId) return;
  castPaused = !castPaused;
  await backendControl(castPaused ? 'pause' : 'resume');
  try { if (window.playerInstance) window.playerInstance._setPlayPauseIcon(!castPaused); } catch (e) {}
}

function fmtTime(secs) {
  if (secs == null || !isFinite(secs) || secs < 0) return '0:00';
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Poll the receiver for VOD position/duration and update the player's own seek
// bar (#player-seek is a 0..100 percentage). Best-effort: if the device reports
// nothing the bar simply stays put. Skips updates while the user is scrubbing.
function startStatusPoll() {
  stopStatusPoll();
  statusPollTimer = setInterval(async () => {
    if (!activeDeviceId) return;
    if (window.playerInstance && window.playerInstance.isSeeking) return;
    const st = await backendStatus();
    if (st.duration && isFinite(st.duration)) castDuration = st.duration;
    const bar = document.getElementById('player-seek');
    const curEl = document.getElementById('player-time-current');
    const durEl = document.getElementById('player-time-duration');
    if (bar && castDuration && st.currentTime != null && isFinite(st.currentTime)) {
      bar.value = String(Math.min(100, (st.currentTime / castDuration) * 100));
    }
    if (curEl && st.currentTime != null) curEl.textContent = fmtTime(st.currentTime);
    if (durEl && castDuration) durEl.textContent = fmtTime(castDuration);
  }, 1000);
}

function stopStatusPoll() {
  if (statusPollTimer) { clearInterval(statusPollTimer); statusPollTimer = null; }
}
