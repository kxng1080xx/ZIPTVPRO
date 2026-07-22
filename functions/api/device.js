/**
 * App sync endpoint (PC + APK). Cross-origin — the apps load from file://, the
 * capacitor:// scheme, or the web build, so CORS is open. It is scoped to a
 * single device_id and never exposes other devices' data.
 *
 * Cloudflare Pages Functions port of api/device.js (Vercel) — see that file's
 * header comment for the full request/response shapes; logic is unchanged,
 * only the (req, res) -> (request, env) / Response plumbing differs.
 */
import { sb, supabaseConfigured } from '../_supabase.js';
import { json, preflight, readJson, errorResponse } from '../_util.js';

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestPost({ request, env }) {
  if (!supabaseConfigured(env)) return json({ error: 'Server not configured.' }, 500);

  try {
    const b = await readJson(request);
    const deviceId = String(b.device_id || '').trim().toUpperCase();
    if (!deviceId || !/^[A-Z0-9]{4,12}$/.test(deviceId)) {
      return json({ error: 'Valid device_id required' }, 400);
    }

    if (b.action === 'pair') return await pair(env, deviceId, b.companion_code);
    if (b.action === 'unpair') return await unpair(env, deviceId);
    if (b.action === 'add_playlist') return await addPlaylist(env, deviceId, b);
    if (b.action === 'remove_playlist') return await removeManagedPlaylist(env, deviceId, b.playlist_id);

    // Heartbeat upsert: only touch heartbeat fields. merge-duplicates updates
    // just the supplied columns, so admin fields (label/expires_at/status) and
    // table defaults (status 'pending' on first insert) are preserved.
    await sb(env, '/devices?on_conflict=device_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: {
        device_id: deviceId,
        platform: normalizePlatform(b.platform),
        app_version: b.app_version || null,
        last_seen: new Date().toISOString()
      }
    });

    // Client-reported runtime error (compat.js capture) — stored separately and
    // best-effort so registration never breaks if the columns don't exist yet.
    if (b.last_error) {
      try {
        await sb(env, `/devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
          method: 'PATCH',
          prefer: 'return=minimal',
          body: {
            last_error: String(b.last_error).slice(0, 300),
            last_error_at: b.last_error_at || new Date().toISOString()
          }
        });
      } catch { /* diagnostic only */ }
    }

    // Pull the device + its playlists.
    const rows = await sb(env,
      `/devices?device_id=eq.${encodeURIComponent(deviceId)}` +
      `&select=device_id,label,expires_at,status,archived,companion_device,playlists(id,name,type,server_url,username,password,hidden_tabs,hidden_categories)`
    );
    const dev = rows && rows[0];
    if (!dev) return json({ status: 'pending', playlists: [] });

    const expired = !!dev.expires_at && new Date(dev.expires_at) < new Date();

    // Companion link (must be mutual; a one-sided link — e.g. the other device
    // was deleted or re-paired — is healed by clearing this side).
    let companion = null;
    if (dev.companion_device) {
      try {
        const cRows = await sb(env,
          `/devices?device_id=eq.${encodeURIComponent(dev.companion_device)}` +
          `&select=device_id,label,platform,companion_device`
        );
        const c = cRows && cRows[0];
        if (c && c.companion_device === dev.device_id) {
          companion = { device_id: c.device_id, platform: c.platform || 'unknown', label: c.label || null };
        } else {
          await sb(env, `/devices?device_id=eq.${encodeURIComponent(dev.device_id)}`, {
            method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
          });
        }
      } catch { /* companion info is best-effort */ }
    }

    let notice = '';
    if (expired) {
      try {
        const cfg = await sb(env, '/app_config?id=eq.1&select=expiry_notice,contact_info');
        const c = (cfg && cfg[0]) || {};
        notice = [c.expiry_notice, c.contact_info].filter(Boolean).join('\n');
      } catch { /* notice is best-effort */ }
    }

    return json({
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
    return errorResponse(err);
  }
}

/* --------------------------- companion pairing --------------------------- */

// Link two devices as companions. Rules: both must exist (have checked in),
// they must be different devices, and their platforms must be pc + apk in
// either order — never pc↔pc or apk↔apk. Re-pairing replaces the old link on
// both sides, including a third device that pointed at either of them.
async function pair(env, deviceId, companionCode) {
  const compId = String(companionCode || '').trim().toUpperCase();
  if (!compId || !/^[A-Z0-9]{4,12}$/.test(compId)) {
    return json({ error: 'Enter the other device’s code.' }, 400);
  }
  if (compId === deviceId) {
    return json({ error: 'That is this device’s own code — enter the OTHER device’s code.' }, 400);
  }

  const rows = await sb(env,
    `/devices?device_id=in.(${encodeURIComponent(deviceId)},${encodeURIComponent(compId)})` +
    `&select=device_id,label,platform,companion_device`
  );
  const me = (rows || []).find((d) => d.device_id === deviceId);
  const other = (rows || []).find((d) => d.device_id === compId);
  if (!me) return json({ error: 'This device has not checked in yet — try again in a moment.' }, 400);
  if (!other) {
    return json({ error: `No device with code ${compId} found. Open ZIPTV on the other device first.` }, 404);
  }

  const myPlat = normalizePlatform(me.platform);
  const otherPlat = normalizePlatform(other.platform);
  if (myPlat === 'unknown' || otherPlat === 'unknown') {
    return json({ error: 'Both devices must run the ZIPTV app (PC or mobile) to pair.' }, 400);
  }
  if (myPlat === otherPlat) {
    const kind = myPlat === 'pc' ? 'computers' : 'mobile devices';
    return json({ error: `Companion sync links a computer with a mobile device — two ${kind} can’t be paired.` }, 400);
  }

  // Detach any third devices that currently point at either side.
  for (const old of [me.companion_device, other.companion_device]) {
    if (old && old !== deviceId && old !== compId) {
      try {
        await sb(env, `/devices?device_id=eq.${encodeURIComponent(old)}`, {
          method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
        });
      } catch { /* best-effort */ }
    }
  }

  await sb(env, `/devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'PATCH', body: { companion_device: compId }, prefer: 'return=minimal'
  });
  await sb(env, `/devices?device_id=eq.${encodeURIComponent(compId)}`, {
    method: 'PATCH', body: { companion_device: deviceId }, prefer: 'return=minimal'
  });

  return json({
    ok: true,
    companion: { device_id: other.device_id, platform: otherPlat, label: other.label || null }
  });
}

// Remove the link from both sides.
async function unpair(env, deviceId) {
  const rows = await sb(env, `/devices?device_id=eq.${encodeURIComponent(deviceId)}&select=companion_device`);
  const comp = rows && rows[0] && rows[0].companion_device;
  await sb(env, `/devices?device_id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
  });
  if (comp) {
    try {
      await sb(env, `/devices?device_id=eq.${encodeURIComponent(comp)}&companion_device=eq.${encodeURIComponent(deviceId)}`, {
        method: 'PATCH', body: { companion_device: null }, prefer: 'return=minimal'
      });
    } catch { /* best-effort */ }
  }
  return json({ ok: true });
}

function normalizePlatform(p) {
  const s = String(p || '').toLowerCase();
  if (s === 'pc' || s === 'apk') return s;
  return 'unknown';
}

/* ------------------------ device-added playlists -------------------------- */

// A playlist added on-device via the hidden manual-login form (bypassing
// dashboard provisioning). Inserting it here — same table the dashboard
// writes to — means the next heartbeat's reconcile sees it as already
// "managed" and won't treat it as removed, while it still shows up for the
// admin to see/edit like any other playlist.
async function addPlaylist(env, deviceId, b) {
  const serverUrl = String(b.server_url || '').trim();
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  if (!serverUrl || !username || !password) {
    return json({ error: 'server_url, username, and password are required' }, 400);
  }

  // Make sure the device row exists so the playlists FK insert doesn't fail
  // if this fires before the device's first heartbeat has landed.
  await sb(env, '/devices?on_conflict=device_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: { device_id: deviceId }
  });

  const rows = await sb(env, '/playlists', {
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
  return json({ ok: true, id: row ? row.id : null });
}

// Delete only removes a row this device owns (device_id must match), so a
// device can never delete another device's playlist by guessing an id.
async function removeManagedPlaylist(env, deviceId, playlistId) {
  const id = String(playlistId || '').trim();
  if (!id) return json({ error: 'playlist_id required' }, 400);
  await sb(env, `/playlists?id=eq.${encodeURIComponent(id)}&device_id=eq.${encodeURIComponent(deviceId)}`, {
    method: 'DELETE', prefer: 'return=minimal'
  });
  return json({ ok: true });
}
