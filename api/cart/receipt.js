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
import { cartVisibleTo } from '../_lib/buycart.js';

const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
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
      source: ['pdf', 'ocr', 'paste', 'manual'].includes(l.source) ? l.source : 'manual',
    })).filter((l) => l.sku);
    if (!lines.length) return send(res, 400, { ok: false, error: 'No receipt lines to record.' });

    // The receipt's own stated total wins over our sum of its rows, and the client sends
    // whichever the reviewer confirmed. It is what every later figure reconciles to, so
    // it must be a number somebody looked at rather than one we derived quietly.
    const receiptTotal = money(body.receiptTotal);
    if (receiptTotal == null) return send(res, 400, { ok: false, error: 'Enter the receipt total.' });

    const full = await setBuyCartReceiptLines({ cartId, lines, receiptTotal, actor: user });
    return send(res, 200, { ok: true, cart: full });
  } catch (e) {
    console.error('[cart/receipt]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that receipt.' });
  }
}
