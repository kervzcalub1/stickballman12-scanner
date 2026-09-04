// POST /api/cart/comment  { cartId, body }  -> { ok, event }
// The thread on a buying request: the questions an approver asks before saying yes, and
// what the answer was. Append-only, like the PO thread, and visible to the buyer —
// "ask the buyer what they are buying" is step one of the process, and it needs
// somewhere to happen that isn't a chat app nobody can audit later.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getBuyCart, logCartEvent, dbConfigured } from '../_lib/db.js';
import { cartVisibleTo } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team', 'gc_issuer', 'auditor']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const b = await getJsonBody(req);
  const cartId = Number(b.cartId);
  const text = String(b.body ?? '').trim().slice(0, 2000);
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
  if (!text) return send(res, 400, { ok: false, error: 'Write something first.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, cart)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    const event = await logCartEvent({ cartId, kind: 'comment', body: text, actor: user });
    return send(res, 200, { ok: true, event });
  } catch (e) {
    console.error('[cart/comment]', e.message);
    return send(res, 500, { ok: false, error: 'Could not post that.' });
  }
}
