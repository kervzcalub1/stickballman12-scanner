// GET /api/items/box-stock?sku=&size=  (warehouse / ph_team / admin)
//   -> { ok, rows: [{ sku, name, size, dimensions, qty, shelved, locations[] }] }
// "I need a box for a size 10.5 Panda" — what empty shoe boxes we hold, grouped the way
// somebody actually asks for one. Boxes already used on a pair are gone from this count.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { boxStockOnHand, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // ph_team is allowed to LOOK: they field the "is there a box for this" question from
  // the listing side. They can't receive one or spend one — those are warehouse writes.
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const url = new URL(req.url, 'http://x');
  const sku = String(url.searchParams.get('sku') || '').trim() || null;
  const size = String(url.searchParams.get('size') || '').trim() || null;
  try {
    return send(res, 200, { ok: true, rows: await boxStockOnHand({ sku, size }) });
  } catch (e) {
    console.error('[items/box-stock]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the box stock.' });
  }
}
