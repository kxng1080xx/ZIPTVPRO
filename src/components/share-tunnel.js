/**
 * Share-to-phone panel (desktop/Electron only).
 *
 * Opens a Cloudflare Quick Tunnel to this machine's local server and shows the
 * resulting private URL with a Copy button. The user copies the link, sends it to
 * their phone, and watches their own library over their own home connection — no
 * iOS app, no central public server, nothing hitting the metered cloud host.
 *
 * Backed by window.appHost.share (see electron/preload.cjs). On the web/Android
 * build appHost.share is absent, so openShareTunnel() no-ops gracefully.
 */

let modalEl = null;
let unsub = null;
let lastState = { running: false, connecting: false, url: '', shareUrl: '' };

function hasShare() {
  return !!(window.appHost && window.appHost.share);
}

function render() {
  if (!modalEl) return;
  const s = lastState;
  const status = modalEl.querySelector('.st-status');
  const urlBox = modalEl.querySelector('.st-url');
  const toggle = modalEl.querySelector('.st-toggle');
  const copyBtn = modalEl.querySelector('.st-copy');

  if (s.shareUrl) {
    status.textContent = 'Live — copy this link and open it in Safari on your iPhone (keep this app open):';
    urlBox.textContent = s.shareUrl;
    urlBox.style.display = 'block';
    copyBtn.style.display = 'inline-block';
    toggle.textContent = 'Stop sharing';
  } else if (s.connecting) {
    status.textContent = 'Starting tunnel…';
    urlBox.style.display = 'none';
    copyBtn.style.display = 'none';
    toggle.textContent = 'Cancel';
  } else {
    status.textContent = 'Get a private link to watch on your iPhone. Your computer stays on and streams to it directly in Safari — no App Store needed.';
    urlBox.style.display = 'none';
    copyBtn.style.display = 'none';
    toggle.textContent = 'Start sharing';
  }
}

function buildModal() {
  const overlay = document.createElement('div');
  overlay.className = 'st-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999',
    'background:rgba(0,0,0,.6)', 'display:flex',
    'align-items:center', 'justify-content:center',
  ].join(';');

  overlay.innerHTML = `
    <div class="st-card" style="background:#0b0f1a;color:#e6e9f0;width:360px;max-width:92vw;
         border:1px solid #1e2740;border-radius:14px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.5);
         font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:16px">Watch on your iPhone</strong>
        <button class="st-close" aria-label="Close" style="background:none;border:none;color:#8b93a7;
                font-size:20px;cursor:pointer;line-height:1">×</button>
      </div>
      <p class="st-status" style="font-size:13px;color:#9aa3b8;margin:8px 0 14px"></p>
      <div class="st-url" style="display:none;word-break:break-all;font-size:13px;color:#7fb2ff;
           background:#0e1424;border:1px solid #1e2740;border-radius:8px;padding:10px;margin-bottom:12px;
           user-select:all;cursor:text"></div>
      <button class="st-copy" style="display:none;background:#2b6fff;color:#fff;border:none;
              border-radius:9px;padding:9px 18px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:12px">Copy link</button>
      <div>
        <button class="st-toggle" style="background:#182036;color:#cfd6e6;border:1px solid #263254;
                border-radius:9px;padding:9px 18px;font-size:14px;font-weight:600;cursor:pointer">Start sharing</button>
      </div>
      <p style="font-size:11px;color:#6b7488;margin:14px 0 0">Tip: in Safari, tap Share → <strong>Add to Home Screen</strong> for an app-like icon. Link is private to you and changes each time; streaming uses your own internet.</p>
    </div>`;

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.st-close').addEventListener('click', close);

  overlay.querySelector('.st-toggle').addEventListener('click', async () => {
    if (lastState.running || lastState.connecting) {
      lastState = await window.appHost.share.stop();
    } else {
      lastState = await window.appHost.share.start();
    }
    render();
  });

  overlay.querySelector('.st-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastState.shareUrl || '');
      const b = overlay.querySelector('.st-copy');
      const t = b.textContent; b.textContent = 'Copied!';
      setTimeout(() => { b.textContent = t; }, 1200);
    } catch (e) {}
  });

  return overlay;
}

/** Open the share panel. No-op on builds without appHost.share. */
export async function openShareTunnel() {
  if (!hasShare()) return;
  if (!modalEl) {
    modalEl = buildModal();
    document.body.appendChild(modalEl);
    // Live updates while the panel is open (tunnel comes up / drops / restarts).
    unsub = window.appHost.share.onChange((state) => {
      lastState = state;
      if (modalEl) render();
    });
  }
  modalEl.style.display = 'flex';
  try { lastState = await window.appHost.share.get(); } catch (e) {}
  render();
}

function close() {
  if (modalEl) modalEl.style.display = 'none';
}

/**
 * Optional: attach the panel to an existing trigger element by selector/id.
 * Returns true if wired. Safe to call on any build (no-ops without appHost).
 */
export function initShareTunnel(triggerSelector) {
  if (!hasShare()) return false;
  if (triggerSelector) {
    const el = document.querySelector(triggerSelector);
    if (el) el.addEventListener('click', openShareTunnel);
  }
  // Expose for quick wiring from other UI code / inline handlers.
  window.openShareTunnel = openShareTunnel;
  return true;
}

export default { initShareTunnel, openShareTunnel };
