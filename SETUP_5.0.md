# ZIPTV Pro 5.0 — Setup & Deploy

Everything in 5.0 is built. These are the steps only you can do (they need your
Supabase + Vercel accounts). Do them in order.

## 1. Create the database tables

Supabase → your project → **SQL Editor** → New query → paste the contents of
`supabase/migrations/5.0_devices.sql` → **Run**.

This creates `devices`, `playlists`, `app_config` and locks them all down with
Row Level Security (no public access — all access goes through the server API).
It leaves your old `device_pairings` table untouched so apps still on 4.x keep
working until everyone updates.

## 2. Get your service-role key

Supabase → **Settings → API**. Copy two things:
- **Project URL** (e.g. `https://jnocgdemunelygygnozw.supabase.co`)
- **`service_role`** secret key (the long one, *not* the anon/publishable key)

## 3. Set environment variables in Vercel

Vercel → your project → **Settings → Environment Variables**. Add these
(Production + Preview), then redeploy:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role secret |
| `ADMIN_PASSWORD` | the password you'll type at /connect |
| `ADMIN_SECRET` | a long random string — run `openssl rand -hex 32` |

(`GH_TOKEN` for releases stays in your local `.env` as before.)

## 4. Rotate the exposed Supabase key  ⚠️ important

The old anon/publishable key was shipped in the app and `connect.html`, so anyone
could read every saved playlist's credentials. 5.0 removes it from the client
entirely. After everyone has updated, in Supabase rotate/disable that key
(**Settings → API → roll anon key**) and consider rotating the provider
passwords that were exposed.

## 5. Deploy

Push to the branch Vercel builds. After deploy:
- Visit `https://ziptvpro-nu.vercel.app/connect` → you should see the password gate.
- Sign in with `ADMIN_PASSWORD`.

## 6. Build the new app installers

```
# PC (.exe) — bump to 5.0.x and build
npm run electron:dist

# Android (.apk)
npm run apk
```

> The build auto-bumps the patch number, so 5.0.0 → 5.0.1 on first build. To ship
> exactly **5.0.0**, run with `NO_BUMP=true` set, e.g. `NO_BUMP=true npm run electron:dist`.

## 7. End-to-end test

1. Open the freshly built app → it shows a 6-char device code and (within a few
   minutes / on launch) appears in `/connect` as **Awaiting setup**.
2. In `/connect`: give it a customer name, **+ Add playlist** (paste an M3U URL or
   server/user/pass), set an expiry (e.g. +30d).
3. Back in the app → within the sync interval (or relaunch) the playlist loads and
   the header badge shows *your* expiry, not the provider's.
4. In `/connect`, **remove** the playlist → it disappears from the app on next sync.
5. Set the expiry to a past date → on next sync the app wipes playlists and shows
   the expiry notice (edit its text via the ⚙️ Settings button on the dashboard).

## How it fits together

- **App** (`src/components/cloud-sync.js` + `src/main.js`) heartbeats to
  `POST /api/device` on launch, every 5 min, and on resume. It mirrors the
  device's playlists and enforces the expiry. No Supabase key in the client.
- **`/api/device`** (public, scoped to one device code) returns that device's
  playlists + expiry, using the service-role key server-side.
- **`/api/admin`** (password-gated) powers the `/connect` dashboard.
- **Supabase** is the source of truth; the app is a mirror.

### Notes / defaults chosen
- Sync interval **5 min** (+ launch + resume). Change `CLOUD_SYNC_MS` in `src/main.js`.
- **Offline grace:** if the app can't reach the API it keeps the last-known
  playlists; it only enforces an expiry it already knows about. A network blip
  never deletes playlists.
- **Online** = last seen under 10 min (dashboard `ONLINE_MS`).
- Expiry is **per device** (all its playlists share one date), set via +30/+90/+365
  presets or a custom date. Presets stack onto an existing future expiry (renew).
- A brand-new **pending** device is never auto-pruned; mirroring (incl. removals)
  starts once you add a playlist or set an expiry (status → active).
