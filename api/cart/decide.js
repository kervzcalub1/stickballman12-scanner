// POST /api/cart/decide  { cartId, action:'approve'|'reject', lineIds?:[…], all?, reason? }
//   -> { ok, decided, cart }
//
// Step 2. EITHER staff side decides — warehouse/admin or PH — one line at a time or
// every pending line at once. Approval is deliberately not held to a single named
// account: the people who know whether a pair is worth buying are the floor and the
// pricing desk, and a buyer standing in a shop at 11pm waiting on one person is how a
// process gets worked around instead of followed.
//
// The BUYER is excluded, and structurally so: `supplier` is not in the role list, and
// requireRole does not auto-admit it. Approving your own request is the thing the whole
// process exists to make impossible.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBuyCart, decideBuyCartLines, dbConfigured } from '../_lib/db.js';
import { CAN_APPROVE } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, CAN_APPROVE); // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const action = body.action === 'reject' ? 'reject' : 'approve';
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (cart.status === 'draft')
      return send(res, 409, { ok: false, error: 'The buyer has not sent this request yet.' });
    // Once cards have been issued the approvals are what the money was released
    // against. Re-deciding a line somebody has already been funded for would leave the
    // spend and the approval describing two different things.
    if (['funded', 'receipted', 'audited', 'closed', 'cancelled'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'Gift cards have already been issued against this request — its approvals are frozen.' });

    const lineIds = body.all ? null : (Array.isArray(body.lineIds) ? body.lineIds : []);
    if (!body.all && (!lineIds || !lineIds.length))
      return send(res, 400, { ok: false, error: 'Pick at least one line, or use approve-all.' });

    const out = await decideBuyCartLines({
      cartId, lineIds: body.all ? null : lineIds, action,
      reason: String(body.reason ?? '').trim().slice(0, 500) || null, actor: user,
    });
    if (!out.decided)
      return send(res, 409, { ok: false, error: 'Nothing was still awaiting a decision — someone may have got there first.' });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[cart/decide]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that decision.' });
  }
}
