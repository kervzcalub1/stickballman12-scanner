// POST /api/cart/submit  { cartId, withdraw? }  -> { ok, cart }
//
// Step 1 closing: the buyer hands the request over. The process is explicit that this
// is where "what are you buying?" gets answered — "I'm just buying stuff" is the exact
// answer it exists to refuse — so a purpose and at least one line are required to
// submit, not optional fields somebody fills in later.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBuyCart, submitBuyCart, withdrawBuyCart, dbConfigured, skusWithoutPhotos } from '../_lib/db.js';
import { cartVisibleTo, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';

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

    if (body.withdraw) {
      const out = await withdrawBuyCart(cartId, user);
      if (!out) return send(res, 409, { ok: false, error: 'This request has already been decided on — it can’t be pulled back.' });
      return send(res, 200, { ok: true, cart: redactCartForViewer(out, user) });
    }

    if (!Number(cart.line_count))
      return send(res, 400, { ok: false, error: 'Add at least one pair before sending this for approval.' });
    if (!String(cart.purpose || '').trim())
      return send(res, 400, { ok: false, error: 'Say what you are buying and why — a request without that can’t be approved.' });
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

    const out = await submitBuyCart(cartId, user);
    if (!out) return send(res, 409, { ok: false, error: 'This request has already been sent.' });
    return send(res, 200, { ok: true, cart: redactCartForViewer(out, user) });
  } catch (e) {
    console.error('[cart/submit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not send that request.' });
  }
}
