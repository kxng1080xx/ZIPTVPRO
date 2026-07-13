/**
 * Watch Together client (ZIPTV Pro 7.2).
 *
 * A host picks a VOD title, the server mints a 4-letter room code, and guests on
 * the SAME subscription join with it. The host is authoritative: only they can
 * pause/seek, and everyone else follows. See api/watch.js for the wire protocol.
 *
 * Like cloud-sync.js this talks to an ABSOLUTE url — in the Electron and APK
 * builds the frontend is loaded locally, so a relative "/api/watch" would hit the
 * bundled local server rather than the cloud.
 *
 * Two things this module exists to get right:
 *
 *  1. CLOCK SKEW. Every response carries `server_now`. We never compare the
 *     host's timestamps against the local clock — a device whose clock is minutes
 *     off would desync permanently. Instead we track an offset to server time and
 *     project the host's position forward through that.
 *
 *  2. PRIVACY. The only thing identifying the provider is a SHA-256 of the server
 *     host. Credentials never leave the device, and the session only carries
 *     stream identifiers — each client rebuilds its own URL from its own login.
 *     Matching on the server rather than the login is deliberate: one server
 *     issues many credentials, and two people on the same provider with separate
 *     logins resolve the same stream ids, so they can watch together fine.
 *
 * This module does transport + timing only. Applying remote state to the player,
 * and the UI, live in main.js / tv-native.js.
 */
import { getDeviceCode } from './cloud-sync.js';
import { getActiveSubscriptionKey } from './xtream-api.js';

const CLOUD_BASE = 'https://ziptvpro-nu.vercel.app';

const POLL_LOBBY_MS = 2000;    // nothing is moving yet — no need to hammer it
const POLL_PLAYING_MS = 1000;  // a pause should land on guests within ~1s

class WatchTogether {
  constructor() {
    this.code = null;
    this.isHost = false;
    this.state = null;         // 'lobby' | 'playing' | 'ended'
    this.content = null;       // {type, streamId, ext, name, logo, backdrop}
    this.guests = [];

    this._timer = null;
    this._last = null;         // last session payload seen, for expectedNow()
    this._offset = 0;          // serverTime - localTime, ms
    this._offsetSeen = false;

    // Callbacks, assigned by the UI layer.
    this.onGuestsChanged = null;   // (guests[]) => void
    this.onStateChanged = null;    // ('lobby'|'playing'|'ended') => void
    this.onRemoteState = null;     // ({position, paused, expected}) => void   guests only
    this.onError = null;           // (Error) => void
  }

  get active() { return !!this.code; }
  get isGuest() { return this.active && !this.isHost; }

  /** Server time as a ms epoch, corrected for local clock skew. */
  serverNow() { return Date.now() + this._offset; }

  /**
   * Where the host is *right now*, projected from the last poll. This is what a
   * joining guest starts playback at, so someone arriving mid-film lands in the
   * right place rather than at 0 and then being yanked forward.
   */
  expectedNow() { return this._last ? this._project(this._last) : 0; }

  /* ---------------------------------------------------------------- session */

  /**
   * Open a session for a title. `content` is {type, streamId, ext, name, logo, backdrop}.
   * Resolves with the 4-letter code.
   */
  async host(content) {
    const sub = await subHash();
    const r = await post({ action: 'create', device_id: getDeviceCode(), sub_hash: sub, content });
    this.code = r.code;
    this.isHost = true;
    this.state = 'lobby';
    this.content = content;
    this.guests = [];
    this._startPolling();
    return r.code;
  }

  /**
   * Join an existing session. Throws an Error whose `.code` is 'not_found' or
   * 'subscription_mismatch' so the UI can show the right message.
   * Resolves with the session's content.
   */
  async join(code) {
    const sub = await subHash();
    const r = await post({
      action: 'join',
      code: String(code || '').trim().toUpperCase(),
      device_id: getDeviceCode(),
      sub_hash: sub
    });
    this.code = r.code;
    this.isHost = false;
    this.state = r.state;
    this.content = r.content;
    this.guests = r.guests || [];
    this._absorb(r);
    this._startPolling();
    return r.content;
  }

  /** Host: flip the session to 'playing' — this is what releases the guests. */
  async start(position = 0) {
    if (!this.isHost) return;
    await this._update({ state: 'playing', position, paused: false });
    this.state = 'playing';
    this._startPolling();
  }

  /** Host: broadcast the current transport state. Cheap; call it freely. */
  async broadcast(position, paused) {
    if (!this.isHost || !this.code) return;
    await this._update({ position, paused });
  }

  /** Leave (guest) or end for everyone (host). Always safe to call. */
  async leave() {
    const code = this.code;
    const wasHost = this.isHost;
    this._stopPolling();
    this.code = null;
    this.isHost = false;
    this.state = null;
    this.content = null;
    this.guests = [];
    this._last = null;
    if (code && wasHost) {
      try { await post({ action: 'end', code, device_id: getDeviceCode() }); } catch (e) { /* best-effort */ }
    }
  }

  /* ---------------------------------------------------------------- polling */

  _startPolling() {
    this._stopPolling();
    const every = this.state === 'playing' ? POLL_PLAYING_MS : POLL_LOBBY_MS;
    this._timer = setInterval(() => this._poll(), every);
  }

  _stopPolling() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    if (!this.code) return;
    let r;
    try {
      r = await post({ action: 'poll', code: this.code, device_id: getDeviceCode() });
    } catch (err) {
      // A session the host ended (or that expired) 404s — that's a clean exit,
      // not an error. Anything else is transient: keep polling and ride it out.
      if (err.code === 'not_found') {
        const wasActive = this.active;
        this._stopPolling();
        this.code = null;
        this.state = 'ended';
        if (wasActive && this.onStateChanged) this.onStateChanged('ended');
      }
      return;
    }

    this._absorb(r);

    if (guestsDiffer(this.guests, r.guests)) {
      this.guests = r.guests || [];
      if (this.onGuestsChanged) this.onGuestsChanged(this.guests);
    }

    if (r.state !== this.state) {
      const prev = this.state;
      this.state = r.state;
      // The poll cadence follows the session: slow in the lobby, 1s once playing.
      if ((prev === 'lobby') !== (r.state === 'lobby')) this._startPolling();
      if (this.onStateChanged) this.onStateChanged(r.state);
    }

    // Guests follow the host. `expected` projects the host's last known position
    // forward by however long ago they reported it — so a 1s poll interval, or a
    // slow request, doesn't leave the guest permanently a second behind.
    if (this.isGuest && this.state === 'playing' && this.onRemoteState) {
      this.onRemoteState({
        position: r.position,
        paused: r.paused,
        expected: this._project(r)
      });
    }
  }

  /** The host's position as of *now*, projected forward if they're playing. */
  _project(r) {
    const pos = Number(r.position) || 0;
    if (r.paused) return pos;
    const since = this.serverNow() - new Date(r.host_updated_at).getTime();
    return pos + Math.max(0, since) / 1000;
  }

  /**
   * Re-sync the clock offset from a response. Smoothed after the first sample so
   * one slow round-trip can't yank the projection around; the request latency
   * itself is unknowable, so this is deliberately approximate — a fraction of a
   * second of error is far below the 2s correction threshold.
   */
  _absorb(r) {
    if (!r) return;
    this._last = r;
    if (!r.server_now) return;
    const sample = new Date(r.server_now).getTime() - Date.now();
    if (!isFinite(sample)) return;
    if (!this._offsetSeen) { this._offset = sample; this._offsetSeen = true; }
    else this._offset = this._offset * 0.8 + sample * 0.2;
  }

  _update(fields) {
    return post({ action: 'update', code: this.code, device_id: getDeviceCode(), ...fields });
  }
}

/* -------------------------------------------------------------------- utils */

/**
 * SHA-256 of the active playlist's server host. This is the only thing that
 * identifies the provider to the backend — credentials stay local.
 */
async function subHash() {
  const key = await getActiveSubscriptionKey();
  if (!key) {
    const e = new Error('No playlist is set up on this device.');
    e.code = 'no_playlist';
    throw e;
  }
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function post(body) {
  let res;
  try {
    res = await fetch(`${CLOUD_BASE}/api/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000)
    });
  } catch (e) {
    const err = new Error('Could not reach the server. Check your connection.');
    err.code = 'network';
    throw err;
  }

  let json = null;
  try { json = await res.json(); } catch (e) {}

  if (!res.ok) {
    const code = (json && json.error) || `http_${res.status}`;
    const err = new Error(messageFor(code));
    err.code = code;
    throw err;
  }
  return json || {};
}

function messageFor(code) {
  switch (code) {
    case 'not_found': return 'That code isn\'t valid — check it and try again.';
    case 'subscription_mismatch': return 'Cannot join session — different provider.';
    case 'not_host': return 'Only the host can control this session.';
    case 'no_playlist': return 'No playlist is set up on this device.';
    default: return 'Something went wrong. Try again.';
  }
}

/** Identity-only comparison — `last_seen` churns every poll and isn't rendered. */
function guestsDiffer(a, b) {
  const ka = (a || []).map((g) => g.device).sort().join(',');
  const kb = (b || []).map((g) => g.device).sort().join(',');
  return ka !== kb;
}

export const watchTogether = new WatchTogether();
