// POST /api/items/event  { vin, type, details }  ->  { ok, item, events }
// Adds a history event to an item (status change, note, or issue).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getItemByVin, addItemEvent, dbConfigured } from '../_lib/db.js';
import { normalizeStatus } from '../_lib/statuses.js';

const TYPES = ['status_change', 'note', 'issue', 'moved'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vin = String(body.vin || '').trim().toUpperCase();
  const type = String(body.type || '');
  const details = body.details && typeof body.details === 'object' ? body.details : {};

  if (!vin) return send(res, 400, { ok: false, error: 'Missing VIN.' });
  if (!TYPES.includes(type)) return send(res, 400, { ok: false, error: 'Invalid event type.' });
  if (type === 'status_change') {
    // Accept a preset key OR a sanitized custom tag (free text from the detail view).
    const norm = normalizeStatus(details.status);
    if (!norm) return send(res, 400, { ok: false, error: 'Invalid status.' });
    details.status = norm;
  }
  if (details.text) details.text = String(details.text).slice(0, 1000);
  if (details.note) details.note = String(details.note).slice(0, 1000);

  try {
    const found = await getItemByVin(vin);
    if (!found) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    // Invariant: "In Stock" means physically on a shelf. Setting it manually on an
    // unshelved unit is rejected — "Move to shelf" is the path (it sets in_stock).
    if (type === 'status_change' && details.status === 'in_stock' && !found.item.location_id)
      return send(res, 409, { ok: false, error: "This unit isn't on a shelf yet — use “Move to shelf” to place it, which also marks it In Stock." });
    await addItemEvent({ itemId: found.item.id, type, details, createdBy: user.name || user.username || '' });

    const updated = await getItemByVin(vin);
    return send(res, 200, { ok: true, ...updated });
  } catch (e) {
    console.error('[items/event]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record the event.' });
  }
}
