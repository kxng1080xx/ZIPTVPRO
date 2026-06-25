/**
 * Tiny stateless admin-session token (HMAC-signed, no DB needed).
 *
 * Env vars (Vercel):
 *   ADMIN_PASSWORD   the password you type on /connect
 *   ADMIN_SECRET     a long random string used to sign session tokens
 */
import crypto from 'crypto';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-vercel-env';
const TTL_MS = 12 * 60 * 60 * 1000; // 12h sessions

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payloadStr) {
  return b64url(crypto.createHmac('sha256', ADMIN_SECRET).update(payloadStr).digest());
}

export function authConfigured() {
  return !!ADMIN_PASSWORD;
}

/** Constant-time-ish password check. Returns a token or null. */
export function issueToken(password) {
  if (!ADMIN_PASSWORD) return null;
  const a = Buffer.from(String(password));
  const b = Buffer.from(String(ADMIN_PASSWORD));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = b64url(JSON.stringify({ exp: Date.now() + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

/** Validate a Bearer token from the request. */
export function verifyRequest(req) {
  const hdr = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = hdr.replace(/^Bearer\s+/i, '').trim();
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  if (sign(payload) !== sig) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}
