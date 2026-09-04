// POST /api/cart/file-sign  { cartId, kind:'gift_card'|'receipt', contentType, name? }
//   -> { ok, uploadUrl, key }
//
// A short-lived presigned R2 PUT so the phone sends the bytes straight to storage and
// this server never handles them — the same shape as the listing-photo upload.
//
// What is DIFFERENT here, and it matters: the returned key is never a public URL. A
// gift card photo is a spendable code and a receipt carries a purchase history, so the
// bucket must not serve either by URL. Reading one back goes through api/cart/file.js,
// which authorises the request first (the courier-label rule, purchase-orders.md).
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, dbConfigured } from '../_lib/db.js';
import { presignPutUrl, r2Configured } from '../_lib/r2.js';
import { hasPrivilege } from '../_lib/buycart.js';

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'application/pdf': 'pdf',
};

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured (R2 env vars missing).' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const kind = body.kind === 'receipt' ? 'receipt' : 'gift_card';
  const contentType = EXT[body.contentType] ? body.contentType : null;
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
  if (!contentType) return send(res, 400, { ok: false, error: 'Upload a photo or a PDF.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
    if (isBuyer && Number(cart.buyer_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // The receipt is the buyer's evidence and the cards are the issuer's. Crossing them
    // would let a buyer add "gift cards" nobody issued, which is a line in the ledger
    // with no money behind it.
    // A card image is a card. Uploading one is the issuing desk's job and needs the
    // privilege — crossing them would let anyone add "gift cards" nobody issued, which
    // is a line in the ledger with no money behind it.
    if (kind !== 'receipt' && !(await hasPrivilege(user, 'issue_gift_cards')))
      return send(res, 403, { ok: false, error: 'Only the gift card desk uploads card images.' });
    if (cart.status === 'closed') return send(res, 409, { ok: false, error: 'This request is closed.' });

    const key = `buy-carts/${cart.cart_code}/${kind}-${Date.now()}.${EXT[contentType]}`;
    return send(res, 200, { ok: true, uploadUrl: presignPutUrl({ key, expiresIn: 300 }), key });
  } catch (e) {
    console.error('[cart/file-sign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare that upload.' });
  }
}
