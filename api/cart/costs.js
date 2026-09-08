// POST /api/cart/costs  { cartId, stack:{ storePct, promoPct, giftPct, cashbackPct,
//                                          taxPct, tipAmt, shippingAmt } }
//   -> { ok, cart, repriced }
//
// What a pair on this request actually costs the company.
//
// A request's cost stack is snapshotted from the BUYER'S payout preset when it is
// opened, and buyers do not manage their own presets — an admin does. So a buyer who has
// never been given one opens a request where every pair lands at exactly its shelf
// price, no payout clears any threshold, and no buy call can be made at all. That is not
// an edge case; it is what every new buyer's first request looks like.
//
// The BUYER writes it first — they are the only person in the room with the information,
// standing in the shop reading the tax off the register and the discount off the sign.
// Either desk privilege can then overwrite anything they typed. What makes that safe is
// not withholding the box but the trail: every write lands in `buy_cart_events` with the
// rate that moved, what it moved from, and whose name it moved under, so a favourable
// stack is visible as the buyer's beside the number the approver replaced it with.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange } from '../_lib/util.js';
import { getBuyCartFull, setBuyCartCostStack, dbConfigured } from '../_lib/db.js';
import {
  cartVisibleTo, canWriteCosts, costStackEditable,
  normaliseCostStack, describeCostChange, repriceLine,
} from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const full = await getBuyCartFull(cartId);
    if (!full) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, full)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // A privilege is read fresh from the database here, never off the token — the same
    // rule the rest of this flow follows, so unticking one stops the next write rather
    // than the next sign-in. A buyer passes on owning the request, not on a privilege.
    if (!(await canWriteCosts(user, full)))
      return send(res, 403, {
        ok: false,
        error: 'Only the buyer, or somebody who can approve or audit buying requests, can set the costs.',
      });
    if (!costStackEditable(full))
      return send(res, 409, { ok: false, error: 'This request is finished — its costs can no longer be changed.' });

    const before = full.cost_stack || {};
    const stack = normaliseCostStack(body.stack || {}, before);
    const note = describeCostChange(before, stack);
    if (!note && full.cost_stack)
      return send(res, 200, { ok: true, cart: full, repriced: 0, unchanged: true });

    // Every line, not only the approved ones: a pending line is exactly the one an
    // approver is about to judge, and it has to be judged on the new numbers.
    const calls = (full.lines || []).map((l) => repriceLine(l, stack)).filter(Boolean);
    const cart = await setBuyCartCostStack(cartId, stack, calls, user,
      `${note || 'Cost stack set'}${calls.length ? ` — ${calls.length} line${calls.length === 1 ? '' : 's'} re-priced` : ''}`);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    return send(res, 200, { ok: true, cart, repriced: calls.length });
  } catch (e) {
    console.error('[cart/costs]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save those costs.' });
  }
}
