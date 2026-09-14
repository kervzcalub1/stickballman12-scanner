// POST /api/batches/reopen-box  { batchId, boxId } -> { ok, reopenedBatch, box, boxes }
// Reopens a SUBMITTED box of a receiving batch so more pairs can be scanned into it —
// "I submitted box 3, then found two more pairs in it". Before this the only route was
// "+ Add box", which filed those pairs as a box that doesn't exist on the carton. The
// box goes back to pending with its pairs intact; the batch reopens with it if the
// submission had finished it.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { reopenBatchBox, getBatchWithBoxes, dbConfigured, SHIPMENT_KINDS } from '../_lib/db.js';

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
  if (!Number.isInteger(batchId) || !Number.isInteger(boxId))
    return send(res, 400, { ok: false, error: 'A valid batchId and boxId are required.' });

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found || !SHIPMENT_KINDS.includes(found.batch.kind)) return send(res, 404, { ok: false, error: 'Batch not found.' });
    const result = await reopenBatchBox(batchId, boxId);
    if (result.error) return send(res, 409, { ok: false, error: result.error });
    return send(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error('[batches/reopen-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reopen the box.' });
  }
}
