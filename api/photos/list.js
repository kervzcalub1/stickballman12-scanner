// GET /api/photos/list?sku=... -> { ok, configured, photos:[{angle,url}] }
// Existing listing photos for a SKU — powers the dedupe check + angle slots.
import { send, applySecurity, rateLimit, requireRole, cleanSku } from '../_lib/util.js';
import { listProductPhotos, dbConfigured } from '../_lib/db.js';
import { r2Configured } from '../_lib/r2.js';

const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const sku = normSku(new URL(req.url, 'http://x').searchParams.get('sku'));
  if (!sku) return send(res, 200, { ok: true, configured: r2Configured(), photos: [] });
  try {
    const photos = await listProductPhotos(sku);
    return send(res, 200, { ok: true, configured: r2Configured(), photos });
  } catch (e) {
    console.error('[photos/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load photos.' });
  }
}
