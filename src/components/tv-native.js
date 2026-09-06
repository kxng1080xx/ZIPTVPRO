/**
 * ZIPTV Pro 7.0 — Native TV (10-foot) interface.
 *
 * Implements the "TV app native interface" design handoff: a launcher home,
 * a three-pane Live TV browser with live-reflection preview, poster-row
 * Movies/Series browse with a cinematic hero, plus the screens the design
 * left out (Guide, Settings, Search, details pages) built in the same
 * design language. Everything is D-pad navigable via a spatial focus engine.
 *
 * Architecture: this is a shell that renders into its own fixed overlay
 * (#tvn-root, a 1920×1080 stage scaled to the viewport) on top of the
 * existing app. Data flows through the existing xtream-api layer, and
 * playback hands off to the existing player stack (libVLC / timeshift /
 * fallbacks) via handlers injected from main.js — the shell hides itself
 * while video plays and restores itself when playback chrome goes away.
 */

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import {
  getCategories,
  getStreams,
  getEPG,
  getStreamInfo,
  getContinueWatching,
  removeWatchProgress,
  removeSeriesWatchProgress,
  getPlaylists,
  proxifyImage,
  getLastSyncAge,
  isCompleted,
  getWatchInfo
} from './xtream-api.js';
import { getAboutRows, DEVELOPER } from './about.js';

// --------------------------------------------------------------------------
// UI-mode persistence (Mobile vs TV) — asked on first APK boot, before login.
// --------------------------------------------------------------------------
const UI_MODE_KEY = 'ziptv_ui_mode';
// TV-only build (tv.apk): the classic UI isn't reachable, so hide every
// "switch interface" affordance. Injected by vite.config.js at build time.
const TV_ONLY = typeof __TV_ONLY__ !== 'undefined' && __TV_ONLY__;
const ACCENT_KEY = 'tvnAccent';
const ACCENTS = ['#38bdf8', '#f97316', '#34d399', '#a78bfa'];

export function getStoredUiMode() {
  try {
    const v = localStorage.getItem(UI_MODE_KEY);
    return (v === 'tv' || v === 'mobile') ? v : null;
  } catch (e) { return null; }
}

export function setStoredUiMode(mode) {
  try { localStorage.setItem(UI_MODE_KEY, mode); } catch (e) {}
}

// Leave the TV shell for the classic desktop/mobile UI and reload. Shared by
// the home-screen "Switch UI" card and the Settings > System tile.
function switchOutOfTvMode() {
  setStoredUiMode('mobile');
  try { if (window.appHost && window.appHost.setFullscreen) window.appHost.setFullscreen(false); } catch (e) {}
  // strip any /tv or ?tv override so the reload actually lands in the other UI
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('tv');
    url.pathname = url.pathname.replace(/\/tv\/?$/i, '/');
    window.location.href = url.toString();
  } catch (e) { window.location.reload(); }
}

function getAccent() {
  try {
    const v = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.includes(v) ? v : ACCENTS[0];
  } catch (e) { return ACCENTS[0]; }
}

/**
 * Write the accent onto an element as BOTH --acc (#rrggbb) and --acc-rgb
 * ('r, g, b'). The focus rings/halos are built with rgba(var(--acc-rgb), a)
 * rather than color-mix() because color-mix() doesn't parse on the old TV
 * WebViews (Fire OS 5, older Tizen/webOS) and one unparsable value drops the
 * whole box-shadow — which left D-pad focus invisible on those sets.
 */
function setAccent(node, hex) {
  if (!node) return;
  node.style.setProperty('--acc', hex);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  node.style.setProperty(
    '--acc-rgb',
    m ? parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) : '56, 189, 248'
  );
}

// Manrope (design typeface) — loaded only when the TV shell is used, with the
// app's existing stack as fallback so an offline TV still renders fine.
let fontLoaded = false;
function ensureFont() {
  if (fontLoaded) return;
  fontLoaded = true;
  try {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(l);
  } catch (e) {}
}

// --------------------------------------------------------------------------
// Module state
// --------------------------------------------------------------------------
let H = null;          // handlers injected from main.js
let root = null;       // #tvn-root
let stage = null;      // #tvn-stage (1920×1080)
let current = null;    // { name, params }
let stack = [];        // back stack (home = empty stack)
let scale = 1;
let clockTimer = null;
let progressTimer = null;
let hiddenForPlayback = false;
let sawPlayback = false;
let restoreFallbackTimer = null;
let lastFocusKey = {}; // per-screen focus memory
let zapList = [];      // channel list the last live playback started from (>> / << zapping)
let popupEl = null;    // #tvn-popup (popout list picker — confines D-pad nav while open)
// 7.1 playback OSD (the shell's own player chrome — live + VOD)
let osdEl = null;
let osdHideTimer = null;
let osdTickTimer = null;
let osdChannel = null;   // live channel currently playing (set via the H.playChannel wrap)
let osdProgram = null;   // current EPG programme for it (title / start / end)
let osdProgramNext = null; // the one after it (the OSD's "Playing Next" box)
let osdVod = null;       // VOD meta while a movie/episode plays { top, title, sub, next, logo } (set via window.__tvnOsdVod)
let osdPaused = false;
let osdFetchSeq = 0;

// per-session caches
const epgCache = new Map();      // streamId -> { at, listings }
const infoCache = new Map();     // "type:id" -> info
let catCache = null;             // live categories
let totalsCache = null;          // { live, movie, series, at }

export function isTvNativeActive() {
  return !!root;
}

// ==========================================================================
// SVG icon set (inline, from the design prototype)
// ==========================================================================
const I = {
  tv: (s = 28, c = 'var(--acc, #38bdf8)', w = 1.8) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"><rect x="3" y="8" width="18" height="12" rx="2.5"></rect><line x1="8" y1="3" x2="12" y2="8"></line><line x1="16" y1="3" x2="12" y2="8"></line></svg>`,
  movie: (s = 52, c = 'var(--acc, #38bdf8)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2.5"></rect><polygon points="10,9 15.5,12 10,15" fill="${c}" stroke="none"></polygon></svg>`,
  series: (s = 52, c = 'var(--acc, #38bdf8)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"><rect x="6" y="3" width="14" height="10" rx="2"></rect><rect x="4" y="11" width="14" height="10" rx="2" fill="#0d1220"></rect></svg>`,
  guide: (s = 40, c = 'var(--acc, #38bdf8)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2.5"></rect><line x1="3" y1="10" x2="21" y2="10"></line><line x1="9" y1="10" x2="9" y2="20"></line></svg>`,
  gear: (s = 40, c = 'var(--acc, #38bdf8)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"></circle><path d="M19.4 15a1.6 1.6 0 0 0 .32 1.76l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.76-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 1 1-4 0v-.09a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.76.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.76 1.6 1.6 0 0 0-1.47-.97H3a2 2 0 1 1 0-4h.09a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.76l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.76.32h.01a1.6 1.6 0 0 0 .96-1.47V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.76-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.76v.01a1.6 1.6 0 0 0 1.47.96H21a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.47.97z"></path></svg>`,
  search: (s = 26, c = 'rgba(255,255,255,0.65)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg>`,
  menu: (s = 26) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="18" x2="20" y2="18"></line><circle cx="9" cy="6" r="2.4" fill="#0d1220"></circle><circle cx="15" cy="12" r="2.4" fill="#0d1220"></circle><circle cx="7" cy="18" r="2.4" fill="#0d1220"></circle></svg>`,
  back: (s = 26) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="14,6 8,12 14,18"></polyline></svg>`,
  home: (s = 24) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,11 12,4 20,11"></polyline><rect x="7" y="11" width="10" height="9"></rect></svg>`,
  play: (s = 30, c = '#0a0f1a') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" stroke="none"><polygon points="8,4.5 20,12 8,19.5"></polygon></svg>`,
  power: (s = 24) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.75)" stroke-width="2.2" stroke-linecap="round"><path d="M18.4 6.6a9 9 0 1 1-12.8 0"></path><line x1="12" y1="2" x2="12" y2="11"></line></svg>`,
  star: '★',
  phone: (s = 52, c = 'var(--acc, #38bdf8)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round"><rect x="7" y="2.5" width="10" height="19" rx="2.5"></rect><line x1="10.5" y1="18.5" x2="13.5" y2="18.5"></line></svg>`,
  refresh: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>`,
  download: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  plus: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  list: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><circle cx="4" cy="6" r="1"></circle><circle cx="4" cy="12" r="1"></circle><circle cx="4" cy="18" r="1"></circle></svg>`,
  logout: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`,
  monitor: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`,
  zap: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
  info: (s = 30, c = 'currentColor') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
  pin: (s = 17, c = 'var(--acc, #38bdf8)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:7px;flex:none"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>`,
  pause: (s = 34, c = '#0a0f1a') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" stroke="none"><rect x="6.5" y="4.5" width="4" height="15" rx="1.2"></rect><rect x="13.5" y="4.5" width="4" height="15" rx="1.2"></rect></svg>`,
  skipPrev: (s = 26, c = '#fff') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" stroke="none"><polygon points="18,4.5 8,12 18,19.5"></polygon><rect x="5" y="4.5" width="2.6" height="15" rx="1"></rect></svg>`,
  skipNext: (s = 26, c = '#fff') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="${c}" stroke="none"><polygon points="6,4.5 16,12 6,19.5"></polygon><rect x="16.4" y="4.5" width="2.6" height="15" rx="1"></rect></svg>`,
  sliders: (s = 24, c = '#fff') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line><circle cx="9" cy="7" r="2.2" fill="#0d1220"></circle><circle cx="15" cy="12" r="2.2" fill="#0d1220"></circle><circle cx="7" cy="17" r="2.2" fill="#0d1220"></circle></svg>`,
  rew10: (s = 26, c = '#fff') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4v5.5H8"></path><path d="M4.6 14.5a8 8 0 1 0 1.7-8.2L2.5 9.5"></path><text x="12.4" y="17" text-anchor="middle" font-size="7.6" font-weight="800" fill="${c}" stroke="none">10</text></svg>`,
  fwd10: (s = 26, c = '#fff') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 4v5.5H16"></path><path d="M19.4 14.5a8 8 0 1 1-1.7-8.2l3.8 3.2"></path><text x="11.6" y="17" text-anchor="middle" font-size="7.6" font-weight="800" fill="${c}" stroke="none">10</text></svg>`,
  users: (s = 40, c = 'var(--acc, #38bdf8)') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  // level: 0 muted · 1 low · 2 high — the OSD swaps these as the volume moves.
  vol: (level = 2, s = 26, c = '#fff') => {
    const waves = level === 0
      ? '<line x1="17" y1="9" x2="22" y2="14"></line><line x1="22" y1="9" x2="17" y2="14"></line>'
      : level === 1
        ? '<path d="M16.5 8.8a4.5 4.5 0 0 1 0 6.4"></path>'
        : '<path d="M16.5 8.8a4.5 4.5 0 0 1 0 6.4"></path><path d="M19.5 6a8.5 8.5 0 0 1 0 12"></path>';
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" fill="${c}" stroke-linejoin="round"></path>${waves}</svg>`;
  }
};

// ==========================================================================
// Marquee — rolling text for labels that don't fit
// ==========================================================================
// Titles are ellipsised to fit their tile, so the end of a long name is simply
// unreadable ("Cloudy with a Chance of Meatba…"). When an item takes focus, any
// label inside it that overflows rolls right-to-left and back, so the whole thing
// can be read.
//
// Only the FOCUSED item animates — rolling every visible label at once would be
// visually chaotic and needlessly expensive. This deliberately still runs under
// perf-lite: that kill-switch exists for the weak boxes (Fire TV, Tizen,
// projectors) which are exactly where a 10-foot user most needs to read a
// truncated title, and one composited transform on one element is cheap. Users
// who ask the OS for less motion still get the plain ellipsis.
const MQ_SEL = [
  '.tvn-poster-label',      // movie / series posters
  '.tvn-ch-name', '.tvn-ch-sub',   // live channel rows
  '.tvn-cat-name',          // category list
  '.tvn-ep-title',          // episodes
  '.tvn-g-name', '.tvn-g-seg-title',   // guide
  '.tvn-set-tile-title', '.tvn-set-tile-sub',
  '.tvn-result-ch-name',    // search results
  '.tvn-popup-row-title', '.tvn-popup-row-sub'
].join(', ');

// The playback OSD's programme titles. Separate list because these are not
// focusable — they roll while the OSD is on screen, not while something is
// focused. (The channel/sub line is included: it truncates the same way.)
const MQ_OSD_SEL = '.tvn-osd-title, .tvn-osd-nexttitle, .tvn-osd-sub';

const MQ_SPEED = 70;   // px per second — readable without being sluggish

// Two independent channels. 'focus' follows the focused item and is torn down
// the moment focus moves. 'osd' holds the now/next programme titles, which are
// NOT focusable — they roll for as long as the OSD is up, so they can't live in
// the same bucket or a button taking focus would cancel them.
const mqBuckets = new Map();

/** Unwrap everything rolling in a channel and put the labels back as they were. */
function mqStop(bucket = 'focus') {
  const nodes = mqBuckets.get(bucket) || [];
  for (const n of nodes) {
    n.classList.remove('tvn-mq');
    n.style.removeProperty('--mq-dur');
    n.style.removeProperty('--mq-shift');
    const inner = n.querySelector(':scope > .tvn-mq-inner');
    if (!inner) continue;
    // Move the children back rather than resetting textContent, so a label that
    // holds markup (a badge, an icon) survives a marquee intact.
    while (inner.firstChild) n.insertBefore(inner.firstChild, inner);
    inner.remove();
  }
  mqBuckets.set(bucket, []);
}

function mqStopAll() {
  for (const b of [...mqBuckets.keys()]) mqStop(b);
}

/** Roll any overflowing label inside `host`, on the given channel. */
function mqStart(host, bucket = 'focus', sel = MQ_SEL) {
  mqStop(bucket);
  if (!host || !host.querySelectorAll) return;

  const active = [];
  const targets = [];
  if (host.matches && host.matches(sel)) targets.push(host);
  targets.push(...host.querySelectorAll(sel));

  for (const n of targets) {
    const overflow = n.scrollWidth - n.clientWidth;
    if (overflow <= 2) continue;   // it fits — nothing to roll

    const inner = document.createElement('span');
    inner.className = 'tvn-mq-inner';
    while (n.firstChild) inner.appendChild(n.firstChild);
    n.appendChild(inner);

    // Travel a little past the overflow so the last character clears the edge.
    n.style.setProperty('--mq-shift', `${-(overflow + 8)}px`);
    n.style.setProperty('--mq-dur', `${(overflow / MQ_SPEED + 1.2).toFixed(2)}s`);
    n.classList.add('tvn-mq');
    active.push(n);
  }
  mqBuckets.set(bucket, active);
}

// Watch Together: a guest follows the host, so their transport is inert.
// player.js already no-ops togglePlay()/skipBy() for them (which covers the
// remote and the keyboard); this stops the OSD from optimistically flipping its
// own play icon on a press that does nothing.
function wtGuestLocked() {
  return document.body.classList.contains('wt-guest');
}

// ==========================================================================
// Small utils
// ==========================================================================
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hashHue(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function grad(h1, h2) {
  return `linear-gradient(150deg, oklch(0.48 0.11 ${h1}), oklch(0.24 0.07 ${h2}))`;
}
function bdrop(h) {
  return `radial-gradient(120% 130% at 78% 18%, oklch(0.42 0.09 ${h}), oklch(0.16 0.04 ${h + 40}) 62%, #05070d 100%)`;
}
function monoOf(name) {
  const words = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return String(name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || '?';
}
// monogram tile with logo image on top (falls back to the monogram if the
// image fails / is missing)
function tileHtml(name, icon, cls) {
  const hue = hashHue(name);
  const img = icon
    ? `<img src="${esc(proxifyImage(icon))}" alt="" loading="lazy" onload="this.parentNode.classList.add('tvn-has-logo')" onerror="this.remove()">`
    : '';
  return `<div class="tvn-mono ${cls}" style="background:${grad(hue, hue - 25)}"><span>${esc(monoOf(name))}</span>${img}</div>`;
}

function fmtTime(d = new Date()) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(d = new Date()) {
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function fmtClockTs(tsSec) {
  const d = new Date(parseInt(tsSec, 10) * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtAge(ms) {
  if (!isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 2) return 'Updated just now';
  if (m < 60) return `Updated ${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Updated ${h} hour${h === 1 ? '' : 's'} ago`;
  const dd = Math.floor(h / 24);
  return `Updated ${dd} day${dd === 1 ? '' : 's'} ago`;
}
function fmtNum(n) {
  try { return Number(n || 0).toLocaleString(); } catch (e) { return String(n); }
}
// Provider text often carries literal "\r\n" sequences (and real newlines) —
// flatten both to spaces for single-block descriptions.
function cleanText(s) {
  return String(s || '')
    .replace(/\\r\\n|\\n|\\r/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ==========================================================================
// EPG helpers (shell-local; the grid component's cache is not loaded here)
// ==========================================================================
async function epgFor(streamId) {
  const key = String(streamId);
  const hit = epgCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.listings;
  try {
    const r = await getEPG(streamId);
    const listings = (r && r.listings) || [];
    epgCache.set(key, { at: Date.now(), listings });
    return listings;
  } catch (e) {
    epgCache.set(key, { at: Date.now(), listings: [] });
    return [];
  }
}
function nowNextOf(listings) {
  const ls = (listings || []).slice()
    .filter(p => p.start_timestamp && p.end_timestamp)
    .sort((a, b) => parseInt(a.start_timestamp) - parseInt(b.start_timestamp));
  const now = Date.now();
  let idx = ls.findIndex(p => now >= parseInt(p.start_timestamp) * 1000 && now < parseInt(p.end_timestamp) * 1000);
  if (idx === -1) idx = ls.findIndex(p => parseInt(p.end_timestamp) * 1000 > now);
  if (idx === -1) return { current: null, upcoming: [] };
  return { current: ls[idx], upcoming: ls.slice(idx + 1, idx + 4) };
}
function progressPct(p) {
  if (!p) return 0;
  const s = parseInt(p.start_timestamp) * 1000;
  const e = parseInt(p.end_timestamp) * 1000;
  if (!s || !e || e <= s) return 0;
  return Math.max(0, Math.min(100, ((Date.now() - s) / (e - s)) * 100));
}

// ==========================================================================
// Spatial D-pad navigation (from the design prototype)
// ==========================================================================
function navRootEl() {
  // the chooser (pre-login), an open popout, the playback OSD, and the shell
  // share the engine; whichever is the visible surface owns the D-pad so
  // focus can't wander behind it
  const chooser = document.getElementById('tvn-chooser');
  if (chooser) return chooser;
  if (popupEl) return popupEl;
  if (root && root.classList.contains('tvn-hidden') && osdVisible()) return osdEl;
  return root;
}

function focusables() {
  const r = navRootEl();
  if (!r) return [];
  return Array.from(r.querySelectorAll('[data-nav]')).filter(n => n.offsetParent);
}

function focusAuto() {
  requestAnimationFrame(() => {
    const all = focusables();
    if (!all.length) return;
    // restore per-screen remembered focus first
    const key = current && lastFocusKey[current.name];
    let el = key ? all.find(n => n.dataset.fkey === key) : null;
    if (!el) el = all.find(n => n.hasAttribute('data-autofocus')) || all[0];
    const wasFocused = document.activeElement === el;
    el.focus({ preventScroll: true });
    ensureVisible(el);
    // focus() on the already-focused element raises no focusin, so the marquee
    // would never start on whatever a screen autofocuses. Kick it directly.
    if (wasFocused) mqStart(el);
  });
}

function move(dir) {
  const all = focusables();
  if (!all.length) return;
  const cur = document.activeElement;
  if (!cur || !all.includes(cur)) { focusAuto(); return; }
  const cr = cur.getBoundingClientRect();
  const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2, ey = r.top + r.height / 2;
    let primary, orth;
    if (dir === 'right') { primary = ex - cx; orth = Math.abs(ey - cy); }
    else if (dir === 'left') { primary = cx - ex; orth = Math.abs(ey - cy); }
    else if (dir === 'down') { primary = ey - cy; orth = Math.abs(ex - cx); }
    else { primary = cy - ey; orth = Math.abs(ex - cx); }
    if (primary < 4) continue;
    const score = primary + orth * 2.2;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    best.focus({ preventScroll: true });
    ensureVisible(best);
  }
}

function ensureVisible(el) {
  const st = navRootEl();
  const s = scale || 1;
  let p = el.parentElement;
  while (p && p !== st) {
    const scrollV = p.scrollHeight > p.clientHeight + 4;
    const scrollH = p.scrollWidth > p.clientWidth + 4;
    if (scrollV || scrollH) {
      const pr = p.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const pad = 40 * s;
      if (scrollV) {
        if (er.top < pr.top + pad) p.scrollTop -= (pr.top + pad - er.top) / s;
        else if (er.bottom > pr.bottom - pad) p.scrollTop += (er.bottom - (pr.bottom - pad)) / s;
      }
      if (scrollH) {
        if (er.left < pr.left + pad) p.scrollLeft -= (pr.left + pad - er.left) / s;
        else if (er.right > pr.right - pad) p.scrollLeft += (er.right - (pr.right - pad)) / s;
      }
    }
    p = p.parentElement;
  }
}

// The shell owns the keys only while it is actually the visible surface —
// never while video chrome, a legacy modal, or the TV keyboard is on top.
function shellHasKeys() {
  if (document.getElementById('tvn-chooser')) return true;
  if (popupEl) return true; // a popout owns keys even over playback (OSD options)
  if (!root || root.classList.contains('tvn-hidden')) return false;
  if (document.fullscreenElement) return false;
  if (document.body.classList.contains('player-fs')) return false;
  if (document.body.classList.contains('vod-mode')) return false;
  if (document.querySelector('.modal-overlay:not(.hidden)')) return false;
  if (document.querySelector('.tvk-overlay, .tvsort-overlay, #update-modal-overlay')) return false;
  return true;
}

function onKeyDown(e) {
  // Playback OSD (live + VOD): while the shell has handed the screen to the
  // player, the OSD owns the D-pad — any nav key summons it, arrows move
  // within it, MENU opens its options popout, Back dismisses it (Back with
  // the OSD hidden falls through to the normal exit-to-shell flow, media
  // keys/letters always pass to the player).
  if (osdActive() && !popupEl &&
      !document.querySelector('.tvk-overlay, .tvsort-overlay, #update-modal-overlay, .modal-overlay:not(.hidden)')) {
    const kk = e.key;
    if (kk === 'ContextMenu' ||
        (e.keyCode === 82 && (!e.key || kk === 'Unidentified' || kk === 'ContextMenu'))) {
      // Remote MENU → the OSD options popout (the legacy control bar it used
      // to summon is display:none under the shell — an invisible menu).
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!osdVisible()) osdShow();
      const opts = osdEl && osdEl.querySelector('[data-osd="opts"]');
      if (opts) opts.click();
      return;
    }
    // Letter shortcuts during playback. These route to the OSD's own controls,
    // not the legacy control bar — that bar is display:none under the shell, so
    // clicking its buttons would open menus nobody can see.
    const lk = (kk && kk.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) ? kk.toLowerCase() : '';
    if (lk === 'c') {
      e.preventDefault();
      e.stopImmediatePropagation();
      osdBump();
      openTracksPopup();
      return;
    }
    if (lk === 's') {
      e.preventDefault();
      e.stopImmediatePropagation();
      legacyClick('player-stop-btn');
      return;
    }

    // Volume: while the volume button holds focus its flyout is open, and Up/Down
    // drive the level instead of moving focus. Left/Right fall through to the
    // normal spatial move, which is how you leave the slider.
    if ((kk === 'ArrowUp' || kk === 'ArrowDown') && osdVisible() && osdVolOpen() &&
        document.activeElement === osdEl.querySelector('[data-osd="vol"]')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      osdVolStep(kk === 'ArrowUp' ? 0.05 : -0.05);
      return;
    }

    if (kk === 'ArrowUp' || kk === 'ArrowDown' || kk === 'ArrowLeft' || kk === 'ArrowRight' ||
        kk === 'Enter' || kk === ' ') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!osdVisible()) { osdShow(); return; }
      osdBump();
      if (kk === 'Enter' || kk === ' ') {
        const a = document.activeElement;
        if (osdEl.contains(a) && a.hasAttribute('data-nav')) a.click();
        else osdShow();
      } else if ((kk === 'ArrowLeft' || kk === 'ArrowRight') &&
                 document.activeElement === osdEl.querySelector('[data-osd-bar]')) {
        // Focused seek bar: Left/Right scrub (key-repeat = hold to seek)
        // instead of moving focus off the bar.
        try { window.playerInstance.skipBy(kk === 'ArrowRight' ? 10 : -10); } catch (err) {}
        osdTick();
      } else {
        move(kk.replace('Arrow', '').toLowerCase());
      }
      return;
    }
    if (kk === 'Escape' || kk === 'Backspace' || kk === 'GoBack' || kk === 'BrowserBack') {
      if (osdVisible()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        osdHide();
        return;
      }
      // OSD hidden — live falls through to the legacy exit-to-shell flow
      // (drop fullscreen, stream keeps running under the shell), but VOD has
      // no legacy Back handler under the shell: exit the player outright
      // (player.js onExitVod teardown → the observer restores the shell).
      if (osdIsVod()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        legacyClick('player-stop-btn');
        return;
      }
    }
  }
  if (!shellHasKeys()) return;
  const k = e.key;
  // While the shell is the visible surface it owns the remote outright:
  // consume every navigation key even when something outside the shell has
  // stolen focus (legacy code focuses its own lists as data loads underneath
  // — letting those keys through would click invisible elements).
  const inShell = navRootEl() && navRootEl().contains(document.activeElement);
  if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!inShell) { focusAuto(); return; }
    move(k.replace('Arrow', '').toLowerCase());
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const a = document.activeElement;
    if (inShell && a && a.hasAttribute('data-nav')) a.click();
    else focusAuto();
  } else if (k === 'ContextMenu' ||
             (e.keyCode === 82 && (!e.key || k === 'Unidentified' || k === 'ContextMenu'))) {
    // Remote MENU (Android KEYCODE_MENU = 82 with an Unidentified key — never
    // a PC keyboard's plain "r") on a pinnable row → Pin/Unpin popout; on a
    // Continue Watching card → Remove popout.
    const t = pinTargetOf(document.activeElement);
    const cwT = t ? null : cwTargetOf(document.activeElement);
    if ((t || cwT) && inShell && !popupEl) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (t) openPinMenuFor(t); else openCwMenuFor(cwT);
    }
  } else if (k === 'Escape' || k === 'Backspace' || k === 'GoBack' || k === 'BrowserBack') {
    if (document.getElementById('tvn-chooser')) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    // an open popout swallows Back — close it, stay on the screen
    if (popupEl) { e.preventDefault(); e.stopImmediatePropagation(); closePopup(); return; }
    // On a text-entry screen (search query, Watch Together code), Backspace
    // deletes a character while there is one, instead of navigating back.
    if (k === 'Backspace' && current && (current.name === 'search' || current.name === 'watch') &&
        window.__tvnQueryDel && window.__tvnQueryDel()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    goBack();
  }
}

// ==========================================================================
// Playback OSD (7.1 live, 7.2 VOD) — the shell's own player chrome, per the
// design mockup: channel/title chip + clock up top; LIVE badge (or seek bar
// in VOD), title, transport and actions (CC/star/options) down low, with a
// Back hint. Purely presentational — every control proxies the legacy
// player's buttons/methods so playback logic stays in player.js. In VOD the
// info block also carries the series "Up next" line (replacing the legacy
// now/next bar, which is hidden under the shell).
// Lives INSIDE #video-container so it renders under OS fullscreen and gets
// the native-compositing visibility punch-through for free.
// ==========================================================================
function osdActive() {
  return document.body.classList.contains('tvn-playing') &&
    !!root && root.classList.contains('tvn-hidden');
}
function osdIsVod() {
  return document.body.classList.contains('vod-mode');
}
function osdVisible() {
  return !!osdEl && osdEl.classList.contains('tvn-osd-show') && osdActive();
}
const legacyClick = (id) => { const b = document.getElementById(id); if (b) b.click(); };

function ensureOsd() {
  const host = document.getElementById('video-container');
  if (!host) return null;
  if (osdEl && osdEl.parentElement === host) return osdEl;
  if (osdEl) osdEl.remove();
  osdEl = el(`
    <div id="tvn-osd">
      <div class="tvn-osd-scrim tvn-osd-scrim-top"></div>
      <div class="tvn-osd-scrim tvn-osd-scrim-bottom"></div>
      <div class="tvn-osd-canvas">
      <div class="tvn-osd-top">
        <button class="tvn-osd-backtop tvn-focable" data-nav data-fkey="osd-backtop" title="Back"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Back</span></button>
        <div class="tvn-osd-chip" data-osd-tile></div>
        <span class="tvn-osd-chname" data-osd-chname></span>
        <div style="flex:1"></div>
        <span class="tvn-osd-clock" data-osd-clock></span>
      </div>
      <div class="tvn-osd-bottom">
        <div class="tvn-osd-info">
          <div class="tvn-osd-labelrow">
            <div class="tvn-osd-liverow">
              <span class="tvn-osd-live">LIVE</span>
              <span class="tvn-osd-nowlab">Playing Now</span>
            </div>
            <span class="tvn-osd-nextlab" data-osd-nextlab hidden>Playing Next</span>
          </div>
          <!-- Now / Next are mirror images: label, title, one meta line. The
               elapsed timer sits BELOW the pair rather than inside the Now
               column — as a third line it made that column taller than the Next
               column, which is what knocked the two titles out of line. -->
          <div class="tvn-osd-detailrow">
            <div class="tvn-osd-info-main">
              <span class="tvn-osd-title" data-osd-title></span>
              <span class="tvn-osd-sub" data-osd-sub></span>
            </div>
            <div class="tvn-osd-upnext" data-osd-upnext hidden>
              <span class="tvn-osd-nexttitle" data-osd-nexttitle></span>
              <span class="tvn-osd-nexttime" data-osd-nexttime></span>
            </div>
          </div>
          <span class="tvn-osd-elapsed" data-osd-elapsed></span>
          <span class="tvn-osd-next" data-osd-next></span>
        </div>
        <div class="tvn-osd-seek">
          <span class="tvn-osd-time" data-osd-cur>--:--</span>
          <div class="tvn-osd-bar tvn-focable" data-nav data-fkey="osd-seek" tabindex="-1" data-osd-bar title="Seek"><i data-osd-fill></i></div>
          <span class="tvn-osd-time" data-osd-dur>--:--</span>
        </div>
        <div class="tvn-osd-controls">
          <div class="tvn-osd-center">
            <button class="tvn-osd-btn tvn-focable" data-nav data-osd="prev" data-fkey="osd-prev" title="Previous channel">${I.skipPrev()}</button>
            <button class="tvn-osd-btn tvn-osd-vodonly tvn-focable" data-nav data-osd="rew" data-fkey="osd-rew" title="Back 10 seconds">${I.rew10()}</button>
            <button class="tvn-osd-btn tvn-osd-play tvn-focable" data-nav data-autofocus data-osd="play" data-fkey="osd-play" title="Play / Pause">${I.pause()}</button>
            <button class="tvn-osd-btn tvn-osd-vodonly tvn-focable" data-nav data-osd="fwd" data-fkey="osd-fwd" title="Forward 10 seconds">${I.fwd10()}</button>
            <button class="tvn-osd-btn tvn-focable" data-nav data-osd="next" data-fkey="osd-next" title="Next channel">${I.skipNext()}</button>
          </div>
          <div class="tvn-osd-right">
            <!-- Volume. Focusing it (D-pad) or hovering it (mouse) reveals a
                 vertical slider above the button: Up/Down adjust, Left/Right
                 leave. Audio & subtitles moved to the Options popout, which
                 already listed them, and the C hotkey still opens them. -->
            <div class="tvn-osd-volwrap" data-osd-volwrap>
              <div class="tvn-osd-volflyout" data-osd-volflyout aria-hidden="true">
                <span class="tvn-osd-volpct" data-osd-volpct>0%</span>
                <div class="tvn-osd-voltrack" data-osd-voltrack title="Volume">
                  <i data-osd-volfill></i>
                </div>
              </div>
              <button class="tvn-osd-btn tvn-osd-sm tvn-focable" data-nav data-osd="vol" data-fkey="osd-vol" title="Volume">${I.vol(2)}</button>
            </div>
            <button class="tvn-osd-btn tvn-osd-sm tvn-focable" data-nav data-osd="fav" data-fkey="osd-fav" title="Favorite"><span class="tvn-osd-star" data-osd-star>${I.star}</span></button>
            <button class="tvn-osd-btn tvn-osd-sm tvn-focable" data-nav data-osd="opts" data-fkey="osd-opts" title="Options">${I.sliders()}</button>
          </div>
        </div>
        <button class="tvn-osd-hint" data-nav data-fkey="osd-back"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9l8 7 8-7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span data-osd-hintlabel>Back to channels</span></button>
      </div>
      </div>
    </div>`);
  osdEl.querySelector('[data-osd="prev"]').onclick = () => { osdBump(); legacyClick('player-prev-btn'); };
  osdEl.querySelector('[data-osd="next"]').onclick = () => { osdBump(); legacyClick('player-next-btn'); };
  osdEl.querySelector('[data-osd="play"]').onclick = () => {
    osdBump();
    if (wtGuestLocked()) return;
    legacyClick('player-play-pause-btn');
    osdPaused = !osdPaused;
    osdEl.querySelector('[data-osd="play"]').innerHTML = osdPaused ? I.play(34) : I.pause();
  };
  osdEl.querySelector('[data-osd="rew"]').onclick = () => {
    osdBump();
    if (wtGuestLocked()) return;
    try { window.playerInstance.skipBy(-10); } catch (e) {}
    osdTick();
  };
  osdEl.querySelector('[data-osd="fwd"]').onclick = () => {
    osdBump();
    if (wtGuestLocked()) return;
    try { window.playerInstance.skipBy(10); } catch (e) {}
    osdTick();
  };
  // VOD progress bar: mouse/touch clicks scrub to that position; the D-pad
  // focuses it (it's data-nav) and Left/Right seek ±10s from onKeyDown. An
  // Enter press arrives here as a synthetic click (no coordinates) — treat it
  // as play/pause, never as a scrub-to-zero.
  const seekBar = osdEl.querySelector('[data-osd-bar]');
  seekBar.onclick = (e) => {
    osdBump();
    if (wtGuestLocked()) return;
    if (!e.isTrusted || (!e.clientX && !e.clientY)) {
      const play = osdEl.querySelector('[data-osd="play"]');
      if (play) play.click();
      return;
    }
    try {
      const p = window.playerInstance;
      const c = p.getClock();
      if (!c.dur) return;
      const r = seekBar.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      p.skipBy(frac * c.dur - c.cur);
      osdTick();
    } catch (err) {}
  };
  // ---- Volume ------------------------------------------------------------
  // The flyout is revealed by focus (D-pad) or hover (mouse). Up/Down adjust
  // while the button holds focus — see the osd-vol branch in onKeyDown, which
  // has to intercept those keys before the spatial focus engine treats them as
  // a move. Left/Right are deliberately NOT handled there, so they fall through
  // to normal navigation and thus "exit" the slider.
  const volBtn = osdEl.querySelector('[data-osd="vol"]');
  const volWrap = osdEl.querySelector('[data-osd-volwrap]');
  volBtn.addEventListener('focus', () => osdVolShow());
  volBtn.addEventListener('blur', () => osdVolHide());
  volWrap.addEventListener('mouseenter', () => osdVolShow());
  volWrap.addEventListener('mouseleave', () => { if (document.activeElement !== volBtn) osdVolHide(); });
  // Clicking the button itself toggles mute (matches the desktop volume button).
  volBtn.onclick = () => {
    osdBump();
    const p = window.playerInstance;
    if (!p) return;
    if (p.getVolume() > 0) { osdVolLast = p.getVolume(); p.setVolume(0); }
    else p.setVolume(osdVolLast || 0.5);
    osdVolSync();
  };
  // Mouse: click (or drag) anywhere on the track to set the level. The track is
  // drawn bottom-up, so a click near the top is loud.
  const volTrack = osdEl.querySelector('[data-osd-voltrack]');
  const volFromEvent = (e) => {
    const r = volTrack.getBoundingClientRect();
    const v = 1 - (e.clientY - r.top) / r.height;
    try { window.playerInstance.setVolume(Math.max(0, Math.min(1, v))); } catch (err) {}
    osdVolSync();
    osdBump();
  };
  volTrack.addEventListener('mousedown', (e) => {
    volFromEvent(e);
    const onMove = (ev) => volFromEvent(ev);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  osdEl.querySelector('[data-osd="fav"]').onclick = async () => {
    osdBump();
    if (!osdChannel || !H.toggleFavorite) return;
    try { await H.toggleFavorite('live', osdChannel.stream_id); } catch (e) {}
    catCache = null; // Favorites rail count changed
    osdRefreshFav();
  };
  osdEl.querySelector('[data-osd="opts"]').onclick = () => {
    osdBump();
    const vod = osdIsVod();
    openPopup({
      title: (vod ? (osdVod && osdVod.title) : (osdChannel && osdChannel.name)) || 'Options',
      items: vod ? [
        { id: 'tracks', title: 'Audio & subtitles' },
        { id: 'restart', title: 'Play from beginning' },
        { id: 'stop', title: 'Stop playback' }
      ] : [
        { id: 'tracks', title: 'Audio & subtitles' },
        { id: 'info', title: 'Channel info' },
        { id: 'stop', title: 'Stop playback' }
      ],
      onPick: (it) => {
        closePopup(false);
        if (it.id === 'tracks') openTracksPopup();
        else if (it.id === 'info') legacyClick('player-info-btn');
        else if (it.id === 'restart') {
          // skipBy clamps to 0 on every engine (incl. native / transcode)
          try { window.playerInstance.skipBy(-1e9); } catch (e) {}
          osdTick();
        }
        else if (it.id === 'stop') legacyClick('player-stop-btn');
      }
    });
  };
  const osdExit = () => {
    osdHide();
    // VOD: Stop leaves the player overlay entirely (player.js onExitVod) and
    // the playback-state observer restores the shell on the browse screen.
    // Live: drop out of fullscreen, the stream keeps running under the shell.
    if (osdIsVod()) legacyClick('player-stop-btn');
    else if (H.exitPlayerFs) H.exitPlayerFs();
  };
  osdEl.querySelector('[data-fkey="osd-back"]').onclick = osdExit;
  osdEl.querySelector('[data-fkey="osd-backtop"]').onclick = osdExit;
  host.appendChild(osdEl);
  return osdEl;
}

// Audio & subtitle picker as a SHELL popout. The legacy player-cc-btn menu is
// a desktop-UI panel: during OS fullscreen it paints behind the video (not a
// descendant of the fullscreen element) and its rows carry no data-nav, so
// the D-pad can't reach it. openPopup solves both (video-container mount +
// navigable rows).
function openTracksPopup() {
  const p = window.playerInstance;
  const menu = p && typeof p.getTrackMenu === 'function' ? p.getTrackMenu() : null;
  const items = [];
  if (menu) {
    if ((menu.audio || []).length > 1) {
      menu.audio.forEach(a => items.push({ id: a.id, title: `Audio: ${a.label}`, selected: !!a.active }));
    }
    if ((menu.subs || []).length > 1) {
      menu.subs.forEach(s => items.push({
        id: s.id,
        title: s.id === 'sub:off' ? 'Subtitles: Off' : `Subtitle: ${s.label}`,
        selected: !!s.active
      }));
    }
  }
  if (!items.length) {
    if (window.showToast) window.showToast('No alternate audio or subtitle tracks', 'info', 3000);
    return;
  }
  openPopup({
    title: 'Audio & subtitles',
    items,
    onPick: (it) => {
      closePopup(false);
      try { p.applyTrack(it.id); } catch (e) {}
    }
  });
}

function osdRefreshFav() {
  if (!osdEl || !osdChannel) return;
  const on = H.isFavorite && H.isFavorite('live', osdChannel.stream_id);
  const star = osdEl.querySelector('[data-osd-star]');
  if (star) star.classList.toggle('tvn-fav', !!on);
}

function fmtElapsed(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
}

// VOD position/duration: "1:23:45" over an hour, "23:45" under.
function fmtDur(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`
    : `${m}:${String(x).padStart(2, '0')}`;
}

function osdRender() {
  if (!ensureOsd()) return;
  const vod = osdIsVod();
  // series-mode lands on the container only after the stream URL resolves, so
  // also trust the explicit flag the series play path passes with its metadata.
  const series = vod && (!!document.getElementById('video-container')?.classList.contains('series-mode') ||
    !!(osdVod && osdVod.series));
  osdEl.classList.toggle('tvn-osd-vod', vod);
  osdEl.classList.toggle('tvn-osd-series', series);
  osdEl.querySelector('[data-osd="prev"]').title = vod ? 'Previous episode' : 'Previous channel';
  osdEl.querySelector('[data-osd="next"]').title = vod ? 'Next episode' : 'Next channel';
  osdEl.querySelector('[data-osd-hintlabel]').textContent = vod ? 'Back to browse' : 'Back to channels';
  const upnextBox = osdEl.querySelector('[data-osd-upnext]');
  const nextLab = osdEl.querySelector('[data-osd-nextlab]');
  if (vod) {
    const m = osdVod || {};
    // Top row shows the ← Back pill in VOD (CSS hides the chip + name there);
    // clear them so a stale live-channel logo can't flash on a mode switch.
    osdEl.querySelector('[data-osd-tile]').innerHTML = '';
    osdEl.querySelector('[data-osd-chname]').textContent = '';
    osdEl.querySelector('[data-osd-title]').textContent = m.title || 'Now playing';
    osdEl.querySelector('[data-osd-sub]').textContent = m.sub || '';
    osdEl.querySelector('[data-osd-next]').textContent = m.next ? `Up next: ${m.next}` : '';
    upnextBox.hidden = true;
    nextLab.hidden = true;
  } else {
    const ch = osdChannel || window.state?.activeChannel || {};
    osdEl.querySelector('[data-osd-tile]').innerHTML = tileHtml(ch.name || '', ch.stream_icon, 'tvn-osd-tile');
    osdEl.querySelector('[data-osd-chname]').textContent = ch.name || '';
    osdEl.querySelector('[data-osd-sub]').textContent = ch.name || '';
    osdEl.querySelector('[data-osd-title]').textContent = (osdProgram && osdProgram.title) || ch.name || 'Live TV';
    osdEl.querySelector('[data-osd-next]').textContent = '';
    // "Playing Next" (opposite side, same label line): the following EPG
    // programme, when known. Label + detail box toggle together.
    if (osdProgramNext && osdProgramNext.title) {
      upnextBox.hidden = false;
      nextLab.hidden = false;
      osdEl.querySelector('[data-osd-nexttitle]').textContent = osdProgramNext.title;
      osdEl.querySelector('[data-osd-nexttime]').textContent = osdProgramNext.start_timestamp
        ? `${fmtClockTs(osdProgramNext.start_timestamp)}${osdProgramNext.end_timestamp ? ' – ' + fmtClockTs(osdProgramNext.end_timestamp) : ''}`
        : '';
    } else {
      upnextBox.hidden = true;
      nextLab.hidden = true;
    }
  }
  osdRefreshFav();
  osdVolSync();

  // Roll the now/next programme titles if they're too long to fit — a truncated
  // "The Twilight Saga: Breaking Da…" tells you nothing. These aren't focusable,
  // so they get their own marquee channel and roll for as long as the OSD is up;
  // sharing the focus channel would cancel them the moment a button took focus.
  // Deferred a frame so the text we just wrote has been laid out and measured.
  requestAnimationFrame(() => {
    if (osdEl) mqStart(osdEl.querySelector('.tvn-osd-info'), 'osd', MQ_OSD_SEL);
  });

  osdTick();
}

function osdTick() {
  if (!osdEl) return;
  osdEl.querySelector('[data-osd-clock]').textContent = fmtTime();
  if (osdIsVod()) {
    // VOD: progress bar + position/duration from the player's engine-aware
    // clock, and keep the play/pause glyph honest (media keys, auto-pause).
    let c = null;
    try { c = window.playerInstance.getClock(); } catch (e) {}
    const cur = osdEl.querySelector('[data-osd-cur]');
    const dur = osdEl.querySelector('[data-osd-dur]');
    const fill = osdEl.querySelector('[data-osd-fill]');
    if (c && c.dur > 0) {
      cur.textContent = fmtDur(c.cur);
      dur.textContent = fmtDur(c.dur);
      fill.style.width = `${Math.max(0, Math.min(100, (c.cur / c.dur) * 100))}%`;
    } else {
      cur.textContent = '--:--';
      dur.textContent = '--:--';
      fill.style.width = '0%';
    }
    if (c && c.paused !== osdPaused) {
      osdPaused = c.paused;
      const p = osdEl.querySelector('[data-osd="play"]');
      if (p) p.innerHTML = osdPaused ? I.play(34) : I.pause();
    }
    return;
  }
  const elp = osdEl.querySelector('[data-osd-elapsed]');
  if (osdProgram && osdProgram.start_timestamp) {
    elp.textContent = fmtElapsed(Date.now() / 1000 - Number(osdProgram.start_timestamp));
    // rolled past the end of the programme → pull the next one
    if (osdProgram.end_timestamp && Date.now() / 1000 > Number(osdProgram.end_timestamp)) osdFetchProgram();
  } else {
    elp.textContent = '';
  }
}

async function osdFetchProgram() {
  if (!osdChannel) return;
  const seq = ++osdFetchSeq;
  try {
    const listings = await epgFor(osdChannel.stream_id);
    if (seq !== osdFetchSeq) return;
    const { current: cur, upcoming } = nowNextOf(listings);
    osdProgramNext = (upcoming && upcoming[0]) || null;
    if (cur && cur !== osdProgram) osdProgram = cur;
    if (osdVisible()) osdRender();
  } catch (e) {}
}

function osdSetNowPlaying(ch, prog) {
  osdChannel = ch || null;
  osdProgram = prog || null;
  osdProgramNext = null;
  osdVod = null;
  osdPaused = false;
  if (osdEl) {
    const p = osdEl.querySelector('[data-osd="play"]');
    if (p) p.innerHTML = I.pause();
  }
  // Always fetch — even with a current programme in hand, the "Playing Next"
  // box needs the following one (epgFor is session-cached, so zaps stay cheap).
  osdFetchProgram();
  // surface the OSD briefly on every channel start / zap — after the legacy
  // play path has done its own focusDefault('player'), so ours wins
  setTimeout(() => { if (osdActive()) osdShow(); }, 650);
}

// VOD counterpart — fed by main.js (playVODStream / playSeriesEpisode) via
// window.__tvnOsdVod, so auto-next and episode zapping refresh the card too.
function osdSetNowPlayingVod(meta) {
  osdVod = meta || {};
  osdChannel = null;
  osdProgram = null;
  osdPaused = false;
  if (osdEl) {
    const p = osdEl.querySelector('[data-osd="play"]');
    if (p) p.innerHTML = I.pause();
  }
  setTimeout(() => { if (osdActive() && osdIsVod()) osdShow(); }, 650);
}

function osdShow() {
  if (!osdActive() || !ensureOsd()) return;
  osdRender();
  osdEl.classList.add('tvn-osd-show');
  if (!osdEl.contains(document.activeElement)) {
    const play = osdEl.querySelector('[data-osd="play"]');
    if (play) play.focus({ preventScroll: true });
  }
  osdBump();
  if (osdTickTimer) clearInterval(osdTickTimer);
  osdTickTimer = setInterval(osdTick, 1000);
}

function osdBump() {
  clearTimeout(osdHideTimer);
  osdHideTimer = setTimeout(osdHide, 5000);
}

// ---- OSD volume flyout ----------------------------------------------------
// Shown while the volume button holds focus (D-pad) or the pointer (mouse).
// Up/Down step it; Left/Right are left to the focus engine, so they just move on
// — which is what "exit the slider" means here.
let osdVolLast = 0.5;   // level to restore when un-muting via the button

function osdVolShow() {
  if (!osdEl) return;
  osdVolSync();
  const w = osdEl.querySelector('[data-osd-volwrap]');
  if (w) w.classList.add('tvn-osd-volopen');
}

function osdVolHide() {
  if (!osdEl) return;
  const w = osdEl.querySelector('[data-osd-volwrap]');
  if (w) w.classList.remove('tvn-osd-volopen');
}

function osdVolOpen() {
  const w = osdEl && osdEl.querySelector('[data-osd-volwrap]');
  return !!(w && w.classList.contains('tvn-osd-volopen'));
}

/** Push the player's current level into the flyout (fill, %, and the icon). */
function osdVolSync() {
  if (!osdEl) return;
  let v = 0;
  try { v = window.playerInstance ? window.playerInstance.getVolume() : 0; } catch (e) {}
  const pct = Math.round(v * 100);
  const fill = osdEl.querySelector('[data-osd-volfill]');
  const label = osdEl.querySelector('[data-osd-volpct]');
  const btn = osdEl.querySelector('[data-osd="vol"]');
  if (fill) fill.style.height = `${pct}%`;
  if (label) label.textContent = `${pct}%`;
  if (btn) btn.innerHTML = I.vol(pct === 0 ? 0 : (pct < 40 ? 1 : 2));
}

/** Step the volume by ±delta (0..1 scale). */
function osdVolStep(delta) {
  const p = window.playerInstance;
  if (!p) return;
  const next = p.getVolume() + delta;
  if (next > 0) osdVolLast = Math.min(1, next);
  p.setVolume(next);
  osdVolSync();
  osdBump();
}

function osdHide() {
  clearTimeout(osdHideTimer);
  osdHideTimer = null;
  if (osdTickTimer) { clearInterval(osdTickTimer); osdTickTimer = null; }
  mqStop('osd');     // nothing to read while the OSD is down
  osdVolHide();
  if (!osdEl) return;
  osdEl.classList.remove('tvn-osd-show');
  // release focus so a hidden button can't swallow the next Enter
  if (osdEl.contains(document.activeElement)) {
    try { document.activeElement.blur(); } catch (e) {}
  }
}

// ==========================================================================
// Pin to top (7.0.4) — remote MENU key or right-click on a category/channel
// row opens a popout with Pin/Unpin. Rows opt in via data-pinnable/-pin-id/
// -pin-name; pins persist in the legacy stores (shared with the old UI).
// ==========================================================================
function pinTargetOf(el) {
  return el && el.closest ? el.closest('[data-pinnable]') : null;
}

// Pinned-first ordering (stable within both groups, pins in pin order).
function sortPinnedCats(list) {
  const order = ((H && H.pinnedCats) ? H.pinnedCats('live') : []).map(p => String(p.id));
  if (!order.length) return list;
  const pinned = [], rest = [];
  list.forEach(c => (order.includes(String(c.category_id)) ? pinned : rest).push(c));
  pinned.sort((a, b) => order.indexOf(String(a.category_id)) - order.indexOf(String(b.category_id)));
  return [...pinned, ...rest];
}
function sortPinnedChannels(list) {
  const order = ((H && H.pinnedChs) ? H.pinnedChs() : []).map(String);
  if (!order.length) return list;
  const pinned = [], rest = [];
  list.forEach(c => (order.includes(String(c.stream_id)) ? pinned : rest).push(c));
  pinned.sort((a, b) => order.indexOf(String(a.stream_id)) - order.indexOf(String(b.stream_id)));
  return [...pinned, ...rest];
}

// Continue Watching rows opt into the same MENU/right-click popout via
// data-cw-* attributes — the only way a 10-foot UI can offer removal.
function cwTargetOf(el) {
  return el && el.closest ? el.closest('[data-cw-id]') : null;
}

function openCwMenuFor(t) {
  if (!t) return;
  const { cwId, cwType, cwKey, cwName, fkey } = t.dataset;
  if (!cwId) return;
  openPopup({
    title: cwName || 'Continue watching',
    items: [{
      id: 'remove',
      title: 'Remove from Continue watching',
      sub: cwType === 'series' ? 'Clears saved progress for every episode' : 'Clears the saved position',
      danger: true
    }],
    onPick: () => {
      try {
        if (cwType === 'series') removeSeriesWatchProgress(cwKey);
        else removeWatchProgress(cwId);
      } catch (e) {}
      closePopup(false);
      // Re-render the screen so the row rebuilds without the entry.
      if (current && fkey) lastFocusKey[current.name] = fkey;
      renderCurrent();
    }
  });
}

function openPinMenuFor(t) {
  if (!t || !H) return;
  const kind = t.dataset.pinnable;            // 'cat' | 'ch'
  const id = t.dataset.pinId;
  const name = t.dataset.pinName || (kind === 'cat' ? 'Category' : 'Channel');
  const fkey = t.dataset.fkey;
  if (!id) return;
  const pinned = kind === 'cat'
    ? !!(H.isCatPinned && H.isCatPinned(id, 'live'))
    : !!(H.isChPinned && H.isChPinned(id));
  openPopup({
    title: name,
    items: [{ id: 'toggle', title: pinned ? 'Unpin from top' : 'Pin to top' }],
    onPick: () => {
      try {
        if (kind === 'cat') { if (H.togglePinCat) H.togglePinCat(id, name, 'live'); }
        else if (H.togglePinCh) H.togglePinCh(id, name);
      } catch (e) {}
      closePopup(false);
      // Re-render so the list re-sorts; focus lands back on the same row.
      if (current && fkey) lastFocusKey[current.name] = fkey;
      renderCurrent();
    }
  });
}

// ==========================================================================
// Popout menu — centered list picker over the current screen. D-pad nav is
// confined to it (see navRootEl); Back/Esc or a backdrop click closes it.
// ==========================================================================
function closePopup(refocus = true) {
  if (!popupEl) return false;
  const returnTo = popupEl._returnFocus;
  popupEl.remove();
  popupEl = null;
  if (refocus && returnTo && document.contains(returnTo)) {
    returnTo.focus({ preventScroll: true });
  }
  return true;
}

/** items: [{ id, title, sub, selected, danger }] — onPick(item, rowEl) */
function openPopup({ title, items, onPick }) {
  closePopup(false);
  const pop = el(`
    <div id="tvn-popup">
      <div class="tvn-popup-panel">
        <span class="tvn-popup-title">${esc(title)}</span>
        <div class="tvn-popup-list"></div>
      </div>
    </div>`);
  const listBox = pop.querySelector('.tvn-popup-list');
  (items || []).forEach((it) => {
    const row = el(`
      <button class="tvn-popup-row tvn-focable ${it.selected ? 'tvn-sel' : ''}" data-nav ${it.selected ? 'data-autofocus' : ''} data-fkey="pop-${esc(it.id)}">
        <span class="tvn-popup-row-txt">
          <span class="tvn-popup-row-title">${esc(it.title)}</span>
          <span class="tvn-popup-row-sub ${it.danger ? 'tvn-danger-txt' : ''}">${esc(it.sub || '')}</span>
        </span>
        <span class="tvn-popup-check">${it.selected ? '✓' : ''}</span>
      </button>`);
    row.onclick = () => onPick(it, row);
    listBox.appendChild(row);
  });
  mountPopup(pop);
}

/**
 * About popout — app/device facts plus the support contact. Shares the #tvn-popup
 * shell (so navRootEl traps the D-pad in it and Back closes it) but renders an
 * info panel rather than a list. Rows come from about.js, the same source the PC
 * settings modal uses.
 */
function openAboutPopup() {
  closePopup(false);
  const pop = el(`
    <div id="tvn-popup">
      <div class="tvn-popup-panel tvn-about-panel">
        <span class="tvn-popup-title">About ZIPTV Pro</span>
        <div class="tvn-about-rows">
          ${getAboutRows().map(r => `
            <div class="tvn-about-row">
              <span class="tvn-about-k">${esc(r.label)}</span>
              <span class="tvn-about-v">${esc(r.value)}</span>
            </div>`).join('')}
        </div>
        <div class="tvn-about-dev">
          <span class="tvn-about-dev-label">Developer &amp; Support</span>
          <span class="tvn-about-dev-name">${esc(DEVELOPER.name)}</span>
          <span class="tvn-about-dev-line">${esc(DEVELOPER.email)}</span>
          <span class="tvn-about-dev-line">${esc(DEVELOPER.phone)}</span>
        </div>
        <button class="tvn-btn tvn-btn-primary tvn-focable tvn-about-close" data-nav data-autofocus data-fkey="about-close">Close</button>
      </div>
    </div>`);
  pop.querySelector('[data-fkey="about-close"]').onclick = () => closePopup();
  mountPopup(pop);
}

/** Shared tail of openPopup/openAboutPopup: backdrop dismiss, mount, focus. */
function mountPopup(pop) {
  // mouse users: clicking the dimmed backdrop dismisses
  pop.addEventListener('mousedown', (e) => { if (e.target === pop) closePopup(); });
  pop._returnFocus = document.activeElement;
  popupEl = pop;
  // While the shell is the visible surface the popout lives in the scaled
  // stage; over playback (OSD options) it must live INSIDE #video-container —
  // during OS fullscreen only descendants of the fullscreen element render,
  // so a body-level popout would paint behind the player.
  if (root && !root.classList.contains('tvn-hidden')) {
    stage.appendChild(pop);
  } else {
    pop.classList.add('tvn-popup-fixed');
    // mounted outside #tvn-stage → it can't inherit the accent tokens
    setAccent(pop, getAccent());
    (document.fullscreenElement || document.getElementById('video-container') || document.body).appendChild(pop);
  }
  focusAuto();
}

// ==========================================================================
// Screen router
// ==========================================================================
function rememberFocus() {
  if (!current) return;
  const a = document.activeElement;
  if (a && a.dataset && a.dataset.fkey && root && root.contains(a)) {
    lastFocusKey[current.name] = a.dataset.fkey;
  }
}

function setScreen(name, params = {}, push = true) {
  if (!root) return;
  rememberFocus();
  if (push && current) stack.push(current);
  current = { name, params };
  renderCurrent();
}

function goBack() {
  if (!root || root.classList.contains('tvn-hidden')) return false;
  if (!current || current.name === 'home') return false; // let the app handle root back (double-back exit)
  rememberFocus();
  const prev = stack.pop();
  current = prev || { name: 'home', params: {} };
  renderCurrent();
  return true;
}

function renderCurrent() {
  if (!root || !current) return;
  closePopup(false); // never carry a popout across a screen change
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  mqStop('focus');   // don't hold references into a stage we're about to replace
  window.__tvnQueryDel = null;
  stage.innerHTML = '<div class="tvn-ambient"></div>';
  const fn = SCREENS[current.name] || SCREENS.home;
  const fail = (err) => {
    console.error('tv-native render failed:', err);
    stage.insertAdjacentHTML('beforeend',
      `<div class="tvn-screen" style="display:grid;place-items:center;"><div class="tvn-note">Something went wrong. Press Back.</div></div>`);
    focusAuto();
  };
  try {
    const p = fn(current.params || {});
    if (p && typeof p.catch === 'function') p.catch(fail);
  } catch (err) {
    fail(err);
  }
  startClockTicker();
  focusAuto();
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function startClockTicker() {
  if (clockTimer) clearInterval(clockTimer);
  const tick = () => {
    if (!root) return;
    root.querySelectorAll('[data-tvn-time]').forEach(n => { n.textContent = fmtTime(); });
    root.querySelectorAll('[data-tvn-date]').forEach(n => { n.textContent = fmtDate(); });
    // launcher's big clock: meridiem rendered smaller so "12:14 PM" fits
    root.querySelectorAll('[data-tvn-bigtime]').forEach(n => {
      const t = fmtTime();
      const m = t.match(/^(.*?)\s*(AM|PM)$/i);
      n.innerHTML = m ? `${esc(m[1])}<span class="tvn-ampm">${esc(m[2])}</span>` : esc(t);
    });
  };
  tick();
  clockTimer = setInterval(tick, 10000);
}

// shared top-right cluster (clock + search + profile) for the Live panel
function profileInitials() {
  try {
    const creds = window.state?.user?.credentials;
    const src = (creds?.playlistName || 'ZP').trim();
    const words = src.split(/[\s._-]+/).filter(Boolean);
    return (words.length >= 2 ? words[0][0] + words[1][0] : src.slice(0, 2)).toUpperCase();
  } catch (e) { return 'ZP'; }
}
function playlistName() {
  try { return window.state?.user?.credentials?.playlistName || ''; } catch (e) { return ''; }
}

// ==========================================================================
// SCREEN: Home (launcher)
// ==========================================================================
async function screenHome() {
  const isElectron = !!(window.electronCast || window.appHost);
  const isNative = Capacitor.isNativePlatform();
  const canExit = isElectron || isNative;
  const scr = el(`
  <div class="tvn-screen tvn-home">
    <div class="tvn-home-bg" aria-hidden="true" data-home-bg>
      <i data-bg="live" class="on"></i><i data-bg="movies"></i><i data-bg="series"></i><i data-bg="guide"></i><i data-bg="settings"></i><i data-bg="watch"></i>
    </div>
    <div class="tvn-home-top">
      <div class="tvn-logo">
        <div class="tvn-logo-icon">${I.tv(28, '#06131f', 2.4)}</div>
        <div class="tvn-logo-word">ZIP<b>TV</b><span>Pro</span></div>
      </div>
      <button class="tvn-search-pill tvn-focable" data-nav data-fkey="search">
        ${I.search()}
        <span>Search channels, movies, series…</span>
      </button>
      <div style="flex:1"></div>
      ${TV_ONLY ? '' : `<button class="tvn-iconbtn tvn-focable" data-nav data-fkey="uimode" title="${isElectron ? 'Switch to Desktop interface' : 'Switch to Mobile interface'}">${I.monitor(26)}</button>`}
      <button class="tvn-avatar tvn-focable" data-nav data-fkey="profile" title="Playlists">${esc(profileInitials())}</button>
      ${canExit ? `<button class="tvn-iconbtn tvn-focable" data-nav data-fkey="power" title="Exit app">${I.power()}</button>` : ''}
    </div>

    <div class="tvn-home-mid">
      <div class="tvn-cards">
        <button class="tvn-card tvn-focable" data-nav data-autofocus data-fkey="live">
          <span class="tvn-card-tag" data-tvn-sync></span>
          <div class="tvn-card-icon">${I.tv(52)}</div>
          <div class="tvn-card-txt">
            <span class="tvn-card-title">Live TV</span>
            <span class="tvn-card-sub" data-count="live">&nbsp;</span>
          </div>
        </button>
        <button class="tvn-card tvn-focable" data-nav data-fkey="movies">
          <div class="tvn-card-icon">${I.movie()}</div>
          <div class="tvn-card-txt">
            <span class="tvn-card-title">Movies</span>
            <span class="tvn-card-sub" data-count="movie">&nbsp;</span>
          </div>
        </button>
        <button class="tvn-card tvn-focable" data-nav data-fkey="series">
          <div class="tvn-card-icon">${I.series()}</div>
          <div class="tvn-card-txt">
            <span class="tvn-card-title">Series</span>
            <span class="tvn-card-sub" data-count="series">&nbsp;</span>
          </div>
        </button>
        <div class="tvn-card-col">
          <button class="tvn-card tvn-card-half tvn-focable" data-nav data-fkey="guide">
            <div class="tvn-card-icon">${I.guide()}</div>
            <div class="tvn-card-txt"><span class="tvn-card-title">Guide</span></div>
          </button>
          <button class="tvn-card tvn-card-half tvn-focable" data-nav data-fkey="watch">
            <div class="tvn-card-icon">${I.users()}</div>
            <div class="tvn-card-txt"><span class="tvn-card-title">Join Watch Session</span></div>
          </button>
          <button class="tvn-card tvn-card-half tvn-focable" data-nav data-fkey="settings">
            <div class="tvn-card-icon">${I.gear()}</div>
            <div class="tvn-card-txt"><span class="tvn-card-title">Settings</span></div>
          </button>
        </div>
      </div>
      <div class="tvn-clock-block">
        <span class="tvn-clock-meta">${I.tv(24, 'rgba(255,255,255,0.6)', 2)} ${esc(playlistName())}</span>
        <span class="tvn-clock-time" data-tvn-bigtime></span>
        <span class="tvn-clock-date" data-tvn-date></span>
        <span class="tvn-clock-exp" data-tvn-exp hidden></span>
      </div>
    </div>

    <div class="tvn-hint">Arrow keys to move · OK / Enter to select · Back / Esc to return</div>
  </div>`);
  stage.appendChild(scr);

  scr.querySelector('[data-fkey="search"]').onclick = () => setScreen('search');
  const uimodeBtn = scr.querySelector('[data-fkey="uimode"]');
  if (uimodeBtn) uimodeBtn.onclick = switchOutOfTvMode;
  scr.querySelector('[data-fkey="profile"]').onclick = () => setScreen('settings', { section: 'playlists' });
  scr.querySelector('[data-fkey="live"]').onclick = () => setScreen('live');
  scr.querySelector('[data-fkey="movies"]').onclick = () => setScreen('browse', { type: 'movie' });
  scr.querySelector('[data-fkey="series"]').onclick = () => setScreen('browse', { type: 'series' });
  scr.querySelector('[data-fkey="guide"]').onclick = () => setScreen('guide');
  scr.querySelector('[data-fkey="watch"]').onclick = () => setScreen('watch');
  scr.querySelector('[data-fkey="settings"]').onclick = () => setScreen('settings');
  const powerBtn = scr.querySelector('[data-fkey="power"]');
  if (powerBtn) powerBtn.onclick = powerToTray;

  // Subscription status under the date — same source and precedence as the
  // desktop profile card (/connect device expiry first, then Xtream exp_date).
  try {
    const acct = H.accountStatus ? H.accountStatus() : null;
    if (acct && acct.text) {
      const expEl = scr.querySelector('[data-tvn-exp]');
      expEl.textContent = acct.text;
      expEl.classList.toggle('tvn-exp-danger', !!acct.danger);
      expEl.hidden = false;
    }
  } catch (e) {}

  // ambient backdrop follows the focused card
  const bgBox = scr.querySelector('[data-home-bg]');
  scr.addEventListener('focusin', (e) => {
    const k = e.target.closest && e.target.closest('.tvn-card[data-fkey]')?.dataset.fkey;
    if (!k || !bgBox.querySelector(`i[data-bg="${k}"]`)) return;
    bgBox.querySelectorAll('i').forEach(n => n.classList.toggle('on', n.dataset.bg === k));
  });

  // sync-age tag on the Live card
  const syncEl = scr.querySelector('[data-tvn-sync]');
  if (syncEl) syncEl.textContent = fmtAge(getLastSyncAge());

  // Counts (cached for 5 minutes). A zero total means the playlist cache hasn't
  // been filled yet — that is NOT a real answer, so it must not be cached as one
  // and the tiles must not be left on it. Booting mid-sync used to freeze the
  // labels on "Syncing…" until the user navigated away and back AND the 5-minute
  // cache expired; instead, keep re-checking in the background and fill the tiles
  // in place the moment the numbers land.
  try {
    if (!totalsCache || Date.now() - totalsCache.at > TOTALS_TTL_MS) {
      totalsCache = await fetchTotals();
    }
    paintCounts(scr, totalsCache);

    let tries = 0;
    while (scr.isConnected && !totalsCache.settled && !totalsComplete(totalsCache)) {
      // A playlist can legitimately have no movies or series, so give up after a
      // while and say so, rather than claiming to sync forever.
      if (++tries > TOTALS_POLL_MAX) { totalsCache.settled = true; break; }
      await new Promise(r => setTimeout(r, TOTALS_POLL_MS));
      if (!scr.isConnected) return;
      totalsCache = await fetchTotals();
      paintCounts(scr, totalsCache);
    }
    paintCounts(scr, totalsCache);
  } catch (e) {}
}

const TOTALS_TTL_MS = 5 * 60 * 1000;
const TOTALS_POLL_MS = 4000;
const TOTALS_POLL_MAX = 30;   // ~2 min, then accept the zeros as "empty"

async function fetchTotals() {
  const [l, m, s] = await Promise.all(['live', 'movie', 'series'].map(t =>
    getStreams({ type: t, categoryId: 'all', page: 1, limit: 1 }).catch(() => null)));
  return {
    at: Date.now(),
    live: l?.pagination?.total || 0,
    movie: m?.pagination?.total || 0,
    series: s?.pagination?.total || 0
  };
}

function totalsComplete(t) {
  return !!(t.live && t.movie && t.series);
}

function paintCounts(scr, t) {
  if (!scr.isConnected) return;
  // Once settled, a zero is the truth (an empty category), not a pending sync.
  const label = (n, unit) => (n ? `${fmtNum(n)} ${unit}` : (t.settled ? 'None yet' : 'Syncing…'));
  const set = (k, txt) => {
    const n = scr.querySelector(`[data-count="${k}"]`);
    if (n) n.textContent = txt;
  };
  set('live', label(t.live, 'channels'));
  set('movie', label(t.movie, 'titles'));
  set('series', label(t.series, 'shows'));
}

function exitApp() {
  try {
    if (Capacitor.isNativePlatform()) { App.exitApp(); return; }
  } catch (e) {}
  try {
    if (window.appHost && window.appHost.quitApp) { window.appHost.quitApp(); return; }
  } catch (e) {}
  try { window.close(); } catch (e) {}
}

// Home power button: on Electron this means "close" — stop all playback and
// park in the tray (recordings keep running), exactly like the window X.
// True quit stays available via Settings > Exit app and the tray menu.
function powerToTray() {
  try {
    if (window.appHost && window.appHost.hideToTray) { window.appHost.hideToTray(); return; }
  } catch (e) {}
  exitApp();
}

// ==========================================================================
// SCREEN: Live TV (rail · channels · now-playing panel)
// ==========================================================================
async function screenLive(params) {
  const scr = el(`
  <div class="tvn-screen tvn-live">
    <div class="tvn-live-rail">
      <div class="tvn-rail-head">
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="back" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.08)">${I.back()}</button>
        <span class="tvn-rail-title">Live TV</span>
      </div>
      <div class="tvn-cat-list" data-cats><div class="tvn-note">Loading categories…</div></div>
    </div>
    <div class="tvn-ch-list" data-chs><div class="tvn-note">Loading channels…</div></div>
    <div class="tvn-now">
      <div class="tvn-now-bg" data-now-bg></div>
      <div class="tvn-now-scrim"></div>
      <div class="tvn-now-top">
        <span class="tvn-now-clock" data-tvn-time></span>
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="np-guide" title="Guide">${I.guide(24, '#fff')}</button>
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="np-search">${I.search(24, '#fff')}</button>
        <div class="tvn-avatar">${esc(profileInitials())}</div>
      </div>
      <div class="tvn-now-info">
        <button class="tvn-btn tvn-btn-primary tvn-focable tvn-return-pill" data-nav data-fkey="return-player" hidden>
          ${I.play(26)} <span data-return-label>Return to player</span>
        </button>
        <span class="tvn-kicker">Now Playing</span>
        <span class="tvn-now-title" data-now-title></span>
        <span class="tvn-now-desc" data-now-desc></span>
        <div class="tvn-progress-wrap" data-now-prog hidden>
          <div class="tvn-progress"><div data-now-bar></div></div>
          <div class="tvn-progress-times"><span data-now-a></span><span data-now-b></span></div>
        </div>
      </div>
    </div>
  </div>`);
  stage.appendChild(scr);

  scr.querySelector('[data-fkey="back"]').onclick = () => goBack();
  scr.querySelector('[data-fkey="np-guide"]').onclick = () => setScreen('guide');
  scr.querySelector('[data-fkey="np-search"]').onclick = () => setScreen('search');

  const catBox = scr.querySelector('[data-cats]');
  const chBox = scr.querySelector('[data-chs]');

  // Back from fullscreen leaves the stream running under the shell — offer a
  // one-press jump straight back into it (no re-tune).
  const returnPill = scr.querySelector('[data-fkey="return-player"]');
  const playingCh = H.nowPlayingChannel ? H.nowPlayingChannel() : null;
  if (playingCh) {
    returnPill.hidden = false;
    returnPill.querySelector('[data-return-label]').textContent =
      playingCh.name ? `Return to ${playingCh.name}` : 'Return to player';
    returnPill.onclick = () => {
      hideForPlayback();
      if (H.returnToPlayer) H.returnToPlayer();
    };
  }

  // ---- categories ----
  let cats = [];
  try {
    if (!catCache || Date.now() - catCache.at > 5 * 60 * 1000) {
      const r = await getCategories('live');
      catCache = { at: Date.now(), data: r };
    }
    const r = catCache.data;
    // No "All Channels" pseudo-category: with thousands of channels it's
    // useless noise — the provider's own categories cover everything.
    cats = [
      { category_id: 'favorites', category_name: 'Favorites', count: r?.counts?.favorites ?? null },
      { category_id: 'recently_viewed', category_name: 'Recently Viewed', count: r?.counts?.recently_viewed ?? null },
      ...sortPinnedCats(((r && r.categories) || []).filter(c => c.category_id !== 'all'))
    ];
  } catch (e) {
    catBox.innerHTML = '<div class="tvn-note">No categories yet — the playlist may still be syncing.</div>';
  }

  // Default to the first real provider category (Favorites/Recently Viewed
  // lead the rail but are often empty — a bad landing spot).
  const firstRealCat = cats.find(c => !['favorites', 'recently_viewed'].includes(String(c.category_id)));
  const selCatId = params.catId || (firstRealCat && firstRealCat.category_id) || (cats[0] && cats[0].category_id) || 'favorites';
  if (cats.length) {
    catBox.innerHTML = '';
    cats.forEach(c => {
      const hue = hashHue(c.category_name);
      const reserved = ['all', 'favorites', 'recently_viewed'].includes(String(c.category_id));
      const catPinned = !reserved && H.isCatPinned && H.isCatPinned(c.category_id, 'live');
      const row = el(`
        <button class="tvn-cat-row tvn-focable ${String(c.category_id) === String(selCatId) ? 'tvn-sel' : ''}" data-nav data-fkey="cat-${esc(c.category_id)}"
          ${reserved ? '' : `data-pinnable="cat" data-pin-id="${esc(c.category_id)}" data-pin-name="${esc(c.category_name)}"`}>
          <div class="tvn-mono tvn-cat-tile" style="background:${grad(hue, hue + 30)}"><span>${esc(String(c.category_name || '?').slice(0, 2).toUpperCase())}</span></div>
          <div class="tvn-cat-txt">
            <span class="tvn-cat-name">${catPinned ? I.pin() : ''}${esc(c.category_name)}</span>
            <span class="tvn-cat-count">${c.count != null ? `${fmtNum(c.count)} channels` : ''}</span>
          </div>
        </button>`);
      row.onclick = () => {
        current.params = { ...current.params, catId: c.category_id };
        loadChannels(c.category_id);
        catBox.querySelectorAll('.tvn-cat-row').forEach(n => n.classList.remove('tvn-sel'));
        row.classList.add('tvn-sel');
      };
      catBox.appendChild(row);
    });
  }

  // ---- now-playing panel (live reflection of the focused channel) ----
  let focusSeq = 0;
  const nowBg = scr.querySelector('[data-now-bg]');
  const nowTitle = scr.querySelector('[data-now-title]');
  const nowDesc = scr.querySelector('[data-now-desc]');
  const nowProg = scr.querySelector('[data-now-prog]');
  const nowBar = scr.querySelector('[data-now-bar]');
  const nowA = scr.querySelector('[data-now-a]');
  const nowB = scr.querySelector('[data-now-b]');
  let lastNowProgram = null;

  async function reflect(ch) {
    const seq = ++focusSeq;
    const hue = hashHue(ch.name);
    nowBg.style.background = bdrop(hue);
    nowBg.innerHTML = ch.stream_icon ? `<img src="${esc(proxifyImage(ch.stream_icon))}" alt="" onerror="this.remove()">` : '';
    nowTitle.textContent = ch.name || '';
    nowDesc.textContent = '';
    nowProg.hidden = true;
    lastNowProgram = null;
    if (!ch.epg_channel_id && !ch.stream_id) return;
    const listings = await epgFor(ch.stream_id);
    if (seq !== focusSeq) return; // stale — focus moved on
    const { current: cur } = nowNextOf(listings);
    if (!cur) return;
    lastNowProgram = cur;
    nowTitle.textContent = cur.title || ch.name;
    nowDesc.textContent = cleanText(cur.description);
    nowProg.hidden = false;
    nowBar.style.width = `${progressPct(cur)}%`;
    nowA.textContent = fmtClockTs(cur.start_timestamp);
    nowB.textContent = fmtClockTs(cur.end_timestamp);
  }
  let reflectT = null;
  const reflectDebounced = (ch) => {
    clearTimeout(reflectT);
    reflectT = setTimeout(() => reflect(ch), 220);
  };
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (lastNowProgram && !nowProg.hidden) nowBar.style.width = `${progressPct(lastNowProgram)}%`;
  }, 30000);

  // ---- channels ----
  const PAGE = 120;
  let channels = [];
  let rendered = 0;
  let loadedCatId = null;

  function badgeRow(ch) {
    const b = [];
    const n = String(ch.name || '');
    if (/4k|uhd/i.test(n)) b.push('4K');
    else if (/fhd|1080/i.test(n)) b.push('FHD');
    else if (/\bhd\b/i.test(n)) b.push('HD');
    if (ch.epg_channel_id) b.push('EPG');
    if (ch.tv_archive) b.push('CATCHUP');
    return b.map(x => `<span class="tvn-badge">${x}</span>`).join('');
  }

  function appendRows() {
    const slice = channels.slice(rendered, rendered + PAGE);
    slice.forEach((ch, i) => {
      const idx = rendered + i;
      const views = H.getViewCount ? H.getViewCount(ch.stream_id) : 0;
      const fav = H.isFavorite ? H.isFavorite('live', ch.stream_id) : false;
      const chPinned = H.isChPinned && H.isChPinned(ch.stream_id);
      const row = el(`
        <button class="tvn-ch-row tvn-focable" data-nav data-fkey="ch-${esc(ch.stream_id)}"
          data-pinnable="ch" data-pin-id="${esc(ch.stream_id)}" data-pin-name="${esc(ch.name)}">
          ${tileHtml(ch.name, ch.stream_icon, 'tvn-ch-tile')}
          <div class="tvn-ch-txt">
            <span class="tvn-ch-name">${chPinned ? I.pin() : ''}${esc(ch.name)}</span>
            <span class="tvn-ch-sub">${views ? `${fmtNum(views)} view${views === 1 ? '' : 's'}` : '&nbsp;'}</span>
            <div class="tvn-ch-badges">${badgeRow(ch)}</div>
          </div>
          <span class="tvn-ch-star tvn-focable ${fav ? 'tvn-fav' : ''}" data-nav tabindex="-1" data-fkey="fav-${esc(ch.stream_id)}" role="button" title="Toggle favorite">${I.star}</span>
        </button>`);
      // focusin (not focus): fires for the row AND its nested star stop.
      row.addEventListener('focusin', () => {
        reflectDebounced(ch);
        if (idx > rendered - 25 && rendered < channels.length) appendRows();
      });
      const star = row.querySelector('.tvn-ch-star');
      star.addEventListener('click', async (e) => {
        e.stopPropagation(); // don't zap to the channel
        if (!H.toggleFavorite) return;
        try {
          await H.toggleFavorite('live', ch.stream_id);
          const on = H.isFavorite ? H.isFavorite('live', ch.stream_id) : false;
          star.classList.toggle('tvn-fav', on);
          catCache = null; // rail counts changed → refetch next screen build
          const cnt = scr.querySelector('[data-fkey="cat-favorites"] .tvn-cat-count');
          const n = window.state?.counts?.favorites;
          if (cnt && n != null) cnt.textContent = `${fmtNum(n)} channels`;
          // Unfavoriting while browsing Favorites removes the row.
          if (!on && String(loadedCatId) === 'favorites') loadChannels('favorites');
        } catch (err) {}
      });
      row.onclick = () => {
        const listings = epgCache.get(String(ch.stream_id));
        const nn = listings ? nowNextOf(listings.listings) : { current: null };
        zapList = channels;
        hideForPlayback();
        H.playChannel(ch, nn.current || null);
      };
      chBox.appendChild(row);
    });
    rendered += slice.length;
  }

  async function loadChannels(catId) {
    loadedCatId = catId;
    chBox.innerHTML = '<div class="tvn-note">Loading channels…</div>';
    try {
      const r = await getStreams({ type: 'live', categoryId: catId, page: 1, limit: 2000 });
      if (loadedCatId !== catId) return;
      channels = sortPinnedChannels((r && r.items) || []);
      rendered = 0;
      chBox.innerHTML = channels.length ? '' : '<div class="tvn-note">No channels in this category.</div>';
      appendRows();
      const firstRow = chBox.querySelector('.tvn-ch-row');
      if (firstRow) firstRow.setAttribute('data-autofocus', '');
      // Land D-pad focus in the channel list once it exists — unless the user
      // already moved somewhere meaningful while it loaded.
      const ae = document.activeElement;
      if (!ae || ae === document.body || (ae.dataset && ae.dataset.fkey === 'back')) focusAuto();
      if (channels[0]) reflectDebounced(channels[0]);
    } catch (e) {
      chBox.innerHTML = '<div class="tvn-note">Could not load channels.</div>';
    }
  }

  loadChannels(selCatId);
}

// ==========================================================================
// SCREEN: Browse (Movies / Series) — pill nav, hero, poster rows
// ==========================================================================
async function screenBrowse(params) {
  const type = params.type === 'series' ? 'series' : 'movie';
  const scr = el(`
  <div class="tvn-screen tvn-browse">
    <div class="tvn-hero-bg" data-hero-bg></div>
    <div class="tvn-hero-scrim"></div>

    <div class="tvn-browse-top">
      <div class="tvn-pillnav">
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="home">${I.home()}</button>
        <span class="tvn-pillnav-word">ZIP<b>TV</b></span>
        <button class="tvn-tab tvn-focable" data-nav data-fkey="tab-live">Live TV</button>
        <button class="tvn-tab tvn-focable ${type === 'movie' ? 'tvn-sel' : ''}" data-nav data-fkey="tab-movies">Movies</button>
        <button class="tvn-tab tvn-focable ${type === 'series' ? 'tvn-sel' : ''}" data-nav data-fkey="tab-series">Series</button>
      </div>
      <div style="flex:1"></div>
      <span class="tvn-browse-date" data-tvn-date></span>
      <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="b-search">${I.search(23, '#fff')}</button>
      <div class="tvn-avatar">${esc(profileInitials())}</div>
    </div>

    <div class="tvn-hero-txt">
      <span class="tvn-hero-genres" data-hero-genres></span>
      <span class="tvn-hero-title" data-hero-title></span>
      <span class="tvn-hero-desc" data-hero-desc></span>
    </div>

    <div class="tvn-rows tvn-rows-multi" data-rows></div>
  </div>`);
  stage.appendChild(scr);

  scr.querySelector('[data-fkey="home"]').onclick = () => goBack();
  scr.querySelector('[data-fkey="tab-live"]').onclick = () => setScreen('live', {}, false);
  scr.querySelector('[data-fkey="tab-movies"]').onclick = () => { if (type !== 'movie') setScreen('browse', { type: 'movie' }, false); };
  scr.querySelector('[data-fkey="tab-series"]').onclick = () => { if (type !== 'series') setScreen('browse', { type: 'series' }, false); };
  scr.querySelector('[data-fkey="b-search"]').onclick = () => setScreen('search');

  const heroBg = scr.querySelector('[data-hero-bg]');
  const heroGenres = scr.querySelector('[data-hero-genres]');
  const heroTitle = scr.querySelector('[data-hero-title]');
  const heroDesc = scr.querySelector('[data-hero-desc]');
  const rowsBox = scr.querySelector('[data-rows]');

  // hero reflects the focused poster; plot fetched lazily + cached
  let heroSeq = 0;
  async function reflectHero(item) {
    const seq = ++heroSeq;
    const art = item.stream_icon || item.cover || '';
    const hue = hashHue(item.name);
    heroBg.style.background = bdrop(hue);
    heroBg.innerHTML = art ? `<img src="${esc(proxifyImage(art))}" alt="" onerror="this.remove()">` : '';
    heroTitle.textContent = item.name || '';
    heroGenres.textContent = item.rating ? `★ ${parseFloat(item.rating).toFixed(1)}` : '';
    heroDesc.textContent = '';
    const key = `${type}:${item.stream_id || item.series_id}`;
    let info = infoCache.get(key);
    if (!info) {
      try {
        info = await getStreamInfo(type === 'series' ? item.series_id : item.stream_id, type);
        infoCache.set(key, info);
      } catch (e) { return; }
    }
    if (seq !== heroSeq) return;
    const meta = info?.info || {};
    const bits = [meta.genre, meta.releasedate || meta.releaseDate || meta.year].filter(Boolean);
    if (item.rating) bits.unshift(`★ ${parseFloat(item.rating).toFixed(1)}`);
    heroGenres.textContent = bits.join('  ·  ');
    heroDesc.textContent = cleanText(meta.plot || meta.description);
  }
  let heroT = null;
  const reflectHeroDebounced = (item) => {
    clearTimeout(heroT);
    heroT = setTimeout(() => reflectHero(item), 260);
  };

  function posterCard(item, fkey, extra = '') {
    const art = item.stream_icon || item.cover || '';
    const hue = hashHue(item.name);
    const watched = type === 'movie' && isCompleted(item.stream_id ?? item.id);
    const card = el(`
      <button class="tvn-poster tvn-focable${watched ? ' tvn-poster-watched' : ''}" data-nav data-fkey="${esc(fkey)}">
        <div class="tvn-poster-art" style="background:${grad(hue, hue + 45)}">
          ${art ? `<img src="${esc(proxifyImage(art))}" alt="" loading="lazy" onerror="this.remove()">` : ''}
          <div class="tvn-poster-scrim"></div>
          <span class="tvn-poster-name">${art ? '' : esc(item.name)}</span>
          ${watched ? '<div class="tvn-watch-again"><i data-lucide="rotate-ccw"></i><span>Watch again</span></div>' : ''}
          ${extra}
        </div>
        <span class="tvn-poster-label">${esc(item.name)}</span>
      </button>`);
    card.addEventListener('focus', () => reflectHeroDebounced(item));
    card.onclick = () => setScreen('details', { item, type });
    return card;
  }

  function addRow(title) {
    rowsBox.insertAdjacentHTML('beforeend', `<span class="tvn-row-title">${esc(title)}</span>`);
    const row = document.createElement('div');
    row.className = 'tvn-posterrow';
    rowsBox.appendChild(row);
    return row;
  }

  /**
   * A poster row that pages in more titles as you approach its end, instead of
   * being capped at a fixed slice.
   *
   * getStreams only takes page+limit (the offset is derived as (page-1)*limit),
   * so the limit MUST stay constant across a row's fetches — asking for 15 then
   * 10 would re-serve items already on screen. Hence one chunk size, with the
   * first fill just pulling two chunks so the row doesn't start out sparse.
   */
  function pagedRow(row, fkeyPrefix, fetchPage) {
    const CHUNK = 10;
    const PREFILL = 2;    // first paint = 20 posters
    const NEAR_END = 4;   // start fetching this many cards from the end

    const st = { page: 0, n: 0, loading: false, done: false, total: null };
    const seen = new Set();

    async function loadMore() {
      if (st.loading || st.done) return;
      st.loading = true;
      try {
        const r = await fetchPage(st.page + 1, CHUNK);
        if (!row.isConnected) { st.done = true; return; }
        const items = (r && r.items) || [];
        const total = r && r.pagination && r.pagination.total;
        if (!items.length) { st.done = true; return; }
        st.page += 1;
        append(items);
        if (typeof total === 'number' && st.n >= total) st.done = true;
      } catch (e) {
        st.done = true;   // a failing endpoint must not be hammered on every focus
      } finally {
        st.loading = false;
      }
    }

    function append(items) {
      for (const item of items) {
        const id = String(item.stream_id ?? item.series_id ?? item.name);
        if (seen.has(id)) continue;   // belt and braces against overlapping pages
        seen.add(id);
        const idx = st.n++;
        const card = posterCard(item, `${fkeyPrefix}-${idx}`);
        // D-pad: nearing the end of what's loaded pulls the next chunk in.
        card.addEventListener('focus', () => {
          if (idx >= st.n - NEAR_END) loadMore();
        });
        row.appendChild(card);
      }
    }

    // Mouse/touch: scrolling toward the right edge pulls the next chunk in too.
    row.addEventListener('scroll', () => {
      if (row.scrollWidth - row.scrollLeft - row.clientWidth < 600) loadMore();
    });

    return {
      state: st,
      loadMore,
      async fill() {
        for (let i = 0; i < PREFILL && !st.done; i++) await loadMore();
        return st.n;
      }
    };
  }

  // Continue watching row
  try {
    let cw = getContinueWatching(type === 'movie' ? 'movie' : 'series');
    // Series: collapse to one card per show (newest episode — list is already
    // sorted by lastWatched), so a binged series shows once, not per-episode.
    if (type !== 'movie') {
      const seen = new Set();
      cw = cw.filter((it) => {
        const key = String(it.seriesId || it.seriesName || it.id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    cw = cw.slice(0, 15);
    if (cw.length) {
      const row = addRow('Continue watching');
      cw.forEach((it, i) => {
        const pct = it.duration ? Math.min(100, Math.round(((it.position || it.currentTime || 0) / it.duration) * 100)) : 0;
        const item = { name: it.cardTitle || it.name, stream_icon: it.logo, stream_id: it.id, series_id: it.seriesId };
        const card = posterCard(item, `cw-${i}`,
          pct ? `<div class="tvn-poster-progress"><div style="width:${pct}%"></div></div>` : '');
        // Remote MENU / right-click opens "Remove from Continue watching".
        card.dataset.cwId = String(it.id);
        card.dataset.cwType = it.type || (type === 'movie' ? 'movie' : 'series');
        card.dataset.cwKey = String(it.seriesId || it.seriesName || it.id);
        card.dataset.cwName = it.cardTitle || it.name || 'Title';
        card.onclick = () => {
          // Series CW cards are grouped (one per show), so a click opens the
          // series details focused on the episode you left off — you pick up
          // from the list rather than blind-playing. Movies (ungrouped) still
          // resume straight into playback.
          if (it.type === 'series') {
            setScreen('details', {
              item: { series_id: it.seriesId, name: it.seriesName || it.cardTitle || it.name, cover: it.logo, stream_icon: it.logo },
              type: 'series',
              focusEpisodeId: it.id,
              focusSeason: it.season
            });
            return;
          }
          hideForPlayback();
          if (H.playVod) {
            H.playVod(it.id, 'movie', it.name, it.logo || '', '',
              it.containerExtension || '', it.position || 0, it.backdrop || '');
          } else H.resumeCw(it);
        };
        row.appendChild(card);
      });
    }
  } catch (e) {}

  // Latest added row (autofocus target)
  const latestRow = addRow(type === 'series' ? 'Latest series' : 'Latest added');
  latestRow.innerHTML = '<div class="tvn-note">Loading…</div>';
  try {
    const pager = pagedRow(latestRow, 'latest',
      (page, limit) => getStreams({ type, categoryId: 'all', page, limit, sort: 'added' }));
    const note = latestRow.firstElementChild;
    const n = await pager.fill();
    if (note) note.remove();
    if (!n) {
      latestRow.innerHTML = '<div class="tvn-note">Nothing here yet — still syncing?</div>';
    } else {
      const first = latestRow.querySelector('.tvn-poster');
      if (first) first.setAttribute('data-autofocus', '');
      focusAuto();
    }
  } catch (e) {
    latestRow.innerHTML = '<div class="tvn-note">Could not load titles.</div>';
  }

  // Category rows (first 10, loaded lazily one after another). Each row pages in
  // more titles as you reach its end, so a category isn't capped at a fixed slice.
  try {
    const r = await getCategories(type);
    const cats = ((r && r.categories) || []).filter(c => c.category_id !== 'all').slice(0, 10);
    for (const c of cats) {
      const row = addRow(c.category_name);
      const pager = pagedRow(row, `cat${c.category_id}`,
        (page, limit) => getStreams({ type, categoryId: c.category_id, page, limit }));
      const n = await pager.fill();
      // Nothing in this category — drop the row and its heading again.
      if (!n) {
        const heading = row.previousElementSibling;
        row.remove();
        if (heading && heading.classList.contains('tvn-row-title')) heading.remove();
      }
      if (!root || !stage.contains(scr)) return; // user left the screen
    }
  } catch (e) {}
}

// ==========================================================================
// SCREEN: Details (movie / series)
// ==========================================================================
async function screenDetails(params) {
  const { item, type, focusEpisodeId, focusSeason } = params;
  const art = item.stream_icon || item.cover || '';
  const hue = hashHue(item.name);
  const scr = el(`
  <div class="tvn-screen tvn-details">
    <div class="tvn-hero-bg" data-hero-bg style="background:${bdrop(hue)}">
      ${art ? `<img src="${esc(proxifyImage(art))}" alt="" onerror="this.remove()">` : ''}
    </div>
    <div class="tvn-hero-scrim"></div>
    <div class="tvn-browse-top">
      <div class="tvn-pillnav">
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="back">${I.back(24)}</button>
        <span class="tvn-pillnav-word">ZIP<b>TV</b></span>
      </div>
      <div style="flex:1"></div>
      <span class="tvn-browse-date" data-tvn-time style="font-weight:700"></span>
    </div>
    <div class="tvn-details-body">
      <div class="tvn-details-meta" data-meta></div>
      <div class="tvn-details-title">${esc(item.name)}</div>
      <div class="tvn-details-desc" data-plot>Loading details…</div>
      <div class="tvn-actions" data-actions></div>
      <div class="tvn-seasons" data-seasons hidden></div>
      <div class="tvn-episodes" data-eps hidden></div>
    </div>
  </div>`);
  stage.appendChild(scr);
  scr.querySelector('[data-fkey="back"]').onclick = () => goBack();

  const metaEl = scr.querySelector('[data-meta]');
  const plotEl = scr.querySelector('[data-plot]');
  const actions = scr.querySelector('[data-actions]');
  const seasonsEl = scr.querySelector('[data-seasons]');
  const epsEl = scr.querySelector('[data-eps]');

  const queryId = type === 'series' ? item.series_id : item.stream_id;
  let info = null;
  try {
    const key = `${type}:${queryId}`;
    info = infoCache.get(key) || await getStreamInfo(queryId, type);
    infoCache.set(key, info);
  } catch (e) {
    plotEl.textContent = 'Failed to load details from the server.';
  }
  const meta = info?.info || {};
  const backdrop = Array.isArray(meta.backdrop_path) ? (meta.backdrop_path[0] || '') : (meta.backdrop_path || '');
  if (backdrop) {
    scr.querySelector('[data-hero-bg]').innerHTML =
      `<img src="${esc(proxifyImage(backdrop))}" alt="" onerror="this.remove()">`;
  }
  plotEl.textContent = cleanText(meta.plot || meta.description) || 'No summary available.';
  const bits = [];
  if (item.rating || meta.rating) bits.push(`★ ${parseFloat(item.rating || meta.rating).toFixed(1)}`);
  if (meta.genre) bits.push(meta.genre);
  if (meta.releasedate || meta.releaseDate || meta.year) bits.push(meta.releasedate || meta.releaseDate || meta.year);
  if (type === 'movie' && meta.duration_secs) bits.push(`${Math.floor(meta.duration_secs / 60)} min`);
  if (type === 'series' && info?.seasons?.length) bits.push(`${info.seasons.length} seasons`);
  metaEl.innerHTML = bits.map(b => `<span>${esc(b)}</span>`).join('<span style="opacity:0.4">·</span>');

  const fav = H.isFavorite ? H.isFavorite(type, queryId) : false;
  const favBtn = el(`<button class="tvn-btn tvn-focable" data-nav data-fkey="fav"><span style="color:${fav ? 'var(--acc)' : 'rgba(255,255,255,0.5)'};font-size:28px">${I.star}</span> Favorite</button>`);
  favBtn.onclick = async () => {
    try {
      await H.toggleFavorite(type, queryId);
      const on = H.isFavorite(type, queryId);
      favBtn.querySelector('span').style.color = on ? 'var(--acc)' : 'rgba(255,255,255,0.5)';
    } catch (e) {}
  };

  if (type === 'movie') {
    const ext = info?.movie_data?.container_extension || meta.container_extension || item.container_extension || '';
    const cwItem = getContinueWatching('movie').find(i => String(i.id) === String(queryId));
    const resume = cwItem && cwItem.position ? cwItem.position : 0;
    const playBtn = el(`<button class="tvn-btn tvn-btn-primary tvn-focable" data-nav data-autofocus data-fkey="play">${I.play(26)} ${resume ? 'Resume' : 'Play Now'}</button>`);
    playBtn.onclick = () => {
      hideForPlayback();
      H.playVod(queryId, 'movie', item.name, art, plotEl.textContent, ext, resume, backdrop);
    };
    actions.appendChild(playBtn);
    if (resume) {
      const restart = el(`<button class="tvn-btn tvn-focable" data-nav data-fkey="restart">${I.play(24, '#fff')} Start over</button>`);
      restart.onclick = () => {
        hideForPlayback();
        H.playVod(queryId, 'movie', item.name, art, plotEl.textContent, ext, 0, backdrop);
      };
      actions.appendChild(restart);
    }

    // Watch Together: open a session for this title, then show the lobby with the
    // code. The session carries identifiers only — the guest's device rebuilds
    // the stream URL from its own credentials.
    const wtBtn = el(`<button class="tvn-btn tvn-focable" data-nav data-fkey="wt">${I.users(24, '#fff')} Watch Together</button>`);
    wtBtn.onclick = async () => {
      wtBtn.disabled = true;
      const code = await window.__wtHost({
        type: 'movie',
        streamId: String(queryId),
        ext,
        name: item.name,
        logo: art || '',
        backdrop: backdrop || ''
      });
      wtBtn.disabled = false;
      if (code) setScreen('watch', { mode: 'host' });
    };
    actions.appendChild(wtBtn);

    actions.appendChild(favBtn);
  } else {
    actions.appendChild(favBtn);
    // seasons + episodes
    const episodesMap = info?.episodes || {};
    const seasons = Object.keys(episodesMap);
    if (!seasons.length) {
      epsEl.hidden = false;
      epsEl.innerHTML = '<div class="tvn-note">No episodes available.</div>';
    } else {
      seasonsEl.hidden = false;
      epsEl.hidden = false;
      // Opening from Continue Watching focuses the season + episode left off on.
      const initialSeason = (focusSeason != null && episodesMap[String(focusSeason)])
        ? String(focusSeason) : seasons[0];
      const renderSeason = (sn) => {
        seasonsEl.querySelectorAll('.tvn-season-pill').forEach(p =>
          p.classList.toggle('tvn-sel', p.dataset.season === String(sn)));
        epsEl.innerHTML = '';
        (episodesMap[sn] || []).forEach((ep, i) => {
          const w = getWatchInfo(ep.id);
          const isFocus = focusEpisodeId != null
            ? String(ep.id) === String(focusEpisodeId)
            : (sn === initialSeason && i === 0);
          const card = el(`
            <button class="tvn-ep-card tvn-focable${w.completed ? ' tvn-ep-watched' : ''}" data-nav data-fkey="ep-${esc(sn)}-${i}" ${isFocus ? 'data-autofocus' : ''}>
              <span class="tvn-ep-num">Episode ${esc(ep.episode_num || i + 1)}</span>
              <span class="tvn-ep-title">${esc(ep.title || 'Episode')}</span>
              <span class="tvn-ep-meta">${w.completed ? 'Watched' : esc(ep.info?.duration || '')}</span>
              ${(!w.completed && w.pct > 0) ? `<div class="tvn-ep-progress"><div style="width:${w.pct}%"></div></div>` : ''}
            </button>`);
          card.onclick = () => {
            hideForPlayback();
            // Full series context (auto-next on end, >>/<< episode zap) —
            // NOT the generic movie path, which can't advance episodes.
            H.playEpisode(item, info, sn, i, 0, backdrop);
          };
          epsEl.appendChild(card);
        });
      };
      seasons.forEach(sn => {
        const pill = el(`<button class="tvn-season-pill tvn-focable" data-nav data-season="${esc(sn)}" data-fkey="season-${esc(sn)}">Season ${esc(sn)}</button>`);
        pill.onclick = () => renderSeason(sn);
        seasonsEl.appendChild(pill);
      });
      renderSeason(initialSeason);
    }
  }
  focusAuto();
}

// ==========================================================================
// SCREEN: Guide (now / next per channel, category rail)
// ==========================================================================
async function screenGuide(params) {
  const scr = el(`
  <div class="tvn-screen tvn-guide">
    <div class="tvn-live-rail">
      <div class="tvn-rail-head">
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="back" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.08)">${I.back()}</button>
        <span class="tvn-rail-title">Guide</span>
      </div>
      <div class="tvn-cat-list" data-cats></div>
    </div>
    <div class="tvn-guide-list" data-rows><div class="tvn-note">Loading guide…</div></div>
  </div>`);
  stage.appendChild(scr);
  scr.querySelector('[data-fkey="back"]').onclick = () => goBack();

  const catBox = scr.querySelector('[data-cats]');
  const rowsBox = scr.querySelector('[data-rows]');

  let cats = [];
  try {
    if (!catCache || Date.now() - catCache.at > 5 * 60 * 1000) {
      catCache = { at: Date.now(), data: await getCategories('live') };
    }
    cats = [
      { category_id: 'favorites', category_name: 'Favorites' },
      ...sortPinnedCats(((catCache.data && catCache.data.categories) || []).filter(c => c.category_id !== 'all'))
    ];
  } catch (e) {}

  // No "All Channels" here either — land on the first provider category.
  const gFirstReal = cats.find(c => String(c.category_id) !== 'favorites');
  const selCatId = params.catId || (gFirstReal && gFirstReal.category_id) || 'favorites';
  catBox.innerHTML = '';
  cats.forEach(c => {
    const hue = hashHue(c.category_name);
    const reserved = ['all', 'favorites'].includes(String(c.category_id));
    const catPinned = !reserved && H.isCatPinned && H.isCatPinned(c.category_id, 'live');
    const row = el(`
      <button class="tvn-cat-row tvn-focable ${String(c.category_id) === String(selCatId) ? 'tvn-sel' : ''}" data-nav data-fkey="gcat-${esc(c.category_id)}"
        ${reserved ? '' : `data-pinnable="cat" data-pin-id="${esc(c.category_id)}" data-pin-name="${esc(c.category_name)}"`}>
        <div class="tvn-mono tvn-cat-tile" style="background:${grad(hue, hue + 30)}"><span>${esc(String(c.category_name || '?').slice(0, 2).toUpperCase())}</span></div>
        <div class="tvn-cat-txt"><span class="tvn-cat-name">${catPinned ? I.pin() : ''}${esc(c.category_name)}</span></div>
      </button>`);
    row.onclick = () => {
      current.params = { ...current.params, catId: c.category_id };
      loadRows(c.category_id);
      catBox.querySelectorAll('.tvn-cat-row').forEach(n => n.classList.remove('tvn-sel'));
      row.classList.add('tvn-sel');
    };
    catBox.appendChild(row);
  });

  let loadSeq = 0;
  async function loadRows(catId) {
    const seq = ++loadSeq;
    rowsBox.innerHTML = '<div class="tvn-note">Loading guide…</div>';
    let channels = [];
    try {
      const r = await getStreams({ type: 'live', categoryId: catId, page: 1, limit: 2000 });
      channels = sortPinnedChannels((r && r.items) || []);
    } catch (e) {}
    if (seq !== loadSeq) return;
    rowsBox.innerHTML = channels.length ? '' : '<div class="tvn-note">No channels in this category.</div>';

    // Lazy EPG fill driven by visibility (with a lookahead margin), so the
    // guide keeps filling as it scrolls instead of stopping after the first
    // screenful. Focus prefetch stays as a fallback for old TV webviews.
    if (rowsBox._epgIo) rowsBox._epgIo.disconnect();
    const io = (typeof IntersectionObserver === 'function')
      ? new IntersectionObserver((entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting && en.target._fillEpg) en.target._fillEpg();
          });
        }, { root: rowsBox, rootMargin: '600px 0px' })
      : null;
    rowsBox._epgIo = io;

    // Rows render in pages (like the Live channel list) so big categories
    // aren't cut off at a fixed cap.
    const PAGE = 60;
    let rendered = 0;
    function appendGuideRows() {
      const slice = channels.slice(rendered, rendered + PAGE);
      slice.forEach((ch, i) => {
        const idx = rendered + i;
        const row = el(`
          <button class="tvn-g-row tvn-focable" data-nav data-fkey="g-${esc(ch.stream_id)}" ${idx === 0 ? 'data-autofocus' : ''}>
            <div class="tvn-g-ch">
              ${tileHtml(ch.name, ch.stream_icon, 'tvn-g-tile')}
              <span class="tvn-g-name">${esc(ch.name)}</span>
            </div>
            <div class="tvn-g-progs" data-progs><div class="tvn-note" style="padding:0;font-size:21px">Loading…</div></div>
          </button>`);
        row.onclick = () => {
          const cached = epgCache.get(String(ch.stream_id));
          const nn = cached ? nowNextOf(cached.listings) : { current: null };
          zapList = channels;
          hideForPlayback();
          H.playChannel(ch, nn.current || null);
        };
        rowsBox.appendChild(row);
        row._fillEpg = async () => {
          if (row._filled) return;
          row._filled = true;
          const listings = await epgFor(ch.stream_id);
          if (seq !== loadSeq || !rowsBox.contains(row)) return;
          const progs = row.querySelector('[data-progs]');
          const { current: cur, upcoming } = nowNextOf(listings);
          if (!cur) { progs.innerHTML = '<div class="tvn-note" style="padding:0;font-size:21px">No guide data</div>'; return; }
          const seg = (p, cls, label) => `
            <div class="tvn-g-seg ${cls}">
              <span class="tvn-g-seg-time">${label} · ${fmtClockTs(p.start_timestamp)}</span>
              <span class="tvn-g-seg-title">${esc(p.title || '')}</span>
              ${cls === 'tvn-g-now' ? `<div class="tvn-progress"><div style="width:${progressPct(p)}%"></div></div>` : ''}
            </div>`;
          let html = seg(cur, 'tvn-g-now', 'NOW');
          (upcoming || []).slice(0, 2).forEach(p => { html += seg(p, 'tvn-g-next', 'NEXT'); });
          progs.innerHTML = html;
        };
        row.addEventListener('focus', () => {
          row._fillEpg();
          // prefetch neighbours for smooth scrolling
          const next = row.nextElementSibling;
          const next2 = next && next.nextElementSibling;
          [next, next2].forEach(n => { if (n && n._fillEpg) n._fillEpg(); });
          // approaching the tail → render the next page of rows
          if (idx > rendered - 15 && rendered < channels.length) appendGuideRows();
        });
        if (io) io.observe(row);
      });
      rendered += slice.length;
    }
    appendGuideRows();

    const ae = document.activeElement;
    if (!ae || ae === document.body || (ae.dataset && ae.dataset.fkey === 'back')) focusAuto();

    // No IntersectionObserver (ancient TV webview): eagerly fill the first
    // screenful, politely (sequential); the rest fill on focus.
    if (!io) {
      const first = Array.from(rowsBox.querySelectorAll('.tvn-g-row')).slice(0, 10);
      for (const r of first) {
        if (seq !== loadSeq) return;
        // eslint-disable-next-line no-await-in-loop
        await r._fillEpg();
      }
    }
  }
  loadRows(selCatId);
}

// ==========================================================================
// SCREEN: Settings
// ==========================================================================
// Two-level layout: a left category rail (Account · Playback · Appearance ·
// System) drives a right content pane. The pane re-renders as focus moves down
// the rail (select-on-focus, same feel as the Live screen), and D-pad Right
// steps into the freshly-rendered tiles via the geometric focus engine.
async function screenSettings(params = {}) {
  const isElectron = !!(window.electronCast || window.appHost);
  const isNative = Capacitor.isNativePlatform();
  const version = (typeof __APP_VERSION__ !== 'undefined') ? __APP_VERSION__ : '';
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  // Compact rail glyphs (stroke style matches the shell's shared I.* icons).
  const PANE_ICON = {
    account: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4 4-6 8-6s8 2 8 6"></path></svg>`,
    playback: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"></polygon></svg>`,
    appearance: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="8.5" cy="9" r="1.4" fill="currentColor" stroke="none"></circle><circle cx="15.5" cy="9" r="1.4" fill="currentColor" stroke="none"></circle><circle cx="9" cy="15.2" r="1.4" fill="currentColor" stroke="none"></circle><circle cx="15" cy="15.2" r="1.4" fill="currentColor" stroke="none"></circle></svg>`,
    system: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"></rect><line x1="4" y1="10" x2="20" y2="10"></line><line x1="10" y1="10" x2="10" y2="20"></line></svg>`
  };
  const PANES = [
    { key: 'account', label: 'Account' },
    { key: 'playback', label: 'Playback' },
    { key: 'appearance', label: 'Appearance' },
    { key: 'system', label: 'System' }
  ];

  const scr = el(`
  <div class="tvn-screen tvn-settings tvn-settings2">
    <div class="tvn-set-nav">
      <div class="tvn-rail-head">
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="back" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.08)">${I.back()}</button>
        <span class="tvn-rail-title">Settings</span>
      </div>
      <div class="tvn-set-navlist" data-navlist></div>
    </div>
    <div class="tvn-set-pane" data-pane></div>
  </div>`);
  stage.appendChild(scr);
  scr.querySelector('[data-fkey="back"]').onclick = () => goBack();
  const navBox = scr.querySelector('[data-navlist]');
  const paneBox = scr.querySelector('[data-pane]');

  // Pane content builders — reuse the existing tile visuals, mounted into the
  // right pane instead of one long scrolling list.
  const group = (title) => {
    const g = el(`<div class="tvn-set-group">${title ? `<span class="tvn-set-group-title">${esc(title)}</span>` : ''}</div>`);
    const grid = document.createElement('div');
    grid.className = 'tvn-set-grid';
    g.appendChild(grid);
    paneBox.appendChild(g);
    return grid;
  };
  const tile = (grid, { icon, title, sub, fkey, danger, accent }) => {
    const t = el(`
      <button class="tvn-set-tile tvn-focable ${danger ? 'tvn-danger' : ''}" data-nav data-fkey="${esc(fkey)}">
        <div class="tvn-set-tile-icon">${icon}</div>
        <div class="tvn-set-tile-txt">
          <span class="tvn-set-tile-title">${esc(title)}</span>
          <span class="tvn-set-tile-sub">${esc(sub || '')}</span>
        </div>
      </button>`);
    if (accent) t.querySelector('.tvn-set-tile-icon').style.color = 'var(--acc)';
    grid.appendChild(t);
    return t;
  };

  // ---- Account: status banner + playlist management ----------------------
  async function paneAccount() {
    let acct = null;
    try { acct = H.accountStatus ? H.accountStatus() : null; } catch (e) {}
    paneBox.appendChild(el(`
      <div class="tvn-acct-banner ${acct && acct.danger ? 'tvn-acct-danger' : ''}">
        <span class="tvn-acct-dot"></span>
        <div class="tvn-acct-txt">
          <span class="tvn-acct-k">Subscription</span>
          <span class="tvn-acct-v">${esc(acct ? acct.text : 'Active')}</span>
        </div>
      </div>`));

    const g = group('Playlists');
    try {
      const { playlists, activeId } = await getPlaylists();
      const plName = (p) => (p && (p.name || p.playlistName)) || 'Playlist';
      const active = (playlists || []).find(p => String(p.id) === String(activeId));
      const swTile = tile(g, {
        icon: I.list(30), title: 'Switch playlist', sub: plName(active),
        fkey: 'switchpl', accent: true
      });
      swTile.onclick = () => {
        let switching = false;
        openPopup({
          title: 'Switch playlist',
          items: (playlists || []).map(p => ({
            id: p.id,
            title: plName(p),
            sub: String(p.id) === String(activeId)
              ? `Current playlist${acct ? ` · ${acct.text}` : ''}` : '',
            selected: String(p.id) === String(activeId),
            danger: String(p.id) === String(activeId) && !!(acct && acct.danger)
          })),
          onPick: async (it, row) => {
            if (String(it.id) === String(activeId)) { closePopup(); return; }
            if (switching) return;
            switching = true;
            row.querySelector('.tvn-popup-row-sub').textContent = 'Switching…';
            try {
              await H.switchPlaylist(it.id); // re-enters the shell on success
            } catch (e) {
              switching = false;
              row.querySelector('.tvn-popup-row-sub').textContent = 'Failed — try again';
            }
          }
        });
      };
    } catch (e) {}
    const addPlTile = tile(g, { icon: I.plus(30), title: 'Add playlist', sub: 'Connect a new source', fkey: 'addpl' });
    addPlTile.onclick = () => { try { if (H.addPlaylist) H.addPlaylist(); } catch (e) {} };
    const resyncTile = tile(g, { icon: I.refresh(30), title: 'Refresh playlist data', sub: 'Re-sync channels, movies & series', fkey: 'resync' });
    resyncTile.onclick = async () => {
      const sub = resyncTile.querySelector('.tvn-set-tile-sub');
      sub.textContent = 'Syncing…';
      try {
        await H.resync((msg) => { sub.textContent = msg || 'Syncing…'; });
        sub.textContent = 'Up to date';
        catCache = null; totalsCache = null; epgCache.clear();
      } catch (e) { sub.textContent = 'Sync failed — try again'; }
    };
  }

  // ---- Playback: player engine + performance mode ------------------------
  function panePlayback() {
    const g = group('Playback');
    // Android (libVLC): Native ↔ Web (HTML5). Desktop (Electron): FFmpeg →
    // HTML5 → External. Web browsers have neither layer, so no engine tile.
    if (isNative) {
      const label = (v) => v === 'web' ? 'Web player · HTML5 (built-in)' : 'Native player · libVLC (recommended)';
      let v = lsGet('playerEngine') === 'web' ? 'web' : 'native';
      const engTile = tile(g, { icon: I.monitor(30), title: 'Player engine', sub: label(v), fkey: 'engine' });
      engTile.onclick = () => {
        v = v === 'web' ? 'native' : 'web';
        lsSet('playerEngine', v);
        engTile.querySelector('.tvn-set-tile-sub').textContent = label(v);
      };
    } else if (isElectron) {
      const order = ['ffmpeg', 'html5', 'external'];
      const labels = {
        ffmpeg: 'FFmpeg transcode (recommended)',
        html5: 'HTML5 player (built-in)',
        external: 'External player (default app)'
      };
      let idx = Math.max(0, order.indexOf(order.includes(lsGet('electronEngine')) ? lsGet('electronEngine') : 'ffmpeg'));
      const engTile = tile(g, { icon: I.monitor(30), title: 'Player engine', sub: labels[order[idx]], fkey: 'engine' });
      engTile.onclick = () => {
        idx = (idx + 1) % order.length;
        lsSet('electronEngine', order[idx]);
        engTile.querySelector('.tvn-set-tile-sub').textContent = labels[order[idx]];
      };
    }
    const perf = lsGet('perfLite');
    const perfLabel = perf === 'on' ? 'On' : perf === 'off' ? 'Off' : 'Auto';
    const perfTile = tile(g, { icon: I.zap(30), title: 'Performance mode', sub: perfLabel, fkey: 'perf' });
    perfTile.onclick = () => {
      // cycle Auto → On → Off
      const cur = lsGet('perfLite');
      const next = cur === null ? 'on' : cur === 'on' ? 'off' : null;
      if (window.setPerfLite) window.setPerfLite(next === null ? null : next === 'on');
      perfTile.querySelector('.tvn-set-tile-sub').textContent = next === 'on' ? 'On' : next === 'off' ? 'Off' : 'Auto';
    };
  }

  // ---- Appearance: accent color ------------------------------------------
  function paneAppearance() {
    const g = el(`<div class="tvn-set-group"><span class="tvn-set-group-title">Accent color</span></div>`);
    const swRow = el(`<div class="tvn-swatch-row"></div>`);
    g.appendChild(swRow);
    paneBox.appendChild(g);
    ACCENTS.forEach((c) => {
      const sw = el(`<button class="tvn-swatch tvn-focable ${getAccent() === c ? 'tvn-sel' : ''}" data-nav data-fkey="acc-${c}" style="background:${c}" title="Accent"></button>`);
      sw.onclick = () => {
        try { localStorage.setItem(ACCENT_KEY, c); } catch (e) {}
        setAccent(stage, c);
        if (popupEl) setAccent(popupEl, c);
        swRow.querySelectorAll('.tvn-swatch').forEach(n => n.classList.remove('tvn-sel'));
        sw.classList.add('tvn-sel');
      };
      swRow.appendChild(sw);
    });
  }

  // ---- System: updates, interface, about + a separated danger zone -------
  function paneSystem() {
    const g = group('About & updates');
    const updTile = tile(g, { icon: I.download(30), title: 'Check for updates', sub: version ? `Version ${version}` : '', fkey: 'update' });
    updTile.onclick = async () => {
      const sub = updTile.querySelector('.tvn-set-tile-sub');
      sub.textContent = 'Checking…';
      try {
        const r = await H.checkUpdate();
        sub.textContent = r === false ? `Up to date · v${version}` : `Version ${version}`;
      } catch (e) { sub.textContent = 'Check failed'; }
    };
    tile(g, { icon: I.info(30), title: 'About ZIPTV Pro', sub: version ? `Version ${version} · TV interface` : 'TV interface', fkey: 'about' }).onclick = openAboutPopup;
    if (!TV_ONLY) {
      const uiTile = tile(g, {
        icon: I.monitor(30),
        title: isElectron ? 'Switch to Desktop interface' : 'Switch to Mobile interface',
        sub: 'Leave TV mode and reload', fkey: 'uimode'
      });
      uiTile.onclick = switchOutOfTvMode;
    }
    // Danger zone — set apart from the safe actions so it's harder to hit by
    // accident with a D-pad.
    const dg = group('Account actions');
    dg.parentElement.classList.add('tvn-set-danger-group');
    const outTile = tile(dg, { icon: I.logout(30), title: 'Sign out', sub: 'Disconnect this playlist', fkey: 'logout', danger: true });
    outTile.onclick = async () => {
      outTile.querySelector('.tvn-set-tile-sub').textContent = 'Signing out…';
      try { await H.logout(); } catch (e) {}
    };
    const exitTile = tile(dg, { icon: I.power(30), title: 'Exit app', sub: isElectron ? 'Close ZIPTV Pro' : 'Leave the app', fkey: 'exit', danger: true });
    exitTile.onclick = exitApp;
  }

  const RENDER = { account: paneAccount, playback: panePlayback, appearance: paneAppearance, system: paneSystem };
  async function renderPane(key) {
    paneBox.innerHTML = '';
    try { await RENDER[key](); } catch (e) {}
  }

  // Left rail: select-on-focus. Moving down the rail live-swaps the pane; the
  // active pane is re-rendered lazily so opening Settings only builds one pane.
  let activePane = 'account';
  PANES.forEach((p) => {
    const item = el(`
      <button class="tvn-set-navitem tvn-focable ${p.key === activePane ? 'tvn-sel' : ''}" data-nav data-fkey="pane-${p.key}" ${p.key === activePane ? 'data-autofocus' : ''}>
        <span class="tvn-set-navitem-ic">${PANE_ICON[p.key]}</span>
        <span class="tvn-set-navitem-lb">${esc(p.label)}</span>
      </button>`);
    const activate = () => {
      navBox.querySelectorAll('.tvn-set-navitem').forEach(n => n.classList.remove('tvn-sel'));
      item.classList.add('tvn-sel');
      if (activePane === p.key && paneBox.childElementCount) return; // already shown
      activePane = p.key;
      renderPane(p.key);
    };
    item.addEventListener('focus', activate);
    item.onclick = activate;
    navBox.appendChild(item);
  });

  await renderPane(activePane);
}

// ==========================================================================
// SCREEN: Search (on-screen keyboard + live results)
// ==========================================================================
async function screenSearch() {
  const scr = el(`
  <div class="tvn-screen tvn-search">
    <div class="tvn-search-left">
      <div class="tvn-rail-head">
        <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="back" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.08)">${I.back()}</button>
        <span class="tvn-rail-title">Search</span>
      </div>
      <div class="tvn-query-box">
        ${I.search(28)}
        <span class="tvn-query-text" data-q><span class="tvn-placeholder">Type to search…</span><span class="tvn-caret"></span></span>
      </div>
      <div class="tvn-keys" data-keys></div>
    </div>
    <div class="tvn-search-results" data-results>
      <div class="tvn-note">Search channels, movies and series with the on-screen keys.</div>
    </div>
  </div>`);
  stage.appendChild(scr);
  scr.querySelector('[data-fkey="back"]').onclick = () => goBack();

  const qEl = scr.querySelector('[data-q]');
  const keysEl = scr.querySelector('[data-keys]');
  const resEl = scr.querySelector('[data-results]');
  let query = '';
  let searchT = null;
  let searchSeq = 0;

  function renderQuery() {
    qEl.innerHTML = query
      ? `${esc(query)}<span class="tvn-caret"></span>`
      : `<span class="tvn-placeholder">Type to search…</span><span class="tvn-caret"></span>`;
  }

  async function runSearch() {
    const seq = ++searchSeq;
    const q = query.trim();
    if (q.length < 2) {
      resEl.innerHTML = '<div class="tvn-note">Keep typing — at least 2 characters.</div>';
      return;
    }
    resEl.innerHTML = '<div class="tvn-note">Searching…</div>';
    const [live, movies, series] = await Promise.all([
      getStreams({ type: 'live', categoryId: 'all', search: q, page: 1, limit: 10 }).catch(() => null),
      getStreams({ type: 'movie', categoryId: 'all', search: q, page: 1, limit: 10 }).catch(() => null),
      getStreams({ type: 'series', categoryId: 'all', search: q, page: 1, limit: 10 }).catch(() => null)
    ]);
    if (seq !== searchSeq) return;
    resEl.innerHTML = '';
    const chs = (live && live.items) || [];
    const mvs = (movies && movies.items) || [];
    const srs = (series && series.items) || [];
    if (!chs.length && !mvs.length && !srs.length) {
      resEl.innerHTML = `<div class="tvn-note">No results for “${esc(q)}”.</div>`;
      return;
    }
    if (chs.length) {
      resEl.insertAdjacentHTML('beforeend', '<span class="tvn-result-row-title">Channels</span>');
      const row = el('<div class="tvn-result-chrow"></div>');
      chs.forEach((ch, i) => {
        const card = el(`
          <button class="tvn-result-ch tvn-focable" data-nav data-fkey="sch-${i}">
            ${tileHtml(ch.name, ch.stream_icon, '')}
            <span class="tvn-result-ch-name">${esc(ch.name)}</span>
          </button>`);
        card.onclick = () => { zapList = chs; hideForPlayback(); H.playChannel(ch, null); };
        row.appendChild(card);
      });
      resEl.appendChild(row);
    }
    const vodRow = (title, items, type) => {
      if (!items.length) return;
      resEl.insertAdjacentHTML('beforeend', `<span class="tvn-result-row-title">${title}</span>`);
      const row = el('<div class="tvn-posterrow"></div>');
      items.forEach((item, i) => {
        const art = item.stream_icon || item.cover || '';
        const hue = hashHue(item.name);
        const card = el(`
          <button class="tvn-poster tvn-focable" data-nav data-fkey="s${type}-${i}">
            <div class="tvn-poster-art" style="background:${grad(hue, hue + 45)}">
              ${art ? `<img src="${esc(proxifyImage(art))}" alt="" loading="lazy" onerror="this.remove()">` : ''}
              <div class="tvn-poster-scrim"></div>
              <span class="tvn-poster-name">${art ? '' : esc(item.name)}</span>
            </div>
            <span class="tvn-poster-label">${esc(item.name)}</span>
          </button>`);
        card.onclick = () => setScreen('details', { item, type });
        row.appendChild(card);
      });
      resEl.appendChild(row);
    };
    vodRow('Movies', mvs, 'movie');
    vodRow('Series', srs, 'series');
  }

  function type_(chr) {
    if (chr === 'DEL') query = query.slice(0, -1);
    else if (chr === 'CLR') query = '';
    else if (chr === 'SPC') query += ' ';
    else query += chr;
    renderQuery();
    clearTimeout(searchT);
    searchT = setTimeout(runSearch, 350);
  }

  // Physical Backspace deletes a character (instead of navigating back) while
  // there is something to delete. Cleared by renderCurrent on screen change.
  window.__tvnQueryDel = () => {
    if (!query) return false;
    type_('DEL');
    return true;
  };

  const KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');
  KEYS.forEach((k, i) => {
    const b = el(`<button class="tvn-key tvn-focable" data-nav data-fkey="k-${k}" ${i === 0 ? 'data-autofocus' : ''}>${k}</button>`);
    b.onclick = () => type_(k);
    keysEl.appendChild(b);
  });
  [['SPC', 'Space'], ['DEL', '⌫ Delete'], ['CLR', 'Clear']].forEach(([code, label]) => {
    const b = el(`<button class="tvn-key tvn-key-wide tvn-focable" data-nav data-fkey="k-${code}" style="font-size:22px">${label}</button>`);
    b.onclick = () => type_(code);
    keysEl.appendChild(b);
  });

  // physical keyboard (desktop /tv mode) types straight into the query
  scr.addEventListener('keydown', (e) => {
    if (e.key.length === 1 && /[a-zA-Z0-9 ]/.test(e.key)) {
      e.stopPropagation();
      type_(e.key === ' ' ? 'SPC' : e.key.toUpperCase());
    }
  });
}

// ==========================================================================
// Watch Together — the 10-foot lobby
// ==========================================================================
// The session itself (transport, clock skew, host authority) lives in
// watch-together.js and main.js; this screen is only its TV-shaped face. It's a
// normal screen rather than an overlay on purpose — staying inside the router
// means navRootEl() and shellHasKeys() need no special-casing for it.
//
//   mode 'join' (default): A-Z key grid → 4 letters → auto-join → lobby.
//   mode 'host':           the code + a live guest list + Start.
async function screenWatch(params = {}) {
  const mode = params.mode === 'host' ? 'host' : 'join';
  const S = () => window.__wtSession;

  const scr = el(`
  <div class="tvn-screen tvn-watch">
    <div class="tvn-rail-head">
      <button class="tvn-iconbtn tvn-focable" data-nav data-fkey="back" style="background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.08)">${I.back()}</button>
      <span class="tvn-rail-title">Watch Together</span>
    </div>
    <div class="tvn-watch-body" data-wt></div>
  </div>`);
  stage.appendChild(scr);
  scr.querySelector('[data-fkey="back"]').onclick = () => leaveAndBack();

  const box = scr.querySelector('[data-wt]');
  let code = '';
  let err = '';
  let busy = false;

  function leaveAndBack() {
    try { window.__wtLeave(); } catch (e) {}
    goBack();
  }

  function type_(chr) {
    if (busy) return;
    if (chr === 'DEL') code = code.slice(0, -1);
    else if (chr === 'CLR') code = '';
    else if (code.length < 4) code += chr;
    err = '';
    render();
    if (code.length === 4) submit();
  }

  async function submit() {
    busy = true;
    render();
    const r = await window.__wtJoin(code);
    busy = false;
    // A join into an already-playing session hands off to the player, which tears
    // this screen down — render() no-ops once that's happened.
    if (r !== true) { err = r.message; code = ''; }
    render();
  }

  // Physical Backspace deletes a letter instead of navigating back.
  window.__tvnQueryDel = () => {
    if (mode !== 'join' || !code || busy) return false;
    type_('DEL');
    return true;
  };

  // The session polls in the background; main.js pings this on every change.
  window.__tvnWatchUpdate = render;

  function render() {
    if (!scr.isConnected) return;   // screen was torn down (e.g. playback started)
    const keep = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.fkey : null;
    const s = S();

    if (mode === 'host') {
      const n = ((s && s.guests) || []).length;
      box.innerHTML = `
        <div class="tvn-wt-card">
          <p class="tvn-wt-sub">${esc((s && s.content && s.content.name) || '')}</p>
          <div class="tvn-wt-code">${esc((s && s.code) || '····')}</div>
          <p class="tvn-wt-hint">Share this code. They'll need to be on the same provider.</p>
          <div class="tvn-wt-status ${n ? 'is-ready' : ''}">${n ? `${n} guest${n > 1 ? 's' : ''} joined` : 'Waiting for guests…'}</div>
          <div class="tvn-wt-actions" data-acts></div>
        </div>`;
      const acts = box.querySelector('[data-acts]');
      const start = el(`<button class="tvn-btn tvn-btn-primary tvn-focable" data-nav data-autofocus data-fkey="wt-start" ${n ? '' : 'disabled'}>${I.play(26)} Start</button>`);
      start.onclick = () => { if (!n) return; hideForPlayback(); window.__wtStart(); };
      acts.appendChild(start);
      const cancel = el(`<button class="tvn-btn tvn-focable" data-nav data-fkey="wt-cancel">Cancel</button>`);
      cancel.onclick = () => leaveAndBack();
      acts.appendChild(cancel);
      restore(keep);
      return;
    }

    if (s && s.active) {
      // Guest, joined, waiting for the host.
      box.innerHTML = `
        <div class="tvn-wt-card">
          <p class="tvn-wt-sub">${esc((s.content && s.content.name) || '')}</p>
          <div class="tvn-wt-status">Waiting for host to start…</div>
          <div class="tvn-wt-actions" data-acts></div>
        </div>`;
      const leave = el(`<button class="tvn-btn tvn-focable" data-nav data-autofocus data-fkey="wt-leave">Leave</button>`);
      leave.onclick = () => leaveAndBack();
      box.querySelector('[data-acts]').appendChild(leave);
      restore(keep);
      return;
    }

    // Code entry.
    const slots = [0, 1, 2, 3]
      .map(i => `<span class="tvn-wt-slot ${i === code.length && !busy ? 'on' : ''}">${esc(code[i] || '')}</span>`)
      .join('');
    box.innerHTML = `
      <div class="tvn-wt-card">
        <p class="tvn-wt-hint">Enter the 4-letter code from the host.</p>
        <div class="tvn-wt-slots">${slots}</div>
        <div class="tvn-wt-status ${err ? 'is-err' : ''}">${busy ? 'Joining…' : esc(err)}&nbsp;</div>
        <div class="tvn-keys" data-keys></div>
      </div>`;
    const keysEl = box.querySelector('[data-keys]');
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((k, i) => {
      const b = el(`<button class="tvn-key tvn-focable" data-nav data-fkey="k-${k}" ${i === 0 ? 'data-autofocus' : ''}>${k}</button>`);
      b.onclick = () => type_(k);
      keysEl.appendChild(b);
    });
    [['DEL', '⌫ Delete'], ['CLR', 'Clear']].forEach(([c, label]) => {
      const b = el(`<button class="tvn-key tvn-key-wide tvn-focable" data-nav data-fkey="k-${c}" style="font-size:22px">${label}</button>`);
      b.onclick = () => type_(c);
      keysEl.appendChild(b);
    });
    restore(keep);
  }

  // Every keypress rebuilds the grid, so put focus back where it was — otherwise
  // typing a code walks the focus ring back to 'A' after each letter.
  function restore(keep) {
    const back = keep && scr.querySelector(`[data-fkey="${keep}"]:not([disabled])`);
    if (back) back.focus();
    else focusAuto();
  }

  // Physical keyboard (desktop /tv mode) types straight into the code.
  scr.addEventListener('keydown', (e) => {
    if (mode !== 'join') return;
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      e.stopPropagation();
      type_(e.key.toUpperCase());
    }
  });

  render();
}

const SCREENS = {
  home: screenHome,
  live: screenLive,
  browse: screenBrowse,
  details: screenDetails,
  guide: screenGuide,
  settings: screenSettings,
  search: screenSearch,
  watch: screenWatch
};

// ==========================================================================
// Playback hand-off: hide the shell while the player owns the screen, restore
// it when the playback chrome (fullscreen / player-fs / vod-mode) goes away.
// ==========================================================================
function hideForPlayback() {
  if (!root) return;
  rememberFocus();
  hiddenForPlayback = true;
  sawPlayback = false;
  root.classList.add('tvn-hidden');
  // Guaranteed playback surface: the video container lives inside the legacy
  // #live-view panel, which is display:none when the underlying app sits on
  // another tab — and browser fullscreen can be denied (slow stream-URL fetch
  // consumes the user-gesture window). body.tvn-playing forces the container
  // into a CSS fullscreen layer so video is always visible in TV mode.
  document.body.classList.add('tvn-playing');
  clearTimeout(restoreFallbackTimer);
  // No auto-restore fallback: the tvn-playing layer keeps the player (or its
  // error/spinner OSD) visible even when OS fullscreen is denied, and Back
  // always routes back to the shell via __tvNativeOnPlayerExit.
}

function playbackChromeUp() {
  return !!document.fullscreenElement ||
    document.body.classList.contains('player-fs') ||
    document.body.classList.contains('vod-mode');
}

function restoreShell() {
  if (!root) return;
  hiddenForPlayback = false;
  sawPlayback = false;
  clearTimeout(restoreFallbackTimer);
  osdHide();
  document.body.classList.remove('tvn-playing');
  root.classList.remove('tvn-hidden');
  renderCurrent();
}

function watchPlaybackState() {
  const check = () => {
    if (!root || !hiddenForPlayback) return;
    if (playbackChromeUp()) { sawPlayback = true; return; }
    if (sawPlayback) {
      // chrome went away → give the player a beat to settle, then restore
      setTimeout(() => {
        if (hiddenForPlayback && !playbackChromeUp()) restoreShell();
      }, 120);
    }
  };
  const mo = new MutationObserver(check);
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('fullscreenchange', check);
}

// ==========================================================================
// Stage scaling
// ==========================================================================
function applyScale() {
  if (!stage) return;
  scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  // The playback OSD lives OUTSIDE the stage (inside #video-container, so it
  // paints during OS fullscreen) and doesn't inherit the stage transform. Its
  // px sizes are designed for the same 1920×1080 canvas — publish the factor
  // as a root var so the OSD canvas (and viewport-pinned popouts) can match.
  // Without this, a TV WebView reporting e.g. 960×540 CSS px renders the OSD
  // at double size ("huge play button").
  try { document.documentElement.style.setProperty('--tvn-scale', String(scale)); } catch (e) {}
}

// ==========================================================================
// Public API
// ==========================================================================

/**
 * Register handlers + global hooks. Call once from main.js during init when
 * the TV UI mode is active (the shell itself is entered after login via
 * enterTvNative()).
 */
export function initTvNative(handlers) {
  H = handlers || {};
  ensureFont();
  document.body.classList.add('tv-native');

  // Every live start/zap flows through H.playChannel — feed the playback OSD.
  const origPlayChannel = H.playChannel;
  if (origPlayChannel) {
    H.playChannel = (ch, prog) => {
      osdSetNowPlaying(ch, prog);
      return origPlayChannel(ch, prog);
    };
  }

  // VOD starts can't be wrapped the same way: auto-next on episode end and
  // >>/<< episode zapping bypass the shell's handlers. main.js feeds this
  // hook from playVODStream / playSeriesEpisode instead — the two funnels
  // every movie/episode start flows through.
  window.__tvnOsdVod = (meta) => osdSetNowPlayingVod(meta);

  // ---- Mouse support -------------------------------------------------------
  // TV mode hides the cursor for the D-pad experience (style.css keys off
  // body.tv-mouse). Any mouse movement shows it; it re-hides after a few
  // seconds idle or as soon as the remote is picked up again. Registered
  // before onKeyDown, whose stopImmediatePropagation would swallow it.
  let mouseTimer = null;
  const mouseOff = () => {
    document.body.classList.remove('tv-mouse');
    if (mouseTimer) { clearTimeout(mouseTimer); mouseTimer = null; }
  };
  const mouseOn = () => {
    document.body.classList.add('tv-mouse');
    if (mouseTimer) clearTimeout(mouseTimer);
    mouseTimer = setTimeout(mouseOff, 4000);
    // mouse users get the playback OSD on movement, like the remote does
    if (osdActive() && !popupEl) { if (osdVisible()) osdBump(); else osdShow(); }
  };
  window.addEventListener('mousemove', mouseOn, { passive: true });
  window.addEventListener('wheel', mouseOn, { passive: true });
  window.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'Enter' || (k && k.startsWith('Arrow'))) mouseOff();
  }, true);

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', applyScale);

  // Rolling text: whatever takes focus gets its overflowing labels marqueed.
  document.addEventListener('focusin', (e) => mqStart(e.target, 'focus'));
  document.addEventListener('focusout', (e) => {
    // Only tear down if focus is actually leaving (not moving inside the item).
    const nodes = mqBuckets.get('focus') || [];
    if (!e.relatedTarget || !nodes.some(n => n.contains(e.relatedTarget))) mqStop('focus');
  });

  // Hovering a focusable makes it the focused element, so the D-pad focus
  // ring doubles as the hover state (the shell has no :hover styling of its
  // own). Gated on body.tv-mouse so screens re-rendering under an idle
  // pointer can't steal focus from a D-pad user.
  window.addEventListener('mouseover', (e) => {
    if (!document.body.classList.contains('tv-mouse')) return;
    if (!shellHasKeys()) return;
    const r = navRootEl();
    if (!r) return;
    const t = e.target && e.target.closest ? e.target.closest('[data-nav]') : null;
    if (t && r.contains(t) && t !== document.activeElement) {
      t.focus({ preventScroll: true });
    }
  });

  // Right-click on a pinnable row (mouse users) → Pin/Unpin popout; on a
  // Continue Watching card → Remove popout.
  window.addEventListener('contextmenu', (e) => {
    if (!shellHasKeys()) return;
    const t = pinTargetOf(e.target);
    const cwT = t ? null : cwTargetOf(e.target);
    const r = navRootEl();
    const target = t || cwT;
    if (!target || !r || !r.contains(target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (t) openPinMenuFor(t); else openCwMenuFor(cwT);
  }, true);

  // True while the shell is the visible surface — the legacy D-pad
  // coordinator uses this to keep its hands off focus (it re-focuses its own
  // lists as data loads, which would yank focus out of the shell).
  window.__tvNativeHasScreen = () => !!root && !root.classList.contains('tvn-hidden');

  // Hardware/remote BACK while the shell is visible → shell back-navigation.
  // Returns true when consumed (tv-navigation's handleBack defers to this).
  window.__tvNativeBack = () => {
    if (!root || root.classList.contains('tvn-hidden')) return false;
    if (!shellHasKeys()) return false;
    return goBack();
  };
  // Live channel zap (player next/prev buttons, N/P keys, remote >> <<):
  // move within the channel list the shell played from. Returns true when the
  // shell handled it (even at a list end) so the legacy EPG-grid zap — whose
  // rows aren't rendered under the shell — never runs in TV mode.
  window.__tvNativeZap = (dir) => {
    if (!root) return false;
    const curId = window.state?.activeChannel?.stream_id;
    const i = zapList.findIndex(c => String(c.stream_id) === String(curId));
    if (i === -1) return false;
    const next = zapList[i + dir];
    if (next) {
      const cached = epgCache.get(String(next.stream_id));
      const nn = cached ? nowNextOf(cached.listings) : { current: null };
      H.playChannel(next, nn.current || null);
    }
    return true;
  };

  // Player chrome torn down (back from fullscreen / VOD exit) → restore shell.
  window.__tvNativeOnPlayerExit = () => {
    if (root && hiddenForPlayback) {
      sawPlayback = true;
      setTimeout(() => {
        if (hiddenForPlayback && !playbackChromeUp()) restoreShell();
      }, 120);
      return true;
    }
    return false;
  };
  watchPlaybackState();
}

/** Build (or rebuild) the shell and land on the launcher. Call after login. */
export function enterTvNative() {
  if (!H) return;
  // Fresh session data: entering the shell happens after login OR a playlist
  // switch — never serve the previous playlist's categories/EPG/details.
  catCache = null;
  totalsCache = null;
  epgCache.clear();
  infoCache.clear();
  zapList = [];
  if (!root) {
    root = document.createElement('div');
    root.id = 'tvn-root';
    root.innerHTML = '<div id="tvn-stage"></div>';
    document.body.appendChild(root);
    stage = root.querySelector('#tvn-stage');
  }
  setAccent(stage, getAccent());
  applyScale();
  root.classList.remove('tvn-hidden');
  hiddenForPlayback = false;
  stack = [];
  current = { name: 'home', params: {} };
  renderCurrent();
}

/** Tear the shell down (e.g. on sign-out back to the login screen). */
export function exitTvNative() {
  if (clockTimer) clearInterval(clockTimer);
  if (progressTimer) clearInterval(progressTimer);
  clockTimer = progressTimer = null;
  osdHide();
  if (osdEl) { osdEl.remove(); osdEl = null; }
  osdChannel = osdProgram = null;
  document.body.classList.remove('tvn-playing');
  if (root) root.remove();
  root = stage = null;
  current = null;
  stack = [];
}

// ==========================================================================
// First-boot device chooser (pre-login): Mobile or TV?
// ==========================================================================
export function showDeviceChooser(defaultTv) {
  ensureFont();
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'tvn-chooser';
    overlay.innerHTML = `
      <div class="tvn-chooser-stage">
        <div class="tvn-ambient"></div>
        <div class="tvn-logo" style="position:absolute;top:64px;left:90px;">
          <div class="tvn-logo-icon">${I.tv(28, '#06131f', 2.4)}</div>
          <div class="tvn-logo-word">ZIP<b>TV</b><span>Pro</span></div>
        </div>
        <div class="tvn-chooser-title">How are you watching?</div>
        <div class="tvn-chooser-sub">Pick the interface for this device. You can change it later in Settings.</div>
        <div class="tvn-chooser-cards">
          <button class="tvn-card tvn-focable" data-nav data-choice="mobile" ${!defaultTv ? 'data-autofocus' : ''}>
            <div class="tvn-card-icon">${I.phone()}</div>
            <div class="tvn-card-txt">
              <span class="tvn-card-title">Mobile</span>
              <span class="tvn-card-sub">Phone or tablet · touch</span>
            </div>
          </button>
          <button class="tvn-card tvn-focable" data-nav data-choice="tv" ${defaultTv ? 'data-autofocus' : ''}>
            <div class="tvn-card-icon">${I.tv(52)}</div>
            <div class="tvn-card-txt">
              <span class="tvn-card-title">TV</span>
              <span class="tvn-card-sub">Big screen · remote control</span>
            </div>
          </button>
        </div>
        <div class="tvn-chooser-hint">Use ◀ ▶ and OK to choose</div>
      </div>`;
    document.body.appendChild(overlay);

    const chooserKeys = (e) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault(); e.stopImmediatePropagation();
        move(k.replace('Arrow', '').toLowerCase());
      } else if (k === 'Enter' || k === ' ') {
        const a = document.activeElement;
        if (a && a.dataset && a.dataset.choice) { e.preventDefault(); e.stopImmediatePropagation(); a.click(); }
      } else if (k === 'Escape' || k === 'Backspace') {
        e.preventDefault(); e.stopImmediatePropagation(); // must choose
      }
    };
    window.addEventListener('keydown', chooserKeys, true);

    const done = (choice) => {
      window.removeEventListener('keydown', chooserKeys, true);
      overlay.remove();
      setStoredUiMode(choice);
      resolve(choice);
    };
    overlay.querySelectorAll('[data-choice]').forEach(btn => {
      btn.addEventListener('click', () => done(btn.dataset.choice));
    });

    requestAnimationFrame(() => {
      const auto = overlay.querySelector('[data-autofocus]') || overlay.querySelector('[data-nav]');
      if (auto) auto.focus({ preventScroll: true });
    });
  });
}
