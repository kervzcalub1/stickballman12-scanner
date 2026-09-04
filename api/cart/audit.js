// POST /api/cart/audit  { cartId, cards:[{ id, spent, remaining }] }  -> { ok, cart, checks }
//
// Step 7. Somebody other than the buyer works out where the money went: for each card,
// what it was actually spent and what is left sitting on it.
//
// The guard is `requireAuditor`, NOT `requireRole`, and the difference is the whole
// control. requireRole auto-admits anything privileged, which would let the admin who
// approved a request also sign off the audit of that request — one person requesting,
// releasing and verifying, which is exactly the situation the written process says must
// never exist. requireAuditor refuses when the account is the one that approved,
// comparing on the stored user id rather than a display name.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, getBuyCartFull, auditBuyCart, dbConfigured } from '../_lib/db.js';
import { requireAuditPrivilege, cartCloseChecks } from '../_lib/buycart.js';

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
    if (!['receipted', 'audited'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'There is nothing to audit until the receipt has been read in.' });

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
