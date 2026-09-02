// POST /api/presell/release  (warehouse / admin)  { batchId }
//
// "Submit a rescale" — send what is left over for listing.
//
// Clearing `pre_sell` and setting `restock_pending` puts the leftovers on PH's Rescale
// Stock worklist, which is already where stock gets priced and pushed to II and the
// stores. Nothing new had to be invented for "subject for upload"; that worklist is it.
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
  try {
    const r = await releasePreSell({ batchId, createdBy: user.name || user.username || '' });
    if (!r.released) return send(res, 409, { ok: false, error: 'Nothing left to release — every unit on this shipment is already spoken for.' });
    return send(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error('[presell/release]', e.message);
    return send(res, 500, { ok: false, error: 'Could not release those units.' });
  }
}
