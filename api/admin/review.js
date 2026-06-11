// POST /api/admin/review  { userId, decision: 'approve' | 'reject' }  (admin only)
// Approves or rejects a pending account.

import { getJsonBody, send, applySecurity, requireAdmin } from '../_lib/util.js';
import { reviewUser, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const admin = requireAdmin(req, res);
  if (!admin) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  const body = await getJsonBody(req);
  const userId = parseInt(body.userId, 10);
  const status =
    body.decision === 'approve' ? 'approved' :
    body.decision === 'reject' ? 'rejected' : null;

  if (!Number.isInteger(userId) || !status)
    return send(res, 400, { ok: false, error: 'Provide a userId and decision (approve/reject).' });

  try {
    const updated = await reviewUser(userId, status, admin.name || 'admin');
    if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
    return send(res, 200, { ok: true, user: updated });
  } catch (e) {
    console.error('[admin/review]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the account.' });
  }
}
