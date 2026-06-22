// POST /api/items/box-found { vin } -> { ok, item, events }
// A no-box unit got a box: mark with_box=true + status needs_shelf (now sellable).
// Warehouse/admin only.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getItemByVin, markBoxFound, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vin = String(body.vin || '').trim().toUpperCase();
  if (!vin) return send(res, 400, { ok: false, error: 'Missing VIN.' });

  try {
    const found = await getItemByVin(vin);
    if (!found) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    await markBoxFound(found.item.id, user.name || user.username || '');
    const updated = await getItemByVin(vin);
    return send(res, 200, { ok: true, ...updated });
  } catch (e) {
    console.error('[items/box-found]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the item.' });
  }
}
