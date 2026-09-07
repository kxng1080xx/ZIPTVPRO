/**
 * Netflix-style poster-dwell trailer preview (ZIPTV Pro 9.0).
 *
 * Rest on a poster for ~2s and it expands into a 16:9 frame that plays the
 * title's YouTube trailer, muted.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL DESIGN RULE: the frame is not allowed to depend on the video.
 * ---------------------------------------------------------------------------
 * Netflix serves its own preview clips from its own CDN. We can't — we have a
 * YouTube key from TMDB, and YouTube fails in ways we don't control:
 *
 *   - TMDB's `videos` array is user-contributed; coverage is thin outside
 *     recent mainstream titles, and dead keys are never pruned.
 *   - Plenty of official uploads are flagged "no embedding", which only
 *     surfaces as a player error AFTER loading.
 *   - Old TV WebViews (Fire OS ships pre-Chromium-103) may refuse inline
 *     playback entirely.
 *   - youtube.com is exactly the sort of host ISP/DNS filters block.
 *
 * So the frame opens IMMEDIATELY on the TMDB backdrop — an image we already
 * have — and the video fades in over it only once it reports as actually
 * playing. Every failure above degrades to "a nice widescreen still", which is
 * indistinguishable from intent. If the video were the requirement instead of
 * the bonus, every one of those cases would read as a bug.
 *
 * ---------------------------------------------------------------------------
 * One embed path everywhere: a plain <iframe>
 * ---------------------------------------------------------------------------
 * The desktop build briefly used a <webview> on its own ad-blocked session.
 * Both justifications turned out to be false: the renderer is served from
 * http://localhost:<serverPort> (not file://), so an iframe has a perfectly
 * good origin; and pointing the ad-blocker at YouTube stripped resources the
 * player needs, so the embed never started. The tell was that identical code
 * played under `npm run dev` and on Android — both iframe paths — and failed
 * only in the packaged EXE. One path now, so dev behaviour is shipped
 * behaviour.
 */

const DWELL_MS = 2000;        // how long focus must rest before opening
const VIDEO_FADE_MS = 420;    // backdrop -> video cross-fade
// Generous on purpose: YouTube's player can take several seconds to actually
// start rolling on a cold session, and giving up early tears the embed down
// and strands the frame on the still image.
const PLAY_TIMEOUT_MS = 15000;
const POLL_MS = 450;          // how often we ask the guest if it is really playing

let overlay = null;      // the frame element (created once, reused)
let mediaHost = null;    // the <iframe>, recreated per trailer
let backdropEl = null;
let titleEl = null;
let stylesInjected = false;

let dwellTimer = null;
let playTimer = null;
let openSeq = 0;         // invalidates async work from a previous open
let detachPlaybackListener = null;
let pollTimer = null;      // reserved for playback probing
let currentAnchor = null;
let hiddenAnchor = null;   // tile currently faded out beneath an open frame
let shiftedTiles = [];     // neighbours currently translated aside
let enabled = true;

const isElectron = () => !!(window.appHost && window.appHost.isElectron);

/** True inside the Capacitor APK (Android), false in Electron and the browser. */
function isNativeApp() {
  try {
    return !!(window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' &&
      window.Capacitor.isNativePlatform());
  } catch (e) { return false; }
}

/** The v7 10-foot shell is mounted (body gets `tv-native` when it activates). */
function tvShellActive() {
  try { return document.body.classList.contains('tv-native'); } catch (e) { return false; }
}

/** localStorage `trailerMuted` = 'on' silences previews. Default: sound on. */
function mutedPref() {
  try { return localStorage.getItem('trailerMuted') === 'on'; } catch (e) { return false; }
}

/** Preview audio sits under normal playback level so it never startles. */
const PREVIEW_VOLUME = 55;

/**
 * Is this device too weak to spin up an embedded browser on poster focus?
 *
 * Deliberately NOT `body.perf-lite`. That flag auto-enables for ANY tv-layout
 * (see shouldAutoLite in main.js), which is true even on a powerful Windows
 * desktop in TV mode — gating on it would disable this feature on 100% of the
 * TV UI, i.e. exactly where it was asked for.
 *
 * So we check what perf-lite is actually a proxy for: genuinely weak hardware.
 * The UA list mirrors main.js's, minus the tv-layout catch-all. An explicit
 * user opt-in to perf-lite is still honoured — if someone has deliberately
 * asked for less, respect it.
 */
function deviceLooksWeak() {
  try {
    if (typeof __LEGACY__ !== 'undefined' && __LEGACY__) return true;
    // Explicit user choice (not the auto-detected default).
    if (localStorage.getItem('perfLite') === 'on') return true;
    const ua = (navigator.userAgent || '').toLowerCase();
    if (/aft|tizen|web0s|webos|smart-?tv|googletv|android tv|bravia|netcast/.test(ua)) return true;
  } catch (e) {}
  return false;
}

/**
 * Hard-off conditions, checked at open time rather than cached — settings and
 * the OS motion preference can both change while the app is running.
 *
 * localStorage `trailerPreview`: 'on' forces it even on weak hardware, 'off'
 * disables it entirely, absent = auto (on unless the device looks weak).
 */
function previewAllowed() {
  if (!enabled) return false;
  try {
    let pref = null;
    try { pref = localStorage.getItem('trailerPreview'); } catch (e) {}
    if (pref === 'off') return false;

    // APK: TV shell only. The phone's portrait layout has no room for a 16:9
    // frame that expands out of a poster and shoves its neighbours aside - it
    // ends up covering most of the screen and reads as a bug rather than a
    // feature. On a TV the same gesture is the whole point. Deliberately not
    // overridable by `trailerPreview: 'on'`: this is a layout constraint, not a
    // performance one. Electron and the browser are unaffected.
    if (isNativeApp() && !tvShellActive()) return false;

    if (pref !== 'on' && deviceLooksWeak()) return false;
    // Someone who asked the OS for less motion should not get autoplaying video.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch (e) {}
  return true;
}

// Styles live here rather than in style.css/tv-native.css because this one
// component renders into both shells; a single injected block keeps them from
// drifting apart. No color-mix() anywhere — old TV WebViews drop the entire
// declaration containing it, which would strip these rules on the devices that
// can least afford a broken layout.
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.ztp-preview {
  position: fixed;
  z-index: 9000;
  border-radius: 14px;
  overflow: hidden;
  background: #05070d;
  box-shadow: 0 26px 70px rgba(0, 0, 0, 0.75), 0 0 0 2px rgba(255, 255, 255, 0.16);
  opacity: 0;
  /* Starts at exactly the anchor tile's scale (set inline per-open) and grows
     to full size, so it reads as the poster expanding rather than a popup
     appearing over it. */
  transform: scale(var(--ztp-start, 0.5));
  transform-origin: center center;
  transition: opacity 0.2s ease, transform 0.34s cubic-bezier(0.22, 0.61, 0.24, 1);
  pointer-events: none;
}
.ztp-preview.is-open { opacity: 1; transform: scale(1); }
.ztp-preview-backdrop {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  object-fit: cover;
  background: #05070d;
}
/* The embed is deliberately LARGER than the frame that clips it.
   YouTube anchors its chrome to the player's own edges - the video title and
   channel avatar across the top, the share / "More videos" / logo bar across
   the bottom - and there is no supported way to switch those off
   (modestbranding is deprecated and now does nothing). Oversizing the iframe
   and centring it pushes that furniture outside the clipped area, leaving
   just picture. Costs a modest crop, which on a preview tile reads as
   framing rather than loss. */
.ztp-preview-media {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 134%;
  height: 134%;
  transform: translate(-50%, -50%);
  border: 0;
  opacity: 0;
  transition: opacity ${VIDEO_FADE_MS}ms ease;
  background: transparent;
}
.ztp-preview.is-playing .ztp-preview-media { opacity: 1; }
/* Scrim + title ride ABOVE the video so the frame still reads as part of the
   UI rather than a bare embed. */
.ztp-preview-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(0deg, rgba(3, 5, 10, 0.92) 0%, rgba(3, 5, 10, 0) 46%);
  pointer-events: none;
}
.ztp-preview-title {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: 12px;
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
body.perf-lite .ztp-preview { transition: none; }

/* The tile being previewed is hidden while its frame is open — otherwise the
   poster art and its focus ring sit behind the frame and the two read as two
   separate things. opacity (not visibility/display) so the row keeps its
   layout and the element keeps DOM focus. */
.ztp-anchor-previewing {
  opacity: 0 !important;
  transition: opacity 0.16s ease;
}

/* Neighbouring tiles roll out of the expanding frame's way. transform only —
   never width/margin — so the whole motion is GPU-composited and the row never
   reflows; a layout animation per dwell would stutter badly on a TV stick.
   !important out-specifies .tvn-poster's own 0.15s transform transition, which
   would otherwise make the roll snap. */
.ztp-shifted {
  transition: transform 0.34s cubic-bezier(0.22, 0.61, 0.24, 1) !important;
}
`;
  const tag = document.createElement('style');
  tag.id = 'ztp-preview-styles';
  tag.textContent = css;
  document.head.appendChild(tag);
}

function ensureOverlay() {
  if (overlay) return overlay;
  injectStyles();
  overlay = document.createElement('div');
  overlay.className = 'ztp-preview';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML =
    '<img class="ztp-preview-backdrop" alt="">' +
    '<div class="ztp-preview-mediaslot"></div>' +
    '<div class="ztp-preview-scrim"></div>' +
    '<div class="ztp-preview-title"></div>';
  backdropEl = overlay.querySelector('.ztp-preview-backdrop');
  titleEl = overlay.querySelector('.ztp-preview-title');
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Size and place the frame over the anchor poster.
 *
 * Fixed positioning against the anchor's viewport rect, rather than expanding
 * the poster in place: reflowing a horizontally-scrolling poster row on a weak
 * TV box is visibly janky, and the row's own scroll position would fight the
 * animation. Clamped to the viewport so an edge poster's frame stays on screen.
 */
function positionOver(anchor) {
  // Measure the ARTWORK, not the whole tile: the tile includes a title label
  // underneath, so centring on it drops the frame low and leaves the label
  // sticking out below.
  const art = anchor.querySelector('.tvn-poster-art, .vod-poster-wrapper') || anchor;
  const r = art.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Keep clear of the 10-foot shell's screen padding; a frame that runs to the
  // physical edge looks like an overlay rather than part of the row.
  const SAFE = 48;

  // Horizontal bounds come from the tile's own container, not the viewport.
  // The desktop layout puts a Categories sidebar to the left of the grid, and
  // clamping to the window let the frame slide out over it. The row/grid rect,
  // intersected with the screen-safe area, keeps the frame inside the content
  // column on every layout.
  const holder = anchor.closest('.tvn-posterrow, .vod-grid, #movies-grid, #series-grid, .series-episodes-list')
    || anchor.parentElement;
  let minX = SAFE;
  let maxX = vw - SAFE;
  if (holder) {
    const h = holder.getBoundingClientRect();
    // A horizontally scrolling row is wider than the window, so only tighten
    // the bound, never loosen it.
    if (h.left > minX) minX = h.left;
    if (h.right < maxX) maxX = h.right;
    // Degenerate container (collapsed or offscreen): fall back to the screen.
    if (maxX - minX < 240) { minX = SAFE; maxX = vw - SAFE; }
  }

  // Height matches the poster tile EXACTLY, and the width follows from 16:9.
  // Driving it the other way round (width first) left the frame shorter than
  // the row, so the expanded tile sat in a band of its own instead of sitting
  // flush with its neighbours.
  // offsetHeight, not the bounding rect: the focused tile is CSS-scaled to
  // 1.09, and matching that would leave the frame standing proud of its
  // unscaled neighbours. Layout height is what the row actually is.
  let height = art.offsetHeight || r.height;
  let width = height * 16 / 9;
  // Only if that would overrun the screen does the height give way.
  const maxWidth = maxX - minX;
  if (width > maxWidth) {
    width = maxWidth;
    height = width * 9 / 16;
  }
  width = Math.round(width);
  height = Math.round(height);

  // Prefer centred on the tile. When centring would overrun a screen edge,
  // anchor to that edge of the TILE and grow inward instead of sliding the
  // frame away from the poster it belongs to — an edge tile should visibly
  // expand from itself, not drift toward the middle of the screen.
  let left = r.left + r.width / 2 - width / 2;
  if (left < minX) left = Math.max(minX, r.left);
  else if (left + width > maxX) left = Math.min(maxX - width, r.right - width);

  let top = r.top + r.height / 2 - height / 2;
  top = Math.max(8, Math.min(top, vh - height - 8));

  overlay.style.left = `${Math.round(left)}px`;
  overlay.style.top = `${Math.round(top)}px`;
  overlay.style.width = `${Math.round(width)}px`;
  overlay.style.height = `${Math.round(height)}px`;
  // Begin the animation at the tile's own width so it visibly grows out of it.
  const startScale = Math.max(0.25, Math.min(0.95, (art.offsetWidth || r.width) / width));
  overlay.style.setProperty('--ztp-start', String(startScale));

  // How far the frame spills past the tile on each side. Derived from the
  // final geometry rather than assumed, so it stays correct whether the frame
  // ended up centred, left-anchored or right-anchored.
  const GAP = 34;   // breathing room so neighbours don't kiss the frame edge
  return {
    overhangLeft: Math.max(0, Math.round(r.left - left)) + GAP,
    overhangRight: Math.max(0, Math.round((left + width) - r.right)) + GAP
  };
}

/**
 * Roll the anchor's row-neighbours out of the way of the expanded frame.
 *
 * Only tiles near the viewport are touched: a paged poster row can hold
 * hundreds of items, and transforming all of them would cost far more than the
 * handful anyone can actually see.
 */
function shiftSiblings(anchor, overhangLeft, overhangRight) {
  clearSiblings();
  const row = anchor.parentElement;
  if (!row) return;
  const kids = Array.from(row.children);
  const idx = kids.indexOf(anchor);
  if (idx === -1) return;
  const vw = window.innerWidth;

  kids.forEach((el, i) => {
    if (el === anchor || !el.getBoundingClientRect) return;
    const b = el.getBoundingClientRect();
    if (b.right < -240 || b.left > vw + 240) return;   // far offscreen
    const dx = i < idx ? -overhangLeft : overhangRight;
    if (!dx) return;
    el.classList.add('ztp-shifted');
    el.style.transform = `translateX(${dx}px)`;
    shiftedTiles.push(el);
  });
}

/** Let the neighbours roll back, then drop the transition class. */
function clearSiblings() {
  if (!shiftedTiles.length) return;
  const tiles = shiftedTiles;
  shiftedTiles = [];
  for (const el of tiles) {
    try { el.style.transform = ''; } catch (e) {}
  }
  setTimeout(() => {
    for (const el of tiles) {
      // Only strip the transition if this tile hasn't been re-shifted since.
      if (!shiftedTiles.includes(el)) {
        try { el.classList.remove('ztp-shifted'); } catch (e) {}
      }
    }
  }, 360);
}

/** Remove the embed and stop playback. Called on every close and re-open. */
function teardownMedia() {
  clearTimeout(playTimer);
  playTimer = null;
  if (detachPlaybackListener) { try { detachPlaybackListener(); } catch (e) {} detachPlaybackListener = null; }
  clearInterval(pollTimer);
  pollTimer = null;
  if (overlay) overlay.classList.remove('is-playing');
  if (mediaHost) {
    // about:blank first: dropping a <webview>/<iframe> without navigating away
    // can leave audio running for a beat on some builds.
    try { mediaHost.src = 'about:blank'; } catch (e) {}
    try { mediaHost.remove(); } catch (e) {}
    mediaHost = null;
  }
}

function embedUrl(key) {
  const p = new URLSearchParams({
    autoplay: '1',
    // Sound on by default. Electron lifts Chromium's unmuted-autoplay block
    // via the autoplay-policy switch (main.electron.cjs); browsers do not, so
    // there the widget quietly falls back to muted playback and the postMessage
    // unmute below is a no-op. `trailerMuted` lets a user force silence.
    mute: mutedPref() ? '1' : '0',
    controls: '0',
    modestbranding: '1',
    rel: '0',
    playsinline: '1',
    iv_load_policy: '3',  // no annotations
    disablekb: '1',
    fs: '0',
    loop: '1',
    playlist: key,        // required for loop=1 on a single video
    // Opens the postMessage channel we use to detect REAL playback. No extra
    // script needed — the widget answers a plain postMessage handshake.
    enablejsapi: '1'
  });
  // `origin` is a security check on YouTube's side and must be a real http(s)
  // origin. The Electron build runs from file://, where sending it breaks the
  // embed outright — that path uses <webview> anyway.
  try {
    if (/^https?:$/.test(location.protocol)) p.set('origin', location.origin);
  } catch (e) {}
  return `https://www.youtube.com/embed/${encodeURIComponent(key)}?${p.toString()}`;
}

/**
 * Listen for the YouTube widget reporting state PLAYING (1).
 *
 * Why not just trust the iframe's `load` event: a load fires for ANY page the
 * embed resolves to, including "Sign in to confirm you're not a bot", the
 * video-unavailable screen, and the embedding-disabled error. Treating load as
 * playback faded a bot-challenge dialog in over a perfectly good backdrop —
 * observed, not theoretical, and more likely on connections whose IP
 * reputation is poor.
 *
 * Returns a detach function.
 */
function listenForPlayback(iframe, onPlaying, onStopped) {
  const onMessage = (ev) => {
    if (!/^https?:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(ev.origin)) return;
    if (!mediaHost || ev.source !== mediaHost.contentWindow) return;
    let d = ev.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
    if (!d) return;
    // Two shapes depending on widget version.
    const state = d.event === 'infoDelivery' ? d.info && d.info.playerState
                : d.event === 'onStateChange' ? d.info
                : undefined;
    if (state === 1) onPlaying();
    // 0 = ENDED. Left alone, YouTube replaces the video with its end-screen
    // grid of "More videos" thumbnails — the least premium thing that could
    // appear on a hover preview.
    else if (state === 0 && onEnded) onEnded();
  };
  window.addEventListener('message', onMessage);

  // Ask the widget to start reporting. Repeated because the player may not be
  // listening the instant the frame's load event fires.
  let tries = 0;
  const ping = setInterval(() => {
    if (!mediaHost || ++tries > 12) { clearInterval(ping); return; }
    try {
      mediaHost.contentWindow.postMessage(
        JSON.stringify({ event: 'listening', id: 'ztp-trailer', channel: 'widget' }),
        'https://www.youtube.com'
      );
    } catch (e) {}
  }, 400);

  return () => {
    clearInterval(ping);
    window.removeEventListener('message', onMessage);
  };
}

/**
 * Mount the embed. Resolves true once it looks like playback started.
 *
 * "Looks like" is doing real work: a plain iframe gives us no playback signal
 * without pulling in the YouTube IFrame API (another script from a host that
 * may be blocked), so a successful load event plus a short settle is the
 * signal. Either way the frame is
 * already showing the backdrop, so a wrong guess costs nothing.
 */
function mountMedia(key, seq) {
  const slot = overlay.querySelector('.ztp-preview-mediaslot');
  if (!slot) return;

  // The widget accepts commands over the same postMessage channel used to
  // detect playback, so this needs no extra script. (A <webview> has no
  // contentWindow, so these are no-ops there — that path relies on the URL
  // params and its own events instead.)
  const command = (func, args) => {
    try {
      const w = mediaHost && mediaHost.contentWindow;
      if (!w) return;
      w.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), 'https://www.youtube.com');
    } catch (e) {}
  };

  // Diagnostics: this feature has several silent failure modes (wrong embed
  // path, guest never loading, playback never confirmed) that all look
  // identical on screen — a frame stuck on the backdrop. Logging which branch
  // ran and what it heard back turns "not playing" into an answerable
  // question from the app's own DevTools (F12).
  const log = (...a) => { try { console.log('[trailer]', ...a); } catch (e) {} };
  log('mounting iframe, key=', key);

  const markPlaying = () => {
    if (seq !== openSeq) return;
    clearTimeout(hideTimer);   // a restart that worked cancels the fallback
    log('revealing video');
    overlay.classList.add('is-playing');
    applyAudio();
  };

  // Volume is set BEFORE unmuting so a trailer never opens at full blast.
  const applyAudio = () => {
    if (mutedPref()) return;
    command('setVolume', [PREVIEW_VOLUME]);
    command('unMute');
  };

  // Whenever the player stops being in PLAYING state it paints its own UI over
  // the video: a large centre play/pause glyph, and after ENDED the grid of
  // "More videos" thumbnails. That centre furniture sits mid-frame, so unlike
  // the top and bottom bars it cannot be cropped away - the only remedy is to
  // stop showing the video and fall back to the still.
  //
  // ENDED gets a couple of silent restarts first, because `loop=1` is
  // unreliable for a single video. PAUSED should not happen at all (the embed
  // has no controls and nothing can click it), so treat it as a stall and give
  // it one nudge before giving up.
  let replays = 0;
  let hideTimer = null;
  const MAX_REPLAYS = 2;

  const showStill = () => {
    if (seq !== openSeq || !overlay) return;
    log('player stopped - falling back to the backdrop');
    overlay.classList.remove('is-playing');
  };

  const handleStopped = (state) => {
    if (seq !== openSeq) return;
    // Hide almost immediately; YouTube paints its chrome the instant it stops,
    // so a slow fallback is a visible flash of their UI. A restart that works
    // re-fires PLAYING and cancels this.
    clearTimeout(hideTimer);
    hideTimer = setTimeout(showStill, 220);
    if (replays++ >= MAX_REPLAYS) return;
    log('state', state, '- attempting restart', replays);
    if (state === 0) command('seekTo', [0, true]);
    command('playVideo');
  };

  // ONE path for every platform: a plain <iframe>.
  //
  // The desktop build used a <webview partition="persist:trailers"> for two
  // stated reasons, and BOTH were wrong:
  //
  //   1. "The renderer runs from file://, so YouTube refuses an iframe."
  //      It does not — main.electron.cjs loads http://localhost:<serverPort>,
  //      a real http origin, exactly like the dev server. An iframe is fine.
  //
  //   2. "That session gets the ad-blocker, so no pre-rolls."
  //      Pointing the Ghostery ads-and-tracking engine at YouTube also strips
  //      resources its player needs, and the embed never starts. The symptom
  //      was decisive: identical code played fine under `npm run dev` (a
  //      browser, so the iframe path) and failed in the packaged EXE (the
  //      webview path). A trailer that plays with an occasional ad beats one
  //      that reliably shows nothing.
  //
  // Keeping a single code path also means the behaviour you debug in dev is
  // the behaviour that ships.
  {
    const fr = document.createElement('iframe');
    fr.className = 'ztp-preview-media';
    fr.setAttribute('allow', 'autoplay; encrypted-media');
    fr.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    fr.setAttribute('frameborder', '0');
    fr.src = embedUrl(key);
    mediaHost = fr;
    // Preferred signal: the widget reporting playerState PLAYING over
    // postMessage — see listenForPlayback for why the load event alone lies.
    detachPlaybackListener = listenForPlayback(fr, markPlaying, handleStopped);

    // Safety net. The handshake is the better signal, but if it never lands
    // (widget version differences, a blocked postMessage, an origin the player
    // dislikes) the frame would sit on the backdrop forever — which is the bug
    // that shipped three times. Once the iframe has loaded and had a moment to
    // start, reveal it anyway. Worst case the viewer briefly sees a YouTube
    // error card instead of a still; far better than a feature that silently
    // does nothing.
    fr.addEventListener('load', () => {
      log('iframe loaded');
      setTimeout(() => {
        if (seq !== openSeq || !overlay) return;
        if (!overlay.classList.contains('is-playing')) {
          log('handshake never confirmed - revealing anyway');
          markPlaying();
        }
      }, 2500);
    });
  }

  slot.appendChild(mediaHost);

  // Safety net: if nothing reports back, stay on the backdrop rather than
  // fading in a frame that may be showing an error page.
  playTimer = setTimeout(() => {
    if (seq !== openSeq) return;
    if (!overlay.classList.contains('is-playing')) {
      log('gave up waiting for playback after', PLAY_TIMEOUT_MS, 'ms - staying on backdrop');
      teardownMedia();
    }
  }, PLAY_TIMEOUT_MS);
}

/**
 * Open the preview over `anchor`.
 * `meta` is a resolved TMDB object (see components/metadata.js) or null.
 */
function openPreview(anchor, meta, label) {
  const seq = ++openSeq;
  ensureOverlay();
  teardownMedia();

  const backdrop = meta?.backdrop || '';
  backdropEl.src = backdrop;
  backdropEl.style.display = backdrop ? '' : 'none';
  titleEl.textContent = meta?.title || label || '';

  const spill = positionOver(anchor);
  // Next frame, so the transition actually runs from the collapsed state.
  requestAnimationFrame(() => {
    if (seq !== openSeq) return;
    overlay.classList.add('is-open');
    // Neighbours roll aside on the same tick, so the frame growing and the row
    // opening up read as one movement.
    shiftSiblings(anchor, spill.overhangLeft, spill.overhangRight);
    // Hide the tile only once the frame is committed to opening, so a preview
    // that bails (below) never leaves a blank gap in the row.
    if (hiddenAnchor && hiddenAnchor !== anchor) hiddenAnchor.classList.remove('ztp-anchor-previewing');
    anchor.classList.add('ztp-anchor-previewing');
    hiddenAnchor = anchor;
  });

  // No backdrop AND no trailer means there is nothing worth showing — a bare
  // black rectangle over the poster is strictly worse than leaving the poster
  // alone. Bail rather than open an empty frame.
  if (!backdrop && !meta?.trailer?.key) {
    closePreview();
    return;
  }

  if (meta?.trailer?.key) {
    // Mount immediately. This used to wait on window.appHost.prepareTrailers(),
    // which armed the ad-blocker on the (now removed) webview session — and on
    // first run that call downloads the Ghostery filter lists, so the embed was
    // delayed by a network fetch before it even started. In the packaged app
    // that could outlast the give-up timer entirely, leaving the frame on the
    // backdrop. Nothing to arm now, so nothing to wait for.
    mountMedia(meta.trailer.key, seq);
  }
}

/** Collapse and fully tear down. Safe to call when nothing is open. */
export function closePreview() {
  clearTimeout(dwellTimer);
  dwellTimer = null;
  openSeq++;              // invalidate any in-flight open
  currentAnchor = null;
  clearSiblings();
  if (hiddenAnchor) {
    try { hiddenAnchor.classList.remove('ztp-anchor-previewing'); } catch (e) {}
    hiddenAnchor = null;
  }
  teardownMedia();
  if (overlay) {
    overlay.classList.remove('is-open', 'is-playing');
    if (backdropEl) backdropEl.removeAttribute('src');
  }
}

/**
 * Called when a poster takes focus. Starts the dwell countdown; the preview
 * only opens if focus is still on this anchor when it elapses.
 *
 * `resolveMeta` is a function returning a Promise for the TMDB object, so the
 * caller keeps ownership of how a title maps to a lookup. It is invoked
 * immediately — the network request overlaps the dwell instead of following
 * it, which is the difference between the frame opening at 2s and at 4s.
 */
export function armPreview(anchor, { resolveMeta, label = '' } = {}) {
  closePreview();
  if (!anchor || !previewAllowed() || typeof resolveMeta !== 'function') return;

  currentAnchor = anchor;
  const mine = anchor;

  // Warm the lookup NOW, not when the timer fires.
  let metaPromise = null;
  try { metaPromise = Promise.resolve(resolveMeta()); } catch (e) { metaPromise = Promise.resolve(null); }

  dwellTimer = setTimeout(async () => {
    if (currentAnchor !== mine) return;
    let meta = null;
    try { meta = await metaPromise; } catch (e) { meta = null; }
    // Focus may have moved while the lookup was still resolving.
    if (currentAnchor !== mine || !document.body.contains(mine)) return;
    if (!previewAllowed()) return;
    openPreview(mine, meta, label);
  }, DWELL_MS);
}

/** Runtime kill-switch (Settings toggle). Closes anything already open. */
export function setPreviewEnabled(on) {
  enabled = !!on;
  if (!enabled) closePreview();
}

export function isPreviewEnabled() {
  return enabled;
}
