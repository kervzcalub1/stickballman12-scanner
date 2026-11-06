// POST /api/cart/file-attach  { cartId, kind, key, name?, contentType?, sizeBytes? }
//   -> { ok, file }
// Records a file this server minted a key for, after the client has PUT the bytes.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, addBuyCartFile, queueCardRead, dbConfigured } from '../_lib/db.js';
import { getObject, deleteObject } from '../_lib/r2.js';
import { sniffImageFormat } from '../_lib/imgformat.js';
import { hasPrivilege, requireBuyerAccess } from '../_lib/buycart.js';
import { kickCardReads } from '../_lib/gc-read-worker.js';

// What's wrong with a shoe photo, by its bytes rather than the type the browser claimed, or
// null. HEIC is refused because browsers can't show it and the Telegram card can't resize it.
export function shoePhotoProblem(buf) {
  const format = sniffImageFormat(buf);
  if (format === 'heic') return 'This photo is in HEIC format, which the desk can’t open. Take it with the camera here, or save it as a JPEG.';
  if (!['jpeg', 'png', 'webp'].includes(format)) return 'That file isn’t a photo the desk can open. Take it again.';
  return null;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!(await requireBuyerAccess(req, res, user))) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const kind = ['receipt', 'shoe'].includes(body.kind) ? body.kind : 'gift_card';
  // A shoe photo hangs off the STYLE CODE, not the line: a buyer sending five sizes of
  // one shoe photographs it once, and every line carrying that SKU shows the same shots.
  const sku = kind === 'shoe' ? String(body.sku ?? '').trim().toUpperCase().slice(0, 40) : null;
  const key = String(body.key ?? '').trim();
  if (!Number.isInteger(cartId)) return send(res, 400, { ok: false, error: 'A valid cartId is required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    const isBuyer = user.role === 'supplier' && !isPrivileged(user.role);
    if (isBuyer && Number(cart.buyer_user_id) !== Number(user.uid))
      return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // A card image is a card. Uploading one is the issuing desk's job and needs the
    // privilege — crossing them would let anyone add "gift cards" nobody issued, which
    // is a line in the ledger with no money behind it.
    // A SHOE PHOTO is the buyer's evidence of what they found, so it is open on the same
    // terms as a receipt. Only a card image needs the desk.
    if (kind === 'gift_card' && !(await hasPrivilege(user, 'issue_gift_cards')))
      return send(res, 403, { ok: false, error: 'Only the gift card desk uploads card images.' });
    if (['closed', 'cancelled', 'written_off'].includes(cart.status))
      return send(res, 409, { ok: false, error: 'This request is finished — it takes no more files.' });
    // Only a key THIS server minted, and only under this cart's own prefix. Without the
    // cart_code in the pattern, an attach could point one request's record at another
    // request's file.
    const re = new RegExp(`^buy-carts/${cart.cart_code}/(gift_card|receipt|shoe)-\\d+\\.(jpg|png|webp|heic|pdf|csv|zip)$`);
    if (!re.test(key) || (/\.(csv|zip)$/.test(key) && kind !== 'gift_card')) return send(res, 400, { ok: false, error: 'Invalid file key.' });

    if (kind === 'shoe') {
      if (!sku) return send(res, 400, { ok: false, error: 'Which shoe is this a photo of?' });
      // A row isn't a photo: the desk has to be able to open it. Read what actually landed.
      let problem;
      try { problem = shoePhotoProblem(await getObject(key)); }
      catch { problem = 'The photo did not reach storage. Take it again.'; }
      if (problem) {
        await deleteObject(key).catch(() => {});
        return send(res, 400, { ok: false, error: problem });
      }
    }

    const file = await addBuyCartFile({
      cartId, kind, key, sku,
      name: String(body.name ?? '').trim().slice(0, 200) || null,
      contentType: String(body.contentType ?? '').slice(0, 100) || null,
      sizeBytes: Number.isInteger(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null,
      actor: user,
    });
    // Nobody presses anything per file: reading starts on the server the moment it lands.
    // Best-effort: the file is saved either way, and the screen offers to read what wasn't.
    if (kind === 'gift_card') {
      try { await queueCardRead(cartId, Number(file.id), user); kickCardReads(); }
      catch (e) { console.warn('[cart/file-attach] could not queue the read:', e.message); }
    }
    return send(res, 200, { ok: true, file });
  } catch (e) {
    console.error('[cart/file-attach]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save that file.' });
  }
}
