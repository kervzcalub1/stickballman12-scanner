// GET /api/po/suppliers  (ph_team / admin)
// Approved supplier accounts, for the "create PO" supplier picker.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { listSupplierUsers, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const suppliers = await listSupplierUsers();
    return send(res, 200, { ok: true, suppliers });
  } catch (e) {
    console.error('[po/suppliers]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load suppliers.' });
  }
}
