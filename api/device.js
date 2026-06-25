/**
 * App sync endpoint (PC + APK). Cross-origin — the apps load from file://, the
 * capacitor:// scheme, or the web build, so CORS is open. It is scoped to a
 * single device_id and never exposes other devices' data.
 *
 *   POST /api/device   { device_id, platform, app_version }
 *     -> { status, label, expires_at, expired, playlists: [...], notice }
 *
 * `playlists` includes credentials (the device knowing its own code is the
 * trust boundary — same model as the old pairing flow). When the device's
 * `expires_at` has passed, playlists comes back empty and `expired` is true so
 * the app wipes local playlists and shows the notice.
 */
import { sb, supabaseConfigured } from './_supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseConfigured()) return res.status(500).json({ error: 'Server not configured.' });

  try {
    const b = await readBody(req);
    const deviceId = String(b.device_id || '').trim().toUpperCase();
    if (!deviceId || !/^[A-Z0-9]{4,12}$/.test(deviceId)) {
      return res.status(400).json({ error: 'Valid device_id required' });
    }

    // Heartbeat upsert: only touch heartbeat fields. merge-duplicates updates
    // just the supplied columns, so admin fields (label/expires_at/status) and
    // table defaults (status 'pending' on first insert) are preserved.
    await sb('/devices?on_conflict=device_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        device_id: deviceId,
        platform: normalizePlatform(b.platform),
        app_version: b.app_version || null,
        last_seen: new Date().toISOString()
      }
    });

    // Pull the device + its playlists.
    const rows = await sb(
      `/devices?device_id=eq.${encodeURIComponent(deviceId)}` +
      `&select=device_id,label,expires_at,status,archived,playlists(id,name,type,server_url,username,password)`
    );
    const dev = rows && rows[0];
    if (!dev) return res.status(200).json({ status: 'pending', playlists: [] });

    const expired = !!dev.expires_at && new Date(dev.expires_at) < new Date();

    let notice = '';
    if (expired) {
      try {
        const cfg = await sb('/app_config?id=eq.1&select=expiry_notice,contact_info');
        const c = (cfg && cfg[0]) || {};
        notice = [c.expiry_notice, c.contact_info].filter(Boolean).join('\n');
      } catch { /* notice is best-effort */ }
    }

    return res.status(200).json({
      status: expired ? 'expired' : (dev.status || 'active'),
      label: dev.label || null,
      expires_at: dev.expires_at || null,
      expired,
      notice,
      playlists: expired ? [] : (dev.playlists || []).map((p) => ({
        id: p.id,
        playlistName: p.name,
        type: p.type,
        server_url: p.server_url,
        username: p.username,
        password: p.password
      }))
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
}

function normalizePlatform(p) {
  const s = String(p || '').toLowerCase();
  if (s === 'pc' || s === 'apk') return s;
  return 'unknown';
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
}
