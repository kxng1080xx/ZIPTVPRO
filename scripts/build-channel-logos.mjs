// Builds public/channel-logos.json from iptv-org (https://github.com/iptv-org/api).
// Run manually to refresh: `npm run logos`. Output is committed so builds stay offline.
import { writeFileSync } from 'fs';
import { logoKey } from '../server/channel-logos.js';

const API = 'https://iptv-org.github.io/api';
const get = async (f) => {
  const r = await fetch(`${API}/${f}`);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  return r.json();
};

const [channels, logos] = await Promise.all([get('channels.json'), get('logos.json')]);

// Best logo per channel: main feed, untagged, raster (old TV WebViews), widest.
const score = (l) => (l.feed ? 0 : 8) + (l.tags?.length ? 0 : 4) + (l.format === 'SVG' ? 0 : 2) + (l.in_use ? 1 : 0);
const best = new Map();
for (const l of logos) {
  const cur = best.get(l.channel);
  if (!cur || score(l) > score(cur) || (score(l) === score(cur) && (l.width || 0) > (cur.width || 0))) best.set(l.channel, l);
}

// Bare-name collisions ("fox", "cnn") resolve to the first channel seen, so the
// countries most providers carry go first; open channels before closed ones.
const PRIORITY = ['US', 'GB', 'CA', 'JM', 'AU', 'IE', 'NZ', 'IN', 'TT'];
const rank = (c) => (c.closed ? 100 : 0) + (PRIORITY.includes(c.country) ? PRIORITY.indexOf(c.country) : PRIORITY.length);
channels.sort((a, b) => rank(a) - rank(b));

const urls = [], ids = {}, names = {};
for (const c of channels) {
  const l = best.get(c.id);
  if (!l) continue;
  const idx = urls.push(l.url) - 1;
  ids[c.id.toLowerCase()] = idx;
  const cc = String(c.country || '').toLowerCase();
  for (const n of [c.name, ...(c.alt_names || [])]) {
    const { name } = logoKey(n);
    if (!name || name.length < 2) continue;
    if (names[name] === undefined) names[name] = idx;
    if (cc && names[`${name}.${cc}`] === undefined) names[`${name}.${cc}`] = idx;
  }
}

const out = JSON.stringify({ built: new Date().toISOString().slice(0, 10), urls, ids, names });
writeFileSync('public/channel-logos.json', out);
console.log(`channel-logos.json: ${urls.length} logos, ${Object.keys(names).length} name keys, ${(out.length / 1e6).toFixed(2)} MB`);
