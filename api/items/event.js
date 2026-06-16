// POST /api/items/event  { vin, type, details }  ->  { ok, item, events }
// Adds a history event to an item (status change, note, or issue).
import { getJsonBody, send, applySecurity, rateLimit, requireAuth } from '../_lib/util.js';
import { getItemByVin, addItemEvent, acquireLock, releaseLock, dbConfigured } from '../_lib/db.js';
import { updateInventoryStatus, sheetsConfigured } from '../_lib/sheets.js';

const TYPES = ['status_change', 'note', 'issue', 'moved'];
const STATUSES = ['in_stock', 'sold', 'returned', 'missing', 'issue'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
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
  if (type === 'status_change' && !STATUSES.includes(details.status))
    return send(res, 400, { ok: false, error: 'Invalid status.' });
  if (details.text) details.text = String(details.text).slice(0, 1000);
  if (details.note) details.note = String(details.note).slice(0, 1000);

  try {
    const found = await getItemByVin(vin);
    if (!found) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    await addItemEvent({ itemId: found.item.id, type, details, createdBy: user.name || user.username || '' });

    // Keep the Inventory tab's Status cell in sync (best-effort; DB is truth).
    if (type === 'status_change' && sheetsConfigured()) {
      const locked = await acquireLock('sheet:write', { waitMs: 8000 }).catch(() => false);
      if (locked) {
        try { await updateInventoryStatus(vin, details.status); }
        catch (e) { console.warn('[items/event] inventory sync:', e.message); }
        finally { await releaseLock('sheet:write'); }
      }
    }

    const updated = await getItemByVin(vin);
    return send(res, 200, { ok: true, ...updated });
  } catch (e) {
    console.error('[items/event]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record the event.' });
  }
}
