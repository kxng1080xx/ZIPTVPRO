/**
 * Renderer-side casting UI (PC/Electron build only).
 *
 * Talks to the Electron main process via the `window.electronCast` preload bridge
 * to discover and drive Chromecast/Android-TV (Google Cast) and Samsung/DLNA
 * receivers. Absent on web/Android, where `window.electronCast` is undefined and
 * the Cast button stays hidden.
 *
 * Receivers fetch the media themselves and cannot play raw live MPEG-TS, so for
 * live channels we force the HLS (m3u8) variant; VOD is passed as-is (mp4/mkv).
 * The main process turns server-relative proxy paths into LAN-absolute URLs.
 */
import { getStreamUrl } from './xtream-api.js';

let castCtx = null;        // { streamId, type, title, isLive, ext }
let devices = [];
let activeDeviceId = null;
let overlayEl = null;

export function isCastAvailable() {
  return !!(window.electronCast && window.electronCast.available);
}

// Called by the player whenever something starts playing, so the Cast button
// knows what to send. `ext` is the VOD container extension (mp4/mkv/…).
export function setCastContext(ctx) {
  castCtx = ctx;
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
  // Push updates as new devices are discovered while the picker is open.
  window.electronCast.onDevices((list) => {
    devices = list || [];
    if (overlayEl) render();
  });
}

async function openCastPicker() {
  if (!castCtx) {
    alert('Start playing a channel or title first, then cast it to your TV.');
    return;
  }
  buildOverlay();
  render();
  try {
    devices = await window.electronCast.list();
    render();
  } catch (e) {
    console.error('[cast] device list failed:', e);
  }
}

function buildOverlay() {
  if (overlayEl) {
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
  document.body.appendChild(overlayEl);

  overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) closeOverlay(); });
  overlayEl.querySelector('.cast-modal-close').addEventListener('click', closeOverlay);
  overlayEl.querySelector('.cast-rescan-btn').addEventListener('click', async () => {
    setStatus('Scanning…');
    try { devices = await window.electronCast.list(); } catch (e) {}
    setStatus('');
    render();
  });
  overlayEl.querySelector('.cast-stop-btn').addEventListener('click', stopCasting);

  if (window.lucide) lucide.createIcons({ scope: overlayEl });
}

function closeOverlay() {
  if (overlayEl) overlayEl.classList.add('hidden');
}

function setStatus(msg) {
  const el = overlayEl && overlayEl.querySelector('#cast-status');
  if (el) {
    el.textContent = msg || '';
    el.style.display = msg ? '' : 'none';
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

// Build the LAN/HLS media descriptor for the current stream.
async function buildCastMedia(ctx) {
  // Receivers cannot play raw live MPEG-TS — force the HLS variant for live.
  const format = ctx.isLive ? 'm3u8' : '';
  const path = await getStreamUrl(ctx.streamId, ctx.type, ctx.ext || '', format);
  const isHls = ctx.isLive || /m3u8/i.test(path);
  const contentType = isHls ? 'application/x-mpegurl' : 'video/mp4';
  return { path, contentType };
}

async function castToDevice(deviceId) {
  if (!castCtx) return;
  setStatus('Preparing stream…');
  try {
    const { path, contentType } = await buildCastMedia(castCtx);
    await window.electronCast.play({
      deviceId,
      path,
      title: castCtx.title || 'ZIPTV Pro',
      contentType,
      isLive: !!castCtx.isLive
    });
    activeDeviceId = deviceId;
    setStatus('');
    render();
    // Mute local playback so the two audio streams don't overlap.
    try { window.playerInstance && window.playerInstance.video && (window.playerInstance.video.muted = true); } catch (e) {}
  } catch (e) {
    console.error('[cast] play failed:', e);
    setStatus(`Could not cast: ${e.message || 'unknown error'}`);
  }
}

async function stopCasting() {
  if (!activeDeviceId) return;
  try {
    await window.electronCast.control({ deviceId: activeDeviceId, action: 'stop' });
  } catch (e) {
    console.error('[cast] stop failed:', e);
  }
  activeDeviceId = null;
  try { window.playerInstance && window.playerInstance.video && (window.playerInstance.video.muted = false); } catch (e) {}
  render();
}
