-- ============================================================================
-- ZIPTV Pro 8.3 — Saved playlist presets for the admin panel.
-- Run this in Supabase: SQL Editor → New query → paste → Run.
-- Stores reusable playlist credentials on the app_config row so the admin can
-- pick them from a dropdown when setting up a new device, instead of typing
-- server/username/password every time.
-- Never exposed to devices: api/device.js selects only expiry_notice,contact_info.
-- ============================================================================

ALTER TABLE public.app_config ADD COLUMN IF NOT EXISTS saved_playlists jsonb DEFAULT '[]';
