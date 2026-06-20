// POST /api/admin/review  (admin only)
//   { userId, decision: 'approve' | 'reject' | 'role' | 'delete', role? }
// Approves/rejects a pending account, changes its role, or deletes it.

import { getJsonBody, send, applySecurity, requireAdmin } from '../_lib/util.js';
import { reviewUser, setUserRole, deleteUser, dbConfigured } from '../_lib/db.js';

const ROLES = ['warehouse', 'ph_team', 'admin'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const admin = requireAdmin(req, res);
  if (!admin) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Accounts are not configured.' });

  const body = await getJsonBody(req);
  const userId = parseInt(body.userId, 10);
  const decision = body.decision;
  if (!Number.isInteger(userId)) return send(res, 400, { ok: false, error: 'Provide a userId.' });

  try {
    if (decision === 'delete') {
      const ok = await deleteUser(userId);
      if (!ok) return send(res, 404, { ok: false, error: 'Account not found.' });
      return send(res, 200, { ok: true, deleted: userId });
    }
    if (decision === 'role') {
      if (!ROLES.includes(body.role)) return send(res, 400, { ok: false, error: 'Invalid role.' });
      const updated = await setUserRole(userId, body.role, admin.name || 'admin');
      if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
      return send(res, 200, { ok: true, user: updated });
    }
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : null;
    if (!status) return send(res, 400, { ok: false, error: 'Provide a valid decision (approve/reject/role/delete).' });
    const updated = await reviewUser(userId, status, admin.name || 'admin');
    if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
    return send(res, 200, { ok: true, user: updated });
  } catch (e) {
    console.error('[admin/review]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the account.' });
  }
}
