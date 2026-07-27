// GET /api/po/list
// ph_team / warehouse / admin see all POs; a supplier sees only their own.
import { send, applySecurity, requireRole, isPrivileged } from '../_lib/util.js';
import { listPos, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team', 'warehouse', 'supplier']);
  if (!user) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const supplierScope = user.role === 'supplier' && !isPrivileged(user.role);
    const pos = await listPos({ uid: Number(user.uid), supplierScope });
    // A supplier reads the reconciliation note but never which staff member wrote it
    // (same rule as po/get and the on-behalf line attribution).
    if (supplierScope) {
      return send(res, 200, { ok: true, pos: pos.map(({ reconcile_note_by, ...p }) => p) });
    }
    return send(res, 200, { ok: true, pos });
  } catch (e) {
    console.error('[po/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load purchase orders.' });
  }
}
