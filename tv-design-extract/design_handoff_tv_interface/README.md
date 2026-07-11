# Handoff: ZIPTV Pro — Native TV (10-foot) Interface

## Overview
A native, D-pad-navigable TV interface for ZIPTV Pro, designed for the 10-foot living-room
experience (Android TV / Fire TV / Apple TV boxes and any TV browser). It replaces the
"scale the phone/desktop UI to fit the screen" approach with a purpose-built leanback UI:
a launcher home screen, a three-pane Live TV browser, a minimal fullscreen player overlay,
and a poster-row Movies/Series browser. Every interactive element is reachable by remote
(arrow keys + OK + Back).

## About the Design Files
The file in this bundle (`ZIPTV TV Interface.dc.html`) is a **design reference created in
HTML** — a working, interactive prototype that shows the intended look, layout, and remote
behavior. It is **not** production code to drop in.

The task is to **recreate this design inside the existing ZIPTV Pro codebase** using its
established patterns:
- Vanilla-JS view modules under `src/components/` (e.g. `home.js`, `player.js`, `tv-navigation.js`).
- CSS layered in `src/style.css` + `src/redesign.css` (the redesign layer already owns the
  TV shell, `body.tv-layout`, focus tokens, and the side-rail).
- The existing D-pad coordinator in `src/components/tv-navigation.js` (zones + arrow handling)
  — extend it rather than adding a second navigation system.
- Real data flows through `src/components/xtream-api.js` / `stalker-api.js` (streams,
  categories, EPG, continue-watching) and playback through `player.js` / `native-player.js`.

The prototype uses **placeholder tiles/posters** (monogram blocks on generated gradients) in
place of channel logos and movie posters, and generated gradient "backdrops" in place of
video/still frames. In the real app, wire these to `stream_icon`, VOD `cover`/`backdrop_path`,
and the live video surface. Do **not** reproduce any third-party channel logos from the
inspiration images — use the provider-supplied artwork.

## Fidelity
**High-fidelity.** Colors, typography, spacing, sizing, focus treatment, and interactions are
final and intended to be matched closely. All measurements below are given at the design's
native **1920×1080** canvas. The prototype scales that canvas uniformly to fit any viewport
(`scale = min(vw/1920, vh/1080)`, centered) — in the real app you can either keep a fixed
1920 design space that scales (simplest, matches `redesign.css`'s viewport-scaled TV layout)
or express everything in `rem`/`vw` derived from these px values.

---

## Design Tokens

### Color
| Token | Value | Use |
|---|---|---|
| `--bg-darkest` | `#04060b` | Letterbox / outermost background |
| `--bg-base` | `#060911` | Stage / screen background |
| Panel gradient | `linear-gradient(175deg, rgba(38,50,78,0.55), rgba(13,18,32,0.9))` | Launcher cards |
| Surface | `rgba(255,255,255,0.045)` | Channel rows (resting) |
| Surface hover/focus | `rgba(255,255,255,0.09)` | Channel rows (focused) |
| Hairline border | `rgba(255,255,255,0.06–0.08)` | Card/row borders |
| Text primary | `#e8ecf5` | Body text |
| Text on-dark | `#ffffff` | Titles |
| Text muted | `rgba(255,255,255,0.45–0.55)` | Subtitles, counts |
| Accent (default) | `#38bdf8` (sky) | Focus glow, progress, logo "TV", active star. Alternates: `#f97316`, `#34d399`, `#a78bfa` |
| Live badge | `#e11d48` | LIVE pill (pulses, 2.4s ease-in-out) |
| Profile gradient | `linear-gradient(140deg, #7c5cff, #2563eb)` | Avatar |
| Ambient glow A | `radial-gradient(1400px 800px at 92% -15%, rgba(37,99,235,0.14), transparent 60%)` | Behind content |
| Ambient glow B | `radial-gradient(1100px 800px at -12% 112%, rgba(6,182,212,0.10), transparent 60%)` | Behind content |

**Placeholder art** (replace with real images): tiles use
`linear-gradient(150deg, oklch(0.48 0.11 <hue>), oklch(0.24 0.07 <hue2>))`; backdrops use
`radial-gradient(120% 130% at 78% 18%, oklch(0.42 0.09 <hue>), oklch(0.16 0.04 <hue+40>) 62%, #05070d 100%)`.

### Typography
- **Family:** `Manrope` (Google Fonts), weights 400/500/600/700/800. (The app currently uses
  its own `--font-title`/body stack — either add Manrope for the TV layout or map these weights
  onto the existing families.)
- **Scale (px @ 1920):** clock 132/800 · hero title 54/800 · screen title 40/800 · launcher
  card title 40/800 · player program 46/800 · channel name 29/700 · poster label 23/600 ·
  category name 27/700 · subtitle/meta 21–24/500 · badge 17/800 (letter-spacing 0.06em).
- **Rule:** nothing below **~20px** at 1920 (≈ readable from a couch). Titles use
  `letter-spacing: -0.01em`, body uses `text-wrap: pretty`.

### Geometry
- Border radius: cards 26px · channel rows 22px · poster 16px · pills/buttons 999px · badges 6–7px.
- Focus ring: `0 0 0 3px rgba(255,255,255,0.95), 0 0 0 7px color-mix(in srgb, <accent> 45%, transparent)`
  plus a drop shadow on cards (`0 30px 70px rgba(0,0,0,0.6)`). Focused cards also
  `transform: scale(1.05) translateY(-8px)`; channel rows `scale(1.02)`; posters `scale(1.06)`.
- Transitions: focus/hover 0.15–0.18s ease.
- Screen padding: launcher `64px 90px 48px`; Live TV rail `56px 0 40px 56px`; player overlay 64px insets.

---

## Screens / Views

### 1. Home (launcher)
- **Purpose:** Entry point; pick a section, search, or see continue-watching context + clock.
- **Layout:** Full-screen flex column. Top bar row (logo · search pill 560px · spacer · menu
  button · profile). Center row: three launcher cards (305×470, 36px gap) left-aligned, big
  clock block right-aligned. Bottom: centered remote-hint line.
- **Components:**
  - **Logo:** 56px rounded-square accent gradient icon + "ZIP**TV** Pro" (36px/800, "TV" in accent).
  - **Search pill:** 62px tall, 999px radius, `rgba(255,255,255,0.055)` bg, search icon +
    placeholder "Search channels, movies, series…". Focusable.
  - **Launcher cards** (Live TV / Movies / Series): 305×470, 26px radius, panel gradient, centered
    108px circular icon + title (40/800) + count subtitle (24/500). Live TV card also shows an
    "Updated 2 hours ago" tag top-left. On focus: white ring + accent glow + `scale(1.05) translateY(-8px)`.
  - **Clock block:** weather line ("24°" + sun icon), time (132/800, `HH:MM`), date
    ("Wednesday, Jul 10" style — weekday, short month, day).
- **Content:** counts are 312 channels / 1,240 titles / 486 shows (placeholder — pull real totals).
- **Default focus:** Live TV card (`data-autofocus`).

### 2. Live TV
- **Purpose:** Browse categories → channels, preview the focused channel, launch playback.
- **Layout:** Three columns. **Rail** (400px): back button + "Live TV" title, then a scrollable
  category list. **Channel list** (620px): scrollable list of channel rows. **Now-playing panel**
  (flex fill): full-bleed backdrop of the focused channel with gradient scrims, top-right
  clock/weather/search/profile, bottom-left now-playing info + progress bar.
- **Components:**
  - **Category row:** 58px circular monogram tile (per-category gradient) + name (27/700) +
    "<n> channels" (21/500). Selected row bg `rgba(255,255,255,0.08)`. Focus ring on the row.
  - **Channel row:** 168×106 monogram tile + name (29/700) + "<n> views" + badge chips
    (HD/4K/EPG/S, 17/800) + favorite star (accent if fav, else faint). Focus: bg lightens,
    `scale(1.02)`, ring + shadow. **On focus** the now-playing panel updates to that channel;
    **on OK** it opens the Player.
  - **Now-playing panel:** kicker "NOW PLAYING" (uppercase, 0.18em), program title (54/800),
    description (24/500, max 560px), progress bar (6px, accent fill) with elapsed/duration.
- **Behavior:** Focus moving through the channel list drives the preview (this is the key
  interaction from the inspiration — the right panel is a live reflection of the focused row).

### 3. Player (fullscreen live overlay)
- **Purpose:** Watch live; minimal auto-hiding chrome over the video.
- **Layout:** Full-bleed video surface (gradient placeholder + `[ live video ]` label). Top-left:
  channel monogram + name. Top-right: clock + weather. Bottom-left: pulsing **LIVE** pill,
  program title (46/800), channel name, running clock (`HH:MM:SS`, tabular-nums, ticks every 1s
  while playing). Bottom-center: transport cluster — prev (74px), **play/pause** (100px white,
  `data-autofocus`), next (74px). Bottom-right: CC · favorite star · playlist/list button. A
  "Back to channels" affordance sits at the very bottom-center.
- **Behavior:** OK on the center button toggles play/pause (swaps pause bars ↔ play triangle and
  freezes the clock). Back / Esc returns to Live TV. In the real app, wire prev/next to channel
  zap, CC to subtitle tracks, star to favorites, list to the channel/EPG overlay.

### 4. Movies / Series (browse)
- **Purpose:** Browse VOD by poster rows with a cinematic hero.
- **Layout:** Hero backdrop occupies top-right ~64%×60% with left/bottom scrims. Top: pill nav
  (home button · "ZIP**TV**" · Live TV / Movies / Series tabs) + date + search + profile. Hero
  text block sits over the right half: genres (24/600), title (54/800), description (23/500,
  max 700px). Bottom: a horizontally scrolling poster row under a section title
  ("Latest added" / "Latest series").
- **Components:**
  - **Tab pill group:** active tab is a white pill with dark text; inactive tabs are muted text.
    Movies/Series switch the dataset, section title, and hero.
  - **Poster card:** 216×316, 16px radius, gradient placeholder + bottom scrim + title overlay,
    plus a caption label below. Focused poster: `scale(1.06)`, white 3px border + accent glow +
    shadow; its label brightens to white and the **hero updates** to the focused title.
- **Behavior:** Moving focus across posters updates the hero (same live-reflection pattern as
  Live TV). OK would open a details page (stubbed in the prototype).

---

## Interactions & Behavior

### Remote / D-pad navigation (core system)
- **Arrow keys** move focus **spatially**: from the focused element, candidates are scored by
  distance in the travel direction plus 2.2× the orthogonal offset; the lowest score wins.
  Candidates behind the travel direction (primary < 4px) are skipped. This lets a single handler
  serve all four screens without hardcoded focus maps. (See `move(dir)` in the prototype; the app
  already has an equivalent zone system in `tv-navigation.js` — reconcile the two.)
- **OK / Enter / Space:** clicks the focused `[data-nav]` element.
- **Back / Esc:** player → Live TV; any other screen → Home; Home → (app exit / confirm).
- **Focus scrolling:** after focus moves, the focused node is scrolled into view inside any
  scrollable ancestor with a ~40px pad (accounting for the stage scale factor).
- **Auto-focus:** on entering a screen, focus the element marked `data-autofocus`, else the first
  focusable. Home → Live TV card; Player → play/pause button.

### Live-reflection focus
Focusing a channel row updates the now-playing panel; focusing a poster updates the hero. This
is `onFocus` → set index → re-render, and is central to the design's feel. Keep it responsive
(no debounce needed at these list sizes).

### Player clock
Increments 1s while `!paused`; formatted `HH:MM:SS`. Pause freezes it and swaps the button glyph.

### Transitions
Focus/hover transitions 0.15–0.18s ease on `transform`, `box-shadow`, `border-color`, `background`.
LIVE pill: `livepulse` opacity 1→0.55→1 over 2.4s, infinite.

## State Management
Prototype state (map to the app's view/router + data layer):
- `screen`: `home | live | movies | series | player` — the app already routes via tabs/zones.
- `catIdx`: selected Live TV category.
- `nowIdx`: focused/previewing channel (drives the now-playing panel and the player subject).
- `heroIdx`: focused VOD poster (drives the hero).
- `paused`, `playerSec`: player transport state + running clock.
- `scale`: viewport→1920 scale factor (recompute on resize).
- **Tweakable props:** `accent` (sky/orange/green/violet), `startScreen` (for previewing a screen
  directly). In production `accent` maps to the app's theme accent; `startScreen` is dev-only.

Real data sources in the codebase: categories/channels/EPG from `xtream-api.js` /
`stalker-api.js`; continue-watching from `getContinueWatching`; posters from VOD listings;
playback via `player.js` / `native-player.js`.

## Assets
- **Font:** Manrope (Google Fonts).
- **Icons:** simple inline SVGs (search, menu, hamburger-list, tv, play/pause/prev/next, home,
  chevrons, sun, star). The app ships `public/lucide.min.js` — prefer Lucide equivalents for
  consistency (`search`, `menu`, `tv`, `play`, `pause`, `skip-back`, `skip-forward`, `home`,
  `chevron-left/down`, `sun`, `star`, `list`, `captions`).
- **No raster assets** are included; all tiles/backdrops are CSS gradients standing in for real
  channel logos, posters, and video frames. Wire these to provider artwork.

## Files
- `ZIPTV TV Interface.dc.html` — the full interactive prototype (all four screens + navigation).
  It is a self-contained HTML file (a "Design Component"): the markup is inside `<x-dc>`, the
  behavior is a `class Component` at the bottom, and it renders via the bundled runtime. Read it
  as a reference for exact markup, inline styles, and the navigation/logic in `renderVals()` and
  the `move`/`handleKey`/`ensureVisible` methods — then re-express it in the app's vanilla-JS
  component style.

### Existing codebase files this touches
- `src/redesign.css` — TV shell, `body.tv-layout`, focus tokens, side-rail (extend here).
- `src/components/tv-navigation.js` — D-pad coordinator (extend the zone model).
- `src/components/home.js`, `player.js`, `native-player.js` — home rows + playback.
- `src/components/xtream-api.js`, `stalker-api.js`, `epg.js` — data + guide.
