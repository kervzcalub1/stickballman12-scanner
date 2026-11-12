// POST /api/cart/ask-cards  { cartId }  -> { ok, sent, reason?, short }
//
// "Ask for $X more" — the gift card desk is DM'd for what a request is short right now.
// The later half of the opt-out on cart/line-qty: an approver who raised a quantity after
// the cards went out and pressed "Don't ask now" asks here when they're ready. Same send
// as every top-up (notifyIssuersIfReady, `asked: true` so an earlier "not now" doesn't
// hold it back); still said once per amount, so a second press for the same figure is a
// no-op that says so.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, dbConfigured } from '../_lib/db.js';
import { requirePrivilege, fundingTarget } from '../_lib/buycart.js';
import { notifyIssuersIfReady, issuerAskWhy } from '../_lib/notify.js';
import { cardsIssuable, cardsRefusedBecause } from '../../src/lib/buycartRules.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'approve_buying',
    'Only somebody who can approve buying can ask the gift card desk for more.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (cart.funding_method === 'company_card')
      return send(res, 409, { ok: false, error: 'This request is paid with the company card — there are no gift cards to ask for.' });
    const short = Math.max(0, Math.round((fundingTarget(cart) - (Number(cart.gc_total) || 0)) * 100) / 100);
    if (!(short > 0)) return send(res, 409, { ok: false, error: 'The cards recorded already cover this request — nothing more to ask for.' });
    if (!['approved', 'funded'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'The receipt is already in — the desk records any card the buyer spent from the request itself.' });
    if (!cardsIssuable(cart)) return send(res, 409, { ok: false, error: cardsRefusedBecause(cart) });

    const r = await notifyIssuersIfReady(cartId, { asked: true });
    if (!r.sent) return send(res, 409, { ok: false, short, error: issuerAskWhy(r.reason) });
    return send(res, 200, { ok: true, sent: true, short, to: r.to });
  } catch (e) {
    console.error('[cart/ask-cards]', e.message);
    return send(res, 500, { ok: false, error: 'Could not ask the gift card desk.' });
  }
}
