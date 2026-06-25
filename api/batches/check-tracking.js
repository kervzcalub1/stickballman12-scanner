// GET /api/batches/check-tracking?tracking=... -> { ok, exists, batchCode, batchId }
// Non-blocking lookup so the receiving screen can warn when a tracking number
// was already received (supplier error / unexpected reshipment). The duplicate
// can still be committed — it just gets flagged via batches.duplicate_of.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { findBatchByTracking, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const tracking = new URL(req.url, 'http://x').searchParams.get('tracking') || '';
  try {
    const match = await findBatchByTracking(tracking);
    return send(res, 200, {
      ok: true,
      exists: Boolean(match),
      batchCode: match?.batch_code || null,
      batchId: match?.id || null,
    });
  } catch (e) {
    console.error('[batches/check-tracking]', e.message);
    return send(res, 500, { ok: false, error: 'Could not check the tracking number.' });
  }
}
