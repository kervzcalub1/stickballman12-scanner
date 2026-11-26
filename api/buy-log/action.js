// POST /api/buy-log/action
//   { action:'pay', id, paid_on, amount, method?, paid_by?, note?, proof?:[url] }  PH / admin; the supplier only WITH a screenshot
//   { action:'proof', id, payment_id, proof:[url] }                     add screenshots to a recorded payment
//   { action:'unpay', id, payment_id }                                  PH / admin only
//   { action:'link', id, po_id } · { action:'unlink', id, po_id }       the supplier (own) or PH / admin
//   { action:'delete', id }       a supplier: only while nothing is paid or linked; PH / admin: any
// The Buy Log (docs/context/buy-log.md). A payment the supplier records must carry its
// screenshot; only staff remove one.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { isAllowedPhotoUrl } from '../_lib/r2.js';
import { dbConfigured, getBuyLogOwner, addBuyLogPayment, addBuyLogPaymentProof, deleteBuyLogPayment, linkBuyLogPo, unlinkBuyLogPo, deleteBuyLog, listPosForBuyLog } from '../_lib/db.js';
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

    // Screenshots of the payment: only files this order's own upload path produced.
    const proofOf = (list) => [...new Set((Array.isArray(list) ? list : []).map(String)
      .filter((u) => isAllowedPhotoUrl(u) && u.includes(`/buy-log/order-${id}/`)))].slice(0, 6);

    if (action === 'proof') {
      if (!isSupplier(user) && !canManage(user)) return send(res, 403, { ok: false, error: 'You can read the buy log, not change it.' });
      const pid = idOf(b.payment_id); const proof = proofOf(b.proof);
      if (!pid) return send(res, 400, { ok: false, error: 'Which payment?' });
      if (!proof.length) return send(res, 400, { ok: false, error: 'Add the screenshot first.' });
      return (await addBuyLogPaymentProof(id, pid, proof, actor)) ? send(res, 200, { ok: true }) : send(res, 409, { ok: false, error: 'That payment was removed.' });
    }

    if (action === 'pay' || action === 'unpay') {
      // Removing a payment stays with staff. RECORDING one: staff, or the supplier who sent
      // it — but then the screenshot is not optional (owner, 2026-11-26: "upload the
      // screenshot of the payment he sent to them, for cross checking").
      if (action === 'unpay' && !canManage(user)) return send(res, 403, { ok: false, error: 'Payments are removed by the PH team or an admin.' });
      if (!isSupplier(user) && !canManage(user)) return send(res, 403, { ok: false, error: 'You can read the buy log, not change it.' });
      if (action === 'unpay') {
        const pid = idOf(b.payment_id);
        if (!pid) return send(res, 400, { ok: false, error: 'Which payment?' });
        return (await deleteBuyLogPayment(id, pid, actor)) ? send(res, 200, { ok: true }) : send(res, 409, { ok: false, error: 'That payment was already removed.' });
      }
      const paidOn = realDate(b.paid_on);
      const amount = Number(b.amount);
      if (!paidOn) return send(res, 400, { ok: false, error: 'When was it paid? Pick the date.' });
      if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_MONEY) return send(res, 400, { ok: false, error: 'How much was paid? Enter an amount above $0.' });
      const proof = proofOf(b.proof);
      if (isSupplier(user) && !proof.length) return send(res, 400, { ok: false, error: 'Add the screenshot of the payment — it is how the payment is checked.' });
      const pid = await addBuyLogPayment(id, { paidOn, amount: Math.round(amount * 100) / 100, method: text(b.method, 60), paidBy: text(b.paid_by, 80) || (isSupplier(user) ? actor : ''), note: text(b.note, 300), proof }, actor);
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
