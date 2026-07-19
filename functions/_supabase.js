/**
 * Shared Supabase REST helper for Cloudflare Pages Functions.
 *
 * Uses the SERVICE ROLE key (server-side only — never shipped to clients), which
 * bypasses Row Level Security. Configured as Pages environment variables
 * (Project -> Settings -> Environment variables), read from `env` per-request
 * (Workers has no process.env) rather than module-level like the Vercel version:
 *   SUPABASE_URL                 e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service_role secret (NOT the anon key)
 */

export function supabaseConfigured(env) {
  return !!(env && env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Thin wrapper over the PostgREST endpoint.
 * @param {object} env   the Pages Function `env` (has SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
 * @param {string} path  e.g. "/devices?select=*"
 * @param {object} opts  { method, body, prefer }
 */
export async function sb(env, path, opts = {}) {
  if (!supabaseConfigured(env)) {
    throw new Error('Supabase env vars missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
  }
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };
  if (opts.prefer) headers.Prefer = opts.prefer;

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
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
