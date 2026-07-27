// POST /api/batches/set-status  { id, status:'open'|'done' } -> { ok }
// Manually finish ('done' → committed) or reopen ('open') a multi-box batch —
// staff override of the auto-complete. (V6 Feature 7)
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { setBatchStatus, getBatchWithBoxes, autoReconcileIfClean, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id);
  const status = body.status === 'open' ? 'open' : 'done';
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid id is required.' });
  try {
    const found = await getBatchWithBoxes(id);
    if (!found || found.batch.kind !== 'receiving') return send(res, 404, { ok: false, error: 'Batch not found.' });
    await setBatchStatus(id, status);
    // Finishing a batch by hand is the same signal as auto-complete: if the PO came
    // out clean it closes itself instead of parking in the reconcile queue.
    if (status === 'done' && found.batch.po_id) {
      await autoReconcileIfClean(Number(found.batch.po_id))
        .catch((e) => console.warn('[batches/set-status] auto-reconcile skipped:', e.message));
    }
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[batches/set-status]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the batch.' });
  }
}
