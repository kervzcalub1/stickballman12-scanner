// GET /api/batches/filter-options -> { ok, suppliers, poCodes }
// What the Batch page's filters can offer: suppliers that appear on a batch, and orders
// that have one linked. PH reads this too, filtered the same way the list is — offering
// them an in-store supplier would leak the existence of stock they must not see.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { batchFilterOptions, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  try {
    const out = await batchFilterOptions({ phSafe: user.role === 'ph_team' });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[batches/filter-options]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load filter options.' });
  }
}
