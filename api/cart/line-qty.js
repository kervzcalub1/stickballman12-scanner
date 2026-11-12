// POST /api/cart/line-qty  { cartId, lineId, qty, expectQty, askCards?: true|false }
//   -> { ok, line, cart, money:{ before, after, short }, ask:{ choice, sent?, reason? } }
//
// HOW MANY of an APPROVED pair, after the gift cards are out (owner, 2026-11-13: "edit the
// quantity even though the gift cards are already issued … opt in or out to request
// additional GC when they fall short").
//
// The ONE narrow exception to "decisions on a funded request are pending-only"
// (DECISIONS_PENDING_ONLY, `decideBuyCartLines({ pendingOnly })`): the decision itself
// stays frozen — this cannot approve, turn down or override anything — only the number on
// a pair that is already approved moves. Telegram replies keep refusing approved pairs.
//
//   · who:  an approver (`approve_buying`; admin/superadmin implicit) — the cart/decide
//           gate. A buyer (supplier) can never hold it.
//   · when: the request is `funded` (cards out, no receipt). From `receipted` on the
//           purchase has happened.
//   · what: a whole number 1–999 on an APPROVED line; dropping a pair is the buyer's ✕.
//           `expectQty` is the number the person was looking at — if the row has moved
//           since, 409 and nothing changes.
//   · money: the funding target moves by the pairs changed, taxed at the rate of the day
//           (recalcCartMoney's funded branch). No card is touched.
//   · short: when the new target is more than the cards recorded, the person must say
//           whether to ask the gift card desk for the difference (`askCards`). true → the
//           desk's DM (notifyIssuersIfReady, once per amount); false → nothing is sent and
//           a `cards_not_asked` row in History says who held it back, for how much.
//           Closing condition 2 still needs the cards to cover the target either way.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, getBuyCartLine, changeApprovedLineQty, logCartEvent, dbConfigured } from '../_lib/db.js';
import { requirePrivilege, redactCartForViewer } from '../_lib/buycart.js';
import { alertLinesDecided } from '../_lib/alerts.js';
import { notifyIssuersIfReady, notifyLineQtyChanged, issuerAskWhy } from '../_lib/notify.js';
import { qtyChangeRefusedBecause, qtyChangeMoney, cardsAskKey } from '../../src/lib/buycartRules.js';

const d = (n) => `$${(Number(n) || 0).toFixed(2)}`;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'approve_buying',
    'Only somebody who can approve buying can change how many pairs to buy.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const lineId = Number(body.lineId);
  const qty = Number(body.qty);
  const expectQty = Number(body.expectQty);
  if (!Number.isInteger(cartId) || !Number.isInteger(lineId))
    return send(res, 400, { ok: false, error: 'A valid cartId and lineId are required.' });
  if (!Number.isInteger(qty) || qty < 1 || qty > 999)
    return send(res, 400, { ok: false, error: 'Say how many to buy — a whole number from 1 to 999. To drop the pair, the buyer marks it as not buying.' });
  if (!Number.isInteger(expectQty) || expectQty < 1)
    return send(res, 400, { ok: false, error: 'Send the quantity you were changing from (expectQty).' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    const was = await getBuyCartLine(cartId, lineId);
    if (!was) return send(res, 404, { ok: false, error: 'That pair is no longer on the request.' });
    const pair = `${was.sku}${was.size ? ` size ${was.size}` : ''}`;

    const refused = qtyChangeRefusedBecause(cart, was);
    if (refused) return send(res, 409, { ok: false, error: refused });
    if (Number(was.qty) !== expectQty)
      return send(res, 409, { ok: false, error: `${pair} is approved ×${was.qty} now, not ×${expectQty} — someone changed it. Look again before changing it.` });
    if (qty === expectQty)
      return send(res, 200, { ok: true, unchanged: true, line: was, cart: redactCartForViewer(cart, user) });

    // The choice is the person's, not a default: when the cards would come up short they
    // must say whether the desk is asked. Refused before the write, with the figure, so the
    // screen can put the question in front of them.
    const projected = qtyChangeMoney(cart, was, qty);
    const choice = body.askCards === true ? 'asked' : body.askCards === false ? 'not_asked' : null;
    if (projected.short > 0 && cart.funding_method !== 'company_card' && !choice)
      return send(res, 400, {
        ok: false, needsChoice: true, short: projected.short,
        error: `The cards would be short by ${d(projected.short)} — say whether to ask the gift card desk for it now.`,
      });

    const out = await changeApprovedLineQty({ cartId, lineId, qty, expectQty, actor: user });
    if (!out) {
      // Lost a race: read it again and say what it is now.
      const now = await getBuyCartLine(cartId, lineId);
      const cartNow = await getBuyCart(cartId);
      return send(res, 409, {
        ok: false,
        error: qtyChangeRefusedBecause(cartNow, now)
          || `${pair} is approved ×${now?.qty} now — someone changed it a moment ago. Look again before changing it.`,
      });
    }

    const target = Number(out.cart.funding_target) || 0;
    const short = Math.max(0, Math.round((target - (Number(out.cart.gc_total) || 0)) * 100) / 100);
    const ask = { choice: short > 0 && cart.funding_method !== 'company_card' ? choice : null };
    if (ask.choice === 'asked') {
      // Awaited, so the person is told whether the desk actually got it.
      const r = await notifyIssuersIfReady(cartId, { asked: true });
      ask.sent = !!r.sent;
      ask.reason = r.sent ? null : issuerAskWhy(r.reason);
    } else if (ask.choice === 'not_asked') {
      await logCartEvent({
        cartId, kind: 'cards_not_asked', lineId, actor: user,
        body: `${cardsAskKey(short, out.cart.gc_total)} — ${user.name || user.username} chose not to ask the gift card desk yet (${pair} ×${expectQty} → ×${qty}). The request reads short until the cards cover it.`,
      });
    }

    const fresh = await getBuyCart(cartId);
    // The buyer — in the shop, buying — gets the new number the way they get any decision;
    // the group gets the note with what it does to the money.
    alertLinesDecided(fresh, [out.line], user);
    notifyLineQtyChanged(cartId, out.line, user, { from: expectQty, ask: ask.choice });
    return send(res, 200, {
      ok: true, line: out.line, cart: redactCartForViewer(fresh, user),
      money: { before: out.targetBefore, after: target, short }, ask,
    });
  } catch (e) {
    console.error('[cart/line-qty]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change the quantity.' });
  }
}
