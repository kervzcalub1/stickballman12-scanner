// GET /api/po/get?id=  — full PO (header + labels + expected lines).
// A supplier is restricted to their own POs; staff/admin see any.
import { send, applySecurity, requireRole, isPrivileged } from '../_lib/util.js';
import { getPoFull, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team', 'warehouse', 'supplier']);
  if (!user) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid id is required.' });

  try {
    const data = await getPoFull(id);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (user.role === 'supplier' && !isPrivileged(user.role)
        && Number(data.po.supplier_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this order.' });
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[po/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the purchase order.' });
  }
}
