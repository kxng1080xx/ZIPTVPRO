/**
 * Admin dashboard backend for /connect.
 *
 * Same-origin only (served from the same Pages project). All actions except
 * `login` require a valid Bearer token issued by `login`.
 *
 * Cloudflare Pages Functions port of api/admin.js (Vercel) — see that file's
 * header comment for the full action/method list; logic is unchanged, only
 * the (req, res) -> (request, env) / Response plumbing differs. Pages routes
 * GET and POST to the same file via separate exports, so both are handled
 * here and dispatch on `?action=`.
 */
import { sb, supabaseConfigured } from '../_supabase.js';
import { issueToken, verifyRequest, authConfigured } from '../_auth.js';
import { json, preflight, readJson, errorResponse } from '../_util.js';

export async function onRequestOptions() {
  return preflight();
}

export async function onRequestGet(ctx) {
  return handle(ctx);
}

export async function onRequestPost(ctx) {
  return handle(ctx);
}

async function handle({ request, env }) {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';

  try {
    // ---- Login: exchange password for a session token -----------------------
    if (action === 'login') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      if (!authConfigured(env)) return json({ error: 'ADMIN_PASSWORD not set on the server.' }, 500);
      const body = await readJson(request);
      const token = await issueToken(env, body.password);
      if (!token) return json({ error: 'Incorrect password.' }, 401);
      return json({ token });
    }

    // ---- Everything else requires a valid token ----------------------------
    if (!(await verifyRequest(env, request))) return json({ error: 'Unauthorized' }, 401);
    if (!supabaseConfigured(env)) return json({ error: 'Supabase env vars missing.' }, 500);

    // ---- List devices (with playlists) -------------------------------------
    if (action === 'devices' && request.method === 'GET') {
      const archived = url.searchParams.get('archived') === '1';
      const rows = await sb(env,
        `/devices?select=*,playlists(id,name,type,server_url,username,created_at,hidden_tabs,hidden_categories)` +
        `&archived=eq.${archived}&order=last_seen.desc.nullslast,created_at.desc`
      );
      return json({ devices: rows || [] });
    }

    // ---- Update a device (label / expiry / archive) ------------------------
    if (action === 'update-device' && request.method === 'POST') {
      const b = await readJson(request);
      if (!b.device_id) return json({ error: 'device_id required' }, 400);
      const patch = {};
      if ('label' in b) patch.label = b.label;
      if ('expires_at' in b) patch.expires_at = b.expires_at; // ISO string or null
      if ('archived' in b) patch.archived = !!b.archived;
      // Derive status from the new expiry when it changes.
      if ('expires_at' in b) {
        patch.status = b.expires_at && new Date(b.expires_at) < new Date() ? 'expired' : 'active';
      }
      const updated = await sb(env, `/devices?device_id=eq.${encodeURIComponent(b.device_id)}`, {
        method: 'PATCH', body: patch, prefer: 'return=representation'
      });
      return json({ device: updated && updated[0] });
    }

    // ---- Add a playlist to a device ----------------------------------------
    if (action === 'add-playlist' && request.method === 'POST') {
      const b = await readJson(request);
      if (!b.device_id || !b.server_url || !b.username || !b.password) {
        return json({ error: 'device_id, server_url, username, password required' }, 400);
      }
      const row = {
        device_id: b.device_id,
        name: b.name || 'Playlist',
        type: b.type || 'xtream',
        server_url: normalizeHost(b.server_url),
        username: b.username,
        password: b.password
      };
      // Pre-add visibility: the admin picked what to sync before creating the
      // playlist, so the device never mirrors the full library first.
      if (Array.isArray(b.hidden_tabs)) row.hidden_tabs = b.hidden_tabs;
      if (Array.isArray(b.hidden_categories)) row.hidden_categories = b.hidden_categories;
      const created = await sb(env, '/playlists', { method: 'POST', body: row, prefer: 'return=representation' });
      // Promote a brand-new device from 'pending' to 'active' so the app begins
      // mirroring (including removals). Best-effort — don't fail the add on this.
      try {
        await sb(env, `/devices?device_id=eq.${encodeURIComponent(b.device_id)}&status=eq.pending`, {
          method: 'PATCH', body: { status: 'active' }, prefer: 'return=minimal'
        });
      } catch (e) { /* ignore */ }
      return json({ playlist: created && created[0] });
    }

    // ---- Remove a playlist --------------------------------------------------
    if (action === 'remove-playlist' && request.method === 'POST') {
      const b = await readJson(request);
      if (!b.id) return json({ error: 'id required' }, 400);
      await sb(env, `/playlists?id=eq.${encodeURIComponent(b.id)}`, { method: 'DELETE' });
      return json({ ok: true });
    }

    // ---- Update a playlist (tabs & categories visibility) ------------------
    if (action === 'update-playlist' && request.method === 'POST') {
      const b = await readJson(request);
      if (!b.id) return json({ error: 'id required' }, 400);
      const patch = {};
      if ('name' in b) patch.name = b.name;
      if ('hidden_tabs' in b) patch.hidden_tabs = b.hidden_tabs;
      if ('hidden_categories' in b) patch.hidden_categories = b.hidden_categories;
      const updated = await sb(env, `/playlists?id=eq.${encodeURIComponent(b.id)}`, {
        method: 'PATCH', body: patch, prefer: 'return=representation'
      });
      return json({ playlist: updated && updated[0] });
    }

    // ---- Fetch categories for a playlist (server-side, keeping password secure)
    if (action === 'playlist-categories' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id required' }, 400);

      const rows = await sb(env, `/playlists?id=eq.${encodeURIComponent(id)}&select=*`);
      const pl = rows && rows[0];
      if (!pl) return json({ error: 'Playlist not found' }, 404);

      try {
        return json(await fetchXtreamCategories(pl.server_url, pl.username, pl.password));
      } catch (err) {
        return json({ error: `Failed to fetch categories: ${err.message}` }, 500);
      }
    }

    // ---- Fetch categories from raw credentials (pre-add visibility picker) ----
    // POST so the password travels in the body, not in a logged query string.
    if (action === 'preview-categories' && request.method === 'POST') {
      const b = await readJson(request);
      if (!b.server_url || !b.username || !b.password) {
        return json({ error: 'server_url, username, password required' }, 400);
      }
      try {
        return json(await fetchXtreamCategories(normalizeHost(b.server_url), b.username, b.password));
      } catch (err) {
        return json({ error: `Failed to fetch categories: ${err.message}` }, 500);
      }
    }

    // ---- Delete a device (and its playlists via cascade) -------------------
    if (action === 'delete-device' && request.method === 'POST') {
      const b = await readJson(request);
      if (!b.device_id) return json({ error: 'device_id required' }, 400);
      await sb(env, `/devices?device_id=eq.${encodeURIComponent(b.device_id)}`, { method: 'DELETE' });
      return json({ ok: true });
    }

    // ---- Config (expiry notice / contact) ----------------------------------
    if (action === 'config' && request.method === 'GET') {
      const rows = await sb(env, '/app_config?id=eq.1&select=*');
      return json({ config: (rows && rows[0]) || {} });
    }
    if (action === 'config' && request.method === 'POST') {
      const b = await readJson(request);
      const patch = { updated_at: new Date().toISOString() };
      if ('expiry_notice' in b) patch.expiry_notice = b.expiry_notice;
      if ('contact_info' in b) patch.contact_info = b.contact_info;
      // Reusable playlist credentials for device setup. Admin-only: the
      // device endpoint never selects this column, so it can't leak to apps.
      if ('saved_playlists' in b) {
        patch.saved_playlists = (Array.isArray(b.saved_playlists) ? b.saved_playlists : [])
          .filter(p => p && p.server_url && p.username && p.password)
          .map(p => ({
            name: String(p.name || 'Playlist'),
            type: 'xtream',
            server_url: normalizeHost(p.server_url),
            username: String(p.username),
            password: String(p.password)
          }));
      }
      const updated = await sb(env, '/app_config?id=eq.1', {
        method: 'PATCH', body: patch, prefer: 'return=representation'
      });
      return json({ config: updated && updated[0] });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (err) {
    return errorResponse(err);
  }
}

// Xtream categories for all three tabs, in parallel. A tab whose call fails
// comes back empty rather than failing the whole request.
async function fetchXtreamCategories(serverUrl, username, password) {
  const fetchCats = async (act) => {
    const url = `${serverUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${act}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Xtream status ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
  };
  const [live, movie, series] = await Promise.all([
    fetchCats('get_live_categories').catch(() => []),
    fetchCats('get_vod_categories').catch(() => []),
    fetchCats('get_series_categories').catch(() => [])
  ]);
  return { live, movie, series };
}

function normalizeHost(h) {
  let s = String(h || '').trim();
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}
