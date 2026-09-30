// POST /api/online-orders/receive  { id, counts:[{ lineId, got }] } -> { ok }
// The warehouse counts an online order's parcel in: per line, how many pairs actually
// arrived. Short pairs ("ordered 5, delivered 3") split off as NOT DELIVERED with their
// refund to chase — the same trail as a cancellation. Warehouse + PH (admin auto).
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getOnlineOrder, receiveOnlineOrder } from '../_lib/db.js';
import { actorOf, idOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const id = idOf(b.id);
  if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
  try {
    const order = await getOnlineOrder(id);
    if (!order) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
    if (order.received_at) return send(res, 409, { ok: false, error: 'This order was already counted in.' });
    const active = (order.lines || []).filter((l) => !l.cancelled_at);
    if (!active.length) return send(res, 409, { ok: false, error: 'Everything on this order was cancelled — there is nothing to count in.' });
    const counts = new Map();
    for (const c of Array.isArray(b.counts) ? b.counts : []) {
      const lineId = Number(c?.lineId);
      const line = active.find((l) => Number(l.id) === lineId);
      if (!line) continue;
      // A blank count is a question, not a zero — Number(null) is 0, which would have
      // filed the whole line as not delivered.
      const got = c?.got === null || c?.got === '' || c?.got === undefined ? NaN : Number(c.got);
      if (!Number.isInteger(got) || got < 0 || got > Number(line.qty)) {
        return send(res, 400, { ok: false, error: `${line.sku} US ${line.size}: count between 0 and ${line.qty}. More than ordered isn't something this order can hold — note it on the batch.` });
      }
      counts.set(lineId, got);
    }
    const ordered = active.reduce((n, l) => n + Number(l.qty), 0);
    const got = active.reduce((n, l) => n + (counts.has(Number(l.id)) ? counts.get(Number(l.id)) : Number(l.qty)), 0);
    const detail = got === ordered ? `all ${ordered} pair(s) arrived` : `${got} of ${ordered} pair(s) arrived — ${ordered - got} not delivered, refund to follow up`;
    await receiveOnlineOrder(order, counts, actorOf(user), detail);
    return send(res, 200, { ok: true });
  } catch (e) {
    if (e.status === 409) return send(res, 409, { ok: false, error: e.message });
    console.error('[online-orders/receive]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record the count.' });
  }
}
