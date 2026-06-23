/**
 * Native player bridge. Browser <video>/mpegts.js/hls.js can't decode the
 * E-AC3/AC3 audio, HEVC video, or MKV containers that premium VOD (and some
 * live) streams use — you get video with no audio, or nothing at all. This
 * routes playback to a real native player that uses the device's hardware
 * codecs (same as IPTV Smarters / VLC):
 *   - Android (APK):  ExoPlayer (Media3) via the NativeVideo Capacitor plugin.
 *   - Electron (PC):  embedded mpv via the appHost.nativeVideo IPC bridge.
 *   - Web:            unavailable (no native layer) → caller uses <video>.
 *
 * The player.js engine tries this first and falls back to the browser path on
 * any failure, so a native problem can never regress working playback.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

const AndroidNative = (() => {
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      return registerPlugin('NativeVideo');
    }
  } catch (e) {}
  return null;
})();

// Electron exposes a native-video bridge on the preload (window.appHost.nativeVideo).
const ElectronNative = (() => {
  try {
    if (window.appHost && window.appHost.nativeVideo) return window.appHost.nativeVideo;
  } catch (e) {}
  return null;
})();

export function isNativeAvailable() {
  return !!(AndroidNative || ElectronNative);
}

export function nativeBackend() {
  if (AndroidNative) return 'android';
  if (ElectronNative) return 'electron';
  return null;
}

// Normalize both backends behind one interface. All methods are async and must
// never throw synchronously (callers race them against a fallback timer).
function impl() {
  if (AndroidNative) {
    return {
      load: (o) => AndroidNative.load(o),
      play: () => AndroidNative.play(),
      pause: () => AndroidNative.pause(),
      seek: (position) => AndroidNative.seek({ position }),
      setVolume: (volume) => AndroidNative.setVolume({ volume }),
      setRect: (r) => AndroidNative.setRect(r),
      stop: () => AndroidNative.stop(),
      getAudioTracks: () => AndroidNative.getAudioTracks(),
      on: (event, cb) => AndroidNative.addListener(event, cb),
    };
  }
  if (ElectronNative) {
    return {
      load: (o) => ElectronNative.load(o),
      play: () => ElectronNative.play(),
      pause: () => ElectronNative.pause(),
      seek: (position) => ElectronNative.seek(position),
      setVolume: (volume) => ElectronNative.setVolume(volume),
      setRect: (r) => (ElectronNative.setRect ? ElectronNative.setRect(r) : null),
      stop: () => ElectronNative.stop(),
      getAudioTracks: () => ElectronNative.getAudioTracks(),
      on: (event, cb) => ElectronNative.on(event, cb),
    };
  }
  return null;
}

const listenerHandles = [];

/**
 * Start native playback. Resolves once the native engine reports it has loaded
 * and is producing video, rejects (or times out) so the caller can fall back.
 *
 * @param {object} opts { url, isLive, startAt, title }
 * @param {object} cbs  { onReady, onTime, onEnded, onError, onBuffering }
 */
export async function nativePlay(opts, cbs = {}) {
  const api = impl();
  if (!api) throw new Error('native player unavailable');

  // (Re)bind event listeners for this session.
  await detachListeners();
  const bind = async (event, fn) => {
    if (!fn) return;
    try {
      const h = await api.on(event, fn);
      if (h) listenerHandles.push(h);
    } catch (e) {}
  };
  await bind('ready', (d) => cbs.onReady && cbs.onReady(d || {}));
  await bind('timeupdate', (d) => cbs.onTime && cbs.onTime(d || {}));
  await bind('ended', () => cbs.onEnded && cbs.onEnded());
  await bind('error', (d) => cbs.onError && cbs.onError(d || {}));
  await bind('buffering', (d) => cbs.onBuffering && cbs.onBuffering(d || {}));
  await bind('vout', (d) => cbs.onVout && cbs.onVout(d || {}));
  await bind('state', (d) => cbs.onState && cbs.onState(d || {}));

  // Resolve once the engine reports "ready" (Playing). A stuck engine must not
  // hang the spinner forever, so we time out — but an engine that is visibly
  // alive (opening/buffering) gets its inactivity timer reset on every event,
  // capped by an absolute deadline, so a slow software-decode start isn't killed
  // prematurely and dumped to a browser that can't decode it anyway. The reject
  // carries the last libVLC state so the caller can show a meaningful error.
  let lastState = 'init';
  let sawLife = false;
  return new Promise((resolve, reject) => {
    let settled = false;
    const INACTIVITY_MS = 15000;  // no events at all for this long → give up
    const ABSOLUTE_MS = 60000;    // hard ceiling even while buffering
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(inactivity);
      clearTimeout(absolute);
      if (ok) resolve({ sawLife, lastState });
      else { const e = err || new Error('native play failed'); e.sawLife = sawLife; e.lastState = lastState; reject(e); }
    };
    let inactivity = setTimeout(() => done(false, new Error('native load timeout (no events)')), INACTIVITY_MS);
    const absolute = setTimeout(() => done(false, new Error(`native stalled (last state: ${lastState})`)), ABSOLUTE_MS);
    const kick = () => { sawLife = true; clearTimeout(inactivity); inactivity = setTimeout(() => done(false, new Error(`native stalled (last state: ${lastState})`)), INACTIVITY_MS); };

    // Resolve on ready (Playing). Keep the engine "alive" on any progress event.
    const origReady = cbs.onReady;
    cbs.onReady = (d) => { done(true); if (origReady) origReady(d); };
    const origErr = cbs.onError;
    cbs.onError = (d) => { done(false, new Error((d && d.message) || 'native error')); if (origErr) origErr(d); };
    const origState = cbs.onState;
    cbs.onState = (d) => { if (d && d.state) lastState = d.state; kick(); if (origState) origState(d); };
    const origBuf = cbs.onBuffering;
    cbs.onBuffering = (d) => { kick(); if (origBuf) origBuf(d); };
    const origVout = cbs.onVout;
    cbs.onVout = (d) => { kick(); if (origVout) origVout(d); };

    Promise.resolve(api.load(opts)).then(() => {
      // load resolved — but wait for ready for true success; keep timers.
    }).catch((e) => done(false, e));
  });
}

export async function nativePlayCtl() { const a = impl(); return a ? a.play() : null; }
export async function nativePauseCtl() { const a = impl(); return a ? a.pause() : null; }
export async function nativeSeek(pos) { const a = impl(); return a ? a.seek(pos) : null; }
export async function nativeSetVolume(v) { const a = impl(); return a ? a.setVolume(v) : null; }
export async function nativeSetRect(r) { const a = impl(); return a && a.setRect ? a.setRect(r) : null; }
export async function nativeGetAudioTracks() { const a = impl(); return a ? a.getAudioTracks() : { tracks: [] }; }

export async function nativeStop() {
  const a = impl();
  await detachListeners();
  if (a) { try { await a.stop(); } catch (e) {} }
}

async function detachListeners() {
  while (listenerHandles.length) {
    const h = listenerHandles.pop();
    try { if (h && h.remove) await h.remove(); } catch (e) {}
  }
}
