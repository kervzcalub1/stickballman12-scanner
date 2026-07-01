// GET /api/locations/items?id=123 -> { ok, items }
// Everything currently stored on a shelf (excl. sold/shipped) — the shelf-contents
// drawer on the Locations page. Warehouse + admin.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listItemsAtLocation, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 240 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const id = Number(new URL(req.url, 'http://x').searchParams.get('id'));
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'A valid location id is required.' });
  try {
    const items = await listItemsAtLocation(id);
    return send(res, 200, { ok: true, items });
  } catch (e) {
    console.error('[locations/items]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the shelf contents.' });
  }
}
