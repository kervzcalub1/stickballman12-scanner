// POST /api/locations/update { id, label?, active? } -> { ok, location }
// Rename a shelf's display label or activate/deactivate it. The structural fields
// (code/bay/shelf) are fixed at create. Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { updateLocation, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing location id.' });
  const patch = {};
  if ('label' in body) patch.label = String(body.label ?? '').trim().slice(0, 40) || null;
  if ('active' in body) patch.active = !!body.active;
  if (!('label' in patch) && !('active' in patch)) return send(res, 400, { ok: false, error: 'Nothing to update.' });

  try {
    const location = await updateLocation(id, patch);
    if (!location) return send(res, 404, { ok: false, error: 'Location not found.' });
    return send(res, 200, { ok: true, location });
  } catch (e) {
    console.error('[locations/update]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update the shelf.' });
  }
}
