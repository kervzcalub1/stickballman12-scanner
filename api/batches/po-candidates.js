// GET /api/batches/po-candidates?batchId=  (warehouse / ph_team / admin)
// Which purchase orders this already-received batch could belong to — the Batch page's
// half of "link a received shipment". Orders carrying one of the batch's tracking numbers
// come first (with the labels that matched); open orders from the same supplier follow.
// The link itself goes through POST /api/po/link-batch, same guards as from the order side.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listBatchPoCandidates, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const batchId = Number(new URL(req.url, 'http://x').searchParams.get('batchId'));
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });

  try {
    const r = await listBatchPoCandidates(batchId);
    if (!r) return send(res, 404, { ok: false, error: 'Batch not found.' });
    return send(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error('[batches/po-candidates]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load candidate purchase orders.' });
  }
}
