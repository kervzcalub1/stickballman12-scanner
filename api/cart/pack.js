// POST /api/cart/pack  { cartId, poBoxId, sku, size, qty }  -> { ok, cart }
//
// Step 6, second half: the buyer packs the receipt into boxes.
//
// This is what replaced the whole-order manifest. `cart/raise-po` now creates the order
// EMPTY, and scanning a pair into a specific label is what declares it — so the order
// carries one manifest per box, and the warehouse checks a carton against its own
// printed sheet instead of against the whole purchase. A box holds as many pairs as it
// holds; the rule is that every pair belongs to exactly ONE box.
//
// The write itself is `addPoScan` — the same call the supplier scan-out portal makes,
// deliberately, so the printed box manifest, the close-and-seal step and per-box receive
// differences all come free rather than being rebuilt here.
//
// WHAT THIS ADDS over calling po/scan directly is the receipt as a ceiling. A pack screen
// that let a buyer type any SKU would produce a second, independently-typed list that can
// quietly disagree with what the money actually bought — which is the exact failure the
// receipt exists to prevent. Nothing may be packed that the receipt does not have.
import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, isPrivileged, blockIfMustChange,
} from '../_lib/util.js';
import {
  getBuyCart, getBuyCartFull, getCartPackState, getPoBox, getPo, addPoScan,
  setPoLineQty, logCartEvent, dbConfigured,
} from '../_lib/db.js';
import { cartVisibleTo, hasCostPrivilege } from '../_lib/buycart.js';

const norm = (v) => String(v ?? '').trim().toUpperCase();

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const poBoxId = Number(body.poBoxId);
  const sku = String(body.sku ?? '').trim().slice(0, 60);
  const size = String(body.size ?? '').trim().slice(0, 20);
  // Negative removes. Packing the wrong size into the wrong box is the single most
  // likely mistake on this screen, and a correction that needs a desk is a correction
  // that gets skipped in favour of shipping it wrong.
  const qty = Math.trunc(Number(body.qty));
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
  if (!Number.isInteger(poBoxId)) return send(res, 400, { ok: false, error: 'Say which box this is going into.' });
  if (!sku) return send(res, 400, { ok: false, error: 'A SKU is required.' });
  if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 999)
    return send(res, 400, { ok: false, error: 'Say how many pairs.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });

    // The buyer packs their own request; either desk can pack on their behalf, because
    // somebody has to be able to fix a box the buyer sealed wrong. Same set as the cost
    // stack, and read from the database on every call like every privilege here.
    const isBuyer = user.role === 'supplier' && Number(cart.buyer_user_id) === Number(user.uid);
    if (!isBuyer && !isPrivileged(user.role) && !(await hasCostPrivilege(user)))
      return send(res, 403, { ok: false, error: 'Only the buyer or a buying desk can pack this request.' });

    if (!cart.po_id)
      return send(res, 409, { ok: false, error: 'Raise the purchase order first — there are no boxes to pack into yet.' });

    const box = await getPoBox(poBoxId);
    if (!box || Number(box.po_id) !== Number(cart.po_id))
      return send(res, 404, { ok: false, error: 'That box is not on this request’s order.' });
    // Once a box is closed for shipment its manifest is what was printed and taped to
    // the outside of it. Reopening is the supplier's own action on the order screen —
    // silently editing a sealed box would invalidate a sheet already inside it.
    if (box.status !== 'pending')
      return send(res, 409, { ok: false, error: 'That box is closed for shipment. Reopen it on the order before changing what is in it.' });

    const po = await getPo(cart.po_id);
    if (po && po.manifest_scope === 'po')
      return send(res, 409, { ok: false, error: 'This order was raised with a whole-order manifest and cannot be packed box by box.' });

    // THE CEILING. What the receipt says was bought, minus what is already in a box.
    const state = await getCartPackState(cartId);
    const row = (state?.rows || []).find((r) => norm(r.sku) === norm(sku) && norm(r.size) === norm(size));
    if (!row)
      return send(res, 409, {
        ok: false,
        // Name the pair rather than saying "invalid": on a shop floor the answer is
        // usually that the size was mistyped, and a refusal that doesn't say what it
        // was looking for is a refusal somebody works around.
        error: `The receipt has no ${sku}${size ? ` size ${size}` : ''}. Only what was actually bought can be packed.`,
      });

    if (qty > 0 && qty > row.remaining)
      return send(res, 409, {
        ok: false,
        error: row.remaining === 0
          ? `All ${row.qty} of ${sku}${size ? ` size ${size}` : ''} are already packed.`
          : `Only ${row.remaining} of ${sku}${size ? ` size ${size}` : ''} left to pack.`,
      });

    if (qty > 0) {
      await addPoScan({
        poId: cart.po_id, poBoxId, sku, size, qty,
        name: row.name || null,
        // The unit price off the RECEIPT, not off the approved line: what the pair
        // actually cost is what the purchase order should carry forward.
        unitCost: null,
        // Always on-behalf when a desk does it; a buyer packing their own order is the
        // supplier declaring their own manifest, exactly like scan-out.
        enteredBy: Number(user.uid) || null,
        enteredOnBehalf: !isBuyer,
      });
    } else {
      // Removing: find the line in THIS box and take the quantity back off it. The line
      // is keyed on (box, sku, size), so there is at most one.
      const target = (state.boxes.find((b) => b.id === poBoxId)?.lines || [])
        .find((l) => norm(l.sku) === norm(sku) && norm(l.size) === norm(size));
      if (!target) return send(res, 409, { ok: false, error: 'That pair is not in this box.' });
      const left = target.qty_expected + qty; // qty is negative
      if (left < 0) return send(res, 409, { ok: false, error: `This box only holds ${target.qty_expected}.` });
      await setPoLineQty(target.id, left);
    }

    await logCartEvent({
      cartId, kind: 'packed', actor: user,
      body: `${qty > 0 ? 'Packed' : 'Removed'} ${Math.abs(qty)} × ${sku}${size ? ` ${size}` : ''} ${qty > 0 ? 'into' : 'from'} box ${box.box_number ?? poBoxId}`,
    });

    return send(res, 200, { ok: true, cart: await getBuyCartFull(cartId) });
  } catch (e) {
    console.error('[cart/pack]', e.message);
    return send(res, 500, { ok: false, error: 'Could not pack that pair.' });
  }
}
