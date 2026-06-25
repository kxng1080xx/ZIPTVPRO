# ZIPTV Pro 5.0.0 — Remote Device & Playlist Management

The biggest update yet. Playlists are now managed centrally from the **Control
Panel** at `ziptvpro-nu.vercel.app/connect` and sync live to every device.

## New
- **Admin Control Panel** at `/connect` (password-protected): see every device,
  give it a customer name, add/remove playlists, and set an expiry — all in one place.
- **Live sync** to PC and APK: changes you make on the dashboard reach the apps
  within minutes (and on launch/resume). Remove a playlist on the dashboard and it
  disappears from the device.
- **Device tracking:** platform (PC/APK), app version, online/last-seen, and each
  device's playlists with days-remaining.
- **Per-device expiry** you control: presets (+30 / +90 / +365 days) or a custom
  date. When a device expires its playlists are removed and a renewal notice (which
  you can edit from the dashboard) is shown.
- The in-app subscription badge now shows **your** expiry, not the provider's.
- Clean URL: `/connect` (no more `connect.html`).

## Changed
- The in-app manual login is gone — the app is now a pure player; all playlists
  come from the Control Panel.
- The app no longer contains any Supabase key. All database access is server-side
  behind the admin password and the device endpoint.

## Security
- New tables (`devices`, `playlists`, `app_config`) are fully locked down with
  Row Level Security; access only via the server API using the service-role key.
- The previously-exposed public key is removed from the client — rotate it in
  Supabase after rollout (see `SETUP_5.0.md`).

## Upgrade
See `SETUP_5.0.md` for the one-time setup (SQL migration, Vercel env vars, key
rotation) before building and shipping the 5.0 installers.
