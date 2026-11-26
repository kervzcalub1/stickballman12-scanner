// POST /api/buy-log/proof-sign  { id, contentType } -> { ok, uploadUrl, publicUrl, key }
// A presigned R2 PUT for the screenshot of a payment on a Buy Log order (docs/context/buy-log.md).
// Whoever may open the order may add one: the supplier (their own order) or PH / admin.
import crypto from 'node:crypto';
import { send, applySecurity, rateLimit, getJsonBody } from '../_lib/util.js';
import { dbConfigured, getBuyLogOwner } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl } from '../_lib/r2.js';
import { buyLogUser, isSupplier, canManage, ownsBuy, idOf } from './_shared.js';

const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await buyLogUser(req, res);
  if (!user) return;
  if (!isSupplier(user) && !canManage(user)) return send(res, 403, { ok: false, error: 'You can read the buy log, not change it.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 40 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const body = await getJsonBody(req);
  const id = idOf(body.id);
  if (!id) return send(res, 400, { ok: false, error: 'Which order?' });
  try {
    if (!ownsBuy(res, user, await getBuyLogOwner(id))) return;
    if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });
    const contentType = EXT[body.contentType] ? body.contentType : 'image/jpeg';
    const key = `buy-log/order-${id}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${EXT[contentType]}`;
    return send(res, 200, { ok: true, uploadUrl: presignPutUrl({ key, expiresIn: 300 }), publicUrl: publicUrl(key), key });
  } catch (e) {
    console.error('[buy-log/proof-sign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare the upload.' });
  }
}
