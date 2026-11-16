// GET  /api/cart/link-po?cartId=…            -> { ok, options: [the buyer's purchase orders] }
// POST /api/cart/link-po { cartId, poId }     -> { ok, cart }   mark shipped: link to that order
// POST /api/cart/link-po { cartId, unlink:true } -> { ok, cart } undo a link
//
// "ALREADY SHIPPED — LINK IT" (owner, 2026-11-17). The written path is: read the receipt →
// "Start packing this shipment" → the request raises its own purchase order. A supplier who
// skips that and ships on an order they made themselves — labels requested, boxes dropped
// off, the drop-off receipt on file — leaves the request saying "waiting on the shipment"
// for ever, with nothing tying it to the order that is in fact on its way. On the 11-13 copy
// of production only 3 of 37 requests had ever been through the written path.
//
// So: the buyer, the warehouse, the PH team or an admin can point the request at that order.
//   · NOTHING on the order changes — it is the supplier's own manifest. (An order RAISED from
//     a request carries the receipt as its list and is gated on the request's packing; a
//     LINKED one — `buy_carts.po_linked_at` — is neither.)
//   · Several requests may sit on one order: a supplier ships a week's buying in one go.
//   · The order must be that buyer's own (`purchase_orders.supplier_user_id`).
//   · From "cards released" on (`funded` / `receipted` / `audited`), and only while the
//     request has no order yet. Unlink only removes a LINK, never a raised order.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, isPrivileged, blockIfMustChange } from '../_lib/util.js';
import {
  getBuyCartFull, getPo, linkBuyCartExistingPo, unlinkBuyCartPo, listPosForCartLink, addPoComment, dbConfigured,
} from '../_lib/db.js';
import { cartVisibleTo, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';

const STAFF = new Set(['warehouse', 'ph_team']);
const LINKABLE = new Set(['funded', 'receipted', 'audited']);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const body = req.method === 'POST' ? await getJsonBody(req) : {};
    const cartId = Number(req.method === 'POST' ? body.cartId : new URL(req.url, 'http://x').searchParams.get('cartId'));
    if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
    const cart = await getBuyCartFull(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // The buyer whose request it is, the warehouse, the PH team, or an admin.
    const isOwnBuyer = user.role === 'supplier' && Number(cart.buyer_user_id) === Number(user.uid);
    if (!isOwnBuyer && !isPrivileged(user.role) && !STAFF.has(user.role))
      return send(res, 403, { ok: false, error: 'Only the buyer, the warehouse or the PH team can link a request to its purchase order.' });

    if (req.method === 'GET') {
      return send(res, 200, { ok: true, options: await listPosForCartLink(cart.buyer_user_id) });
    }

    if (body.unlink === true) {
      if (!cart.po_id) return send(res, 409, { ok: false, error: 'This request isn’t linked to a purchase order.' });
      if (!cart.po_linked_at)
        return send(res, 409, { ok: false, error: 'This order was raised from the request itself — it can’t be unlinked. Delete the order on the Purchase Orders side if it is wrong.' });
      const po = await getPo(cart.po_id);
      const updated = await unlinkBuyCartPo(cartId, user);
      if (!updated) return send(res, 409, { ok: false, error: 'That link was just changed — reload the request.' });
      if (po) await note(po.id, `${who(user)} removed the link to buying request ${cart.cart_code}.`, user);
      return send(res, 200, { ok: true, cart: redactCartForViewer(await getBuyCartFull(cartId), user) });
    }

    const poId = Number(body.poId);
    if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'Pick the purchase order it shipped on.' });
    if (cart.po_id) return send(res, 409, { ok: false, error: 'This request already has a purchase order.' });
    if (!LINKABLE.has(cart.status))
      return send(res, 409, { ok: false, error: 'A request can be linked to its shipment once its gift cards have been released, and before it is closed.' });
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'That purchase order does not exist.' });
    if (Number(po.supplier_user_id) !== Number(cart.buyer_user_id))
      return send(res, 409, { ok: false, error: `${po.po_code} isn’t ${cart.buyer_name}’s order — a request can only be linked to its own buyer’s purchase order.` });
    if (po.order_kind && po.order_kind !== 'shoes')
      return send(res, 409, { ok: false, error: `${po.po_code} is an empty-box order, not a shoe shipment.` });

    const updated = await linkBuyCartExistingPo(cartId, po, user);
    if (!updated) return send(res, 409, { ok: false, error: 'This request was just given a purchase order — reload it.' });
    await note(po.id, `${who(user)} linked buying request ${cart.cart_code} to this order (marked shipped).`, user);
    return send(res, 200, { ok: true, cart: redactCartForViewer(await getBuyCartFull(cartId), user) });
  } catch (e) {
    console.error('[cart/link-po]', e.message);
    return send(res, 500, { ok: false, error: 'Could not link the purchase order.' });
  }
}

const who = (u) => u.name || u.username || 'Someone';
// On the order's own history too, so the PO page says which requests it carries. Best-effort.
function note(poId, text, user) {
  const uid = Number(user.uid);
  return addPoComment({ poId, kind: 'system', body: text, author: { id: Number.isInteger(uid) ? uid : null, name: who(user), role: user.role } })
    .catch((e) => console.warn('[cart/link-po] order note:', e.message));
}
