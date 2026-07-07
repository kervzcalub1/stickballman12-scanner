// POST /api/auth/login  { username, password }  ->  { ok, token, user }
// Authenticates against the DB (employees) or the env admin account, with
// DB-backed brute-force throttling. Generic errors avoid username enumeration.

import crypto from 'node:crypto';
import {
  getJsonBody, send, applySecurity, rateLimit, signToken, verifyPassword, hashPassword, clientIp,
} from '../_lib/util.js';
import {
  findUserByUsername, recordLoginAttempt, countRecentFailures, dbConfigured,
} from '../_lib/db.js';

// A real hash to verify against when the username doesn't exist, so login costs
// the same scrypt time either way (defeats username enumeration by timing).
const DUMMY_HASH = hashPassword('decoy-never-matches');

const MAX_FAILS_PER_USER = 5;   // per window, then locked
const MAX_FAILS_PER_IP = 30;    // per window, across usernames
const WINDOW_MINS = 15;

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // In-memory burst guard (per IP) in front of the DB-backed window throttle.
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Too many attempts. Slow down a moment.' });
  if (!dbConfigured())
    return send(res, 500, { ok: false, error: 'Accounts are not configured on the server.' });

  const body = await getJsonBody(req);
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = clientIp(req);

  if (!username || !password)
    return send(res, 400, { ok: false, error: 'Enter your username and password.' });

  // Brute-force throttle (checked before verifying the password).
  try {
    const { by_user, by_ip } = await countRecentFailures({ username, ip, windowMins: WINDOW_MINS });
    if (by_user >= MAX_FAILS_PER_USER || by_ip >= MAX_FAILS_PER_IP) {
      return send(res, 429, {
        ok: false,
        error: `Too many failed attempts. Try again in about ${WINDOW_MINS} minutes.`,
      });
    }
  } catch (e) {
    console.error('[login] throttle check failed:', e.message);
    // fail closed-ish: continue but without throttle data
  }

  const fail = async (msg = 'Incorrect username or password.', code = 401) => {
    try { await recordLoginAttempt({ username, ip, success: false }); } catch { /* noop */ }
    return send(res, code, { ok: false, error: msg });
  };

  // Admin account lives in env, not the DB.
  if (username === 'admin') {
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) return send(res, 500, { ok: false, error: 'Admin login is not configured.' });
    if (!constantTimeEqual(password, adminPass)) return fail();
    await recordLoginAttempt({ username, ip, success: true });
    const user = { uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' };
    return send(res, 200, { ok: true, token: signToken(user), user: publicUser(user) });
  }

  // Superadmin account also lives in env (username + password both configurable).
  // Same privileges as admin server-side, plus the PH-team pages client-side.
  const superUser = String(process.env.SUPERADMIN_USERNAME || '').trim().toLowerCase();
  if (superUser && username === superUser) {
    const superPass = process.env.SUPERADMIN_PASSWORD;
    if (!superPass) return send(res, 500, { ok: false, error: 'Superadmin login is not configured.' });
    if (!constantTimeEqual(password, superPass)) return fail();
    await recordLoginAttempt({ username, ip, success: true });
    const user = { uid: 'superadmin', username: superUser, name: 'Super Admin', role: 'superadmin' };
    return send(res, 200, { ok: true, token: signToken(user), user: publicUser(user) });
  }

  // Employees from the DB.
  let row;
  try {
    row = await findUserByUsername(username);
  } catch (e) {
    console.error('[login] lookup failed:', e.message);
    return send(res, 500, { ok: false, error: 'Login is temporarily unavailable.' });
  }

  // Always run the (slow) verify — against a dummy hash when the user is unknown —
  // so timing can't distinguish a valid username from an invalid one.
  const passOk = verifyPassword(password, row ? row.pass_hash : DUMMY_HASH);
  if (!row || !passOk) return fail();

  // Correct password — now gate on approval status.
  if (row.status === 'pending')
    return send(res, 403, { ok: false, error: 'Your account is awaiting admin approval.' });
  if (row.status === 'rejected')
    return send(res, 403, { ok: false, error: 'Your account was not approved. Contact the admin.' });

  await recordLoginAttempt({ username, ip, success: true });
  const user = { uid: row.id, username: row.username, name: row.name, role: row.role };
  return send(res, 200, { ok: true, token: signToken(user), user: publicUser(user) });
}

function publicUser(u) {
  return { username: u.username, name: u.name, role: u.role };
}
