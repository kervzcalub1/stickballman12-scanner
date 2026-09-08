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
// The lines come off the RECEIPT, not off the approved request. What was approved is
// what we agreed to spend; what the receipt says is what actually exists and is coming.
// Where they differ, the difference is a finding for the audit — not something to
// quietly reconcile away by declaring the tidier of the two lists.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import {
  getBuyCartFull, createPo, addPoOrderScan, setPoManifestScope, linkBuyCartPo, dbConfigured,
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

    // A WHOLE-ORDER manifest (Path C, po_box_id NULL): the receipt is one list for the
    // whole purchase, and which box a pair ends up in is decided later when the buyer
    // packs. Splitting the receipt across boxes now would be a guess presented as a
    // record. `manifest_scope` must flip with it, or reconciliation counts the
    // per-label lines (of which there are none) and reads the whole order as short.
    const po = created.po;
    await setPoManifestScope(po.id, 'po');
    for (const r of cart.receiptLines) {
      await addPoOrderScan({
        poId: po.id, sku: r.sku, size: r.size, qty: r.qty, name: r.name,
        unitCost: r.unit_price,
        // Always on-behalf: a staff member raised this from the buyer's receipt. The
        // buyer did not scan it out themselves, and the attribution has to say so.
        enteredBy: Number(user.uid) || null, enteredOnBehalf: true,
      });
    }

    const updated = await linkBuyCartPo(cartId, po.id, user);
    return send(res, 200, { ok: true, po: { id: po.id, po_code: po.po_code }, cart: updated });
  } catch (e) {
    console.error('[cart/raise-po]', e.message);
    return send(res, 500, { ok: false, error: 'Could not raise the purchase order.' });
  }
}
