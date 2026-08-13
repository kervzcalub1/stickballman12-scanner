// GET /api/po/link-candidates?poId=[&batchId=]  (warehouse / ph_team / admin)
// Which already-received batches could BE this order's shipment — same supplier, or a
// tracking number matching one of its labels. With `batchId`, also returns that batch's
// boxes pre-matched to the order's labels, which is what the link screen confirms.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listPoLinkCandidates, getPoLinkPreview, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const params = new URL(req.url, 'http://x').searchParams;
  const poId = Number(params.get('poId'));
  const batchId = params.get('batchId') ? Number(params.get('batchId')) : null;
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid poId is required.' });
  if (batchId != null && !Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'Invalid batchId.' });

  try {
    const batches = await listPoLinkCandidates(poId);
    const preview = batchId ? await getPoLinkPreview(poId, batchId) : null;
    return send(res, 200, { ok: true, batches, preview });
  } catch (e) {
    console.error('[po/link-candidates]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load candidate batches.' });
  }
}
