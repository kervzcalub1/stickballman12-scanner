// POST /api/po/reconcile  (warehouse / admin)  { poId }
// Freezes the current expected-vs-received comparison onto the PO
// (reconciliation JSONB + reconciled_at) and closes it out → status 'reconciled'.
// Allowed once the PO has been received against (status 'receiving').
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, snapshotReconciliation, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    if (po.status !== 'receiving')
      return send(res, 409, { ok: false, error: `PO ${po.po_code} is ${po.status} — only a PO being received can be reconciled.` });
    const data = await snapshotReconciliation(poId);
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[po/reconcile]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reconcile the purchase order.' });
  }
}
