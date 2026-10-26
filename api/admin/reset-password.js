// POST /api/admin/reset-password  (admin / superadmin)
//   { userId }  ->  { ok, user, tempPassword }
// Generates a random temporary password for a DB account, stores only its hash, and
// returns the plaintext ONCE so the admin can relay it to the user. The account is
// flagged must_change_password, so the user is forced to pick a new password on their
// next sign-in before they can use the app. The env admin/superadmin accounts have no
// DB row and cannot be reset here.

import crypto from 'node:crypto';
import { getJsonBody, send, applySecurity, rateLimit, hashPassword } from '../_lib/util.js';
import { adminResetPassword, dbConfigured, getUserById } from '../_lib/db.js';
import { requireAccessManager, accessRefusal } from '../_lib/buycart.js';

// Readable temp password: 12 chars from an unambiguous alphabet (no 0/O/1/I/l).
function makeTempPassword(len = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // An admin, or an account holding "Manage user access" (not on an admin's account).
  const admin = await requireAccessManager(req, res);
  if (!admin) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  const body = await getJsonBody(req);
  const userId = parseInt(body.userId, 10);
  if (!Number.isInteger(userId)) return send(res, 400, { ok: false, error: 'Provide a userId.' });

  try {
    if (!admin.fullAdmin) {
      const target = await getUserById(userId);
      if (!target) return send(res, 404, { ok: false, error: 'Account not found.' });
      const why = accessRefusal(admin, target);
      if (why) return send(res, 403, { ok: false, error: why });
    }
    const tempPassword = makeTempPassword();
    const updated = await adminResetPassword(userId, hashPassword(tempPassword));
    if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
    return send(res, 200, { ok: true, user: updated, tempPassword });
  } catch (e) {
    console.error('[admin/reset-password]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reset the password.' });
  }
}
