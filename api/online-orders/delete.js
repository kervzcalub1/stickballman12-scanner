// POST /api/online-orders/delete { id } -> { ok }
// For an order recorded by mistake. Refused once the warehouse has counted it in, or once
// any refund has been traced on it — by then it is part of the money trail, and the way
// to undo a real order is to cancel its lines. PH (admin auto).
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getOnlineOrder, deleteOnlineOrder } from '../_lib/db.js';
import { idOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const id = idOf(b.id);
  if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
  try {
    const order = await getOnlineOrder(id);
    if (!order) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
    if (order.received_at) return send(res, 409, { ok: false, error: 'The warehouse already counted this order in — it can’t be deleted. Cancel its lines instead.' });
    if ((order.lines || []).some((l) => l.refund === 'requested' || l.refund === 'refunded')) {
      return send(res, 409, { ok: false, error: 'A refund has been traced on this order — it stays for the audit. Cancel its lines instead.' });
    }
    await deleteOnlineOrder(id);
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[online-orders/delete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not delete the order.' });
  }
}
