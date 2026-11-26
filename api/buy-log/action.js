// POST /api/buy-log/action
//   { action:'pay', id, paid_on, amount, method?, paid_by?, note? }   PH / admin only
//   { action:'unpay', id, payment_id }                                  PH / admin only
//   { action:'link', id, po_id } · { action:'unlink', id, po_id }       the supplier (own) or PH / admin
//   { action:'delete', id }       a supplier: only while nothing is paid or linked; PH / admin: any
// The Buy Log (docs/context/buy-log.md). Payments are recorded by STAFF: the supplier does not
// sign for money that was sent to them.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { dbConfigured, getBuyLogOwner, addBuyLogPayment, deleteBuyLogPayment, linkBuyLogPo, unlinkBuyLogPo, deleteBuyLog, listPosForBuyLog } from '../_lib/db.js';
import { buyLogUser, isSupplier, canManage, ownsBuy, actorOf, idOf, realDate, MAX_MONEY } from './_shared.js';

const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await buyLogUser(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  let b;
  try { b = await getJsonBody(req); } catch (e) { return send(res, e.status || 400, { ok: false, error: e.message || 'Bad request.' }); }
  const action = String(b.action || '');
  const id = idOf(b.id);
  if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
  const actor = actorOf(user);
  try {
    const own = await getBuyLogOwner(id);
    if (!ownsBuy(res, user, own)) return;

    if (action === 'pay' || action === 'unpay') {
      if (!canManage(user)) return send(res, 403, { ok: false, error: 'Payments are recorded by the PH team or an admin.' });
      if (action === 'unpay') {
        const pid = idOf(b.payment_id);
        if (!pid) return send(res, 400, { ok: false, error: 'Which payment?' });
        return (await deleteBuyLogPayment(id, pid, actor)) ? send(res, 200, { ok: true }) : send(res, 409, { ok: false, error: 'That payment was already removed.' });
      }
      const paidOn = realDate(b.paid_on);
      const amount = Number(b.amount);
      if (!paidOn) return send(res, 400, { ok: false, error: 'When was it paid? Pick the date.' });
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_MONEY) return send(res, 400, { ok: false, error: 'How much was paid? Enter an amount above $0.' });
      const pid = await addBuyLogPayment(id, { paidOn, amount: Math.round(amount * 100) / 100, method: text(b.method, 60), paidBy: text(b.paid_by, 80), note: text(b.note, 300) }, actor);
      return send(res, 200, { ok: true, payment_id: pid });
    }

    if (action === 'link' || action === 'unlink') {
      if (!isSupplier(user) && !canManage(user)) return send(res, 403, { ok: false, error: 'You can read the buy log, not change it.' });
      const poId = idOf(b.po_id);
      if (!poId) return send(res, 400, { ok: false, error: 'Which purchase order?' });
      if (action === 'unlink') {
        return (await unlinkBuyLogPo(id, poId, actor)) ? send(res, 200, { ok: true }) : send(res, 409, { ok: false, error: 'That purchase order was not linked.' });
      }
      // Only this supplier's own purchase orders: a link decides what counts as "received".
      const mine = await listPosForBuyLog({ supplierUserId: own.supplier_user_id, supplierName: own.supplier_name });
      if (!mine.some((o) => Number(o.po_id) === poId)) return send(res, 400, { ok: false, error: 'That purchase order is not one of this supplier’s.' });
      await linkBuyLogPo(id, poId, actor);
      return send(res, 200, { ok: true });
    }

    if (action === 'delete') {
      if (isSupplier(user)) {
        if (own.payments > 0 || own.pos > 0) return send(res, 409, { ok: false, error: 'This order has a payment or a purchase order on it — ask the PH team to remove it.' });
      } else if (!canManage(user)) return send(res, 403, { ok: false, error: 'You can read the buy log, not change it.' });
      return (await deleteBuyLog(id)) ? send(res, 200, { ok: true }) : send(res, 404, { ok: false, error: 'That order no longer exists.' });
    }
    return send(res, 400, { ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[buy-log/action]', e.message);
    return send(res, 500, { ok: false, error: 'Could not do that.' });
  }
}
