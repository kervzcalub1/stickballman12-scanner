// GET /api/expected  ->  { ok, boxes, online }
//
// What the warehouse should expect, from suppliers and from online stores. Every box still on
// its way plus every online order not yet counted in. Read-only and courier-free: the tracking
// webhook has already written all of this, so opening it costs one query and no quota. Sorting
// into days and groups lives in `src/lib/expected.js`, so the Home card and this screen agree.
import { send, applySecurity, rateLimit, requireRole } from './_lib/util.js';
import { listExpectedShipments, dbConfigured } from './_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    return send(res, 200, { ok: true, ...(await listExpectedShipments()) });
  } catch (e) {
    console.error('[expected]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load what is expected.' });
  }
}
