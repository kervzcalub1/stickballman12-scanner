// POST /api/auth/signup  { name, username, password }  ->  { ok, message }
// Creates a PENDING employee account. No session is issued — the user must be
// approved by the admin before they can sign in.

import {
  getJsonBody, send, applySecurity, rateLimit, hashPassword,
} from '../_lib/util.js';
import { createUser, dbConfigured } from '../_lib/db.js';

const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Limit signup spam per IP.
  if (!rateLimit(req, { windowMs: 60_000, max: 10 }))
    return send(res, 429, { ok: false, error: 'Too many requests. Slow down a moment.' });
  if (!dbConfigured())
    return send(res, 500, { ok: false, error: 'Accounts are not configured on the server.' });

  const body = await getJsonBody(req);

  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  // Requested role — admin is never self-assignable at signup.
  const role = ['warehouse', 'ph_team'].includes(body.role) ? body.role : 'warehouse';

  if (!name) return send(res, 400, { ok: false, error: 'Please enter your name.' });
  if (!USERNAME_RE.test(username))
    return send(res, 400, {
      ok: false,
      error: 'Username must be 3–32 chars: letters, numbers, and . _ - only.',
    });
  if (username === 'admin')
    return send(res, 400, { ok: false, error: 'That username is reserved.' });
  if (password.length < 8 || password.length > 200)
    return send(res, 400, { ok: false, error: 'Password must be at least 8 characters.' });

  try {
    await createUser({ name, username, passHash: hashPassword(password), role });
    return send(res, 201, {
      ok: true,
      message: 'Account created. Please wait for an admin to approve your access.',
    });
  } catch (e) {
    if (e.code === 'USERNAME_TAKEN')
      return send(res, 409, { ok: false, error: 'That username is already taken.' });
    console.error('[signup]', e.message);
    return send(res, 500, { ok: false, error: 'Could not create the account. Try again.' });
  }
}
