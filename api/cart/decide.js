// POST /api/cart/decide  { cartId, action:'approve'|'reject', lineIds?:[…], all?, reason? }
//   -> { ok, decided, cart }
//
// Step 2. Deciding what company funds may be spent on is a PRIVILEGE
// (`approve_buying`), not a job title — held by whoever the admin has ticked, on top of
// whatever role they do. It is checked against the database on every call, so removing
// it from somebody stops them at once rather than at their next sign-in.
//
// The BUYER is excluded structurally: a `supplier` account can hold no privilege at all
// (db-setup strips any that are set, and `hasPrivilege` refuses the role outright).
// Approving your own request is the thing the whole process exists to make impossible.
import { getJsonBody, send, applySecurity, rateLimit } from '../_lib/util.js';
import { getBuyCart, dbConfigured } from '../_lib/db.js';
import { requirePrivilege, decideLines } from '../_lib/buycart.js';

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
  const action = body.action === 'reject' ? 'reject' : 'approve';
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });

    const qtyById = {};
    for (const [k, v] of Object.entries(body.qty && typeof body.qty === 'object' ? body.qty : {})) {
      const id = Number(k); const n = Number(v);
      if (Number.isInteger(id) && Number.isInteger(n) && n > 0 && n <= 999) qtyById[id] = n;
    }
    const qtyAll = Number.isInteger(Number(body.qtyAll)) && Number(body.qtyAll) > 0
      ? Math.min(Number(body.qtyAll), 999) : null;

    // Everything from here is shared with `cart/telegram-decide` — see `decideLines`.
    const out = await decideLines({
      cart, action, all: !!body.all,
      lineIds: Array.isArray(body.lineIds) ? body.lineIds : [],
      qtyById, qtyAll, reason: body.reason, actor: user,
    });
    if (out.error) return send(res, out.code, { ok: false, error: out.error });
    return send(res, 200, { ok: true, ...out });
  } catch (e) {
    console.error('[cart/decide]', e.message);
    return send(res, 500, { ok: false, error: 'Could not record that decision.' });
  }
}
