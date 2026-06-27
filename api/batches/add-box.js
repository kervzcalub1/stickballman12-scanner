// POST /api/batches/add-box  { batchId, trackingNumber } -> { ok, box }
// Adds a physical box (its own tracking #) to an open multi-box batch. The box
// starts 'pending'; box-commit marks it received. (V6 Feature 7)
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { addBatchBox, getBatchWithBoxes, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const batchId = Number(body.batchId);
  const trackingNumber = String(body.trackingNumber ?? '').trim().slice(0, 120) || null;
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found || found.batch.kind !== 'receiving') return send(res, 404, { ok: false, error: 'Batch not found.' });
    if (found.batch.status !== 'open') return send(res, 409, { ok: false, error: 'This batch is already finished — reopen it to add a box.' });
    const box = await addBatchBox(batchId, { trackingNumber }, user.name || user.username || '');
    return send(res, 200, { ok: true, box });
  } catch (e) {
    console.error('[batches/add-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not add the box.' });
  }
}
