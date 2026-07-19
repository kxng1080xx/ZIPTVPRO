/**
 * Tiny stateless admin-session token (HMAC-signed, no DB needed).
 * Cloudflare Workers port of api/_auth.js: uses the Web Crypto API
 * (crypto.subtle) instead of Node's `crypto` module, and reads secrets from
 * the per-request `env` instead of process.env.
 *
 * Env vars (Cloudflare Pages -> Settings -> Environment variables):
 *   ADMIN_PASSWORD   the password you type on /connect
 *   ADMIN_SECRET     a long random string used to sign session tokens
 */

const TTL_MS = 12 * 60 * 60 * 1000; // 12h sessions

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToString(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return bin;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

async function sign(secret, payloadStr) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadStr));
  return b64url(new Uint8Array(sig));
}

// Constant-time-ish string compare (Node's crypto.timingSafeEqual has no
// direct Web Crypto equivalent for arbitrary strings).
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authConfigured(env) {
  return !!(env && env.ADMIN_PASSWORD);
}

/** Constant-time-ish password check. Returns a token or null. */
export async function issueToken(env, password) {
  if (!authConfigured(env)) return null;
  const a = String(password || '');
  const b = String(env.ADMIN_PASSWORD);
  if (!timingSafeEqualStr(a, b)) return null;
  const secret = env.ADMIN_SECRET || 'change-me-in-cloudflare-env';
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ exp: Date.now() + TTL_MS })));
  return `${payload}.${await sign(secret, payload)}`;
}

/** Validate a Bearer token from the request. */
export async function verifyRequest(env, request) {
  const hdr = request.headers.get('authorization') || request.headers.get('Authorization') || '';
  const token = hdr.replace(/^Bearer\s+/i, '').trim();
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const secret = env.ADMIN_SECRET || 'change-me-in-cloudflare-env';
  if ((await sign(secret, payload)) !== sig) return false;
  try {
    const { exp } = JSON.parse(b64urlDecodeToString(payload));
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}
