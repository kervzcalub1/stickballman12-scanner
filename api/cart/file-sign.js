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
import { hasPrivilege, requireBuyerAccess } from '../_lib/buycart.js';

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'application/pdf': 'pdf',
};

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured (R2 env vars missing).' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const kind = ['receipt', 'shoe'].includes(body.kind) ? body.kind : 'gift_card';
  // A shoe photo hangs off the STYLE CODE, not the line: a buyer sending five sizes of
  // one shoe photographs it once, and every line carrying that SKU shows the same shots.
  const sku = kind === 'shoe' ? String(body.sku ?? '').trim().toUpperCase().slice(0, 40) : null;
  const contentType = EXT[body.contentType] ? body.contentType : null;
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });
  if (!contentType) return send(res, 400, { ok: false, error: 'Upload a photo or a PDF.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
    if (isBuyer && Number(cart.buyer_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // A RECEIPT is open to every role this endpoint admits — the buyer, PH, warehouse
    // and admin. Whoever has the paper should be able to attach it; holding that behind
    // one desk is how a request sits waiting on somebody in another timezone. What it
    // SAYS is a separate act, gated separately (`cart/receipt`).
    // A card image is a card. Uploading one is the issuing desk's job and needs the
    // privilege — crossing them would let anyone add "gift cards" nobody issued, which
    // is a line in the ledger with no money behind it.
    // A SHOE PHOTO is the buyer's evidence of what they found, so it is open on the same
    // terms as a receipt. Only a card image needs the desk.
    if (kind === 'gift_card' && !(await hasPrivilege(user, 'issue_gift_cards')))
      return send(res, 403, { ok: false, error: 'Only the gift card desk uploads card images.' });
    // A finished request takes no more evidence. `closed` alone left a cancelled or
    // written-off one still accepting uploads, which is a file attached to a record
    // nobody will ever read again.
    if (['closed', 'cancelled', 'written_off'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'This request is finished — it takes no more files.' });

    const key = `buy-carts/${cart.cart_code}/${kind}-${Date.now()}.${EXT[contentType]}`;
    return send(res, 200, { ok: true, uploadUrl: presignPutUrl({ key, expiresIn: 300 }), key });
  } catch (e) {
    console.error('[cart/file-sign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare that upload.' });
  }
}
