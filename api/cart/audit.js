// POST /api/cart/audit  { cartId, scope:'money', cards:[{ id, spent, remaining }] }
// POST /api/cart/audit  { cartId, scope:'goods', note? }
//
// Step 7, and it is TWO sign-offs rather than one.
//
// 7a — THE MONEY. Somebody other than the buyer works out where the funds went: for each
// card, what it was actually spent and what is left sitting on it.
//
// 7b — THE GOODS. The shipment against the receipt. Three lists have to agree — what the
// receipt says was paid for, what the buyer packed into each box, and what the warehouse
// physically counted — and only the middle pair were ever compared. Reconciliation
// checks the manifest against what arrived; the manifest is the buyer's own account of
// what they packed. The receipt against what arrived is the comparison that takes
// nobody's word for anything.
//
// They are kept apart because they are answerable at different times from different
// evidence: the money the day the receipt lands, the goods only once the boxes are in the
// building, which may be weeks. One signature covering both would hold every request open
// for the length of a shipment — and a control people wait weeks to satisfy is a control
// they start working around.
//
// The guard is `requireAuditor`, NOT `requireRole`, and the difference is the whole
// control. requireRole auto-admits anything privileged, which would let the admin who
// approved a request also sign off the audit of that request — one person requesting,
// releasing and verifying, which is exactly the situation the written process says must
// never exist. requireAuditor refuses when the account is the one that approved,
// comparing on the stored user id rather than a display name.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, getBuyCartFull, auditBuyCart, goodsAuditBuyCart, dbConfigured } from '../_lib/db.js';
import { requireAuditPrivilege, cartCloseChecks, allChecksPass } from '../_lib/buycart.js';

const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  // The cart has to be loaded BEFORE the guard runs — the approver-is-not-the-auditor
  // check needs to know who approved it.
  const cart = await getBuyCart(cartId);
  if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
  const user = await requireAuditPrivilege(req, res, cart);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  try {
    const scope = body.scope === 'goods' ? 'goods' : 'money';

    if (scope === 'goods') {
      // The goods audit reads the same conditions the screen renders and `cart/close`
      // enforces, so a person can never sign off a comparison the server would refuse.
      // It signs off the GOODS half only — a shipment can be verified while a gift card
      // balance is still unaccounted for, and saying so is more useful than one opaque
      // "not ready yet".
      const before = await getBuyCartFull(cartId);
      const goods = (await cartCloseChecks(before)).filter((k) => k.scope === 'goods');
      if (!allChecksPass(goods)) {
        const out = goods.filter((k) => !k.ok);
        return send(res, 409, {
          ok: false,
          error: `The shipment doesn’t reconcile yet: ${out.map((k) => (k.detail || k.label).toLowerCase()).join('; ')}`,
          checks: await cartCloseChecks(before),
        });
      }
      await goodsAuditBuyCart({ cartId, note: String(body.note ?? '').trim().slice(0, 500) || null, actor: user });
      const full = await getBuyCartFull(cartId);
      return send(res, 200, { ok: true, cart: full, checks: await cartCloseChecks(full) });
    }

    if (!['receipted', 'audited'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'There is nothing to audit until the receipt has been read in.' });

    // A card-funded request has no cards to count. What replaces this audit there is the
    // authorised charge against the receipt, which `cart/control` records and the closing
    // conditions check — so refuse rather than write an empty audit over the top of it.
    if ((cart.funding_method || 'gift_card') === 'company_card')
      return send(res, 409, { ok: false, error: 'This request was funded by company card — record the authorised charge instead of card balances.' });

    const cards = (Array.isArray(body.cards) ? body.cards : []).slice(0, 200)
      .map((c) => ({ id: Number(c.id), spent: money(c.spent), remaining: money(c.remaining) }))
      .filter((c) => Number.isInteger(c.id));
    if (!cards.length) return send(res, 400, { ok: false, error: 'Record what each card was spent.' });
    // Both numbers per card, or neither means anything. "Spent $180" with no remaining
    // balance leaves the closing condition unanswerable, and a remaining balance with no
    // spend says money moved but not where.
    if (cards.some((c) => c.spent == null || c.remaining == null))
      return send(res, 400, { ok: false, error: 'Every card needs both what it was spent and what is left on it.' });

    await auditBuyCart({ cartId, cards, actor: user });
    const full = await getBuyCartFull(cartId);
    return send(res, 200, { ok: true, cart: full, checks: await cartCloseChecks(full) });
  } catch (e) {
    console.error('[cart/audit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record the audit.' });
  }
}
