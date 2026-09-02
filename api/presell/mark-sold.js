// POST /api/presell/mark-sold  (warehouse / admin)
//   { batchId, sku, size, qty }   — how many of that row are covered by an order
//   { vin }                       — or name one unit, scanned
//
// Both land on the same end state: the unit's status becomes `pre_sold`. NOT `sold` —
// the pair is still on our floor and hasn't shipped. It reaches sold/shipped through the
// normal scan when it actually leaves, and `sold` is terminal here, so claiming it early
// would strand the unit if the pre-sale collapsed.
//
// The count path is the fast one (a row of identical, unshelved pairs — which VIN carries
// which order is not a decision anybody needs to make); the scan path names the pair.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { setPreSellSold, markPreSoldByVin, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const createdBy = user.name || user.username || '';
  const vin = String(body.vin ?? '').trim();

  try {
    if (vin) {
      const r = await markPreSoldByVin(vin, createdBy);
      if (r.error) return send(res, 409, { ok: false, error: r.error });
      return send(res, 200, { ok: true, ...r });
    }
    const batchId = Number(body.batchId);
    const sku = String(body.sku ?? '').trim();
    const size = String(body.size ?? '').trim();
    const qty = Number(body.qty);
    if (!Number.isInteger(batchId) || !sku) return send(res, 400, { ok: false, error: 'A shipment and SKU are required.' });
    if (!Number.isInteger(qty) || qty < 0) return send(res, 400, { ok: false, error: 'How many are sold?' });
    return send(res, 200, { ok: true, ...(await setPreSellSold({ batchId, sku, size, qty, createdBy })) });
  } catch (e) {
    console.error('[presell/mark-sold]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that.' });
  }
}
