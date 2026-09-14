// POST /api/cart/close  { cartId }                         -> { ok, cart }
// POST /api/cart/close  { cartId, cancel:true, reason }     -> cancel an un-funded request
// POST /api/cart/close  { cartId, writeOff:true, reason }   -> a documented loss
//
// Step 10, and the point of the whole thing: a transaction is NOT complete because the
// gift cards were spent. It is complete when every one of the ten conditions is true in
// the data — approved, cards recorded, receipt received and read, spending reconciled,
// inventory expected, shipped, physically received, matching, balance accounted for.
//
// The checks are re-evaluated HERE, server-side, against the same function the screen
// renders. A gate that only exists in the UI is a gate that a stale tab walks through.
//
// There is deliberately no way to CLOSE this without every condition being true. What
// there is instead is a third ending, and it is not the same thing as an override.
//
// A genuinely lost receipt used to leave a request open forever, and the pressure that
// creates is pressure to record a false "received" or "refunded" instead — which is
// worse than either honest outcome. WRITE-OFF says out loud that the company took a
// loss: its own status, a required reason, a name against it, and a word that reads
// differently from `closed` everywhere it is shown. It is a documented management
// decision, not a way past the checks.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, getBuyCartFull, closeBuyCart, cancelBuyCart, writeOffBuyCart, dbConfigured } from '../_lib/db.js';
import { requireAuditPrivilege, cartCloseChecks, allChecksPass, requirePrivilege, redactCartForViewer } from '../_lib/buycart.js';

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
    const user = await requirePrivilege(req, res, 'approve_buying');
    if (!user) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
      return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    const out = await cancelBuyCart(cartId, String(body.reason ?? '').trim().slice(0, 500) || null, user);
    if (!out) return send(res, 409, { ok: false, error: 'Cards have already been issued against this request — it has to be reconciled, not cancelled.' });
    return send(res, 200, { ok: true, cart: redactCartForViewer(out, user) });
  }

  // A write-off ends a request that can never be completed. Same guard as closing it —
  // the account that approved the spend cannot be the one that declares it a loss.
  if (body.writeOff) {
    const user = await requireAuditPrivilege(req, res, cart);
    if (!user) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 10 }))
      return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    const reason = String(body.reason ?? '').trim().slice(0, 1000);
    // The reason IS the control. A write-off with no account of what was lost and why
    // is indistinguishable from a force-close, which is the thing this is not.
    if (reason.length < 10)
      return send(res, 400, { ok: false, error: 'Say what could not be recovered and why — a write-off with no reason is just a force-close.' });
    const out = await writeOffBuyCart({ cartId, reason, actor: user });
    if (!out) return send(res, 409, { ok: false, error: 'This request is already finished.' });
    return send(res, 200, { ok: true, cart: redactCartForViewer(out, user) });
  }

  const user = await requireAuditPrivilege(req, res, cart);
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
        error: `${outstanding.length} of the ${checks.length} checks are still outstanding: ${outstanding.map((c) => c.label.toLowerCase()).join('; ')}.`,
        checks,
      });
    }
    const out = await closeBuyCart(cartId, user);
    return send(res, 200, { ok: true, cart: redactCartForViewer(out, user), checks });
  } catch (e) {
    console.error('[cart/close]', e.message);
    return send(res, 500, { ok: false, error: 'Could not close that request.' });
  }
}
