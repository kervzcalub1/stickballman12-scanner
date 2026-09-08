// GET /api/items/pending-counts -> { ok, counts:{ not_ii, not_alias, not_stockx,
//   not_shopify, needs_shelf, no_box, restock_pending, carts_to_approve, … } }
// Powers the home-screen pending badges. Readable by all signed-in staff.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { pendingCounts, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const counts = await pendingCounts();
    return send(res, 200, { ok: true, counts });
  } catch (e) {
    console.error('[items/pending-counts]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load counts.' });
  }
}
