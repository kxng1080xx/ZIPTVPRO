// Self-check for server/channel-logos.js against the built index: `node scripts/check-channel-logos.mjs`
import { readFileSync } from 'fs';
import assert from 'assert';
import { logoKey, lookupLogo, fillChannelLogos } from '../server/channel-logos.js';

assert.deepStrictEqual(logoKey('US: CNN HD'), { name: 'cnn', cc: 'us' });
assert.deepStrictEqual(logoKey('[UK] Sky Sports Main Event FHD'), { name: 'skysportsmainevent', cc: 'gb' });
assert.deepStrictEqual(logoKey('USA - Catchy Comedy'), { name: 'catchycomedy', cc: 'us' });

const index = JSON.parse(readFileSync('public/channel-logos.json', 'utf8'));
const samples = [
  { name: 'US: CNN HD' }, { name: 'UK: BBC One FHD' }, { name: 'ESPN 2' }, { name: '|UK| Sky Sports Premier League' },
  { name: 'CA: TSN 1' }, { name: 'HBO' }, { name: 'whatever', epg_channel_id: 'BBCTwo.uk' }, { name: 'Discovery Channel' },
  { name: 'Nickelodeon' }, { name: 'TVJ' }, { name: 'zzz not a channel' }
];
for (const s of samples) console.log((lookupLogo(index, s) || '-').padEnd(70), s.name);
assert.ok(lookupLogo(index, { name: 'x', epg_channel_id: 'BBCTwo.uk' }), 'epg id match');
assert.strictEqual(lookupLogo(index, { name: 'zzz not a channel' }), '');
const kept = fillChannelLogos([{ name: 'CNN', stream_icon: 'mine.png' }], index);
assert.strictEqual(kept[0].stream_icon, 'mine.png', 'provider logo must win');
console.log('ok');
