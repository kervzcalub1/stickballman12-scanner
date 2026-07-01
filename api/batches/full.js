// GET /api/batches/full?id=… -> { ok, batch, boxes, items }
// Batch Page view: the batch row + its boxes (with received item counts) + every
// item (grouped by box on the client, VIN → history). (Feature 7)
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBatchWithBoxes, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid id is required.' });
  try {
    const found = await getBatchWithBoxes(id);
    if (!found) return send(res, 404, { ok: false, error: 'Batch not found.' });
    return send(res, 200, { ok: true, batch: found.batch, boxes: found.boxes, items: found.items });
  } catch (e) {
    console.error('[batches/full]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the batch.' });
  }
}
