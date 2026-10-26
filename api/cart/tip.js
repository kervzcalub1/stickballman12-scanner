// POST /api/cart/tip  { cartId, sku, action:'approve'|'decline', amount? }  -> { ok, outcome, lines }
//
// The desk's answer to a PREMIUM shoe's proposed tip (docs/context/buy-cart.md "Premium
// shoes"). Every size of that SKU on the request at once — the buyer proposed it for the
// shoe, not a size. `amount` approves a different figure than the one proposed. Same
// privilege as approving the pairs (`approve_buying`), and the same `decideTip` a Telegram
// "tip ok" reply runs, so the two can't record it differently.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCartFull, dbConfigured } from '../_lib/db.js';
import { requirePrivilege, decideTip } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'approve_buying'); // admin/superadmin implicit
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const sku = String(body.sku ?? '').trim().toUpperCase();
  if (!Number.isInteger(cartId) || !sku) return send(res, 400, { ok: false, error: 'A cartId and a SKU are required.' });
  const action = body.action === 'decline' ? 'decline' : 'approve';
  const amount = body.amount == null || String(body.amount).trim() === '' ? null : Number(body.amount);

  try {
    const cart = await getBuyCartFull(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    const lines = (cart.lines || []).filter((l) => String(l.sku || '').toUpperCase() === sku);
    const out = await decideTip({ cart, lines, action, amount, actor: user });
    if (out.error) return send(res, out.code, { ok: false, error: out.error });
    return send(res, 200, { ok: true, outcome: out.outcome, lines: out.lines });
  } catch (e) {
    console.error('[cart/tip]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record the tip answer.' });
  }
}
