-- ============================================================================
-- ZIPTV Pro 8.4 — Companion device pairing (cross-device Continue Watching).
-- Run this in Supabase: SQL Editor → New query → paste → Run.
--
-- A device may link ONE companion (PC ↔ mobile only, enforced in api/device.js).
-- The link is stored on both rows and must be mutual before either side may
-- read the other's watch_history rows (api/history.js `companion-list`).
-- ============================================================================

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS companion_device text;
