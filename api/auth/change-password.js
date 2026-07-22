// POST /api/auth/change-password  (authed)  { newPassword }  ->  { ok, token, user }
// The signed-in user sets a new password. Primary use: the forced-change screen shown
// after signing in with an admin-issued temp password (must_change_password = true).
// Clears the forced-change flag and returns a FRESH token so the client's session no
// longer carries the "must change" gate.
//
// DB accounts only — the env admin/superadmin accounts have no DB row; their password
// lives in Railway env and is changed there, not here.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, signToken, hashPassword } from '../_lib/util.js';
import { changeOwnPassword, dbConfigured } from '../_lib/db.js';

const MIN_LEN = 8;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Too many attempts. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  // Env accounts (uid is a string 'admin'/'superadmin', not a numeric row id).
  if (!Number.isInteger(Number(user.uid))) {
    return send(res, 400, { ok: false, error: 'This built-in account’s password is managed in the server settings, not here.' });
  }

  const body = await getJsonBody(req);
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < MIN_LEN)
    return send(res, 400, { ok: false, error: `Choose a password of at least ${MIN_LEN} characters.` });

  try {
    const updated = await changeOwnPassword(Number(user.uid), hashPassword(newPassword));
    if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
    // Fresh token WITHOUT the mustChange gate.
    const fresh = { uid: updated.id, username: updated.username, name: updated.name, role: updated.role };
    return send(res, 200, {
      ok: true,
      token: signToken(fresh),
      user: { username: updated.username, name: updated.name, role: updated.role },
    });
  } catch (e) {
    console.error('[auth/change-password]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change the password.' });
  }
}
