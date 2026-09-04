// POST /api/admin/review  (admin only)
//   { userId, decision: 'approve' | 'reject' | 'role' | 'privileges' | 'delete', role?, privileges? }
// Approves/rejects a pending account, changes its role or its PRIVILEGES, or deletes it.
//
// Role and privileges are separate on purpose. A role is the one job somebody does; a
// privilege is a permission on top of it — the gift-card duties are held by a PH team
// member or an admin who ALSO does that, not instead of it. See docs/context/buy-cart.md.

import { getJsonBody, send, applySecurity, requireAdmin } from '../_lib/util.js';
import { reviewUser, setUserRole, setUserPrivileges, deleteUser, dbConfigured } from '../_lib/db.js';
import { PRIVILEGE_KEYS } from '../_lib/buycart.js';

// `supplier` = external scan-out partner (PO feature); admin-assignable, never at signup.
const ROLES = ['warehouse', 'ph_team', 'admin', 'supplier'];

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
    if (decision === 'privileges') {
      const wanted = Array.isArray(body.privileges) ? body.privileges : [];
      // Only privileges this server knows about, deduped. An unknown string in the
      // column would sit there forever looking like a permission somebody has.
      const clean = [...new Set(wanted.filter((k) => PRIVILEGE_KEYS.includes(k)))];
      const updated = await setUserPrivileges(userId, clean);
      if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
      // A supplier is external and holds none — setUserPrivileges enforces that, so say
      // so rather than letting the checkboxes silently spring back.
      if (updated.role === 'supplier' && clean.length)
        return send(res, 200, { ok: true, user: updated, note: 'Buyers can’t hold privileges — they would be approving their own requests.' });
      return send(res, 200, { ok: true, user: updated });
    }
    if (decision === 'role') {
      if (!ROLES.includes(body.role)) return send(res, 400, { ok: false, error: 'Invalid role.' });
      const updated = await setUserRole(userId, body.role, admin.name || 'admin');
      if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
      return send(res, 200, { ok: true, user: updated });
    }
    const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : null;
    if (!status) return send(res, 400, { ok: false, error: 'Provide a valid decision (approve/reject/role/privileges/delete).' });
    const updated = await reviewUser(userId, status, admin.name || 'admin');
    if (!updated) return send(res, 404, { ok: false, error: 'Account not found.' });
    return send(res, 200, { ok: true, user: updated });
  } catch (e) {
    console.error('[admin/review]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the account.' });
  }
}
