// Builds the external EPG published to the `epg-data` branch (see .github/workflows/epg.yml).
// Streams epgshare01 XMLTV feeds and writes, into <outDir>:
//   ch/<file>.json  -> [{ title, description, start_timestamp, end_timestamp }] for one channel
//   index.json      -> { urls: [file], ids: { lowercased xmltv id: i }, names: { key | key.cc: i } }
// index.json uses the same shape as public/channel-logos.json so the app matches
// channels with the same lookup (server/channel-logos.js).
// Usage: node scripts/build-epg.mjs epg-out
import { createGunzip } from 'zlib';
import { Readable } from 'stream';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { logoKey } from '../server/channel-logos.js';

const BASE = 'https://epgshare01.online/epgshare01/';
// Earlier sources win when two feeds carry the same channel or name.
const SOURCES = process.env.EPG_SOURCES
  ? process.env.EPG_SOURCES.split(',')   // e.g. EPG_SOURCES=JM1 for a cheap local test
  : ['US2', 'US_SPORTS1', 'UK1', 'CA2', 'JM1'];
const OUT = process.argv[2] || 'epg-out';
const NOW = Date.now() / 1000;
const FROM = NOW - 4 * 3600;   // keep what's on now
const TO = NOW + 36 * 3600;    // build runs twice a day, so 36h always covers tomorrow

const unesc = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? unesc(m[1]) : ''; };
const inner = (block, name) => { const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(block); return m ? unesc(m[1]).trim() : ''; };

// XMLTV time: "20261105183000 +0000" -> unix seconds
function xmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 1000;
  if (!m[7]) return t;
  const off = (+m[7].slice(1, 3)) * 3600 + (+m[7].slice(3)) * 60;
  return m[7][0] === '-' ? t + off : t - off;
}

const channels = new Map(); // id -> { names: [], src, progs: [] }
const chan = (id, src) => {
  let c = channels.get(id);
  if (!c) channels.set(id, c = { names: [], src, progs: [] });
  return c;
};

async function ingest(src) {
  const res = await fetch(`${BASE}epg_ripper_${src}.xml.gz`);
  if (!res.ok) { console.warn(`${src}: HTTP ${res.status}, skipped`); return; }
  const stream = Readable.fromWeb(res.body).pipe(createGunzip());
  stream.setEncoding('utf8'); // decoder keeps multi-byte chars intact across chunks
  const block = /<channel\b[\s\S]*?<\/channel>|<programme\b[\s\S]*?<\/programme>/g;
  let buf = '', n = 0;
  for await (const chunk of stream) {
    buf += chunk;
    let m, end = 0;
    block.lastIndex = 0;
    while ((m = block.exec(buf))) {
      end = block.lastIndex;
      const b = m[0];
      if (b.startsWith('<channel')) {
        const c = chan(attr(b, 'id'), src);
        if (c.src !== src) continue;
        for (const d of b.matchAll(/<display-name\b[^>]*>([\s\S]*?)<\/display-name>/g)) c.names.push(unesc(d[1]).trim());
      } else {
        const id = attr(b, 'channel');
        const c = chan(id, src);
        if (c.src !== src) continue;
        const s = xmltvTime(attr(b, 'start')), e = xmltvTime(attr(b, 'stop'));
        if (!(e > FROM && s < TO)) continue;
        c.progs.push({
          title: inner(b, 'title'),
          description: inner(b, 'desc').slice(0, 500),
          start_timestamp: String(s),
          end_timestamp: String(e)
        });
        n++;
      }
    }
    if (end) buf = buf.slice(end);
    if (buf.length > 4e6) buf = buf.slice(-1e6); // ponytail: guard against a malformed unclosed block eating RAM
  }
  console.log(`${src}: ${n} programmes`);
}

for (const src of SOURCES) {
  try { await ingest(src); } catch (e) { console.warn(`${src}: ${e.message}`); }
}

// iptv-org knows short/alt names ("TVJ" = "Television Jamaica") and its own ids
// ("BBCOne.uk"), which many providers use as epg_channel_id. Map name+country ->
// iptv-org channel so each feed channel inherits those aliases.
const iptvByKey = new Map();
try {
  const list = await (await fetch('https://iptv-org.github.io/api/channels.json')).json();
  for (const c of list) {
    const cc = String(c.country || '').toLowerCase();
    for (const n of [c.name, ...(c.alt_names || [])]) {
      const k = `${logoKey(n).name}.${cc}`;
      if (!iptvByKey.has(k)) iptvByKey.set(k, c);
    }
  }
} catch (e) { console.warn(`iptv-org aliases skipped: ${e.message}`); }

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/ch`, { recursive: true });
const urls = [], ids = {}, names = {};
const used = new Set();
for (const [id, c] of channels) {
  if (!c.progs.length) continue;
  let file = id.toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/^\.+/, '') || 'ch';
  while (used.has(file)) file += '_';
  used.add(file);
  c.progs.sort((a, b) => a.start_timestamp - b.start_timestamp);
  writeFileSync(`${OUT}/ch/${file}.json`, JSON.stringify(c.progs));
  const i = urls.push(file) - 1;
  ids[id.toLowerCase()] = i;
  let cc = (id.split('.').pop() || '').toLowerCase();
  if (cc === 'uk') cc = 'gb';
  const aliases = [...c.names, id.replace(/\.[a-z]{2}$/i, '').replace(/\./g, ' ')];
  const iptv = aliases.map((n) => iptvByKey.get(`${logoKey(n).name}.${cc}`)).find(Boolean);
  if (iptv) {
    if (ids[iptv.id.toLowerCase()] === undefined) ids[iptv.id.toLowerCase()] = i;
    aliases.push(iptv.name, ...(iptv.alt_names || []));
  }
  for (const raw of aliases) {
    const { name } = logoKey(raw);
    if (!name || name.length < 2) continue;
    if (names[name] === undefined) names[name] = i;
    if (cc.length === 2 && names[`${name}.${cc}`] === undefined) names[`${name}.${cc}`] = i;
  }
}
writeFileSync(`${OUT}/index.json`, JSON.stringify({ built: new Date().toISOString(), urls, ids, names }));
console.log(`EPG: ${urls.length} channels with listings -> ${OUT}/`);
