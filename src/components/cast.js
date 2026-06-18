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
  // "Stop Casting" button on the player's casting overlay.
  const overlayStop = document.getElementById('cast-overlay-stop');
  if (overlayStop) overlayStop.addEventListener('click', stopCasting);

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
function buildCastMedia(ctx, isDlna) {
  const kind = ctx.type === 'movie' ? 'movie' : ctx.type === 'series' ? 'series' : 'live';
  let ext;
  let contentType;

  if (ctx.isLive) {
    ext = isDlna ? 'ts' : 'm3u8';
    // DLNA: advertise as the MPEG-TS profile the TV accepts (video/mpeg →
    // MPEG_TS_NA_ISO is applied server/DIDL side). Chromecast wants HLS.
    contentType = isDlna ? 'video/mpeg' : 'application/x-mpegurl';
  } else {
    ext = (ctx.ext || 'mp4').toLowerCase();
    contentType = VOD_MIME[ext] || 'video/mp4';
  }

  const path = `/cast/${kind}/${encodeURIComponent(ctx.streamId)}.${ext}`;
  return { path, contentType };
}

async function castToDevice(deviceId) {
  if (!castCtx) return;
  const dev = devices.find((d) => d.id === deviceId);
  const name = (dev && dev.name) || 'device';
  const isDlna = !!(dev && dev.type === 'dlna');

  setStatus(`Connecting to ${name}…`);
  markRowBusy(deviceId, true);

  try {
    const { path, contentType } = await buildCastMedia(castCtx, isDlna);
    console.log('[cast] sending to', name, '|', contentType, '|', path);

    // Don't let an unresponsive receiver hang the UI indefinitely.
    await withTimeout(
      window.electronCast.play({
        deviceId,
        path,
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
  try {
    await window.electronCast.control({ deviceId: activeDeviceId, action: 'stop' });
  } catch (e) {
    console.error('[cast] stop failed:', e);
  }
  activeDeviceId = null;
  // Resume local playback and hide the "Playing on TV" overlay.
  try { if (window.playerInstance) window.playerInstance.resumeLocalPlayback(); } catch (e) {}
  render();
}
