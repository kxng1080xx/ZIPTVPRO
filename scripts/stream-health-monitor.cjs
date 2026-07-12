#!/usr/bin/env node
/*
 * stream-health-monitor.cjs
 * HLS stream stability analyzer. Polls the playlist and downloads every new
 * segment for a fixed duration, recording drops, recovery time/cleanliness,
 * stalls, throughput, and drop-interval uniformity.
 *
 * Usage: node scripts/stream-health-monitor.cjs "<m3u8 url>" [--duration 600] [--out <dir>]
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------- args ----------
const args = process.argv.slice(2);
const streamUrl = args.find(a => !a.startsWith('--'));
if (!streamUrl) { console.error('Usage: node stream-health-monitor.cjs <url> [--duration secs] [--out dir]'); process.exit(1); }
function argVal(name, def) { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; }
const DURATION_MS = parseInt(argVal('duration', '600'), 10) * 1000;
const OUT_DIR = argVal('out', path.join(__dirname, '..', 'stream-monitor-out'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const EVENTS_FILE = path.join(OUT_DIR, `events-${RUN_ID}.jsonl`);
const REPORT_FILE = path.join(OUT_DIR, `report-${RUN_ID}.txt`);

const PLAYLIST_TIMEOUT = 10000;
const SEGMENT_TIMEOUT = 30000;
const RETRY_INTERVAL = 2000;

// ---------- state ----------
const startTime = Date.now();
const events = [];               // all recorded events
const playlistLatencies = [];    // ms, successful playlist fetches
const segmentStats = [];         // {seq, bytes, ms, ttfb, durationSec, mbps, realtimeRatio}
let lastMediaSeq = -1;
let lastSeqAdvanceAt = Date.now();
let targetDuration = 6;
let down = null;                 // {since, reason, lastGoodSeq, attempts}
let discontinuityCount = 0;
let playlistFetches = 0, playlistFailures = 0, segmentFailures = 0;
let interrupted = false;

function elapsed() { return ((Date.now() - startTime) / 1000).toFixed(1); }
function log(msg) { console.log(`[+${elapsed()}s] ${msg}`); }
function record(type, data) {
  const ev = { t: Date.now(), elapsedSec: +elapsed(), type, ...data };
  events.push(ev);
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n');
  return ev;
}

// ---------- http ----------
function fetchUrl(u, timeoutMs, redirects = 5) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let ttfb = null;
    let parsed;
    try { parsed = new URL(u); } catch (e) { return resolve({ err: 'BAD_URL:' + e.message, ms: 0 }); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 (StreamHealthMonitor)' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, u).href, timeoutMs, redirects - 1));
      }
      ttfb = Date.now() - t0;
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ms: Date.now() - t0, ttfb, headers: res.headers, finalUrl: u }));
      res.on('error', e => resolve({ err: e.code || e.message, ms: Date.now() - t0, ttfb, status: res.statusCode, finalUrl: u }));
    });
    req.on('timeout', () => { req.destroy(new Error('ETIMEDOUT')); });
    req.on('error', e => resolve({ err: e.code || e.message, ms: Date.now() - t0, ttfb }));
  });
}

// ---------- m3u8 parsing ----------
function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = { isMaster: false, mediaSeq: 0, targetDuration: null, segments: [], variants: [], discontinuities: 0, endlist: false };
  let pendingDur = null, pendingDisc = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      out.isMaster = true;
      const bw = /BANDWIDTH=(\d+)/.exec(line);
      const next = lines.slice(i + 1).find(l => l.trim() && !l.startsWith('#'));
      if (next) out.variants.push({ bandwidth: bw ? +bw[1] : 0, uri: new URL(next.trim(), baseUrl).href });
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      out.mediaSeq = parseInt(line.split(':')[1], 10);
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      out.targetDuration = parseInt(line.split(':')[1], 10);
    } else if (line.startsWith('#EXTINF:')) {
      pendingDur = parseFloat(line.slice(8));
    } else if (line === '#EXT-X-DISCONTINUITY') {
      out.discontinuities++; pendingDisc = true;
    } else if (line === '#EXT-X-ENDLIST') {
      out.endlist = true;
    } else if (!line.startsWith('#')) {
      out.segments.push({ uri: new URL(line, baseUrl).href, duration: pendingDur || out.targetDuration || 6, discontinuity: pendingDisc });
      pendingDur = null; pendingDisc = false;
    }
  }
  return out;
}

// ---------- drop / recovery tracking ----------
function markDown(reason, detail) {
  if (down) { down.attempts++; return; }
  down = { since: Date.now(), reason, detail, lastGoodSeq: lastMediaSeq, attempts: 1 };
  record('drop', { reason, detail, lastGoodSeq: lastMediaSeq });
  log(`DROP: ${reason} (${detail || ''})`);
}
function markUp(newSeq, hadDiscontinuity) {
  if (!down) return;
  const downtimeMs = Date.now() - down.since;
  const viaPortal = !!down.reresolved;
  // segments that would have aired during downtime vs how far the seq jumped
  const expectedAdvance = Math.round(downtimeMs / 1000 / (targetDuration || 6));
  const seqJump = down.lastGoodSeq >= 0 ? newSeq - down.lastGoodSeq : 0;
  const clean = !hadDiscontinuity && downtimeMs < (targetDuration || 6) * 1000;
  record('recovery', {
    downtimeMs, attempts: down.attempts, reason: down.reason,
    seqJump, expectedAdvance, discontinuityOnReturn: hadDiscontinuity, clean, requiredPortalReauth: viaPortal,
  });
  log(`RECOVERED after ${(downtimeMs / 1000).toFixed(1)}s, ${down.attempts} attempt(s), seq jumped ${seqJump} (expected ~${expectedAdvance}), ${clean ? 'CLEAN' : 'NOT clean'}${viaPortal ? ' [needed portal re-auth]' : ''}`);
  down = null;
}

// ---------- stats helpers ----------
function stats(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
  const pct = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: arr.length, min: s[0], max: s[s.length - 1], mean, sd, cv: mean ? sd / mean : 0, p50: pct(0.5), p95: pct(0.95) };
}
const fmt = (n, d = 1) => n == null ? 'n/a' : (+n).toFixed(d);

// ---------- report ----------
function report() {
  const L = [];
  const runSec = (Date.now() - startTime) / 1000;
  L.push('==================== STREAM HEALTH REPORT ====================');
  L.push(`URL host        : ${new URL(streamUrl).host}`);
  L.push(`Run time        : ${fmt(runSec, 0)}s (target ${DURATION_MS / 1000}s)${interrupted ? ' [INTERRUPTED]' : ''}`);
  L.push(`Target duration : ${targetDuration}s per segment`);
  L.push('');

  const drops = events.filter(e => e.type === 'drop');
  const recoveries = events.filter(e => e.type === 'recovery');
  const stalls = events.filter(e => e.type === 'stall');
  const slow = events.filter(e => e.type === 'slow_segment');

  L.push('--- CONNECTION DROPS ---');
  L.push(`Total drops           : ${drops.length}`);
  L.push(`Playlist fetch errors : ${playlistFailures}/${playlistFetches}`);
  L.push(`Segment fetch errors  : ${segmentFailures}`);
  const reasons = {};
  drops.forEach(d => { const k = `${d.reason}${d.detail ? ' (' + d.detail + ')' : ''}`; reasons[k] = (reasons[k] || 0) + 1; });
  Object.entries(reasons).forEach(([k, v]) => L.push(`  ${k}: ${v}`));
  if (drops.length) {
    L.push('Drop timeline (s from start): ' + drops.map(d => fmt(d.elapsedSec, 0)).join(', '));
  }
  L.push('');

  L.push('--- DROP UNIFORMITY ---');
  if (drops.length >= 2) {
    const intervals = [];
    for (let i = 1; i < drops.length; i++) intervals.push(drops[i].elapsedSec - drops[i - 1].elapsedSec);
    const st = stats(intervals);
    L.push(`Intervals between drops (s): ${intervals.map(x => fmt(x, 0)).join(', ')}`);
    L.push(`mean=${fmt(st.mean)}s  sd=${fmt(st.sd)}s  CV=${fmt(st.cv, 2)}`);
    L.push(st.cv < 0.25 ? `>> PERIODIC: drops occur ~every ${fmt(st.mean, 0)}s — points to a server-side timer (token/session TTL, connection-lifetime limit, segmenter restart), NOT random network loss.`
      : st.cv < 0.6 ? '>> SEMI-REGULAR: some periodicity; could be load-correlated or a jittery server-side limit.'
      : '>> IRREGULAR: drops look random — points to network congestion, packet loss, or server overload rather than a fixed limit.');
  } else if (drops.length === 1) {
    L.push('Only 1 drop — cannot judge uniformity.');
  } else {
    L.push('No drops recorded.');
  }
  L.push('');

  L.push('--- RECOVERY ---');
  if (recoveries.length) {
    const dts = recoveries.map(r => r.downtimeMs / 1000);
    const st = stats(dts);
    const cleanN = recoveries.filter(r => r.clean).length;
    L.push(`Recoveries        : ${recoveries.length} (${cleanN} clean, ${recoveries.length - cleanN} with content loss/discontinuity)`);
    L.push(`Downtime          : mean=${fmt(st.mean)}s  p95=${fmt(st.p95)}s  max=${fmt(st.max)}s`);
    L.push(`Attempts to recover: ${recoveries.map(r => r.attempts).join(', ')}`);
    const reauthN = recoveries.filter(r => r.requiredPortalReauth).length;
    L.push(`Needed portal re-auth (fresh token/edge): ${reauthN}/${recoveries.length}`);
    if (reauthN) L.push('>> Retrying the SAME tokenized URL was not enough — the fix is to re-request the portal URL on error (fresh token). Players that only retry the current URL will hard-fail here.');
    L.push(`Segments lost per drop (seq jump vs expected): ${recoveries.map(r => `${r.seqJump}/${r.expectedAdvance}`).join(', ')}`);
    L.push(cleanN === recoveries.length
      ? '>> All recoveries clean: a player with retry logic can ride through these invisibly (bigger buffer hides them).'
      : '>> Some recoveries lost content: the server advanced past segments during the outage — buffering more ahead of time is the only client-side mitigation.');
  } else if (drops.length) {
    L.push('Stream never recovered from the last drop within the run.');
  } else {
    L.push('n/a (no drops)');
  }
  L.push('');

  L.push('--- STALLS (playlist stopped advancing while HTTP still OK) ---');
  L.push(`Stall events: ${stalls.length}` + (stalls.length ? '  at: ' + stalls.map(s => fmt(s.elapsedSec, 0) + 's (' + fmt(s.stalledForSec, 0) + 's)').join(', ') : ''));
  L.push(stalls.length ? '>> Stalls with HTTP OK mean the ORIGIN/segmenter is hiccuping (source feed), not your connection.' : '');
  L.push('');

  L.push('--- PLAYLIST LATENCY ---');
  const pl = stats(playlistLatencies);
  if (pl) L.push(`n=${pl.n}  p50=${fmt(pl.p50, 0)}ms  p95=${fmt(pl.p95, 0)}ms  max=${fmt(pl.max, 0)}ms`);
  L.push('');

  L.push('--- SEGMENT DOWNLOADS (throughput vs realtime) ---');
  if (segmentStats.length) {
    const ratios = stats(segmentStats.map(s => s.realtimeRatio));
    const mbps = stats(segmentStats.map(s => s.mbps));
    const ttfb = stats(segmentStats.map(s => s.ttfb));
    const bitrateMbps = segmentStats.reduce((a, s) => a + (s.bytes * 8 / s.durationSec), 0) / segmentStats.length / 1e6;
    L.push(`Segments downloaded : ${segmentStats.length}`);
    L.push(`Est. stream bitrate : ${fmt(bitrateMbps, 2)} Mbps`);
    L.push(`Download speed      : p50=${fmt(mbps.p50, 1)} Mbps  min=${fmt(mbps.min, 1)} Mbps`);
    L.push(`TTFB                : p50=${fmt(ttfb.p50, 0)}ms  p95=${fmt(ttfb.p95, 0)}ms  max=${fmt(ttfb.max, 0)}ms`);
    L.push(`Realtime ratio      : p50=${fmt(ratios.p50, 1)}x  min=${fmt(ratios.min, 2)}x  (need >1x; <1x = guaranteed stutter)`);
    L.push(`Slow segments (<1.5x realtime): ${slow.length}` + (slow.length ? '  at: ' + slow.map(s => fmt(s.elapsedSec, 0) + 's').join(', ') : ''));
    if (ratios.min < 1) L.push('>> Some segments downloaded SLOWER than realtime — direct cause of stuttering (server throughput, not just drops).');
    else if (ratios.p50 < 3) L.push('>> Throughput headroom is thin; brief server slowdowns will stall a small buffer. Increase player buffer.');
    else L.push('>> Throughput is healthy when connected; stutter is coming from the drops/stalls, not bandwidth.');
  } else {
    L.push('No segments downloaded.');
  }
  L.push('');
  L.push(`Discontinuity tags seen in playlist: ${discontinuityCount}`);
  L.push(`Edge servers used: ${[...hostsSeen].join(', ') || 'n/a'}`);
  L.push('');
  L.push(`Raw events: ${EVENTS_FILE}`);
  L.push('==============================================================');

  const text = L.filter(x => x !== '').concat('').join('\n');
  console.log('\n' + text);
  fs.writeFileSync(REPORT_FILE, text);
  console.log(`Report saved: ${REPORT_FILE}`);
}

process.on('SIGINT', () => { interrupted = true; report(); process.exit(0); });
process.on('SIGTERM', () => { interrupted = true; report(); process.exit(0); });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- main loop ----------
const hostsSeen = new Set();

(async function main() {
  let playlistUrl = streamUrl;
  log(`Monitoring ${new URL(streamUrl).host} for ${DURATION_MS / 1000}s ...`);

  while (Date.now() - startTime < DURATION_MS) {
    playlistFetches++;
    const viaPortal = playlistUrl === streamUrl;
    const res = await fetchUrl(playlistUrl, PLAYLIST_TIMEOUT);

    if (res.err || res.status !== 200) {
      playlistFailures++;
      const detail = res.err || `HTTP ${res.status}`;
      record('playlist_error', { detail, ms: res.ms, viaPortal });
      markDown('playlist_fetch_failed', detail);
      // after 2 failed attempts on the resolved edge URL, go back through the
      // portal for a fresh token/edge (what a player's "reconnect" does)
      if (down && down.attempts >= 2 && !viaPortal) {
        down.reresolved = true;
        playlistUrl = streamUrl;
        record('portal_reresolve_attempt', {});
        log('Re-resolving through portal for fresh token/edge...');
      }
      await sleep(RETRY_INTERVAL);
      continue;
    }

    // note which edge server we landed on (redirects followed inside fetchUrl)
    if (res.finalUrl && res.finalUrl !== playlistUrl) {
      const newHost = new URL(res.finalUrl).host;
      if (!hostsSeen.has(newHost)) log(`Edge server: ${newHost}${viaPortal ? ' (via portal redirect)' : ''}`);
      record('edge_resolved', { host: newHost, viaPortal });
      hostsSeen.add(newHost);
      playlistUrl = res.finalUrl;
    } else {
      hostsSeen.add(new URL(res.finalUrl || playlistUrl).host);
    }

    playlistLatencies.push(res.ms);
    const pl = parsePlaylist(res.body.toString('utf8'), playlistUrl);

    if (pl.isMaster) {
      if (!pl.variants.length) { markDown('master_playlist_empty'); await sleep(RETRY_INTERVAL); continue; }
      pl.variants.sort((a, b) => b.bandwidth - a.bandwidth);
      playlistUrl = pl.variants[0].uri;
      record('selected_variant', { bandwidth: pl.variants[0].bandwidth, variants: pl.variants.length });
      log(`Master playlist -> selected variant @ ${(pl.variants[0].bandwidth / 1e6).toFixed(1)} Mbps (${pl.variants.length} variants)`);
      continue;
    }

    if (pl.targetDuration) targetDuration = pl.targetDuration;
    if (pl.endlist) { record('endlist', {}); log('Playlist has ENDLIST — stream marked as ended by server!'); }
    const hadDisc = pl.segments.some(s => s.discontinuity);
    if (hadDisc) discontinuityCount++;

    // recovery check (we were down, playlist is back)
    markUp(pl.mediaSeq, hadDisc);

    // stall detection: playlist fetches OK but sequence not advancing
    if (pl.mediaSeq > lastMediaSeq) {
      lastSeqAdvanceAt = Date.now();
    } else {
      const stalledFor = (Date.now() - lastSeqAdvanceAt) / 1000;
      if (stalledFor > targetDuration * 2.5) {
        record('stall', { stalledForSec: stalledFor, mediaSeq: pl.mediaSeq });
        log(`STALL: playlist stuck at seq ${pl.mediaSeq} for ${stalledFor.toFixed(0)}s (HTTP fine, origin not producing)`);
        lastSeqAdvanceAt = Date.now(); // don't re-fire every poll
      }
    }

    // download new segments
    const firstSeq = pl.mediaSeq;
    for (let i = 0; i < pl.segments.length; i++) {
      const seq = firstSeq + i;
      if (seq <= lastMediaSeq) continue;
      // on first pass, only grab the newest segment (live edge)
      if (lastMediaSeq === -1 && i < pl.segments.length - 1) continue;
      const seg = pl.segments[i];
      const sres = await fetchUrl(seg.uri, SEGMENT_TIMEOUT);
      if (sres.err || sres.status !== 200) {
        segmentFailures++;
        const detail = sres.err || `HTTP ${sres.status}`;
        record('segment_error', { seq, detail, ms: sres.ms });
        markDown('segment_fetch_failed', detail);
        break;
      }
      const durationSec = seg.duration || targetDuration;
      const mbps = (sres.body.length * 8) / (sres.ms / 1000) / 1e6;
      const realtimeRatio = durationSec / (sres.ms / 1000);
      segmentStats.push({ seq, bytes: sres.body.length, ms: sres.ms, ttfb: sres.ttfb, durationSec, mbps, realtimeRatio });
      record('segment', { seq, bytes: sres.body.length, ms: sres.ms, ttfb: sres.ttfb, durationSec: +durationSec.toFixed(2), mbps: +mbps.toFixed(2), realtimeRatio: +realtimeRatio.toFixed(2) });
      if (realtimeRatio < 1.5) {
        record('slow_segment', { seq, realtimeRatio: +realtimeRatio.toFixed(2), mbps: +mbps.toFixed(2) });
        log(`SLOW segment ${seq}: ${realtimeRatio.toFixed(2)}x realtime (${mbps.toFixed(1)} Mbps)`);
      }
      lastMediaSeq = seq;
    }
    if (down) { await sleep(RETRY_INTERVAL); continue; }

    await sleep(Math.max(1000, (targetDuration * 1000) / 2));
  }

  if (down) log(`Run ended while stream was DOWN (down for ${((Date.now() - down.since) / 1000).toFixed(0)}s)`);
  report();
})().catch(e => { console.error('FATAL:', e); report(); process.exit(1); });
