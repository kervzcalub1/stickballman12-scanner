// GET /api/cart/file?cartId=…&fileId=…[&download=1]  -> the bytes
//
// Proxied, never a bucket URL. A gift card photo IS the code, and a receipt is a record
// of company spending — so every read is a request this server authorises first, and
// the R2 signature never leaves the process. Same rule, same reason as the courier
// labels (docs/context/purchase-orders.md).
//
// Inline by default so the viewer can page through card photos left and right;
// `download=1` forces the save, which is what a PDF receipt usually wants.
import { send, applySecurity, rateLimit, requireRole, isPrivileged } from '../_lib/util.js';
import { getBuyCart, getBuyCartFile, dbConfigured } from '../_lib/db.js';
import { getObject, r2Configured } from '../_lib/r2.js';

const TYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'File storage is not configured.' });

  const params = new URL(req.url, 'http://x').searchParams;
  const cartId = Number(params.get('cartId'));
  const fileId = Number(params.get('fileId'));
  if (!Number.isInteger(cartId) || !Number.isInteger(fileId))
    return send(res, 400, { ok: false, error: 'A valid cartId and fileId are required.' });

  try {
    const cart = await getBuyCart(cartId);
    if (!cart) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (user.role === 'supplier' && !isPrivileged(user.role)) {
      if (Number(cart.buyer_user_id) !== Number(user.uid))
        return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
      // Same rule as revealing a pasted code: a photograph of a card is the card.
      if (params.get('kind') !== 'receipt' && !['funded', 'receipted', 'audited', 'closed'].includes(cart.status))
        return send(res, 409, { ok: false, error: 'These cards have not been released to you yet.' });
    }
    const file = await getBuyCartFile(cartId, fileId);
    if (!file) return send(res, 404, { ok: false, error: 'That file does not exist.' });

    const bytes = await getObject(file.r2_key);
    const ext = String(file.r2_key).split('.').pop().toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', file.content_type || TYPE[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes.length));
    const name = (file.name || `${cart.cart_code}-${file.kind}.${ext}`).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', `${params.get('download') ? 'attachment' : 'inline'}; filename="${name}"`);
    // A spendable code must never sit in a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  } catch (e) {
    console.error('[cart/file]', e.message);
    return send(res, 500, { ok: false, error: 'Could not fetch that file.' });
  }
}
