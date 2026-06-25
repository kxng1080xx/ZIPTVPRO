/**
 * Shared Supabase REST helper for the serverless API.
 *
 * Uses the SERVICE ROLE key (server-side only — never shipped to clients), which
 * bypasses Row Level Security. All env vars are configured in Vercel:
 *   SUPABASE_URL                 e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service_role secret (NOT the anon key)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function supabaseConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY);
}

/**
 * Thin wrapper over the PostgREST endpoint.
 * @param {string} path  e.g. "/devices?select=*"
 * @param {object} opts  { method, body, prefer }
 */
export async function sb(path, opts = {}) {
  if (!supabaseConfigured()) {
    throw new Error('Supabase env vars missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  }
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json'
  };
  if (opts.prefer) headers.Prefer = opts.prefer;

  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Supabase error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}
