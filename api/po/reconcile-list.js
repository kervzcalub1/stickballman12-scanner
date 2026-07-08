// GET /api/po/reconcile-list  (warehouse / ph_team / admin)
// POs that have been received against — 'receiving' (awaiting reconcile) first,
// then 'reconciled' (done) — for the Reconciliation screen's list.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { listReconcilePos, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const pos = await listReconcilePos();
    return send(res, 200, { ok: true, pos });
  } catch (e) {
    console.error('[po/reconcile-list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load purchase orders.' });
  }
}
