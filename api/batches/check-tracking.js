// GET /api/batches/check-tracking?tracking=...&exceptBatch=ID -> { ok, exists, batchCode, batchId, supplier }
// Non-blocking lookup so the receiving screen can warn when a tracking number
// was already received (supplier error / unexpected reshipment). The duplicate
// can still be committed — it just gets flagged via batches.duplicate_of, and the server
// logs it in tracking_duplicates when the package is committed (receiving.md).
// `exceptBatch`: the open batch a box slot belongs to — its own boxes are this receive,
// not an earlier one (the screen compares its slots with each other itself).
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { findBatchByTracking, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const params = new URL(req.url, 'http://x').searchParams;
  const tracking = params.get('tracking') || '';
  const except = Number(params.get('exceptBatch'));
  try {
    const match = await findBatchByTracking(tracking, { exceptBatchId: Number.isSafeInteger(except) && except > 0 ? except : null });
    return send(res, 200, {
      ok: true,
      exists: Boolean(match),
      batchCode: match?.batch_code || null,
      batchId: match?.id || null,
      supplier: match?.supplier_name || null,
    });
  } catch (e) {
    console.error('[batches/check-tracking]', e.message);
    return send(res, 500, { ok: false, error: 'Could not check the tracking number.' });
  }
}
