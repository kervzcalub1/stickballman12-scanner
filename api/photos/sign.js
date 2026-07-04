// POST /api/photos/sign  { sku, angle, contentType } -> { ok, uploadUrl, publicUrl, key }
// Mint a short-lived presigned R2 PUT URL so the client uploads the image bytes
// straight to Cloudflare R2 (the Node server never handles the file). The client
// then calls /api/photos/attach with the returned publicUrl.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl } from '../_lib/r2.js';
import { photoSourceForRole } from '../_lib/photos.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const ANGLES = ['side', 'diagonal', 'outsole', 'top', 'rear'];
const PH_EXTRA = ['extra1', 'extra2']; // PH-only extra images (viewer/download, never a thumbnail)
const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Warehouse shoots raw ('warehouse'); PH uploads edits ('ph_edited'); admin either.
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });

  const body = await getJsonBody(req);
  const source = photoSourceForRole(user.role, body.source);
  if (!source) return send(res, 403, { ok: false, error: 'You can’t manage that photo set.' });
  const sku = normSku(body.sku);
  const allowed = source === 'ph_edited' ? [...ANGLES, ...PH_EXTRA] : ANGLES;
  const angle = allowed.includes(body.angle) ? body.angle : null;
  const contentType = EXT[body.contentType] ? body.contentType : 'image/jpeg';
  if (!sku) return send(res, 400, { ok: false, error: 'A valid SKU is required.' });
  if (!angle) return send(res, 400, { ok: false, error: 'A valid angle is required.' });

  // Key: listings/<sku>/<source>/<angle>-<ts>.<ext> — timestamp avoids stale CDN cache on replace.
  const safeSku = sku.replace(/[^A-Za-z0-9._-]/g, '_');
  const key = `listings/${safeSku}/${source}/${angle}-${Date.now()}.${EXT[contentType]}`;
  try {
    const uploadUrl = presignPutUrl({ key, expiresIn: 300 });
    return send(res, 200, { ok: true, uploadUrl, publicUrl: publicUrl(key), key });
  } catch (e) {
    console.error('[photos/sign]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare the upload.' });
  }
}
