// GET /api/admin/users  ->  { ok, users }   (admin only)
// Lists accounts for the "Check Access" screen (pending first).

import { send, applySecurity, requireAdmin } from '../_lib/util.js';
import { listUsers, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  try {
    const users = await listUsers();
    return send(res, 200, { ok: true, users });
  } catch (e) {
    console.error('[admin/users]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load accounts.' });
  }
}
