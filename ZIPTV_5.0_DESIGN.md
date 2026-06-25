# ZIPTV Pro 5.0 — Remote Device & Playlist Management

**Status:** Design / brainstorm (pre-build)
**Date:** 2026-06-25
**Theme:** Turn the one-shot device-code pairing into a persistent, admin-controlled
device + playlist management system backed by Supabase, with live sync to PC and APK.

---

## 1. The core shift

Today Supabase is a *transient mailbox*: the app drops a `device_pairings` row, the
connect page fills in credentials, the app grabs them and the row is **deleted**.
Playlists then live only locally (Dexie/IndexedDB) on each device.

In 5.0 the **database becomes the source of truth**. Devices and playlists live in
Supabase permanently. You manage everything from a private dashboard at `/connect`,
and the apps continuously reconcile their local state against the DB — so adding,
removing, or expiring a playlist from the dashboard propagates down to both PC and
APK automatically.

---

## 2. Decisions (locked)

| Area | Decision |
|---|---|
| **Audience of /connect** | Private **admin dashboard** — only you. End users never touch it. |
| **Source of truth** | Supabase DB. Apps mirror it. |
| **Sync model** | **Live background sync** — app reconciles on launch + every few minutes while open. |
| **Security** | **Password gate + server-side API.** Service-role key stays on the server; Supabase RLS locks the table; anon key gets minimal rights. |
| **Expiry scope** | **Per device** — one expiration covers all of that device's playlists. |
| **Expiry input** | **Presets (30 / 90 / 365 days) + custom date picker.** Renew = bump the date. |
| **Onboarding** | Customer installs app → reads you their device code → you add playlist(s) + expiry on /connect. |
| **Dashboard shows per device** | Customer label, platform & app version, last-seen / online, playlists with expiry + days-left. |
| **On expiry** | Remove all playlists from the device **+ show a one-time notice** before clearing. |
| **In-app login** | **Removed.** App becomes a pure player; all playlists come from the dashboard. Pairing screen stays (to display the device code). |
| **Expired device record** | **Kept** in dashboard as "Expired" so you can renew / re-add and reactivate the same customer. |
| **In-app expiry display** | Show **your** device expiration, not the provider's Xtream login expiry. |
| **URL** | `ziptvpro-nu.vercel.app/connect` (clean), not `connect.html`. |

---

## 3. Data model (Supabase)

### `devices`
| Column | Type | Notes |
|---|---|---|
| `device_id` | text, PK | The 6-char code the app generates |
| `label` | text | Customer name / note ("John — WhatsApp") |
| `platform` | text | `pc` \| `apk` \| `unknown` (reported by app) |
| `app_version` | text | Reported by app each heartbeat |
| `last_seen` | timestamptz | Updated every sync; drives online/offline |
| `expires_at` | timestamptz, null | The device-level expiry **you** control |
| `status` | text | `pending` \| `active` \| `expired` |
| `created_at` | timestamptz | |

### `playlists`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid, PK | |
| `device_id` | text, FK → devices | |
| `name` | text | Display name |
| `type` | text | `xtream` \| `m3u` |
| `server_url` | text | |
| `username` | text | |
| `password` | text | |
| `created_at` | timestamptz | |

> Removing a row here = the app removes that playlist on next sync.
> Device `expires_at` passing = the app wipes **all** the device's playlists + shows the notice.

### `app_config` (optional, single row)
Holds the editable **expiry notice text + contact info** so you can change "contact
me to renew" without shipping a new app build.

---

## 4. Admin dashboard (`/connect`)

Password-gated. After login:

- **Device list** — every device with label, platform/version, online dot (last-seen),
  expiry + days-left, playlist count. Filter/search by label. Sort by expiry (see who's
  lapsing soon).
- **Per device:** edit label · add playlist (M3U autoparse or server/user/pass, same as
  today's form) · remove a playlist · set/extend expiry (presets + custom date) · view status.
- **Pending devices** surface at the top when a customer's app first checks in with no
  playlists yet — that's your cue to provision them.
- **Expired section** keeps lapsed devices renewable.

All reads/writes go through the **server-side API** (`/api/...`), which holds the Supabase
service-role key. The browser never sees it.

---

## 5. App behavior (PC + APK)

1. **Pairing screen** stays — shows the 6-char device code. On launch the app upserts its
   `devices` row (status `pending`) and starts the heartbeat.
2. **Heartbeat / sync loop** (on launch, on resume, every few minutes while open):
   - PATCH `last_seen`, `platform`, `app_version`.
   - Pull the device row + its playlists.
   - **Reconcile** local Dexie store to match: add new playlists, remove deleted ones.
   - If `expires_at` has passed → show the one-time notice, then wipe all local playlists
     and return to the pairing screen.
3. **Expiry display** in-app now reads `devices.expires_at` (your date), replacing the
   Xtream `exp_date` logic in `src/main.js` (~line 3170) and the resolver in
   `src/components/xtream-api.js`.
4. **In-app login/add-playlist form removed** — app mirrors the DB exactly, so reconcile
   can safely delete anything not in the DB.

> **APK note:** sync runs while the app is open (launch + interval + resume). True
> background sync with the app fully closed is out of scope; removals take effect next
> time the app is opened or within the interval while it's running.

---

## 6. Security model

- **Admin password** on `/connect` (env var to start; can grow into real accounts later).
- **Server-side API** (`/api/admin/*`) holds the **service-role key** and performs all
  admin reads/writes. Gate it with the admin session.
- **Supabase RLS** locked down: the public **anon key** (shipped in the app) can only:
  upsert its own `devices` row, update its own `last_seen`/platform/version, and read its
  own row + playlists. No reading other devices, no deletes.
- **Rotate the currently-exposed anon key and any real provider credentials** already in
  the public table — they've been readable by anyone with the page source.

---

## 7. Clean `/connect` URL

`connect.html` → served at `/connect`. Handle via `vercel.json` (rewrite `/connect` →
`/connect.html`, or move the page into the routed build). Keep `connect.html` working as a
fallback/redirect so old links don't break.

---

## 8. Suggested build phases

1. **Schema + RLS** — create `devices` / `playlists` / `app_config`; lock down policies; rotate keys.
2. **Server API** — `/api/admin/*` (auth + CRUD via service role) and a slim public sync endpoint if needed.
3. **Dashboard** — rebuild `/connect` as the password-gated admin UI; `/connect` clean URL.
4. **App sync** — heartbeat, reconcile loop, expiry-wipe + notice; swap expiry display; remove in-app login.
5. **Test** — pair a device, add/remove playlists, set expiry in the past → confirm wipe + notice on both PC and APK; verify RLS blocks cross-device access.
6. **Ship** — bump to 5.0, build APK + EXE, release notes.

---

## 9. Open items to confirm before building

- **Sync interval** — every 5 min while open? (plus on launch + on resume)
- **Offline grace** — if the app can't reach the DB, keep playing the last-known state
  rather than locking the customer out on a network blip. How long a grace window before
  it enforces a cached expiry?
- **Notice content** — exact wording + contact method (WhatsApp/Telegram/email) for the
  "expired — contact to renew" screen. Pull from `app_config` so it's editable.
- **Online threshold** — last_seen under N minutes = "online"? (e.g. 10 min)
- **Admin auth** — single shared password to start, or do you want per-login accounts now?
- **Multiple playlists, one expiry** — confirm: "remove playlist" (one) and "expire device"
  (all) are two distinct actions in the UI.
