// GET /api/batches/full?id=… -> { ok, batch, boxes, items, issues, onlineOrder }
// Batch Page view: the batch row + its boxes (with received item counts) + every
// item (grouped by box on the client, VIN → history). (Feature 7)
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBatchWithBoxes, getBatchOnlineOrder, dbConfigured, PH_EXCLUDED_KINDS } from '../_lib/db.js';
import { orderCode } from '../../src/lib/onlineOrders.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid id is required.' });
  try {
    const found = await getBatchWithBoxes(id);
    if (!found) return send(res, 404, { ok: false, error: 'Batch not found.' });
    // The list is filtered for PH, so this must be too — otherwise an id typed into the
    // URL walks straight past it. 404, not 403: whether an in-store batch exists is
    // itself something the PH team doesn't see.
    if (user.role === 'ph_team' && PH_EXCLUDED_KINDS.includes(found.batch?.kind))
      return send(res, 404, { ok: false, error: 'Batch not found.' });
    // The online order this batch is: linked by hand, else the one its tracking number is
    // on. Its own try — before db:setup adds the link column the page must still open.
    let onlineOrder = null;
    try {
      const o = await getBatchOnlineOrder(id);
      if (o) onlineOrder = { ...o, code: orderCode(o.id) };
    } catch (e) { console.warn('[batches/full] online order:', e.message); }
    return send(res, 200, { ok: true, batch: found.batch, boxes: found.boxes, items: found.items, issues: found.issues || [], onlineOrder });
  } catch (e) {
    console.error('[batches/full]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the batch.' });
  }
}
