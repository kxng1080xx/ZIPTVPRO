/**
 * Shared helpers for Cloudflare Pages Functions (the Vercel -> Cloudflare port
 * of api/*.js). Pages Functions use the Fetch API (Request/Response) instead
 * of Vercel's Node-style (req, res) handlers, so every route needs a JSON
 * Response helper and a body reader instead of res.status().json().
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function readJson(request) {
  try {
    const t = await request.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

// Errors thrown by _supabase.js (and elsewhere) carry `.status`; anything else
// is a 500. Centralizes the try/catch -> Response mapping every route repeats.
export function errorResponse(err) {
  return json({ error: (err && err.message) || 'Server error' }, (err && err.status) || 500);
}
