// POST /api/items/rescale  { vin, status, note, reason }  ->  { ok, item, events }
// Re-scans an EXISTING in-hand unit by its VIN: appends a 'rescaled' event and a
// 'status_change' to the item's OWN history (no new VIN), keeping one continuous
// timeline per physical shoe. Used by the Rescale wizard when a VIN is scanned;
// genuinely new/unlabeled stock (scanned by UPC/SKU) still goes through batch
// commit. Warehouse/admin only.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getItemByVin, rescaleItem, dbConfigured } from '../_lib/db.js';
import { normalizeStatus } from '../_lib/statuses.js';

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

  // Status is required for a rescale (the warehouse picks the new status per unit).
  const status = normalizeStatus(body.status);
  if (!status) return send(res, 400, { ok: false, error: 'Pick a valid status for the rescanned unit.' });
  const note = body.note ? String(body.note).slice(0, 1000) : null;
  const reason = body.reason ? String(body.reason).slice(0, 80) : null;

  try {
    const found = await getItemByVin(vin);
    if (!found) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    await rescaleItem({ itemId: found.item.id, status, note, reason, createdBy: user.name || user.username || '' });

    const updated = await getItemByVin(vin);
    return send(res, 200, { ok: true, ...updated });
  } catch (e) {
    console.error('[items/rescale]', e.message);
    return send(res, 500, { ok: false, error: 'Could not rescale the item.' });
  }
}
