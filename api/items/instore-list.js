// GET /api/items/instore-list?from=YYYY-MM-DD&to=YYYY-MM-DD  ->  { ok, rows }
// The In-Store Listing worklist: sellable in-store pairs + their per-store listing
// flags (Alias/StockX/Shopify), for admin/warehouse to track manual store listing.
// In-store bypasses the PH team, so this is a warehouse/admin-only surface.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listInstoreItems, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // admin (auto-allowed) + warehouse only; ph_team is blocked (in-store isn't theirs).
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const p = new URL(req.url, 'http://x').searchParams;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  const from = isDate(p.get('from')) ? p.get('from') : null;
  const to = isDate(p.get('to')) ? p.get('to') : null;

  try {
    const rows = await listInstoreItems(from, to);
    return send(res, 200, { ok: true, rows });
  } catch (e) {
    console.error('[items/instore-list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the in-store listing worklist.' });
  }
}
