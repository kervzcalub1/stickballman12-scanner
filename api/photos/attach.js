// POST /api/photos/attach  { sku, angle, url } -> { ok }
// Record (or replace) a SKU's listing photo for one angle after the client has
// uploaded the bytes to R2 via the presigned URL.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku } from '../_lib/util.js';
import { setProductPhoto, dbConfigured } from '../_lib/db.js';
import { isAllowedPhotoUrl } from '../_lib/r2.js';
import { photoSourceForRole, PHOTO_ANGLES, PH_EXTRA_ANGLES } from '../_lib/photos.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const source = photoSourceForRole(user.role, body.source);
  if (!source) return send(res, 403, { ok: false, error: 'You can’t manage that photo set.' });
  const sku = normSku(body.sku);
  const allowed = source === 'ph_edited' ? [...PHOTO_ANGLES, ...PH_EXTRA_ANGLES] : PHOTO_ANGLES;
  const angle = allowed.includes(body.angle) ? body.angle : null;
  const url = String(body.url || '').trim().slice(0, 500);
  // SSRF guard: only accept a URL on our own R2 host (not any https URL) —
  // download.js later fetches this server-side.
  if (!sku || !angle || !isAllowedPhotoUrl(url))
    return send(res, 400, { ok: false, error: 'sku, angle and a photo URL on the configured R2 host are required.' });
  try {
    await setProductPhoto({ sku, angle, url, source, createdBy: user.name || user.username || '' });
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[photos/attach]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the photo.' });
  }
}
