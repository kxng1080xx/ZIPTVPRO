/**
 * App sync endpoint (PC + APK). Cross-origin — the apps load from file://, the
 * capacitor:// scheme, or the web build, so CORS is open. It is scoped to a
 * single device_id and never exposes other devices' data.
 *
 *   POST /api/device   { device_id, platform, app_version }
 *     -> { status, label, expires_at, expired, playlists: [...], notice, companion }
 *
 *   POST /api/device   { action: 'pair', device_id, companion_code }
 *     -> { ok, companion: { device_id, platform, label } }
 *   POST /api/device   { action: 'unpair', device_id }
 *     -> { ok }
 *
 * Companion pairing links exactly two devices of DIFFERENT platforms (pc ↔ apk)
 * so Continue Watching can hand off between a computer and a phone. Knowing
 * both device codes is the trust boundary, same as activation.
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

    if (b.action === 'pair') return await pair(res, deviceId, b.companion_code);
    if (b.action === 'unpair') return await unpair(res, deviceId);
    if (b.action === 'add_playlist') return await addPlaylist(res, deviceId, b);
    if (b.action === 'remove_playlist') return await removeManagedPlaylist(res, deviceId, b.playlist_id);

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
      `&select=device_id,label,expires_at,status,archived,companion_device,playlists(id,name,type,server_url,username,password,hidden_tabs,hidden_categories)`
    );
    const dev = rows && rows[0];
    if (!dev) return res.status(200).json({ status: 'pending', playlists: [] });

    const expired = !!dev.expires_at && new Date(dev.expires_at) < new Date();

    // Companion link (must be mutual; a one-sided link — e.g. the other device
    // was deleted or re-paired — is healed by clearing this side).
    let companion = null;
    if (dev.companion_device) {
      try {
        const cRows = await sb(
          `/devices?device_id=eq.${encodeURIComponent(dev.companion_device)}` +
          `&select=device_id,label,platform,companion_device`
        );
        const c = cRows && cRows[0];
        if (c && c.companion_device === dev.device_id) {
          companion = { device_id: c.device_id, platform: c.platform || 'unknown', label: c.label || null };
        } else {
          await sb(`/devices?device_id=eq.${encodeURIComponent(dev.device_id)}`, {
            method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
          });
        }
      } catch { /* companion info is best-effort */ }
    }

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
      companion,
      playlists: expired ? [] : (dev.playlists || []).map((p) => ({
        id: p.id,
        playlistName: p.name,
        type: p.type,
        server_url: p.server_url,
        username: p.username,
        password: p.password,
        hidden_tabs: p.hidden_tabs || [],
        hidden_categories: p.hidden_categories || []
      }))
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
}

/* --------------------------- companion pairing --------------------------- */

// Link two devices as companions. Rules: both must exist (have checked in),
// they must be different devices, and their platforms must be pc + apk in
// either order — never pc↔pc or apk↔apk. Re-pairing replaces the old link on
// both sides, including a third device that pointed at either of them.
async function pair(res, deviceId, companionCode) {
  const compId = String(companionCode || '').trim().toUpperCase();
  if (!compId || !/^[A-Z0-9]{4,12}$/.test(compId)) {
    return res.status(400).json({ error: 'Enter the other device’s code.' });
  }
  if (compId === deviceId) {
    return res.status(400).json({ error: 'That is this device’s own code — enter the OTHER device’s code.' });
  }

  const rows = await sb(
    `/devices?device_id=in.(${encodeURIComponent(deviceId)},${encodeURIComponent(compId)})` +
    `&select=device_id,label,platform,companion_device`
  );
  const me = (rows || []).find((d) => d.device_id === deviceId);
  const other = (rows || []).find((d) => d.device_id === compId);
  if (!me) return res.status(400).json({ error: 'This device has not checked in yet — try again in a moment.' });
  if (!other) {
    return res.status(404).json({ error: `No device with code ${compId} found. Open ZIPTV on the other device first.` });
  }

  const myPlat = normalizePlatform(me.platform);
  const otherPlat = normalizePlatform(other.platform);
  if (myPlat === 'unknown' || otherPlat === 'unknown') {
    return res.status(400).json({ error: 'Both devices must run the ZIPTV app (PC or mobile) to pair.' });
  }
  if (myPlat === otherPlat) {
    const kind = myPlat === 'pc' ? 'computers' : 'mobile devices';
    return res.status(400).json({ error: `Companion sync links a computer with a mobile device — two ${kind} can’t be paired.` });
  }

  // Detach any third devices that currently point at either side.
  for (const old of [me.companion_device, other.companion_device]) {
    if (old && old !== deviceId && old !== compId) {
      try {
        await sb(`/devices?device_id=eq.${encodeURIComponent(old)}`, {
          method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
        });
      } catch { /* best-effort */ }
    }
  }

  await sb(`/devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'PATCH', body: { companion_device: compId }, prefer: 'return=minimal'
  });
  await sb(`/devices?device_id=eq.${encodeURIComponent(compId)}`, {
    method: 'PATCH', body: { companion_device: deviceId }, prefer: 'return=minimal'
  });

  return res.status(200).json({
    ok: true,
    companion: { device_id: other.device_id, platform: otherPlat, label: other.label || null }
  });
}

// Remove the link from both sides.
async function unpair(res, deviceId) {
  const rows = await sb(`/devices?device_id=eq.${encodeURIComponent(deviceId)}&select=companion_device`);
  const comp = rows && rows[0] && rows[0].companion_device;
  await sb(`/devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
  });
  if (comp) {
    try {
      await sb(`/devices?device_id=eq.${encodeURIComponent(comp)}&companion_device=eq.${encodeURIComponent(deviceId)}`, {
        method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
      });
    } catch { /* best-effort */ }
  }
  return res.status(200).json({ ok: true });
}

/* ------------------------ device-added playlists -------------------------- */

// A playlist added on-device via the hidden manual-login form (bypassing
// dashboard provisioning). Inserting it here — same table the dashboard
// writes to — means the next heartbeat's reconcile sees it as already
// "managed" and won't treat it as removed, while it still shows up for the
// admin to see/edit like any other playlist.
async function addPlaylist(res, deviceId, b) {
  const serverUrl = String(b.server_url || '').trim();
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!serverUrl || !username || !password) {
    return res.status(400).json({ error: 'server_url, username, and password are required' });
  }

  // Make sure the device row exists so the playlists FK insert doesn't fail
  // if this fires before the device's first heartbeat has landed.
  await sb('/devices?on_conflict=device_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: { device_id: deviceId }
  });

  const rows = await sb('/playlists', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      device_id: deviceId,
      name: b.name || 'My Xtream Playlist',
      type: b.type || 'xtream',
      server_url: serverUrl,
      username,
      password
    }
  });
  const row = rows && rows[0];
  return res.status(200).json({ ok: true, id: row ? row.id : null });
}

// Delete only removes a row this device owns (device_id must match), so a
// device can never delete another device's playlist by guessing an id.
async function removeManagedPlaylist(res, deviceId, playlistId) {
  const id = String(playlistId || '').trim();
  if (!id) return res.status(400).json({ error: 'playlist_id required' });
  await sb(
    `/playlists?id=eq.${encodeURIComponent(id)}&device_id=eq.${encodeURIComponent(deviceId)}`,
    { method: 'DELETE', prefer: 'return=minimal' }
  );
  return res.status(200).json({ ok: true });
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
