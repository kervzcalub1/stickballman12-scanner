// POST /api/presell/release  (warehouse / admin)  { batchId, sku?, size?, reason? }
//
// Free held units for listing — the leftovers of a fulfilled pre-sale, or a shoe that
// was never pre-sell at all and was marked by mistake.
//
// `sku` (with an optional `size`) narrows it to one shoe. That scope is what makes the
// common mistake fixable: a shipment where one of fifteen SKUs is spoken for used to
// hold all fifteen, and whole-batch release could only free them by freeing the real one
// too. `reason: 'not_presell'` is recorded on each unit — "the order was fulfilled and
// this is the overage" and "this was never pre-sell" are different stories.
//
// They land on PH's NEW INVENTORY, dated by the day they were freed (pre-sell.md).
//
// Units already marked pre_sold are left alone — they are spoken for, and listing one
// would offer somebody else's pair for sale.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { releasePreSell, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const batchId = Number(body.batchId);
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'A valid shipment is required.' });
  const sku = String(body.sku ?? '').trim().slice(0, 60) || null;
  const size = sku ? (String(body.size ?? '').trim().slice(0, 24) || null) : null;
  const reason = body.reason === 'not_presell' ? 'not_presell' : null;
  try {
    const r = await releasePreSell({ batchId, sku, size, reason, createdBy: user.name || user.username || '' });
    if (!r.released) return send(res, 409, { ok: false, error: sku
      ? 'Nothing to free there — those pairs are already listed or spoken for.'
      : 'Nothing left to release — every unit on this shipment is already spoken for.' });
    return send(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error('[presell/release]', e.message);
    return send(res, 500, { ok: false, error: 'Could not release those units.' });
  }
}
