/**
 * Background update check. Fetches the published version manifest, compares it
 * to this build's version, and — if a newer one exists and the user hasn't
 * skipped it — shows an "update available" prompt with Cancel / Skip / Download.
 *
 * On Android (incl. Fire TV, whose browser can't install APKs) the Download
 * action downloads the APK in-app and launches the system installer via the
 * native ApkInstaller plugin. Elsewhere it opens the installer URL.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import navigation from './tv-navigation.js';

const ApkInstaller = registerPlugin('ApkInstaller');

const VERSION_URL = 'https://ziptvpro-nu.vercel.app/version.json';
const SKIP_KEY = 'skip_update_version';

// Compare dotted numeric versions: returns true if `a` is newer than `b`.
function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

function localVersion() {
  try {
    return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0';
  } catch (e) {
    return '0';
  }
}

// Pick the right installer for the platform.
function downloadUrlFor(manifest) {
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isWindowsDesktop = /Windows NT/i.test(ua) && !isAndroid;
  if (isWindowsDesktop) return manifest.exe || 'https://ziptvpro-nu.vercel.app/latest.exe';
  return manifest.apk || 'https://ziptvpro-nu.vercel.app/app.apk';
}

function isAndroidNative() {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch (e) {
    return false;
  }
}

// Download + install the app. On Android, do it in-app via the native installer
// (browser can't on Fire TV). On Electron, open the .exe link in the system
// browser. On plain web, open the link. Returns a small status object.
export async function downloadApp(url, onStatus, onProgress) {
  if (isAndroidNative()) {
    if (onStatus) onStatus('Downloading update…');
    let progressHandle = null;
    try {
      // Subscribe BEFORE starting so no early progress ticks are missed. The
      // native plugin emits { percent, downloaded, total } on this event.
      if (onProgress) {
        try {
          progressHandle = await ApkInstaller.addListener('downloadProgress', (d) => onProgress(d || {}));
        } catch (e) {}
      }
      await ApkInstaller.downloadAndInstall({ url });
      return { ok: true };
    } catch (e) {
      const msg = (e && (e.message || e.errorMessage)) || String(e);
      if (msg.includes('NEEDS_PERMISSION')) return { ok: false, needsPermission: true };
      return { ok: false, error: msg };
    } finally {
      try { if (progressHandle && progressHandle.remove) await progressHandle.remove(); } catch (e) {}
    }
  }

  if (window.appHost && typeof window.appHost.openExternal === 'function') {
    window.appHost.openExternal(url); // Electron → system browser
  } else {
    window.open(url, '_blank'); // web
  }
  return { ok: true };
}

// Background or manual update check. For a manual check (Settings button) we
// report status (incl. "you're on the latest version") and ignore a prior skip.
export async function checkForUpdate({ manual = false, onStatus } = {}) {
  const status = (m) => { if (manual && onStatus) onStatus(m); };
  status('Checking for updates…');

  let manifest;
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) { status('Could not check for updates.'); return; }
    manifest = await res.json();
  } catch (e) {
    status('Could not check for updates (offline?).');
    return;
  }
  if (!manifest || !manifest.version) { status('Could not check for updates.'); return; }

  const remote = manifest.version;
  const local = localVersion();
  if (!isNewer(remote, local)) {
    status(`You're on the latest version (v${local}).`);
    return;
  }
  // Background checks honour a skipped version; a manual check always prompts.
  if (!manual && localStorage.getItem(SKIP_KEY) === remote) return;
  status(`Update available: v${remote}`);
  showUpdateModal(remote, local, manifest);
}

// Periodic background check (used on Windows desktop: every launch + every 3h).
let periodicTimer = null;
export function startPeriodicUpdateCheck(intervalMs = 3 * 60 * 60 * 1000) {
  if (periodicTimer) return;
  periodicTimer = setInterval(() => { checkForUpdate(); }, intervalMs);
}

function showUpdateModal(remote, local, manifest) {
  if (document.getElementById('update-modal-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'update-modal-overlay';
  overlay.className = 'update-modal-overlay';
  overlay.innerHTML = `
    <div class="update-modal">
      <div class="update-modal-icon"><i data-lucide="arrow-up-circle"></i></div>
      <h2 class="update-modal-title">A new version is available</h2>
      <p class="update-modal-text">Version <strong>${remote}</strong> is available. You're on v${local}.</p>
      <div class="update-modal-actions">
        <button class="update-btn update-btn-ghost" data-action="cancel">Cancel</button>
        <button class="update-btn update-btn-ghost" data-action="skip">Skip this version</button>
        <button class="update-btn update-btn-primary" data-action="download"><i data-lucide="download"></i> Download</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let onKey = null;
  const close = () => {
    if (onKey) document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    try {
      if (navigation && navigation.restoreBackgroundFocus) {
        navigation.restoreBackgroundFocus();
      }
    } catch (e) {}
  };

  overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-action="skip"]').addEventListener('click', () => {
    try { localStorage.setItem(SKIP_KEY, remote); } catch (e) {}
    close();
  });
  overlay.querySelector('[data-action="download"]').addEventListener('click', async () => {
    const actions = overlay.querySelector('.update-modal-actions');
    const textEl = overlay.querySelector('.update-modal-text');
    const setText = (msg) => { if (textEl) textEl.textContent = msg; };

    // On Android, keep the modal up and show a live progress bar; the system
    // installer takes over on success. Elsewhere, just open the link and close.
    if (isAndroidNative()) {
      if (actions) actions.style.display = 'none';
      setText('Downloading update…');

      // Inject the progress bar (removed again if the download fails).
      const modal = overlay.querySelector('.update-modal');
      const prog = document.createElement('div');
      prog.className = 'update-progress indeterminate';
      prog.innerHTML = `
        <div class="update-progress-track"><div class="update-progress-fill"></div></div>
        <div class="update-progress-label">Starting…</div>`;
      if (modal) modal.appendChild(prog);
      const fill = prog.querySelector('.update-progress-fill');
      const label = prog.querySelector('.update-progress-label');

      const onProgress = (d) => {
        const pct = typeof d.percent === 'number' ? d.percent : -1;
        if (pct >= 0) {
          // Known size → determinate bar with a percentage.
          prog.classList.remove('indeterminate');
          if (fill) fill.style.width = `${pct}%`;
          if (label) label.textContent = `${pct}%`;
        } else {
          // Unknown size → keep the bar animating, show MB downloaded.
          prog.classList.add('indeterminate');
          const mb = d.downloaded ? (d.downloaded / 1048576).toFixed(1) : '0';
          if (label) label.textContent = `${mb} MB`;
        }
      };

      const res = await downloadApp(downloadUrlFor(manifest), setText, onProgress);
      if (res.ok) {
        if (fill) fill.style.width = '100%';
        if (label) label.textContent = 'Installing…';
        close();
      } else if (res.needsPermission) {
        prog.remove();
        setText('Allow "Install unknown apps" for ZIPTV Pro, then press Download again.');
        if (actions) actions.style.display = '';
      } else {
        prog.remove();
        setText(`Update failed: ${res.error || 'unknown error'}`);
        if (actions) actions.style.display = '';
      }
    } else {
      downloadApp(downloadUrlFor(manifest));
      close();
    }
  });

  if (window.lucide) lucide.createIcons({ scope: overlay });

  // Self-contained D-pad navigation (capture phase). The global TV-nav handler
  // for this modal has proven unreliable across versions, so the prompt drives
  // its own focus — guaranteed to work regardless of nav state/timing.
  const btns = Array.from(overlay.querySelectorAll('.update-btn'));
  let fIdx = btns.length - 1; // default to Download
  const focusBtn = (i) => {
    fIdx = Math.max(0, Math.min(btns.length - 1, i));
    btns.forEach((b) => b.classList.remove('tvk-focused'));
    const el = btns[fIdx];
    if (el) { el.classList.add('tvk-focused'); try { el.focus({ preventScroll: true }); } catch (e) {} }
  };
  onKey = (e) => {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape', 'Backspace'].includes(k)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (k === 'Escape' || k === 'Backspace') { close(); return; }
    if (k === 'Enter' || k === ' ') { if (btns[fIdx]) btns[fIdx].click(); return; }
    if (k === 'ArrowLeft' || k === 'ArrowUp') focusBtn(fIdx - 1);
    else if (k === 'ArrowRight' || k === 'ArrowDown') focusBtn(fIdx + 1);
  };
  document.addEventListener('keydown', onKey, true);
  focusBtn(fIdx);
}

// ---------------------------------------------------------------------------
// Desktop (Electron) auto-updater UI. electron-updater downloads in the
// background; this surfaces a small toast with a live progress bar and, when
// ready, a "Restart & update" button. Call once on boot in the Electron app.
// ---------------------------------------------------------------------------
function formatSpeed(bps) {
  if (!bps || bps <= 0) return '';
  const mb = bps / 1048576;
  if (mb >= 1) return ` · ${mb.toFixed(1)} MB/s`;
  return ` · ${(bps / 1024).toFixed(0)} KB/s`;
}

export function initElectronUpdaterUI() {
  if (!(window.appHost && typeof window.appHost.onUpdate === 'function')) return;

  let toast = null;
  const build = () => {
    if (toast) return toast;
    toast = document.createElement('div');
    toast.id = 'updater-toast';
    toast.className = 'updater-toast';
    toast.innerHTML = `
      <div class="updater-toast-row">
        <i data-lucide="arrow-up-circle"></i>
        <span class="updater-toast-title">Update available</span>
        <button class="updater-toast-close" aria-label="Dismiss">&times;</button>
      </div>
      <div class="updater-toast-text">Preparing download…</div>
      <div class="update-progress indeterminate">
        <div class="update-progress-track"><div class="update-progress-fill"></div></div>
        <div class="update-progress-label">0%</div>
      </div>
      <div class="updater-toast-actions" style="display:none">
        <button class="update-btn update-btn-primary" data-action="restart"><i data-lucide="refresh-cw"></i> Restart &amp; update</button>
        <button class="update-btn update-btn-ghost" data-action="later">Later</button>
      </div>`;
    document.body.appendChild(toast);
    if (window.lucide) { try { lucide.createIcons({ scope: toast }); } catch (e) {} }
    toast.querySelector('.updater-toast-close').addEventListener('click', () => { toast.remove(); toast = null; });
    toast.querySelector('[data-action="later"]').addEventListener('click', () => { toast.remove(); toast = null; });
    toast.querySelector('[data-action="restart"]').addEventListener('click', () => {
      try { window.appHost.installUpdate(); } catch (e) {}
    });
    return toast;
  };

  const setText = (t) => { const el = toast && toast.querySelector('.updater-toast-text'); if (el) el.textContent = t; };
  const setTitle = (t) => { const el = toast && toast.querySelector('.updater-toast-title'); if (el) el.textContent = t; };

  window.appHost.onUpdate((e) => {
    if (!e || !e.type) return;

    if (e.type === 'available') {
      build();
      setTitle(`Downloading update${e.version ? ' v' + e.version : ''}`);
      setText('Starting…');
    } else if (e.type === 'progress') {
      build();
      const prog = toast.querySelector('.update-progress');
      const fill = toast.querySelector('.update-progress-fill');
      const label = toast.querySelector('.update-progress-label');
      const pct = Math.max(0, Math.min(100, Math.round(e.percent || 0)));
      prog.classList.remove('indeterminate');
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = `${pct}%`;
      setText(`Downloading…${formatSpeed(e.bytesPerSecond)}`);
    } else if (e.type === 'downloaded') {
      build();
      setTitle('Update ready');
      setText(`Version ${e.version || ''} downloaded.`.trim());
      const fill = toast.querySelector('.update-progress-fill');
      const label = toast.querySelector('.update-progress-label');
      toast.querySelector('.update-progress').classList.remove('indeterminate');
      if (fill) fill.style.width = '100%';
      if (label) label.textContent = '100%';
      const actions = toast.querySelector('.updater-toast-actions');
      if (actions) actions.style.display = '';
    } else if (e.type === 'error') {
      // Stay quiet unless a download was already visibly in progress.
      if (toast) { setText('Update failed. It will retry later.'); }
    }
  });
}
