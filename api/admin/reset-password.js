// POST /api/admin/reset-password  (admin / superadmin)
//   { userId }  ->  { ok, user, tempPassword }
// Generates a random temporary password for a DB account, stores only its hash,
// and returns the plaintext ONCE so the admin can relay it to the user. The user
// can keep using it (no forced change — plain reset). The env admin/superadmin
// accounts have no DB row and cannot be reset here.

import crypto from 'node:crypto';
import { getJsonBody, send, applySecurity, requireAdmin, rateLimit, hashPassword } from '../_lib/util.js';
import { setUserPassword, dbConfigured } from '../_lib/db.js';

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
  const admin = requireAdmin(req, res);
  if (!admin) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  const body = await getJsonBody(req);
  const userId = parseInt(body.userId, 10);
  if (!Number.isInteger(userId)) return send(res, 400, { ok: false, error: 'Provide a userId.' });

  try {
    const tempPassword = makeTempPassword();
    const updated = await setUserPassword(userId, hashPassword(tempPassword));
    if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
    return send(res, 200, { ok: true, user: updated, tempPassword });
  } catch (e) {
    console.error('[admin/reset-password]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reset the password.' });
  }
}
