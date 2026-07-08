// GET /api/po/reconciliation?poId=  (warehouse / ph_team / admin)
// The expected-vs-received table + summary for a PO (computed on demand). If the
// PO is already reconciled, the frozen snapshot is on the PO too (po.reconciliation).
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { getPoReconciliation, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const poId = Number(new URL(req.url, 'http://x').searchParams.get('poId'));
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    const data = await getPoReconciliation(poId);
    if (!data) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[po/reconciliation]', e.message);
    return send(res, 500, { ok: false, error: 'Could not compute the reconciliation.' });
  }
}
