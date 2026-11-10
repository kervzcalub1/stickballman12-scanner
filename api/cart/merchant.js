// POST /api/cart/merchant  { cartId, merchant }  -> { ok, cart }
//
// Which merchant's gift cards a request needs: Nike, Foot Locker / Champs Sports, Adidas,
// Finish Line / JD Sports, or Dick's Sporting Goods (src/lib/giftCardMerchants.js). It is
// picked when the request is opened. This endpoint sets it on a request opened before the
// list existed, and corrects a wrong pick.
//
// Who: the buyer on their own request, or anyone who approves requests or issues the
// cards. When: only until the desk records a card. After that, a different merchant would
// make the cards already handed over the wrong ones, so the request has to be sorted out
// with the desk instead.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange, isPrivileged } from '../_lib/util.js';
import { getBuyCartFull, setBuyCartMerchant, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, hasPrivilege, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';
import { merchantKey, merchantLabel, merchantEditable } from '../../src/lib/giftCardMerchants.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
  const key = merchantKey(body.merchant);
  if (!key) return send(res, 400, { ok: false, error: 'Pick which merchant the gift cards are for.' });

  try {
    const full = await getBuyCartFull(cartId);
    if (!full) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, full)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // The buyer passes on owning the request (cartVisibleTo already scoped them to their
    // own). Staff need one of the two desks that act on the cards: approving or issuing.
    // Privileges are read fresh from the database, never off the token.
    const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
    const allowed = isBuyer || isPrivileged(user.role)
      || (await hasPrivilege(user, 'approve_buying')) || (await hasPrivilege(user, 'issue_gift_cards'));
    if (!allowed)
      return send(res, 403, { ok: false, error: 'Only the buyer, an approver or the gift card desk can change the merchant.' });
    if (!merchantEditable(full))
      return send(res, 409, { ok: false, error: 'Gift cards are already on this request, so the merchant can no longer change. Talk to the gift card desk.' });
    if (full.gc_merchant === key)
      return send(res, 200, { ok: true, cart: redactCartForViewer(full, user), unchanged: true });

    const from = merchantLabel(full.gc_merchant);
    const note = from ? `Gift card merchant: ${from} → ${merchantLabel(key)}` : `Gift card merchant: ${merchantLabel(key)}`;
    const cart = await setBuyCartMerchant(cartId, key, note, user);
    if (!cart) return send(res, 409, { ok: false, error: 'Gift cards were just added to this request, so the merchant can no longer change.' });
    return send(res, 200, { ok: true, cart: redactCartForViewer(cart, user) });
  } catch (e) {
    console.error('[cart/merchant]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the merchant.' });
  }
}
