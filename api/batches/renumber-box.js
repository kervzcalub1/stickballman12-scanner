// POST /api/batches/renumber-box  { batchId, boxId, boxNumber } -> { ok, absorbed, boxes }
// Corrects the number on a box of a receiving batch — for the box that arrived out of
// order and got recorded as "box 10" when the label on it says 6. Received boxes can be
// renumbered too: that's when the mismatch is usually spotted.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { renumberBatchBox, getBatchWithBoxes, dbConfigured, SHIPMENT_KINDS } from '../_lib/db.js';

const MAX_BOX_NUMBER = 999;

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
  const boxId = Number(body.boxId);
  const boxNumber = Number(body.boxNumber);
  if (!Number.isInteger(batchId) || !Number.isInteger(boxId))
    return send(res, 400, { ok: false, error: 'A valid batchId and boxId are required.' });
  if (!Number.isInteger(boxNumber) || boxNumber < 1 || boxNumber > MAX_BOX_NUMBER)
    return send(res, 400, { ok: false, error: `Enter a box number between 1 and ${MAX_BOX_NUMBER}.` });

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found || !SHIPMENT_KINDS.includes(found.batch.kind)) return send(res, 404, { ok: false, error: 'Batch not found.' });
    const result = await renumberBatchBox(batchId, boxId, boxNumber);
    if (result.error) return send(res, 409, { ok: false, error: result.error });
    return send(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error('[batches/renumber-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not renumber the box.' });
  }
}
