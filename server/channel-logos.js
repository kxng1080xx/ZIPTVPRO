// Fills missing live-channel logos from the iptv-org index baked into
// public/channel-logos.json (see scripts/build-channel-logos.mjs).
// Pure ESM with no Node/DOM imports: shared by the client sync (xtream-api.js)
// and the desktop server sync (server/index.js).

const COUNTRY_ALIAS = { uk: 'gb', usa: 'us', can: 'ca', aus: 'au', eng: 'gb', uae: 'ae' };

// "US: CNN HD" -> { name: 'cnn', cc: 'us' }. Also used by the build script, so
// index keys and lookup keys are always normalized the same way.
export function logoKey(raw) {
  let s = String(raw || '').toLowerCase();
  let cc = '';
  // Leading tags: "US:", "[UK]", "|AR|", "USA -", "PM : CA ..." (a few passes, tags stack).
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^\W*([a-z]{2,3})\W*(?:[:|\]]|\s[-–—])\s*/);
    if (!m) break;
    cc = COUNTRY_ALIAS[m[1]] || m[1];
    s = s.slice(m[0].length);
  }
  const name = s
    .replace(/\((?:[^)]*)\)|\[[^\]]*\]/g, ' ')                    // "(backup)", "[geo]"
    .replace(/\b(?:f?hd|uhd|sd|4k|8k|hevc|h\.?26[45]|\d{3,4}p|raw|backup|vip)\b/g, ' ')
    .replace(/[^a-z0-9+]/g, '');
  return { name, cc: cc.length === 2 ? cc : '' };
}

// index: { urls: [..], ids: { lowercased iptv-org id: urlIdx }, names: { key | key.cc: urlIdx } }
export function lookupLogo(index, channel) {
  if (!index) return '';
  const id = String(channel.epg_channel_id || '').toLowerCase().replace(/@.*$/, '');
  let i = id ? index.ids[id] : undefined;
  if (i === undefined) {
    const { name, cc } = logoKey(channel.name);
    if (name) i = (cc ? index.names[`${name}.${cc}`] : undefined) ?? index.names[name];
  }
  return i === undefined ? '' : index.urls[i];
}

// Mutates rows: only channels with no provider logo get one.
export function fillChannelLogos(rows, index) {
  if (!index || !Array.isArray(rows)) return rows;
  for (const r of rows) {
    if (r && !r.stream_icon) {
      const url = lookupLogo(index, r);
      if (url) r.stream_icon = url;
    }
  }
  return rows;
}
