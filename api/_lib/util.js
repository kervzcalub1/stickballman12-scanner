// Shared server-side helpers for the serverless API functions.
// Anything in /api/_lib is NOT exposed as an HTTP endpoint by Vercel
// (files/folders prefixed with "_" are ignored as routes).

import crypto from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Request / response helpers (work on Vercel AND in the Vite dev      */
/* middleware, which both pass raw Node req/res objects).              */
/* ------------------------------------------------------------------ */

export async function getJsonBody(req) {
  // Vercel may have already parsed the body.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Otherwise read the raw stream.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

export function send(res, status, data) {
  const payload = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

/* ------------------------------------------------------------------ */
/* Security headers + CORS (same-origin only).                         */
/* ------------------------------------------------------------------ */

export function applySecurity(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // API is called same-origin by our own frontend; do not echo arbitrary origins.
  res.setHeader('Vary', 'Origin');
}

/* ------------------------------------------------------------------ */
/* Lightweight in-memory rate limiter (per IP, sliding window).        */
/* Note: serverless instances are ephemeral, so this guards bursts on  */
/* a warm instance rather than providing global limits.                */
/* ------------------------------------------------------------------ */

const buckets = new Map();

export function rateLimit(req, { windowMs = 60_000, max = 30 } = {}) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const now = Date.now();
  const hits = (buckets.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(ip, hits);
  // opportunistic cleanup
  if (buckets.size > 5000) buckets.clear();
  return hits.length <= max;
}

/* ------------------------------------------------------------------ */
/* Signed session tokens (HMAC-SHA256). No database required.          */
/* ------------------------------------------------------------------ */

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    // Refuse to issue/verify tokens with a weak/absent secret in prod.
    throw new Error('SESSION_SECRET is not configured (min 16 chars).');
  }
  return s;
}

export function signToken(payload, ttlMs = 8 * 60 * 60 * 1000) {
  const secret = getSecret();
  const body = b64url(
    JSON.stringify({ ...payload, exp: Date.now() + ttlMs })
  );
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  try {
    const secret = getSecret();
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = b64url(
      crypto.createHmac('sha256', secret).update(body).digest()
    );
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

// Returns true if the request carries a valid session token.
// If APP_PASSWORD is not configured, the gate is disabled (dev convenience)
// and a warning is logged.
export function requireAuth(req, res) {
  if (!process.env.APP_PASSWORD) {
    console.warn('[auth] APP_PASSWORD not set — access gate is DISABLED.');
    return true;
  }
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const data = verifyToken(token);
  if (!data) {
    send(res, 401, { ok: false, error: 'Unauthorized. Please sign in again.' });
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Input validation.                                                   */
/* ------------------------------------------------------------------ */

export function cleanUpc(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  // UPC-A/EAN are 8–14 digits.
  if (digits.length < 8 || digits.length > 14) return null;
  return digits;
}

export function cleanSku(raw) {
  // Allow letters, digits, spaces and dashes; trim and cap length.
  const s = String(raw || '').trim().slice(0, 64);
  if (!s) return null;
  if (!/^[A-Za-z0-9 .\-_/]+$/.test(s)) return null;
  return s;
}

/* ------------------------------------------------------------------ */
/* Upstream helpers: timeouts + a tiny in-memory lookup cache.         */
/* ------------------------------------------------------------------ */

// fetch() with an abort timeout so a slow/hung upstream fails fast (which, for
// UPC search, lets us rotate to the Alias fallback quickly instead of hanging).
export async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Process-local TTL cache for product lookups. Serverless instances are
// ephemeral, so this only helps repeat scans on a warm instance — but those
// are exactly the common case (re-scanning the same item) and it skips the
// ~1s upstream round trip entirely. Product metadata (name/sku/sizes) is
// effectively static over a short window, so a few minutes is safe.
const _lookupCache = new Map();

export function cacheGet(key) {
  const hit = _lookupCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _lookupCache.delete(key);
    return null;
  }
  // Refresh LRU position.
  _lookupCache.delete(key);
  _lookupCache.set(key, hit);
  return hit.value;
}

export function cacheSet(key, value, ttlMs = 5 * 60 * 1000) {
  _lookupCache.set(key, { value, exp: Date.now() + ttlMs });
  // Bound memory: drop the oldest entry once we exceed the cap.
  if (_lookupCache.size > 500) {
    _lookupCache.delete(_lookupCache.keys().next().value);
  }
}
