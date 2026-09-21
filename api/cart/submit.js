// POST /api/cart/submit  { cartId }               -> close the buyer's list
// POST /api/cart/submit  { cartId, reopen:true }  -> open it again
//   -> { ok, cart }
//
// There is no "send for approval" any more: adding a pair IS asking about it
// (`cart/line`). What the buyer presses at the end of the trip is "Close the request" —
// the list is complete, fund what you approved. Closing is what lets the gift-card desk
// record a card; a list still growing has no total to fund.
//
// The route keeps its old name so nothing that links to it moves.
//
// Closing is where "what are you buying?" has to have been answered — and the LINES are
// that answer: a store, at least one line and a photo of every shoe are required here.
// A written purpose is no longer asked for or required. It was collected before the trip
// began, which is the one moment the buyer cannot know — they work it out in the shop —
// so it was either a guess or a blocker, and the SKUs, photos and counts say more than
// the sentence ever did. Requests raised before this still carry theirs, and it still
// shows; nothing reads it as a gate.
//
// RE-OPENING is the buyer changing their mind on the way out: one more pair, or the
// cards came up short. Allowed until the receipt is in. The group is told either way —
// the desk was about to fund a total, and needs to know it is about to move.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBuyCart, closeBuyCartList, reopenBuyCartList, dbConfigured, skusWithoutPhotos } from '../_lib/db.js';
import { cartVisibleTo, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';
import { buyerCanClose, buyerCanReopen, reopenRefusedBecause } from '../../src/lib/buycartRules.js';
import { notifyRequestEvent } from '../_lib/notify.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team', 'warehouse']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });

    if (body.reopen) {
      if (!buyerCanReopen(cart))
        return send(res, 409, { ok: false, error: reopenRefusedBecause(cart) || 'This request is not closed.' });
      const out = await reopenBuyCartList(cartId, user);
      if (!out) return send(res, 409, { ok: false, error: 'This request is not closed.' });
      // Fire-and-forget, after the write — the buyer is in a shop and never waits on Make.
      notifyRequestEvent(cartId, 'buying_request_reopened', user);
      return send(res, 200, { ok: true, cart: redactCartForViewer(out, user) });
    }

    if (cart.list_closed_at)
      return send(res, 409, { ok: false, error: 'This request is already closed.' });
    if (!buyerCanClose(cart) && Number(cart.line_count) > 0)
      return send(res, 409, { ok: false, error: 'This request is past the point of closing its list.' });
    if (!Number(cart.line_count))
      return send(res, 400, { ok: false, error: 'Add at least one pair before closing the request.' });
    if (!String(cart.retailer || '').trim())
      return send(res, 400, { ok: false, error: 'Say which store this is for — the gift cards have to be for the right retailer.' });

    // EVERY SHOE NEEDS A PHOTO. The approver is deciding on something they cannot see,
    // in a shop they are not standing in, off a style code that is four digits away from
    // a different shoe — and a photo is the only thing on the request that shows what was
    // actually found. Keyed by SKU, so five sizes of one shoe need one set of shots.
    const unshot = await skusWithoutPhotos(cartId);
    if (unshot.length)
      return send(res, 400, {
        ok: false,
        error: `Add a photo of ${unshot.length === 1 ? 'this shoe' : 'these shoes'} first: ${unshot.slice(0, 4).join(', ')}${unshot.length > 4 ? `, and ${unshot.length - 4} more` : ''}. One photo covers every size of the same shoe.`,
      });

    const out = await closeBuyCartList(cartId, user);
    if (!out) return send(res, 409, { ok: false, error: 'This request is already closed.' });
    notifyRequestEvent(cartId, 'buying_request_closed', user);
    return send(res, 200, { ok: true, cart: redactCartForViewer(out, user) });
  } catch (e) {
    console.error('[cart/submit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update that request.' });
  }
}
