// POST /api/items/set-upc { vin, upc } -> { ok, item, events }
// Save a found/entered UPC onto a unit (used by the No Box box-label flow so the
// pair's box label scans normally). Warehouse/admin only.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getItemByVin, setItemUpc, dbConfigured } from '../_lib/db.js';

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
  const upc = String(body.upc || '').replace(/\D/g, '');
  if (!vin) return send(res, 400, { ok: false, error: 'Missing VIN.' });
  if (![8, 12, 13].includes(upc.length))
    return send(res, 400, { ok: false, error: 'Enter a valid 8-, 12-, or 13-digit UPC/EAN.' });

  try {
    const found = await getItemByVin(vin);
    if (!found) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    await setItemUpc(found.item.id, upc);
    const updated = await getItemByVin(vin);
    return send(res, 200, { ok: true, ...updated });
  } catch (e) {
    console.error('[items/set-upc]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the UPC.' });
  }
}
