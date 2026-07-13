/**
 * Watch Together sessions (PC + APK + TV). Cross-origin — the apps load from
 * file://, the capacitor:// scheme, or the web build, so CORS is open.
 *
 *   POST /api/watch  { action, ... }
 *
 *     create { device_id, sub_hash, content }      -> { code, expires_at }
 *     join   { code, device_id, sub_hash }         -> { content, state, position, paused, ... }
 *     poll   { code, device_id }                   -> full session state + guests
 *     update { code, device_id, position, paused, state }   host only
 *     end    { code, device_id }                            host only
 *
 * SECURITY. The device code is itself a credential (see api/device.js — knowing
 * it returns a playlist's server_url/username/password), so a watch session is
 * keyed by a SEPARATE, short-lived 4-letter code and never carries credentials.
 * Instead it stores `sub_hash`, a fingerprint of the subscription that every
 * client can recompute locally. A join only returns the content payload when the
 * caller's hash matches the host's, so a guessed code on a different
 * subscription reveals nothing. Content travels as identifiers (stream id +
 * container extension) and each client rebuilds the stream URL from its own
 * credentials.
 *
 * Host authority is enforced here, not just in the UI: `update` and `end` reject
 * any caller whose device_id is not the session's host_device.
 */
import { sb, supabaseConfigured } from './_supabase.js';

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_LEN = 4;
const CODE_ATTEMPTS = 8;

// 26^4 is ~457k, so a random 4-letter code will occasionally land on something
// unfortunate. Cheap to skip; the retry loop just draws again.
const BLOCKED = new Set(['ANUS', 'ARSE', 'CLIT', 'COCK', 'COON', 'CUNT', 'DAMN', 'DICK', 'DYKE', 'FUCK', 'GOOK', 'JIZZ', 'KIKE', 'KUNT', 'MICK', 'PAKI', 'PISS', 'PORN', 'RAPE', 'SHAG', 'SHIT', 'SLUT', 'SPIC', 'TARD', 'TITS', 'TURD', 'TWAT', 'WANK']);

// A guest that hasn't polled in this long is treated as gone.
const GUEST_STALE_MS = 20000;

const SESSION_COLS = 'code,host_device,sub_hash,content,state,position,paused,host_updated_at,guests,expires_at';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseConfigured()) return res.status(500).json({ error: 'Server not configured.' });

  try {
    const b = await readBody(req);
    const action = String(b.action || '').trim();

    switch (action) {
      case 'create': return await create(req, res, b);
      case 'join':   return await join(req, res, b);
      case 'poll':   return await poll(req, res, b);
      case 'update': return await update(req, res, b);
      case 'end':    return await end(req, res, b);
      default:       return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
}

/* ------------------------------------------------------------------ actions */

async function create(req, res, b) {
  const device = deviceId(b.device_id);
  const subHash = hash(b.sub_hash);
  const content = b.content;

  if (!device) return res.status(400).json({ error: 'Valid device_id required' });
  if (!subHash) return res.status(400).json({ error: 'Valid sub_hash required' });
  if (!content || typeof content !== 'object' || !content.streamId) {
    return res.status(400).json({ error: 'content.streamId required' });
  }

  // Opportunistic sweep — no cron needed, and the table stays tiny.
  try { await sb(`/watch_sessions?expires_at=lt.${new Date().toISOString()}`, { method: 'DELETE', prefer: 'return=minimal' }); } catch { /* best-effort */ }

  const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const row = {
    host_device: device,
    sub_hash: subHash,
    content: {
      type: String(content.type || 'movie'),
      streamId: String(content.streamId),
      ext: String(content.ext || ''),
      name: String(content.name || 'Untitled'),
      logo: String(content.logo || ''),
      backdrop: String(content.backdrop || '')
    },
    state: 'lobby',
    position: 0,
    paused: true,
    host_updated_at: new Date().toISOString(),
    guests: [],
    expires_at: expiresAt
  };

  // Draw codes until one lands on a free primary key. Collisions are rare enough
  // that this practically never loops, but a full table must not hang the request.
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const code = randomCode();
    try {
      await sb('/watch_sessions', { method: 'POST', prefer: 'return=minimal', body: { ...row, code } });
      return res.status(200).json({ code, expires_at: expiresAt, server_now: nowIso() });
    } catch (err) {
      if (err.status === 409) continue;   // code taken — draw again
      throw err;
    }
  }
  return res.status(503).json({ error: 'Could not allocate a session code. Try again.' });
}

async function join(req, res, b) {
  const device = deviceId(b.device_id);
  const subHash = hash(b.sub_hash);
  const code = roomCode(b.code);

  if (!device) return res.status(400).json({ error: 'Valid device_id required' });
  if (!subHash) return res.status(400).json({ error: 'Valid sub_hash required' });
  if (!code) return res.status(400).json({ error: 'not_found' });

  const s = await loadSession(code);
  if (!s) return res.status(404).json({ error: 'not_found' });

  // The content payload is withheld on a mismatch, so a guessed code on a
  // different subscription discloses nothing about what the host is watching.
  if (s.sub_hash !== subHash) return res.status(403).json({ error: 'subscription_mismatch' });

  if (device !== s.host_device) {
    const guests = liveGuests(s.guests).filter((g) => g.device !== device);
    guests.push({ device, joined_at: nowIso(), last_seen: nowIso() });
    await patch(code, { guests });
    s.guests = guests;
  }

  return res.status(200).json(sessionPayload(s, true));
}

async function poll(req, res, b) {
  const device = deviceId(b.device_id);
  const code = roomCode(b.code);
  if (!device || !code) return res.status(400).json({ error: 'code and device_id required' });

  const s = await loadSession(code);
  if (!s) return res.status(404).json({ error: 'not_found' });

  // Guest heartbeat. The host's own poll doesn't touch the list — it only reads
  // it, so the host sees guests disappear once they stop polling.
  if (device !== s.host_device) {
    const guests = liveGuests(s.guests);
    const me = guests.find((g) => g.device === device);
    if (me) me.last_seen = nowIso();
    else guests.push({ device, joined_at: nowIso(), last_seen: nowIso() });
    await patch(code, { guests });
    s.guests = guests;
  } else {
    s.guests = liveGuests(s.guests);
  }

  return res.status(200).json(sessionPayload(s, true));
}

async function update(req, res, b) {
  const device = deviceId(b.device_id);
  const code = roomCode(b.code);
  if (!device || !code) return res.status(400).json({ error: 'code and device_id required' });

  const s = await loadSession(code);
  if (!s) return res.status(404).json({ error: 'not_found' });
  if (s.host_device !== device) return res.status(403).json({ error: 'not_host' });

  const fields = { host_updated_at: nowIso() };
  if (b.position != null && isFinite(Number(b.position))) fields.position = Math.max(0, Number(b.position));
  if (typeof b.paused === 'boolean') fields.paused = b.paused;
  if (b.state === 'lobby' || b.state === 'playing' || b.state === 'ended') fields.state = b.state;

  await patch(code, fields);
  return res.status(200).json({ ok: true, server_now: nowIso() });
}

async function end(req, res, b) {
  const device = deviceId(b.device_id);
  const code = roomCode(b.code);
  if (!device || !code) return res.status(400).json({ error: 'code and device_id required' });

  const s = await loadSession(code);
  if (!s) return res.status(200).json({ ok: true, server_now: nowIso() });   // already gone
  if (s.host_device !== device) return res.status(403).json({ error: 'not_host' });

  await patch(code, { state: 'ended', host_updated_at: nowIso() });
  return res.status(200).json({ ok: true, server_now: nowIso() });
}

/* ------------------------------------------------------------------ helpers */

/** Loads a live session. An expired row is treated as if it never existed. */
async function loadSession(code) {
  const rows = await sb(`/watch_sessions?code=eq.${encodeURIComponent(code)}&select=${SESSION_COLS}`);
  const s = rows && rows[0];
  if (!s) return null;
  if (s.expires_at && new Date(s.expires_at) < new Date()) return null;
  return s;
}

function patch(code, fields) {
  return sb(`/watch_sessions?code=eq.${encodeURIComponent(code)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: fields
  });
}

/**
 * The shared response shape. `server_now` is the whole point of it: clients
 * compute their offset from it rather than trusting the local clock, so a device
 * whose clock is minutes off still syncs correctly.
 */
function sessionPayload(s, withContent) {
  return {
    code: s.code,
    state: s.state,
    position: s.position,
    paused: s.paused,
    host_updated_at: s.host_updated_at,
    host_device: s.host_device,
    guests: liveGuests(s.guests).map((g) => ({ device: g.device, joined_at: g.joined_at })),
    content: withContent ? s.content : undefined,
    server_now: nowIso()
  };
}

/** Drops guests that stopped polling, so the host's "guest joined" list is live. */
function liveGuests(guests) {
  const cutoff = Date.now() - GUEST_STALE_MS;
  return (Array.isArray(guests) ? guests : []).filter(
    (g) => g && g.device && new Date(g.last_seen || 0).getTime() >= cutoff
  );
}

function randomCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) {
      c += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
    }
    if (!BLOCKED.has(c)) return c;
  }
}

function deviceId(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(s) ? s : null;
}

function roomCode(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{4}$/.test(s) ? s : null;
}

function hash(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(s) ? s : null;
}

function nowIso() { return new Date().toISOString(); }

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}
