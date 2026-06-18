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

const ApkInstaller = registerPlugin('ApkInstaller');

const VERSION_URL = 'https://ziptvpro.vercel.app/version.json';
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
  if (isWindowsDesktop) return manifest.exe || 'https://ziptvpro.vercel.app/latest.exe';
  return manifest.apk || 'https://ziptvpro.vercel.app/app.apk';
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
export async function downloadApp(url, onStatus) {
  if (isAndroidNative()) {
    if (onStatus) onStatus('Downloading update…');
    try {
      await ApkInstaller.downloadAndInstall({ url });
      return { ok: true };
    } catch (e) {
      const msg = (e && (e.message || e.errorMessage)) || String(e);
      if (msg.includes('NEEDS_PERMISSION')) return { ok: false, needsPermission: true };
      return { ok: false, error: msg };
    }
  }

  if (window.appHost && typeof window.appHost.openExternal === 'function') {
    window.appHost.openExternal(url); // Electron → system browser
  } else {
    window.open(url, '_blank'); // web
  }
  return { ok: true };
}

export async function checkForUpdate() {
  let manifest;
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    manifest = await res.json();
  } catch (e) {
    return; // offline / unreachable — silently skip
  }
  if (!manifest || !manifest.version) return;

  const remote = manifest.version;
  const local = localVersion();
  if (!isNewer(remote, local)) return;
  if (localStorage.getItem(SKIP_KEY) === remote) return; // user chose to skip this one

  showUpdateModal(remote, local, manifest);
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

  const close = () => overlay.remove();

  overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-action="skip"]').addEventListener('click', () => {
    try { localStorage.setItem(SKIP_KEY, remote); } catch (e) {}
    close();
  });
  overlay.querySelector('[data-action="download"]').addEventListener('click', async () => {
    const actions = overlay.querySelector('.update-modal-actions');
    const textEl = overlay.querySelector('.update-modal-text');
    const setText = (msg) => { if (textEl) textEl.textContent = msg; };

    // On Android, keep the modal up and show progress; the system installer
    // takes over on success. Elsewhere, just open the link and close.
    if (isAndroidNative()) {
      if (actions) actions.style.display = 'none';
      const res = await downloadApp(downloadUrlFor(manifest), setText);
      if (res.ok) {
        close();
      } else if (res.needsPermission) {
        setText('Allow "Install unknown apps" for ZIPTV Pro, then press Download again.');
        if (actions) actions.style.display = '';
      } else {
        setText(`Update failed: ${res.error || 'unknown error'}`);
        if (actions) actions.style.display = '';
      }
    } else {
      downloadApp(downloadUrlFor(manifest));
      close();
    }
  });

  if (window.lucide) lucide.createIcons({ scope: overlay });
}
