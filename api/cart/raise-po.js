// POST /api/cart/raise-po  { cartId, boxes? }  -> { ok, po, cart }
//
// Step 6: the parsed receipt becomes EXPECTED INVENTORY — stock the company has paid
// for and has not yet got.
//
// It does that by raising a real purchase order rather than by inventing a parallel
// list, because everything downstream already exists on that side: PO reconciliation
// compares expected against what physically arrived, 17TRACK watches the parcel, and
// the warehouse receives against the manifest. A second expected-inventory table would
// give the company two answers to "what are we still waiting on".
//
// The order is raised EMPTY. The receipt is the pick list the buyer packs from, not
// the manifest itself — see `cart/pack`.
//
// The lines come off the RECEIPT, not off the approved request. What was approved is
// what we agreed to spend; what the receipt says is what actually exists and is coming.
// Where they differ, the difference is a finding for the audit — not something to
// quietly reconcile away by declaring the tidier of the two lists.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import {
  getBuyCartFull, createPo, linkBuyCartPo, dbConfigured,
} from '../_lib/db.js';
import { requirePrivilege } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'approve_buying');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCartFull(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (cart.po_id)
      return send(res, 409, { ok: false, error: 'This request already has a purchase order.' });
    if (!cart.receiptLines.length)
      return send(res, 409, { ok: false, error: 'Read the receipt first — the order is raised from what was actually bought.' });

    // Numberless boxes: the buyer packs and then asks for labels, which is the
    // manifest-first direction the PO side already supports (`raised_by:'supplier'`).
    const boxes = Number.isInteger(Number(body.boxes)) && Number(body.boxes) > 0 ? Math.min(Number(body.boxes), 100) : 1;
    // createPo returns the FULL order — { po, boxes, lines, batches } — not the row.
    const created = await createPo({
      supplierName: cart.buyer_name,
      supplierUserId: cart.buyer_user_id,
      tagCode: cart.cart_code,
      notes: `Raised from buying request ${cart.cart_code}${cart.retailer ? ` · ${cart.retailer}` : ''}`,
      orderKind: 'shoes',
      labels: Array.from({ length: boxes }, () => ({ trackingNumber: '', carrierKey: null })),
      raisedBy: 'supplier',
      createdBy: user.name || user.username || '',
    });

    // NO manifest is written here, and that is the change. The order is created with
    // its blank labels and nothing else, on the ordinary PER-BOX scope.
    //
    // The receipt cannot produce a per-box manifest: when it is parsed the shoes are
    // still in the buyer's car and no box has been filled. Writing the whole receipt as
    // one order-level list was a way of pretending otherwise — it told the warehouse
    // what the PURCHASE contained, and could never tell them what THIS BOX should
    // contain, so a short carton was only ever discoverable as a short order.
    //
    // The receipt stays where it already lives, on the request, and becomes the pick
    // list for `cart/pack`. Scanning a pair into a label is what declares it, exactly
    // as every other supplier order is declared — which is also why the printed box
    // manifest, the close-and-seal step and per-box receive differences all come free.
    const po = created.po;

    const updated = await linkBuyCartPo(cartId, po.id, user);
    return send(res, 200, { ok: true, po: { id: po.id, po_code: po.po_code }, cart: updated });
  } catch (e) {
    console.error('[cart/raise-po]', e.message);
    return send(res, 500, { ok: false, error: 'Could not raise the purchase order.' });
  }
}
