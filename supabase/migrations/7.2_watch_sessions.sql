-- ============================================================================
-- ZIPTV Pro 7.2 — Watch Together sessions
-- Run this in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.
--
-- A session is a short-lived room: the host picks a VOD title, the app mints a
-- 4-letter code, and guests on the SAME provider join with it. The row never
-- holds playlist credentials — only `sub_hash`, a fingerprint of the server host
-- that each client can recompute locally. It is the SERVER, not server+username:
-- one server issues many logins, and those users all resolve the same stream ids,
-- so they can watch together. Content is carried as identifiers (stream id +
-- container extension), so every client rebuilds its own stream URL from its own creds.
-- ============================================================================

create table if not exists public.watch_sessions (
  code            text primary key,                          -- 4 chars, A-Z
  host_device     text not null,                             -- devices.device_id of the host
  sub_hash        text not null,                             -- sha256(normalised server host)
  content         jsonb not null,                            -- {type, streamId, ext, name, logo, backdrop}
  state           text not null default 'lobby',             -- 'lobby' | 'playing' | 'ended'
  position        double precision not null default 0,       -- host clock, seconds
  paused          boolean not null default true,
  host_updated_at timestamptz not null default now(),        -- when position/paused were last set
  guests          jsonb not null default '[]'::jsonb,        -- [{device, joined_at, last_seen}]
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '6 hours'
);

-- Sweep target for the opportunistic cleanup in api/watch.js.
create index if not exists watch_sessions_expires_idx on public.watch_sessions(expires_at);

-- ----------------------------------------------------------------------------
-- Row Level Security: same posture as `devices` / `playlists` — the app never
-- talks to Supabase directly. All access goes through api/watch.js with the
-- SERVICE ROLE key, which bypasses RLS. No policies are created on purpose, so
-- the anon and authenticated roles are fully denied.
-- ----------------------------------------------------------------------------
alter table public.watch_sessions enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public' and tablename = 'watch_sessions'
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;
