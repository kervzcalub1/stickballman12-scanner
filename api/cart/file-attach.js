// POST /api/cart/file-attach  { cartId, kind, key, name?, contentType?, sizeBytes? }
//   -> { ok, file }
// Records a file this server minted a key for, after the client has PUT the bytes.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, addBuyCartFile, dbConfigured } from '../_lib/db.js';
import { CAN_ISSUE_CARDS } from '../_lib/buycart.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, [...CAN_ISSUE_CARDS, 'supplier', 'warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const kind = body.kind === 'receipt' ? 'receipt' : 'gift_card';
  const key = String(body.key ?? '').trim();
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
    if (isBuyer && Number(cart.buyer_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    if (isBuyer && kind !== 'receipt')
      return send(res, 403, { ok: false, error: 'Only the gift card desk uploads card images.' });
    // Only a key THIS server minted, and only under this cart's own prefix. Without the
    // cart_code in the pattern, an attach could point one request's record at another
    // request's file.
    const re = new RegExp(`^buy-carts/${cart.cart_code}/(gift_card|receipt)-\\d+\\.(jpg|png|webp|heic|pdf)$`);
    if (!re.test(key)) return send(res, 400, { ok: false, error: 'Invalid file key.' });

    const file = await addBuyCartFile({
      cartId, kind, key,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      contentType: String(body.contentType ?? '').slice(0, 100) || null,
      sizeBytes: Number.isInteger(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null,
      actor: user,
    });
    return send(res, 200, { ok: true, file });
  } catch (e) {
    console.error('[cart/file-attach]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that file.' });
  }
}
