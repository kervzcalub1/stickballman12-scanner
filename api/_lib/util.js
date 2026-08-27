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
  // Otherwise read the raw stream, capping total size to guard against
  // oversized-payload abuse.
  const MAX_BYTES = 256 * 1024; // 256 KB is ample for our small JSON bodies
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BYTES) return {}; // drop oversized bodies → handlers validate and 400
    chunks.push(chunk);
  }
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
  const ip = clientIp(req); // spoof-resistant (see clientIp) — not raw X-Forwarded-For
  // Scope the bucket per (ip, route) — a shared IP-only bucket let unrelated
  // endpoint traffic exhaust a strict per-route budget (e.g. ph/refresh-gi).
  const route = String(req.url || '').split('?')[0];
  const key = `${ip}|${route}`;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
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

// Verifies the Bearer session token. On success returns the decoded user
// payload ({ uid, username, name, role, exp }); on failure sends 401 and
// returns null. Callers use: `const user = requireAuth(req, res); if (!user) return;`
export function requireAuth(req, res) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const data = verifyToken(token);
  if (!data) {
    send(res, 401, { ok: false, error: 'Unauthorized. Please sign in again.' });
    return null;
  }
  return data;
}

// Privileged roles auto-allowed wherever admin is: the env `admin` account and the
// env `superadmin` account (which additionally reaches the PH-team pages, client-side).
export const isPrivileged = (role) => role === 'admin' || role === 'superadmin';

// getPoFull attaches OUR received count to each label. That's staff-only — a supplier
// must not read what the warehouse counted off their portal before the reconciliation
// is settled with them — so every response that can reach a supplier drops it.
export const hideReceivedUnits = (boxes) => (boxes || []).map(({ received_units, ...b }) => b);

// A user carrying the signed `mustChange` flag (admin issued a temp password) is blocked
// from every role/admin-gated endpoint until they set a new password via
// /api/auth/change-password (which requireAuth allows). 428 = "precondition required".
function blockIfMustChange(user, res) {
  if (user && user.mustChange) {
    send(res, 428, { ok: false, error: 'Set a new password to continue.', mustChange: true });
    return true;
  }
  return false;
}

// Like requireAuth but also requires an admin-level role (admin or superadmin).
// Returns the user or null.
export function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (blockIfMustChange(user, res)) return null;
  if (!isPrivileged(user.role)) {
    send(res, 403, { ok: false, error: 'Admin access required.' });
    return null;
  }
  return user;
}

// Like requireAuth but restricts to a set of roles (admin/superadmin always allowed).
// Returns the user or null (after sending 401/403). Use for page-scoped access.
export function requireRole(req, res, roles) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (blockIfMustChange(user, res)) return null;
  if (!isPrivileged(user.role) && !roles.includes(user.role)) {
    send(res, 403, { ok: false, error: 'You do not have access to this feature.' });
    return null;
  }
  return user;
}

// SUPERADMIN ONLY — `requireRole` is no use here: it auto-passes anything privileged
// (isPrivileged covers admin too), so a list of roles can never exclude an admin. The
// merge tools are irreversible and rewrite other people's records, so they are held one
// notch above the rest of the admin surface.
export function requireSuperadmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (blockIfMustChange(user, res)) return null;
  if (user.role !== 'superadmin') {
    send(res, 403, { ok: false, error: 'This tool is superadmin only.' });
    return null;
  }
  return user;
}

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt — built into Node, no extra dependency).   */
/* Stored format: s2$<saltHex>$<hashHex>                               */
/* ------------------------------------------------------------------ */

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 64);
  return `s2$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 's2' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(plain), Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Best-effort client IP (Vercel sets x-forwarded-for).
// The client IP used for rate-limiting / login throttling. `X-Forwarded-For` is
// CLIENT-CONTROLLED and must NOT be trusted unless a known proxy sits in front:
// otherwise an attacker rotates the header to reset every per-IP limit. Set
// TRUST_PROXY_HOPS to the number of trusted proxies in prod (Railway = 1); when
// 0 (default, dev / direct exposure) we ignore the header and use the socket IP,
// which can't be spoofed.
export function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || 'unknown';
  const hops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (hops <= 0) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // Our trusted proxy layer appends the real peer as the outermost entries; the
  // client is `hops` from the right. Any entries the client itself injected sit
  // to the LEFT of that and are ignored.
  return chain[chain.length - hops] || socketIp;
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

// Some pairs carry TWO style codes in one field — "315121-115/CW2290-111" (a shoe
// re-issued under a new code, or double-labelled). No provider knows that combined
// string: Alias returns nothing for it, so every price lookup on those items came
// back empty while each half resolves fine on its own. Pricing therefore keys off
// the FIRST code — the one whoever received the pair wrote first.
//
// Splits on `/`, `,` and `|` only. NOT on whitespace: a style code is sometimes
// typed with a space instead of a dash ("DD1391 100"), and splitting there would
// truncate a perfectly good single SKU to "DD1391".
export function primarySku(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const first = s.split(/[/,|]/)[0].trim();
  return first || null;
}

// EVERY style code a product record declares, in order, de-duplicated.
// StockX writes both codes of a re-released shoe on a single styleId
// ("315122-111/CW2288-111"), and supplier manifests do the same. The Alias catalog
// only ever knows ONE code at a time (aliasCatalogBySku searches on `primarySku`
// above), so any caller that takes Alias's `sku` verbatim silently drops the rest —
// the box says two codes and the app shows one. Splits on the same separators as
// `primarySku` so the two can never disagree about what a code boundary is.
export function skuCodes(raw) {
  const seen = new Set();
  return String(raw || '').split(/[/,|]/)
    .map((c) => c.trim().replace(/\s+/g, '-'))
    .filter((c) => {
      if (!c) return false;
      const k = c.toUpperCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export function cleanSku(raw) {
  // Allow letters, digits, spaces and dashes; trim and cap length.
  const s = String(raw || '').trim().slice(0, 64);
  if (!s) return null;
  if (!/^[A-Za-z0-9 .\-_/]+$/.test(s)) return null;
  return s;
}

// Normalize a product gender for store listing. Accepts a raw provider value
// (Alias `gender`/`single_gender`, e.g. "men"/"women"/"youth"/"infant") and/or
// a size string + title to derive it when the provider is silent: StockX encodes
// gender on the size suffix ("8.5W" → women's, "5Y"/"5C" → youth/kids), and shoe
// titles often carry "(Women's)"/"(GS)"/"(TD)". Returns a clean label
// ('Men' | 'Women' | 'Youth' | 'Toddler' | 'Unisex') or null when unknown.
export function normalizeGender(raw, { size = '', title = '' } = {}) {
  const r = String(raw || '').trim().toLowerCase();
  if (/wom|female|\bw\b|ladies/.test(r)) return 'Women';
  if (/\bmen\b|male|\bm\b/.test(r)) return 'Men';
  if (/unisex|adult/.test(r)) return 'Unisex';
  if (/infant|toddler|\btd\b|crib|\bps\b|preschool/.test(r)) return 'Toddler';
  if (/youth|grade|kids?|child|\bgs\b|\by\b/.test(r)) return 'Youth';

  const s = String(size || '').trim().toUpperCase();
  if (/\d(W)$/.test(s)) return 'Women';
  if (/\d(C|TD|PS)$/.test(s)) return 'Toddler';
  if (/\d(Y|GS|K)$/.test(s)) return 'Youth';

  const t = String(title || '').toLowerCase();
  if (/women|wmns|\(w\)/.test(t)) return 'Women';
  if (/\(td\)|toddler|\(ps\)/.test(t)) return 'Toddler';
  if (/\(gs\)|grade school|youth|\bkids?\b/.test(t)) return 'Youth';
  if (/\bmen\b|mens|\bmn\b/.test(t)) return 'Men';
  return null;
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
