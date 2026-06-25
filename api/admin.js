/**
 * Admin dashboard backend for /connect.
 *
 * Same-origin only (served from the Vercel app). All actions except `login`
 * require a valid Bearer token issued by `login`.
 *
 *   POST /api/admin?action=login            { password } -> { token }
 *   GET  /api/admin?action=devices          [&archived=1] -> { devices: [...] }
 *   POST /api/admin?action=update-device    { device_id, label?, expires_at?, archived? }
 *   POST /api/admin?action=add-playlist     { device_id, name, type, server_url, username, password }
 *   POST /api/admin?action=remove-playlist  { id }
 *   POST /api/admin?action=delete-device    { device_id }
 *   GET  /api/admin?action=config           -> { config }
 *   POST /api/admin?action=config           { expiry_notice, contact_info }
 */
import { sb, supabaseConfigured } from './_supabase.js';
import { issueToken, verifyRequest, authConfigured } from './_auth.js';

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';

  try {
    // ---- Login: exchange password for a session token -----------------------
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (!authConfigured()) return res.status(500).json({ error: 'ADMIN_PASSWORD not set on the server.' });
      const body = await readBody(req);
      const token = issueToken(body.password);
      if (!token) return res.status(401).json({ error: 'Incorrect password.' });
      return res.status(200).json({ token });
    }

    // ---- Everything else requires a valid token ----------------------------
    if (!verifyRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
    if (!supabaseConfigured()) return res.status(500).json({ error: 'Supabase env vars missing.' });

    // ---- List devices (with playlists) -------------------------------------
    if (action === 'devices' && req.method === 'GET') {
      const archived = req.query.archived === '1';
      const rows = await sb(
        `/devices?select=*,playlists(id,name,type,server_url,username,created_at)` +
        `&archived=eq.${archived}&order=last_seen.desc.nullslast,created_at.desc`
      );
      return res.status(200).json({ devices: rows || [] });
    }

    // ---- Update a device (label / expiry / archive) ------------------------
    if (action === 'update-device' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.device_id) return res.status(400).json({ error: 'device_id required' });
      const patch = {};
      if ('label' in b) patch.label = b.label;
      if ('expires_at' in b) patch.expires_at = b.expires_at; // ISO string or null
      if ('archived' in b) patch.archived = !!b.archived;
      // Derive status from the new expiry when it changes.
      if ('expires_at' in b) {
        patch.status = b.expires_at && new Date(b.expires_at) < new Date() ? 'expired' : 'active';
      }
      const updated = await sb(`/devices?device_id=eq.${encodeURIComponent(b.device_id)}`, {
        method: 'PATCH', body: patch, prefer: 'return=representation'
      });
      return res.status(200).json({ device: updated && updated[0] });
    }

    // ---- Add a playlist to a device ----------------------------------------
    if (action === 'add-playlist' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.device_id || !b.server_url || !b.username || !b.password) {
        return res.status(400).json({ error: 'device_id, server_url, username, password required' });
      }
      const row = {
        device_id: b.device_id,
        name: b.name || 'Playlist',
        type: b.type || 'xtream',
        server_url: normalizeHost(b.server_url),
        username: b.username,
        password: b.password
      };
      const created = await sb('/playlists', { method: 'POST', body: row, prefer: 'return=representation' });
      // Promote a brand-new device from 'pending' to 'active' so the app begins
      // mirroring (including removals). Best-effort — don't fail the add on this.
      try {
        await sb(`/devices?device_id=eq.${encodeURIComponent(b.device_id)}&status=eq.pending`, {
          method: 'PATCH', body: { status: 'active' }, prefer: 'return=minimal'
        });
      } catch (e) { /* ignore */ }
      return res.status(200).json({ playlist: created && created[0] });
    }

    // ---- Remove a playlist --------------------------------------------------
    if (action === 'remove-playlist' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.id) return res.status(400).json({ error: 'id required' });
      await sb(`/playlists?id=eq.${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // ---- Delete a device (and its playlists via cascade) -------------------
    if (action === 'delete-device' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.device_id) return res.status(400).json({ error: 'device_id required' });
      await sb(`/devices?device_id=eq.${encodeURIComponent(b.device_id)}`, { method: 'DELETE' });
      return res.status(200).json({ ok: true });
    }

    // ---- Config (expiry notice / contact) ----------------------------------
    if (action === 'config' && req.method === 'GET') {
      const rows = await sb('/app_config?id=eq.1&select=*');
      return res.status(200).json({ config: (rows && rows[0]) || {} });
    }
    if (action === 'config' && req.method === 'POST') {
      const b = await readBody(req);
      const patch = { updated_at: new Date().toISOString() };
      if ('expiry_notice' in b) patch.expiry_notice = b.expiry_notice;
      if ('contact_info' in b) patch.contact_info = b.contact_info;
      const updated = await sb('/app_config?id=eq.1', {
        method: 'PATCH', body: patch, prefer: 'return=representation'
      });
      return res.status(200).json({ config: updated && updated[0] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
}

function normalizeHost(h) {
  let s = String(h || '').trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}
