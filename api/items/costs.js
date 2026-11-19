// GET /api/items/costs?from&to&mode&supplier&all
//                                -> { ok, rows, suppliers, total } — cost backlog. mode=zero
//                                   lists pairs recorded as $0 (review) instead of blanks.
//                                   supplier = one supplier's pairs ("(none)" = no supplier);
//                                   suppliers/total are counted over the whole range, so the
//                                   page can say when `rows` (newest 5,000) is not all of it.
//                                   all=1 = the export: up to 50,000 rows.
// GET /api/items/costs?q=<code>  -> { ok, rows } — every unit of the SKU behind a
//                                   VIN / UPC / SKU, costed or not (fix a wrong one)
// Powers the Costs page. Admin + warehouse + PH: suppliers leave cost off the
// manifest often enough that whoever notices should be able to fill it in.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listItemsMissingCost, listCostBacklogSuppliers, listItemCostsByCode, COST_NO_SUPPLIER, dbConfigured } from '../_lib/db.js';

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
    if (q) return send(res, 200, { ok: true, rows: await listItemCostsByCode(q) });
    const supplier = (url.searchParams.get('supplier') || '').trim().slice(0, 200) || null;
    const all = url.searchParams.get('all') === '1';
    const [rows, suppliers] = await Promise.all([
      listItemsMissingCost(from, to, zero, { supplier, limit: all ? 50000 : 5000 }),
      listCostBacklogSuppliers(from, to, zero),
    ]);
    const want = supplier ? supplier.toLowerCase() : null;
    const total = suppliers
      .filter((s) => !want || (want === COST_NO_SUPPLIER ? s.value === COST_NO_SUPPLIER : s.value.toLowerCase() === want))
      .reduce((n, s) => n + s.pairs, 0);
    return send(res, 200, { ok: true, rows, suppliers, total });
  } catch (e) {
    console.error('[items/costs]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load costs.' });
  }
}
