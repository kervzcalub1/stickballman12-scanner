// POST /api/batches/set-expected  { batchId, expectedBoxes } -> { ok, from, to, removed, boxes }
// Corrects how many boxes a receiving batch expects — the "130" typed at Step 1 for a
// shipment of 30. Lowering it also removes the empty pending box slots above the new
// count; a box with pairs, a tracking number or a PO label is never removed
// (setBatchExpectedBoxes). Warehouse/admin, open or finished batches alike.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { setBatchExpectedBoxes, getBatchWithBoxes, dbConfigured, SHIPMENT_KINDS } from '../_lib/db.js';

// Same ceiling create-open puts on the number at Step 1.
const MAX_EXPECTED = 999;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const batchId = Number(body.batchId);
  const expected = Number(body.expectedBoxes);
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });
  if (!Number.isInteger(expected) || expected < 1 || expected > MAX_EXPECTED)
    return send(res, 400, { ok: false, error: `Enter a whole number of boxes between 1 and ${MAX_EXPECTED}.` });

  try {
    const found = await getBatchWithBoxes(batchId);
    if (!found || !SHIPMENT_KINDS.includes(found.batch.kind)) return send(res, 404, { ok: false, error: 'Batch not found.' });
    const result = await setBatchExpectedBoxes(batchId, expected);
    if (result.error) return send(res, 409, { ok: false, error: result.error });
    // There is no per-batch change log; this line is the record of who changed it.
    console.log(`[batches/set-expected] ${found.batch.batch_code}: expected boxes ${result.from ?? '—'} → ${result.to}, `
      + `${result.removed} empty slot(s) removed, by ${user.username || user.name || user.id}`);
    return send(res, 200, { ok: true, ...result });
  } catch (e) {
    console.error('[batches/set-expected]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change the expected boxes.' });
  }
}
