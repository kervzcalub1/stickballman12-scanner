// GET /api/cancellations/photo?id=<photo id> -> the JPEG (auth'd; fetched as a blob by the page).
// Order photos carry customer names and addresses, so they are never served by public URL.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, getCancellationPhoto } from '../_lib/db.js';
import { getObject } from '../_lib/r2.js';
import { VIEW_ROLES, idOf } from './_shared.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, VIEW_ROLES)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 240 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const id = idOf(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!id) return send(res, 400, { ok: false, error: 'Which photo?' });
  try {
    const p = await getCancellationPhoto(id);
    if (!p) return send(res, 404, { ok: false, error: 'That photo does not exist.' });
    const bytes = p.bytes || (p.r2_key ? await getObject(p.r2_key) : null);
    if (!bytes) return send(res, 404, { ok: false, error: 'That photo was not saved.' });
    res.statusCode = 200;
    res.setHeader('Content-Type', p.content_type || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="cancellation-photo-${id}.jpg"`);
    return res.end(bytes);
  } catch (e) {
    console.error('[cancellations/photo]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the photo.' });
  }
}
