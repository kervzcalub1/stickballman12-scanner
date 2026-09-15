// POST /api/cart/receipt  { cartId, lines:[…], receiptTotal }  -> { ok, cart }
//
// Step 5 committing: the REVIEWED lines, after a person has looked at them. The parse
// itself happens on the client (src/lib/receiptParse.js) against an editable table —
// deliberately, because a receipt read wrong is a reconciliation that balances against
// the wrong number, and OCR on a thermal receipt will mis-read a digit sooner or later.
//
// The buyer commits their own; staff can do it for them, which is the ordinary case
// when a buyer photographs a receipt and sends it on.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, getBuyCartFull, setBuyCartReceiptLines, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo, redactCartForViewer, requireBuyerAccess } from '../_lib/buycart.js';

const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
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
    if (user.role === 'supplier' && !isPrivileged(user.role) && Number(cart.buyer_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    if (!['funded', 'receipted'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'A receipt belongs to a request that has been funded.' });

    const lines = (Array.isArray(body.lines) ? body.lines : []).slice(0, 300).map((l) => ({
      sku: String(l.sku ?? '').trim().toUpperCase().slice(0, 40) || null,
      size: String(l.size ?? '').trim().slice(0, 20) || null,
      qty: Number.isInteger(Number(l.qty)) && Number(l.qty) > 0 ? Math.min(Number(l.qty), 999) : 1,
      name: String(l.name ?? '').trim().slice(0, 200) || null,
      unitPrice: money(l.unitPrice), totalPrice: money(l.totalPrice),
      source: ['pdf', 'ocr', 'paste', 'manual', 'email'].includes(l.source) ? l.source : 'manual',
    }));
    if (!lines.length) return send(res, 400, { ok: false, error: 'No receipt lines to record.' });

    // A line with no SKU is REFUSED, not dropped (2026-09-11).
    //
    // It used to be silently filtered out here, which was survivable while the receipt
    // was only a pick list. It is not now: these lines become the purchase order's
    // order-level list — what we are owed — so a row quietly discarded at save time is a
    // pair the order never expects, never counts short, and nobody ever chases. That is
    // the exact invisibility putting the receipt on the order exists to remove.
    //
    // A shop till frequently prints no style code (`buy-cart.md`), so this is the common
    // case rather than an edge one, and the person is looking at the review table right
    // now — which is the cheapest possible moment to fix it.
    const nameless = lines.filter((l) => !l.sku);
    if (nameless.length)
      return send(res, 400, {
        ok: false,
        error: `${nameless.length} line${nameless.length === 1 ? '' : 's'} on this receipt ${nameless.length === 1 ? 'has' : 'have'} no SKU. Fill in the style code, or delete the row if it is not a shoe — a till often prints no code at all.`,
      });

    // The receipt's own stated total wins over our sum of its rows, and the client sends
    // whichever the reviewer confirmed. It is what every later figure reconciles to, so
    // it must be a number somebody looked at rather than one we derived quietly.
    const receiptTotal = money(body.receiptTotal);
    if (receiptTotal == null) return send(res, 400, { ok: false, error: 'Enter the receipt total.' });

    const full = // The breakdown is optional — plenty of tills print no tax line, and a receipt with
    // no subtotal is still a receipt. Absent stays ABSENT rather than becoming 0: a
    // stored zero would read as "the shop charged no tax", which is a claim.
    await setBuyCartReceiptLines({
      cartId, lines, receiptTotal,
      subtotal: money(body.subtotal), tax: money(body.tax),
      actor: user,
    });
    return send(res, 200, { ok: true, cart: redactCartForViewer(full, user) });
  } catch (e) {
    console.error('[cart/receipt]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that receipt.' });
  }
}
