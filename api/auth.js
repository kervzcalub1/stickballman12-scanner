// POST /api/auth  { password }  ->  { ok, token }
// Validates the shared app password (server-side env var) and returns a
// short-lived HMAC-signed session token used to authorize the other APIs.

import crypto from 'node:crypto';
import { getJsonBody, send, applySecurity, rateLimit, signToken } from './_lib/util.js';

export default async function handler(req, res) {
  applySecurity(req, res);

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!rateLimit(req, { windowMs: 60_000, max: 10 }))
    return send(res, 429, { ok: false, error: 'Too many attempts. Try again shortly.' });

  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    // Gate disabled — hand back a token anyway so the same client flow works.
    try {
      return send(res, 200, { ok: true, token: signToken({ sub: 'open' }), gate: false });
    } catch (e) {
      return send(res, 200, { ok: true, token: null, gate: false });
    }
  }

  const { password } = await getJsonBody(req);
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(appPassword);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) return send(res, 401, { ok: false, error: 'Incorrect password.' });

  try {
    return send(res, 200, { ok: true, token: signToken({ sub: 'user' }), gate: true });
  } catch (e) {
    return send(res, 500, { ok: false, error: 'Server auth is misconfigured (SESSION_SECRET).' });
  }
}
