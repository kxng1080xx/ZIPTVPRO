# ZIPTV v10 — feature parity with v9

Cloud: Cloudflare Pages only (Vercel dropped).

v10 (Rust core + Kotlin/Compose for Android phone/TV and Windows) replaces the
Electron/Capacitor app only when every row below is done. One adaptive UI:
the device decides the layout (TV/projector, touch, desktop); no mode switch.

Legend: ✅ done · 🟡 partial · ⬜ not started

## Core & data (Rust: native/core)
| Feature | Status | Notes |
|---|---|---|
| Xtream login (network vs bad-login errors) | ✅ | |
| Catalog sync: live/movies/series, sequential, 3x retry, keep old list on failure | ✅ | 51k channels in ~8s |
| Catalog disk cache, instant start | ✅ | |
| Channel-name cleanup (`US: CNN HD` → `CNN HD`) | ✅ | ported from v9 |
| Missing logos from iptv-org index | ✅ | |
| External EPG (epg-data branch) + provider fallback | ✅ | |
| Search (accent/case-insensitive, prefix first) | ✅ | |
| Series episodes | ✅ | |
| Stalker portal playlists | ➖ skipped | v9 stalker-api.js |
| M3U (non-Xtream) playlists | ✅ | core m3u.rs; empty username = M3U |
| Hidden categories / hidden tabs (admin pre-add visibility) | ✅ | |
| Catch-up / timeshift (tv_archive) | ✅ | `archive_days` already parsed |

## Screens & navigation
| Feature | Status | Notes |
|---|---|---|
| Device detection: TV / touch / desktop, no switching | ✅ | |
| Adaptive layout: side rail (TV/PC/tablet), bottom bar (phone) | ✅ | |
| Live TV: categories, channels with now-playing, preview + guide | ✅ | |
| Movies / Series poster grids + episodes | ✅ | |
| Search | ✅ | |
| Settings: playlists add/switch/remove, refresh | ✅ | |
| Home screen (continue watching, recent channels, recently added) | ✅ | v9 home.js |
| Full EPG grid ("Show full guide") | ✅ | v9 epg.js |
| Favorites (channels, movies, series) | ✅ | |
| Pinned categories / channels | 🟡 | categories pin; channels use favorites |
| Recently viewed | ✅ | |
| Continue watching + resume position | ✅ | |
| Category sort | ✅ | |
| TMDB metadata: about, cast, ratings, trailers on dwell | ✅ | About/cast/trailer button; muted dwell preview skipped (user) |
| Dark-logo whitening | ✅ | v9 logo-contrast.js |
| Quality badges (HD/FHD/4K) | ✅ | |
| Reminders | ✅ | |
| Sleep timer | ✅ | |

## Playback
| Feature | Status | Notes |
|---|---|---|
| Live + VOD + episode playback (libVLC Android, vlcj PC) | ✅ | |
| Fullscreen player, auto-hiding controls, pause | ✅ | |
| Channel up/down zapping | ✅ | |
| VOD seek bar, ±10s, resume | ✅ | |
| Audio track / subtitle selection | ✅ | |
| Online subtitle search | ➖ skipped | user decision |
| Deinterlace, upscaler | 🟡 | deinterlace (VLC yadif2x) done; upscaler not in VLC | |
| Picture-in-picture | 🟡 | Android; desktop has no OS PiP |
| Chromecast | ⬜ 10.1 | wanted, moved to 10.1 so it doesn't hold the release |
| Recording (DVR) + recordings list | ✅ | Rust Recorder; More menu, long-press guide rows, Home row | |
| Short-cycle provider resilience (reconnect/resume) | 🟡 | VLC `--http-reconnect`; v9 had PTS splice |
| Bundle VLC with the PC installer | ✅ | trimmed VLC in app resources (prepareVlc) |

## Cloud & devices
| Feature | Status | Notes |
|---|---|---|
| Device activation code + admin-panel playlists (Supabase) | ✅ | v9 cloud-sync.js |
| Device expiry + notice | ✅ | |
| Remove-all playlists (device + cloud) | ✅ | |
| Companion device sync (continue watching hand-off) | ✅ | |
| Watch Together | ✅ | v9 protocol; More → Watch together, Settings join |
| Built-in VPN (OpenVPN profile) | ➖ skipped | |
| Update check / auto-update | 🟡 | check + Download banner (v10+ GitHub releases, platform asset); no silent install | |
| Share tunnel / TV link | ➖ dropped | v10 has no local server |
