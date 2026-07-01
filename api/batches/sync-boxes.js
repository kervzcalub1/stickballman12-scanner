// POST /api/batches/sync-boxes  { batchId, boxes:[{ boxNumber, trackingNumber }] }
//   -> { ok, boxes }
// Persists a multi-box batch's box slots (box number + tracking) WITHOUT
// committing items, so every expected box — including empty ones and ones with
// only a tracking number scanned — shows on the Batch page. Received boxes are
// left untouched. Warehouse/admin, open receiving batches only. (V6 Feature 7)
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBatchWithBoxes, syncBatchBoxes, dbConfigured } from '../_lib/db.js';

const MAX_BOXES = 500;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const batchId = Number(body.batchId);
  const boxes = (Array.isArray(body.boxes) ? body.boxes : [])
    .map((b) => ({ boxNumber: Number(b?.boxNumber), trackingNumber: String(b?.trackingNumber ?? '').trim().slice(0, 120) }))
    .filter((b) => Number.isInteger(b.boxNumber) && b.boxNumber > 0);
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });
  if (boxes.length > MAX_BOXES) return send(res, 400, { ok: false, error: `Too many boxes (max ${MAX_BOXES}).` });

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found || found.batch.kind !== 'receiving') return send(res, 404, { ok: false, error: 'Batch not found.' });
    if (found.batch.status !== 'open') return send(res, 409, { ok: false, error: 'This batch is already finished — reopen it to change boxes.' });
    const synced = await syncBatchBoxes(batchId, boxes, user.name || user.username || '');
    return send(res, 200, { ok: true, boxes: synced });
  } catch (e) {
    console.error('[batches/sync-boxes]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the boxes.' });
  }
}
