// POST /api/photos/sign-issue  { vin, contentType } -> { ok, uploadUrl, publicUrl, key }
// Presigned R2 PUT for a per-unit DEFECT photo (V6 Feature 4), keyed by VIN
// (issues/<vin>/<ts>.<ext>). The returned publicUrl is carried in the batch
// commit payload and stored on the unit's 'issue' item_event. Defect photos are
// per-VIN (distinct from per-SKU listing photos).
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { r2Configured, presignPutUrl, publicUrl } from '../_lib/r2.js';
import { VIN_RE } from '../_lib/vins.js';

const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (!r2Configured()) return send(res, 503, { ok: false, error: 'Photo storage is not configured (R2 env vars missing).' });

  const body = await getJsonBody(req);
  const vin = String(body.vin || '').trim().toUpperCase();
  const contentType = EXT[body.contentType] ? body.contentType : 'image/jpeg';
  if (!VIN_RE.test(vin)) return send(res, 400, { ok: false, error: 'A valid VIN is required.' });

  const key = `issues/${vin}/${Date.now()}.${EXT[contentType]}`;
  try {
    const uploadUrl = presignPutUrl({ key, expiresIn: 300 });
    return send(res, 200, { ok: true, uploadUrl, publicUrl: publicUrl(key), key });
  } catch (e) {
    console.error('[photos/sign-issue]', e.message);
    return send(res, 500, { ok: false, error: 'Could not prepare the upload.' });
  }
}
