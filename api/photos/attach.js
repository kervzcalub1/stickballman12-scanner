// POST /api/photos/attach  { sku, angle, url } -> { ok }
// Record (or replace) a SKU's listing photo for one angle after the client has
// uploaded the bytes to R2 via the presigned URL.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku } from '../_lib/util.js';
import { setProductPhoto, dbConfigured } from '../_lib/db.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const ANGLES = ['side', 'diagonal', 'outsole', 'top', 'rear'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const sku = normSku(body.sku);
  const angle = ANGLES.includes(body.angle) ? body.angle : null;
  const url = String(body.url || '').trim().slice(0, 500);
  if (!sku || !angle || !/^https:\/\//.test(url))
    return send(res, 400, { ok: false, error: 'sku, angle and a valid https url are required.' });
  try {
    await setProductPhoto({ sku, angle, url, createdBy: user.name || user.username || '' });
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[photos/attach]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the photo.' });
  }
}
