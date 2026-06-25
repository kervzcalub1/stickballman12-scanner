// POST /api/photos/remove  { sku, angle } -> { ok }
// Drop a SKU's photo for one angle (removes the DB row; the R2 object is left to
// lifecycle cleanup). Lets staff re-shoot a bad angle.
import { send, applySecurity, rateLimit, requireRole, getJsonBody, cleanSku } from '../_lib/util.js';
import { removeProductPhoto, dbConfigured } from '../_lib/db.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };
const ANGLES = ['side', 'diagonal', 'outsole', 'top', 'rear'];

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const sku = normSku(body.sku);
  const angle = ANGLES.includes(body.angle) ? body.angle : null;
  if (!sku || !angle) return send(res, 400, { ok: false, error: 'sku and angle are required.' });
  try {
    await removeProductPhoto(sku, angle);
    return send(res, 200, { ok: true });
  } catch (e) {
    console.error('[photos/remove]', e.message);
    return send(res, 500, { ok: false, error: 'Could not remove the photo.' });
  }
}
