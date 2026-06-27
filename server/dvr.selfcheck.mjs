// Runnable self-check for the DVR/timeshift logic added to server/index.js and
// the player/main wiring. Re-implements the *pure* decision pieces and asserts
// them — the smallest things that fail if the logic breaks. No ffmpeg/network.
//   run:  node server/dvr.selfcheck.mjs
import assert from 'node:assert';

// --- mirrors server/index.js: sanitize() ---------------------------------
const sanitize = (s) => String(s || '').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 80) || 'rec';
assert.equal(sanitize('BBC One HD!'), 'BBC_One_HD_');
assert.equal(sanitize('../../etc/passwd'), '_etc_passwd');   // no path separators survive
assert.equal(sanitize(''), 'rec');
assert.equal(sanitize('a/b\\c').includes('/'), false);

// --- mirrors recordings index add + remove (writeJson/filter/concat) ------
let idx = [];
const addRec = (e) => { idx = idx.filter(r => r.id !== e.id).concat(e); };
addRec({ id: 'rec_1', status: 'recording' });
addRec({ id: 'rec_1', status: 'recording' });          // same id must not duplicate
assert.equal(idx.length, 1);
addRec({ id: 'rec_2', status: 'recording' });
idx = idx.filter(r => r.id !== 'rec_1');               // delete
assert.deepEqual(idx.map(r => r.id), ['rec_2']);

// --- mirrors armSchedule(): past => false, future => arms + fires ---------
function armSchedule(job, now, fire) {
  const delay = new Date(job.startAt).getTime() - now;
  if (delay < 0) return false;
  setTimeout(fire, delay);
  return true;
}
const now = Date.now();
assert.equal(armSchedule({ startAt: new Date(now - 1000).toISOString() }, now, () => {}), false);
let fired = false;
assert.equal(armSchedule({ startAt: new Date(now + 5).toISOString() }, now, () => { fired = true; }), true);

// --- mirrors main.js recordCurrentChannel(): EPG-aware duration -----------
// Accepts end as seconds-epoch or ms-epoch; pads 2 min; ignores absurd ( >=720 ).
function durationMins(end, nowMs) {
  let mins = 120;
  if (end) {
    const endMs = String(end).length > 12 ? +end : +end * 1000;
    const left = Math.round((endMs - nowMs) / 60000);
    if (left > 0 && left < 720) mins = left + 2;
  }
  return mins;
}
const t = 1_700_000_000_000;                              // fixed ms epoch
assert.equal(durationMins(undefined, t), 120);            // no EPG -> default
assert.equal(durationMins((t + 30 * 60000) / 1000, t), 32); // 30 min away (sec epoch) + pad
assert.equal(durationMins(t + 45 * 60000, t), 47);        // 45 min away (ms epoch) + pad
assert.equal(durationMins(t - 60000, t), 120);            // already ended -> default
assert.equal(durationMins(t + 900 * 60000, t), 120);      // absurd (15h) -> default

// --- mirrors player.js timeshift seek mapping (window <-> seek bar) -------
// fraction (0..1) -> element currentTime, and the inverse used by the bar.
const win = { start: 1000, end: 1000 + 1800 };            // 30-min DVR window
const seekTo = (frac) => win.start + frac * (win.end - win.start);
const barFrac = (cur) => (cur - win.start) / (win.end - win.start);
assert.equal(seekTo(0), 1000);                            // 0% -> oldest buffered
assert.equal(seekTo(1), 2800);                            // 100% -> live edge
assert.ok(Math.abs(barFrac(seekTo(0.5)) - 0.5) < 1e-9);  // round-trips

setTimeout(() => {
  assert.ok(fired, 'future schedule should have fired');
  console.log('OK: DVR/timeshift logic self-check passed');
}, 30);
