// GET /api/online-orders/get?id=N -> { ok, order, events, parcels, batches }
// One order with its lines, each pair's actual cost, and the history (created, edited,
// a line cancelled, a refund requested / received, counted in by the warehouse).
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getOnlineOrder, onlineOrderEvents, listOrderShipments, listOnlineOrderBatches, orderKey } from '../_lib/db.js';
import { shapeOrder, idOf } from './_shared.js';
import { trackKeys } from '../../src/lib/onlineOrders.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team', 'warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const id = idOf(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
  try {
    const o = await getOnlineOrder(id);
    if (!o) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
    const events = await onlineOrderEvents(id);
    // The parcels the store's shipping emails describe for this order number, and which
    // entry each one is on (by its tracking number).
    const ships = o.order_number ? await listOrderShipments(orderKey(o.order_number)) : [];
    const parcels = ships.map((s) => ({
      tracking_number: s.tracking_number, carrier: s.carrier, status: s.status, emailed_at: s.emailed_at,
      pairs: (s.items || []).reduce((n, it) => n + (Number(it.qty) || 0), 0), items: s.items || [],
      order_id: (o.same_order || []).find((x) => trackKeys(x.tracking_number).includes(s.tracking_key))?.id ?? null,
    }));
    // The batches linked to it by hand on the Batch page. Before db:setup: none, not an error.
    const batches = await listOnlineOrderBatches(id).catch(() => []);
    return send(res, 200, { ok: true, order: shapeOrder(o), events, parcels, batches: batches.map((b) => ({ ...b, id: Number(b.id) })) });
  } catch (e) {
    console.error('[online-orders/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load that order.' });
  }
}
