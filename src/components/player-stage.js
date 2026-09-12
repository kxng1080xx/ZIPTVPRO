/**
 * Expanding player stage + idle auto-fullscreen (ZIPTV Pro 9.1, desktop only).
 *
 * Three behaviours, all confined to the desktop Live TV layout:
 *
 *   1. The stage is SMALL while nothing is playing and expands once playback
 *      starts. Idle, the player is a "Ready to stream" placeholder and the
 *      channel grid is what you are actually reading, so the grid gets the
 *      room; the moment there is a picture, the picture earns it back.
 *
 *   2. After 15s of no user input WHILE PLAYING, it goes fullscreen by itself —
 *      the lean-back case, where you have stopped driving and are just watching.
 *
 *   3. Any real input while in that auto-fullscreen drops straight back out,
 *      and auto-fullscreen then STAYS DISARMED until fullscreen is entered
 *      manually again.
 *
 * Rule 3's disarm is the important half. Without it the thing ping-pongs: input
 * exits, 15s of stillness re-enters, a nudge of the mouse exits again, forever.
 * Arming only on an explicit, manual fullscreen means the automatic behaviour
 * happens at most once per decision by the user, never in a loop.
 *
 * Why not the Fullscreen API for rule 2: requestFullscreen() needs transient
 * user activation, and a 15-second idle timer is by definition the opposite of
 * that — the browser rejects it. So this uses Electron's window fullscreen
 * (no gesture required) plus a CSS immersive state, which is also how the
 * native builds already do it (body.player-fs).
 */

const IDLE_MS = 15000;        // stillness before auto-fullscreen
const GRACE_MS = 1200;        // ignore input right after entering, or the act
                              // of entering can immediately dismiss it
const MOUSE_SLOP = 12;        // px; ignore sub-pixel drift and cheap-mouse jitter

let video = null;
let row = null;
let idleTimer = null;

let playing = false;
let autoFsActive = false;     // WE put it in fullscreen (not the user)
let armed = true;             // may auto-fullscreen at all
let enteredAt = 0;
let lastX = null;
let lastY = null;

const isElectron = () => !!(window.appHost && window.appHost.isElectron);

/**
 * Desktop only. The TV shell runs its own 10-foot layout and its own key
 * handling, and the Capacitor builds have the rotate/native-surface fullscreen
 * path — this would fight both.
 */
function desktopOnly() {
  const b = document.body;
  return !b.classList.contains('tv-layout') && !b.classList.contains('app-native');
}

// --------------------------------------------------------------------------
// Stage size
// --------------------------------------------------------------------------
function setPlaying(on) {
  if (playing === on) return;
  playing = on;
  if (row) row.classList.toggle('is-playing', on);
  if (on) {
    restartIdle();
  } else {
    clearTimeout(idleTimer);
    idleTimer = null;
    // Nothing is playing, so nothing should be fullscreen because of us.
    if (autoFsActive) exitAutoFs();
  }
}

// --------------------------------------------------------------------------
// Auto fullscreen
// --------------------------------------------------------------------------
function enterAutoFs() {
  if (autoFsActive || !playing || !armed || !desktopOnly()) return;
  autoFsActive = true;
  enteredAt = Date.now();
  // Disarm immediately, not on the way out: if anything interrupts before the
  // exit path runs, the worst case must still be "no more automatic
  // fullscreen", never a loop.
  armed = false;
  document.body.classList.add('player-autofs');
  if (isElectron()) {
    try { window.appHost.setFullscreen(true); } catch (e) {}
  }
}

function exitAutoFs() {
  if (!autoFsActive) return;
  autoFsActive = false;
  document.body.classList.remove('player-autofs');
  if (isElectron()) {
    try { window.appHost.setFullscreen(false); } catch (e) {}
  }
  clearTimeout(idleTimer);
  idleTimer = null;   // stays off until a manual fullscreen re-arms it
}

function restartIdle() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!playing || !armed || autoFsActive) return;
  idleTimer = setTimeout(enterAutoFs, IDLE_MS);
}

/**
 * Something the user actually did.
 *
 * In auto-fullscreen this dismisses it; otherwise it just postpones the idle
 * timer. Mouse movement is deliberately filtered by MOUSE_SLOP — an optical
 * mouse reports movement from a passing lorry, and "fullscreen collapses on
 * its own" would be a far worse bug than "fullscreen needed a deliberate
 * nudge to leave".
 */
function onUserInput(e) {
  if (!desktopOnly()) return;

  if (e && e.type === 'mousemove') {
    const { clientX: x, clientY: y } = e;
    if (lastX !== null && Math.abs(x - lastX) < MOUSE_SLOP && Math.abs(y - lastY) < MOUSE_SLOP) {
      return;   // drift, not intent
    }
    lastX = x;
    lastY = y;
  }

  if (autoFsActive) {
    if (Date.now() - enteredAt < GRACE_MS) return;
    exitAutoFs();
    return;
  }
  restartIdle();
}

/**
 * A manual fullscreen re-arms the automatic one.
 *
 * This is the only way back: having dropped out once, the user has to ask for
 * fullscreen themselves before the app is allowed to choose it again. Entering
 * while `autoFsActive` is our own doing and must not re-arm.
 */
function onFullscreenChange() {
  const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (inFs && !autoFsActive) {
    armed = true;
    restartIdle();
  }
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------
/**
 * Call once at startup. Safe on every platform — it no-ops where it doesn't
 * apply, and re-checks desktopOnly() on each event because the UI mode can be
 * switched at runtime (Settings → TV interface).
 */
export function initPlayerStage() {
  video = document.getElementById('main-video-player');
  row = document.querySelector('.live-top-row');
  if (!video || !row) return;

  // Playback state. 'playing' rather than 'play' so a source that never
  // actually starts doesn't expand the stage over a black box.
  video.addEventListener('playing', () => setPlaying(true));
  video.addEventListener('pause', () => setPlaying(false));
  video.addEventListener('ended', () => setPlaying(false));
  video.addEventListener('emptied', () => setPlaying(false));

  // Capture phase: the player overlay stops propagation on some of these, and
  // an input the user made must count even when a control swallows it.
  const opts = { capture: true, passive: true };
  ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart'].forEach((t) => {
    document.addEventListener(t, onUserInput, opts);
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
}

/** Manual override, for a Settings toggle or a keybinding later. */
export function cancelAutoFullscreen() {
  armed = false;
  exitAutoFs();
}
