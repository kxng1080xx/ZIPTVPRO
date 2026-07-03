# ZIPTV Pro 6.0.0

Major version bump reflecting the scope of UI and admin-dashboard work landing in this release.

## Highlights

- **New styling layer** (`src/redesign.css`): a large (~1,500 line) additional stylesheet refining the app's visual design on top of the existing theme.
- **Admin dashboard (`connect.html`) overhaul**: substantial rework of the `/connect` Control Panel (device/playlist management UI).
- **Home/player shell (`index.html`)**: layout and markup adjustments to support the refreshed styling.
- **EPG (`src/components/epg.js`)**: expanded guide logic/rendering.
- **Xtream API client (`src/components/xtream-api.js`)**: expanded request/parsing logic.
- **TV navigation (`src/components/tv-navigation.js`)**: D-pad/remote navigation refinements.
- **Player**: minor playback tweaks (`src/components/player.js`).
- **Server**: small adjustments to `server/index.js`.

## Upgrade notes

- No database schema changes in this release; the 5.0 Supabase setup (`supabase/migrations/5.0_devices.sql`) still applies as-is.
- Same install/update path as 5.x: PC installer (`latest.exe`) and Android APK (`app.apk`) via the GitHub release assets.
