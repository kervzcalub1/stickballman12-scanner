// POST /api/cart/receipt-remove  { cartId, lineIds:[…], reason }          -> { ok, cart }
//                                { cartId, lineIds:[…], restore:true }    -> { ok, cart }
//
// Shoes on the receipt that are not ours: the cashier rang the buyer's own pairs up with
// the approved ones, so the receipt and its total carry shoes we never paid for.
//
// The auditor or the approver only, never the buyer: taking a row off lowers what the buyer
// has to account for. The row stays on the record with who and why, and can be put back.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange } from '../_lib/util.js';
import { getBuyCartFull, setBuyCartReceiptLinesRemoved, dbConfigured } from '../_lib/db.js';
import { hasPrivilege, redactCartForViewer } from '../_lib/buycart.js';
import { receiptAfterRemoval } from '../../src/lib/buycartRules.js';

const key = (a, b) => `${String(a ?? '').trim().toUpperCase()}|${String(b ?? '').trim().toUpperCase()}`;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  if (!(await hasPrivilege(user, 'audit_buying')) && !(await hasPrivilege(user, 'approve_buying')))
    return send(res, 403, { ok: false, error: 'Only the auditor or an approver can take shoes off a receipt.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const lineIds = (Array.isArray(body.lineIds) ? body.lineIds : []).slice(0, 300).map(Number).filter(Number.isInteger);
  if (!Number.isInteger(cartId) || !lineIds.length)
    return send(res, 400, { ok: false, error: 'Tick the shoes first.' });
  const restore = body.restore === true;
  const reason = String(body.reason ?? '').trim().slice(0, 200);
  if (!restore && reason.length < 3)
    return send(res, 400, { ok: false, error: 'Say why these shoes are not ours. It stays on the record.' });

  try {
    const cart = await getBuyCartFull(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (['closed', 'cancelled', 'written_off'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'This request has ended, so its receipt can no longer change.' });

    const ids = new Set(lineIds);
    const pool = restore ? cart.removedReceiptLines : cart.receiptLines;
    const moving = pool.filter((l) => ids.has(Number(l.id)));
    if (moving.length !== ids.size)
      return send(res, 404, { ok: false, error: restore ? 'That row is already on the receipt.' : 'That row is not on this receipt any more. Refresh and try again.' });

    if (!restore) {
      if (moving.length === cart.receiptLines.length)
        return send(res, 409, { ok: false, error: 'That would leave nothing on the receipt. Keep at least one row.' });
      // A share of the total can't be worked out with a price missing.
      const { unpriced } = receiptAfterRemoval({
        total: cart.receipt_total, lines: [...cart.receiptLines, ...cart.removedReceiptLines], removedIds: [],
      });
      if (unpriced.length)
        return send(res, 409, { ok: false, error: `${unpriced.length} row${unpriced.length === 1 ? ' has' : 's have'} no price, so the total can't be worked out. Correct the receipt first.` });
      // A pair on a box's packing list is on its way to us, so it isn't the buyer's own.
      const going = new Map();
      for (const l of moving) going.set(key(l.sku, l.size), (going.get(key(l.sku, l.size)) || 0) + (Number(l.qty) || 0));
      for (const r of cart.pack?.rows || []) {
        const n = going.get(key(r.sku, r.size));
        if (n && r.packed > r.qty - n)
          return send(res, 409, { ok: false, error: `${r.sku} size ${r.size || '—'} is on a box's packing list (${r.packed} packed), and only ${r.qty - n} would be left on the receipt. Take it off the box first, or check whether it really is the buyer's own.` });
      }
    }

    const full = await setBuyCartReceiptLinesRemoved({ cartId, lineIds, restore, reason: reason || null, actor: user });
    if (!full) return send(res, 409, { ok: false, error: 'Nothing changed. Someone may have got there first.' });
    return send(res, 200, { ok: true, cart: redactCartForViewer(full, user) });
  } catch (e) {
    console.error('[cart/receipt-remove]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change the receipt.' });
  }
}
