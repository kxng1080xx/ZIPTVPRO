/**
 * "About" info — one source of truth for both shells.
 *
 * The PC settings modal and the TV shell's settings popout render this same
 * data, so the version, device code and support contact can never drift apart
 * between the two interfaces.
 */
import { getDeviceCode, detectPlatform } from './cloud-sync.js';

export const DEVELOPER = {
  name: 'Leon Goulbourne',
  email: 'legoulbourne@gmail.com',
  phone: '876 467 9006'
};

const PLATFORM_LABEL = {
  pc: 'Windows (Desktop)',
  apk: 'Android',
  web: 'Web'
};

/** App/device facts, as label/value rows ready to render. */
export function getAboutRows() {
  const version = (typeof __APP_VERSION__ !== 'undefined') ? __APP_VERSION__ : '—';
  const platform = detectPlatform();
  const rows = [
    { label: 'Version', value: version },
    { label: 'Platform', value: PLATFORM_LABEL[platform] || 'Unknown' },
    { label: 'Interface', value: interfaceLabel() }
  ];
  // The device code is what support needs to look an install up, so it belongs
  // here rather than only in the pairing flow.
  try {
    const code = getDeviceCode();
    if (code) rows.push({ label: 'Device code', value: code });
  } catch (e) {}
  return rows;
}

function interfaceLabel() {
  if (document.body.classList.contains('tv-layout') || document.getElementById('tvn-root')) return 'TV (10-foot)';
  if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) return 'Mobile';
  return 'Desktop';
}
