// POST /api/items/instore-listed  { vins:[...], alias, stockx, shopify }  ->  { ok, rows }
// Sets the per-store listing flags on in-store units (the whole desired triple is
// sent, so toggling one store is race-free). admin/warehouse only; the db layer
// guards to kind='instore' so these flags can never land on other stock.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { setInstoreListed, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = (Array.isArray(body.vins) ? body.vins : [])
    .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean).slice(0, 2000);
  if (!vins.length) return send(res, 400, { ok: false, error: 'No units to update.' });

  const flags = { alias: Boolean(body.alias), stockx: Boolean(body.stockx), shopify: Boolean(body.shopify) };
  try {
    const rows = await setInstoreListed(vins, flags, user.name || user.username || '');
    return send(res, 200, { ok: true, rows });
  } catch (e) {
    console.error('[items/instore-listed]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the listing status.' });
  }
}
