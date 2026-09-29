// GET /api/ph/platform-profit
//   -> { ok, rows:[{ sku, size, name, qty, costed, cost, cost_min, cost_max, shelf, suppliers }] }
//
// The stock half of the Platform Profit report: every SKU + size PH still has to sell,
// with what those pairs landed at. The MARKET half (Alias / StockX lowest ask) is priced
// by the screen through api/payout/batch.js, a page of styles at a time — one StockX
// call per size against a shared daily quota means "price everything on load" would be
// thousands of calls every time someone opened the page. Read-only.
// PH + admin, like every other pricing surface (the warehouse doesn't set prices).
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, listPlatformProfitStock } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  try {
    const rows = await listPlatformProfitStock();
    return send(res, 200, {
      ok: true,
      rows: rows.map((r) => ({
        sku: r.sku, size: r.size, name: r.name, qty: r.qty, costed: r.costed,
        cost: r.cost == null ? null : Number(r.cost),
        cost_min: r.cost_min == null ? null : Number(r.cost_min),
        cost_max: r.cost_max == null ? null : Number(r.cost_max),
        shelf: r.shelf == null ? null : Number(r.shelf),
        suppliers: r.suppliers || '',
      })),
    });
  } catch (e) {
    console.error('[ph/platform-profit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the stock list.' });
  }
}
