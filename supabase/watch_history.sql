-- ---------------------------------------------------------------------------
-- watch_history — cloud backup of each device's "Continue Watching" entries.
--
-- Mirrors the client's localStorage Continue Watching item (see
-- xtream-api.js saveWatchProgress): one row per (device, playlist, item), so
-- it stays resumable (an upsert moves the position forward) while accumulating
-- across every title the device has watched.
--
-- Run this once in the Supabase SQL editor. It is idempotent.
--
-- Written to by the SERVICE ROLE key from /api/history only (same trust model
-- as devices/watch_sessions). RLS is enabled with NO public policy, so the
-- anon key cannot read or write it — all access goes through the API.
-- ---------------------------------------------------------------------------

create table if not exists public.watch_history (
  id           bigint generated always as identity primary key,
  device_id    text        not null,
  playlist_id  text        not null default '',   -- local active playlist id ('' when unknown)
  item_id      text        not null,              -- stream / episode id
  type         text        not null default 'movie',  -- 'movie' | 'series' | 'live'
  name         text        not null default '',
  logo         text        not null default '',
  backdrop     text        not null default '',
  series_id    text,
  series_name  text,
  season       integer,
  episode      integer,
  position     numeric     not null default 0,    -- seconds watched
  duration     numeric     not null default 0,    -- seconds total (0 when unknown)
  completed    boolean     not null default false, -- watched to the end (<5min left)
  last_watched timestamptz not null default now(),
  created_at   timestamptz not null default now(),

  -- One row per title per playlist per device → an upsert resumes in place.
  unique (device_id, playlist_id, item_id)
);

-- Fast "recent history for this device" reads (the future feature's main query).
create index if not exists watch_history_device_recent_idx
  on public.watch_history (device_id, last_watched desc);

-- Optional: scope reads to a single playlist quickly.
create index if not exists watch_history_device_playlist_idx
  on public.watch_history (device_id, playlist_id);

-- Locked down: only the service role (used by /api/history) may touch it.
alter table public.watch_history enable row level security;

-- ---------------------------------------------------------------------------
-- Housekeeping (optional): cap history per device so the table cannot grow
-- without bound. Keeps the 500 most recently watched rows per device.
-- Safe to run periodically, or wire into a Supabase scheduled function.
-- ---------------------------------------------------------------------------
-- delete from public.watch_history w
-- using (
--   select id from (
--     select id,
--            row_number() over (partition by device_id order by last_watched desc) as rn
--     from public.watch_history
--   ) ranked
--   where ranked.rn > 500
-- ) old
-- where w.id = old.id;
