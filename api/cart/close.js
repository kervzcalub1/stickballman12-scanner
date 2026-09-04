// POST /api/cart/close  { cartId }         -> { ok, cart }
// POST /api/cart/close  { cartId, cancel:true, reason } -> cancel an un-funded request
//
// Step 10, and the point of the whole thing: a transaction is NOT complete because the
// gift cards were spent. It is complete when every one of the ten conditions is true in
// the data — approved, cards recorded, receipt received and read, spending reconciled,
// inventory expected, shipped, physically received, matching, balance accounted for.
//
// The checks are re-evaluated HERE, server-side, against the same function the screen
// renders. A gate that only exists in the UI is a gate that a stale tab walks through.
//
// There is deliberately NO override. That is a decision with a cost worth stating: a
// genuinely lost receipt leaves a request open indefinitely. The alternative — a
// force-close button — is the escape hatch that every control like this eventually
// leaks through, and it can be added later far more easily than it could be taken away.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBuyCart, getBuyCartFull, closeBuyCart, cancelBuyCart, dbConfigured } from '../_lib/db.js';
import { requireAuditor, cartCloseChecks, allChecksPass, CAN_APPROVE } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  const cart = await getBuyCart(cartId);
  if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });

  // Cancelling is a different act from closing: it ends a request BEFORE any money
  // moved, so it needs no reconciliation and no auditor — just somebody who could have
  // approved it. Once cards exist there is money to account for and this path is shut.
  if (body.cancel) {
    const user = requireRole(req, res, CAN_APPROVE);
    if (!user) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
      return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    const out = await cancelBuyCart(cartId, String(body.reason ?? '').trim().slice(0, 500) || null, user);
    if (!out) return send(res, 409, { ok: false, error: 'Cards have already been issued against this request — it has to be reconciled, not cancelled.' });
    return send(res, 200, { ok: true, cart: out });
  }

  const user = requireAuditor(req, res, cart);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  try {
    if (cart.status === 'closed') return send(res, 409, { ok: false, error: 'This request is already closed.' });
    const full = await getBuyCartFull(cartId);
    const checks = await cartCloseChecks(full);
    if (!allChecksPass(checks)) {
      const outstanding = checks.filter((c) => !c.ok);
      return send(res, 409, {
        ok: false,
        // Name what is missing, not just that something is. A refusal with no detail is
        // what teaches people to route around a process rather than finish it.
        error: `${outstanding.length} of the 10 checks are still outstanding: ${outstanding.map((c) => c.label.toLowerCase()).join('; ')}.`,
        checks,
      });
    }
    const out = await closeBuyCart(cartId, user);
    return send(res, 200, { ok: true, cart: out, checks });
  } catch (e) {
    console.error('[cart/close]', e.message);
    return send(res, 500, { ok: false, error: 'Could not close that request.' });
  }
}
