// GET /api/items/costs?from&to&mode -> { ok, rows } — cost backlog. mode=zero lists
//                                   pairs recorded as $0 (review) instead of blanks
// GET /api/items/costs?q=<code>  -> { ok, rows } — every unit of the SKU behind a
//                                   VIN / UPC / SKU, costed or not (fix a wrong one)
// Powers the Costs page. Admin + warehouse + PH: suppliers leave cost off the
// manifest often enough that whoever notices should be able to fill it in.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listItemsMissingCost, listItemCostsByCode, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim();
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;
  const zero = url.searchParams.get('mode') === 'zero';

  try {
    const rows = q ? await listItemCostsByCode(q) : await listItemsMissingCost(from, to, zero);
    return send(res, 200, { ok: true, rows });
  } catch (e) {
    console.error('[items/costs]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load costs.' });
  }
}
