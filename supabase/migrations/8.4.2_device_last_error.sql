-- ============================================================================
-- ZIPTV Pro 8.4.2 — device runtime-error reporting
-- Run in Supabase: SQL Editor → New query → paste → Run. Safe to run anytime;
-- until it runs, error reporting silently no-ops (the API writes these columns
-- best-effort) and nothing else is affected.
-- ============================================================================

alter table public.devices add column if not exists last_error text;
alter table public.devices add column if not exists last_error_at timestamptz;
