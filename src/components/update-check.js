/**
 * Background update check. Fetches the published version manifest, compares it
 * to this build's version, and — if a newer one exists and the user hasn't
 * skipped it — shows an "update available" prompt with Cancel / Skip / Download.
 */

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

function openDownload(url) {
  // Electron: open in the system browser; otherwise a normal new tab / download.
  if (window.appHost && typeof window.appHost.openExternal === 'function') {
    window.appHost.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
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
  overlay.querySelector('[data-action="download"]').addEventListener('click', () => {
    openDownload(downloadUrlFor(manifest));
    close();
  });

  if (window.lucide) lucide.createIcons({ scope: overlay });
}
