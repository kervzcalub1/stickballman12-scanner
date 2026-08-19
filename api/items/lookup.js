// GET /api/items/lookup?code=SB-100001  ->  { ok, item, events }
// Resolves an internal barcode / VIN to its item + full history.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { getItemByVin, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // PH team reads item detail + history from the Inventory page (read-only).
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const raw = new URL(req.url, 'http://x').searchParams.get('code') || '';
  const vin = raw.trim().toUpperCase();
  if (!vin) return send(res, 400, { ok: false, error: 'Provide a code.' });

  try {
    const data = await getItemByVin(vin);
    if (!data) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[items/lookup]', e.message);
    return send(res, 500, { ok: false, error: 'Lookup failed.' });
  }
}
