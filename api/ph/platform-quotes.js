// GET /api/ph/platform-quotes?skus=A,B,C[&consigned=0]
//   -> { ok, quotes: [{ sku, size, alias, stockx, stockxInexact, fetched_at }] }
//
// What the market last said about these styles — the Alias / StockX lowest asks that
// api/payout/batch.js remembered (platform_quotes), no older than 12 hours. Reads the
// DB only: it never calls Alias or StockX, so the New Inventory chip can ask about every
// line on screen for free and price only the ones nobody has looked at lately.
// PH + admin, like every other pricing surface.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getPlatformQuotes } from '../_lib/db.js';

const MAX_SKUS = 400;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const params = new URL(req.url, 'http://x').searchParams;
  const skus = String(params.get('skus') || '').split(',').map((x) => x.trim().slice(0, 40)).filter(Boolean).slice(0, MAX_SKUS);
  const consigned = params.get('consigned') !== '0';   // PH prices consigned
  try {
    const rows = await getPlatformQuotes(skus, consigned);
    return send(res, 200, {
      ok: true,
      quotes: rows.map((r) => ({
        sku: r.sku, size: r.size,
        alias: r.alias_ask == null ? null : Number(r.alias_ask),
        stockx: r.stockx_ask == null ? null : Number(r.stockx_ask),
        stockxInexact: !!r.stockx_inexact, fetched_at: r.fetched_at,
      })),
    });
  } catch (e) {
    // Before db:setup has created the table: no remembered prices, not a broken page.
    if (/platform_quotes/.test(e.message)) return send(res, 200, { ok: true, quotes: [] });
    console.error('[ph/platform-quotes]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load market prices.' });
  }
}
