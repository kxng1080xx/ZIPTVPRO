-- ============================================================================
-- ZIPTV Pro 9.4 - Built-in OpenVPN Configuration Sync
-- Run this in Supabase: SQL Editor -> New query -> paste -> Run.
-- Adds VPN configuration columns to app_config table so the admin can upload
-- an .ovpn file from /connect and push it Over-The-Air to all user devices.
-- ============================================================================

ALTER TABLE public.app_config 
  ADD COLUMN IF NOT EXISTS vpn_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS vpn_ovpn text DEFAULT '',
  ADD COLUMN IF NOT EXISTS vpn_version bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vpn_updated_at timestamptz DEFAULT now();
