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
// The order is raised with the RECEIPT AS ITS ORDER-LEVEL LIST, and the buyer then packs
// it into boxes — two lists, `manifest_scope='order+box'`. See the block above the write
// below for why both, and why neither one alone was enough.
//
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import {
  getBuyCartFull, createPo, linkBuyCartPo, addPoOrderScan, setPoManifestScope, dbConfigured,
} from '../_lib/db.js';
import { cartVisibleTo, hasPrivilege, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';
import { requireAuth, isPrivileged, blockIfMustChange } from '../_lib/util.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // THE BUYER RAISES THEIR OWN SHIPMENT (2026-09-11).
  //
  // This was `approve_buying` only, and that left the person doing the physical work
  // unable to start it: a buyer standing over a pile of shoeboxes with a receipt already
  // read had no way to open the order, so nothing could be packed until a desk noticed
  // and guessed a box count for them. The desk's job is deciding what may be SPENT, and
  // that decision was made two steps ago.
  //
  // Nothing about the money moves here. The order is raised from the receipt — a
  // document the buyer cannot edit once the cards are out — so there is no figure for
  // them to influence by pressing it. What they gain is the ability to begin.
  const user = requireAuth(req, res);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCartFull(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // Either the buyer whose request it is, or somebody who can approve buying. A buyer
    // reaches only their own — `cartVisibleTo` already scopes them on the token's id.
    const isOwnBuyer = user.role === 'supplier' && Number(cart.buyer_user_id) === Number(user.uid);
    if (!isOwnBuyer && !isPrivileged(user.role) && !(await hasPrivilege(user, 'approve_buying')))
      return send(res, 403, { ok: false, error: 'Only the buyer, or somebody who can approve buying requests, can start the shipment.' });
    if (cart.po_id)
      return send(res, 409, { ok: false, error: 'This request already has a purchase order.' });
    if (!cart.receiptLines.length)
      return send(res, 409, { ok: false, error: 'Read the receipt first — the order is raised from what was actually bought.' });

    // Every receipt line has to name a shoe, because every receipt line is about to
    // become something we are OWED. A shop receipt frequently prints no style code at
    // all (`buy-cart.md` — no SKU, no size, names truncated to fit the paper), and the
    // person who reviewed the parse is meant to have filled those in.
    //
    // Refused rather than skipped. Dropping a nameless line would raise an order that
    // quietly expects less than the receipt says was bought, and the whole point of
    // putting the receipt on the order is that the two agree.
    const nameless = cart.receiptLines.filter((l) => !String(l.sku || '').trim());
    if (nameless.length)
      return send(res, 409, {
        ok: false,
        error: `${nameless.length} receipt line${nameless.length === 1 ? ' has' : 's have'} no SKU, so the order cannot say what it is owed. Fill them in on the receipt first — a shop till often prints no style code.`,
      });

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

    const po = created.po;

    // THE RECEIPT BECOMES THE ORDER (2026-09-11). Two lists live on this purchase order
    // and they are not competing versions of one thing:
    //
    //   the ORDER      po_lines with no box — written here, from the receipt. What we
    //                  paid for, and therefore what we are owed. This is `expected`.
    //   the PACKING    po_lines on a box — written by the buyer at `cart/pack`. Which
    //     LIST         carton each pair is in.
    //
    // This order was raised EMPTY until now, and the reasoning was that the receipt
    // cannot produce a per-box manifest — true, and beside the point. It was read as an
    // argument for the order knowing NOTHING until the buyer packed, and the cost of that
    // was severe: a pair the buyer never put in a box was not short, it was INVISIBLE.
    // Reconciliation counted only what shipped, so the order came out clean while the
    // shoe was nowhere, and only the request's own checklist ever noticed.
    //
    // Writing both fixes that without giving anything up. The warehouse still checks a
    // carton against its own printed sheet, a shortage is still located to a box — and
    // from the moment the receipt is read, the order can say what it is still owed.
    //
    // The lines come off the RECEIPT, not off the approved request. What was approved is
    // what we agreed to spend; what the receipt says is what actually exists and is
    // coming. Where they differ, the difference is a finding for the audit — not
    // something to quietly reconcile away by declaring the tidier of the two lists.
    for (const l of cart.receiptLines) {
      await addPoOrderScan({
        poId: po.id,
        sku: String(l.sku).trim().toUpperCase(),
        size: String(l.size ?? '').trim() || null,
        qty: Math.max(1, Number(l.qty) || 1),
        name: l.name || null,
        // What the till actually charged for one pair. The order carries real money from
        // the start, so a shortage has a value without anybody looking anything up.
        unitCost: l.unit_price == null ? null : Number(l.unit_price),
        // `entered_by` is a users(id) FK, and the env admin/superadmin have a NON-NUMERIC
        // uid — writing a name here is the bigint cast that has taken this down before
        // (see PO comments). Stamp the on-behalf flag either way; leave the id null when
        // there is no real row to point at.
        enteredBy: Number.isInteger(Number(user.uid)) ? Number(user.uid) : null,
        // Not the buyer's own account of what they packed — ours, off their receipt.
        enteredOnBehalf: true,
      });
    }
    await setPoManifestScope(po.id, 'order+box');

    const updated = await linkBuyCartPo(cartId, po.id, user);
    return send(res, 200, { ok: true, po: { id: po.id, po_code: po.po_code }, cart: redactCartForViewer(updated, user) });
  } catch (e) {
    console.error('[cart/raise-po]', e.message);
    return send(res, 500, { ok: false, error: 'Could not raise the purchase order.' });
  }
}
