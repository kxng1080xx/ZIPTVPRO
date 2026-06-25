-- ============================================================================
-- ZIPTV Pro 5.0 — Remote Device & Playlist Management
-- Run this in Supabase: SQL Editor → New query → paste → Run.
-- Safe to run once. It replaces the transient `device_pairings` model with
-- persistent `devices` + `playlists`, plus an editable `app_config`.
-- ============================================================================

-- Useful for gen_random_uuid()
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- devices: one row per installed app (keyed by the 6-char code it generates).
-- ----------------------------------------------------------------------------
create table if not exists public.devices (
  device_id    text primary key,
  label        text,                                   -- customer name / note
  platform     text default 'unknown',                 -- 'pc' | 'apk' | 'unknown'
  app_version  text,
  last_seen    timestamptz,
  expires_at   timestamptz,                            -- the expiry YOU control (null = no expiry yet)
  status       text not null default 'pending',        -- 'pending' | 'active' | 'expired'
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- playlists: the playlists attached to a device (managed from the dashboard).
-- Deleting a row here makes the app drop that playlist on its next sync.
-- ----------------------------------------------------------------------------
create table if not exists public.playlists (
  id          uuid primary key default gen_random_uuid(),
  device_id   text not null references public.devices(device_id) on delete cascade,
  name        text not null default 'Playlist',
  type        text not null default 'xtream',           -- 'xtream' | 'm3u'
  server_url  text not null,
  username    text not null,
  password    text not null,
  created_at  timestamptz not null default now()
);

create index if not exists playlists_device_idx on public.playlists(device_id);

-- ----------------------------------------------------------------------------
-- app_config: single-row, editable strings the app reads (e.g. expiry notice).
-- ----------------------------------------------------------------------------
create table if not exists public.app_config (
  id            int primary key default 1,
  expiry_notice text default 'Your subscription has expired. Please contact your provider to renew.',
  contact_info  text default '',
  updated_at    timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);

insert into public.app_config (id) values (1)
  on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Row Level Security: LOCK EVERYTHING DOWN.
-- The app no longer talks to Supabase directly — all access goes through the
-- serverless API (api/admin.js, api/device.js) using the SERVICE ROLE key,
-- which BYPASSES RLS. So we grant the public anon/authenticated roles NOTHING.
-- This makes the old, publicly-exposed anon key useless to attackers.
-- ----------------------------------------------------------------------------
alter table public.devices    enable row level security;
alter table public.playlists  enable row level security;
alter table public.app_config enable row level security;

-- Drop any permissive policies that may linger from the old setup.
do $$
declare p record;
begin
  for p in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('devices','playlists','app_config')
  loop
    execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- No policies created on purpose => anon & authenticated roles are fully denied.
-- (Service role bypasses RLS, so the API still works.)

-- ----------------------------------------------------------------------------
-- Optional: retire the old transient pairing table once 5.0 is fully rolled out.
-- Leave commented until every client has updated, so old (<5.0) apps still pair.
-- ----------------------------------------------------------------------------
-- drop table if exists public.device_pairings;
