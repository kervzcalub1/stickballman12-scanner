// POST /api/locations/delete { id } -> { ok, location, detached }
// Permanently remove a shelf. Refuses (409) while live stock is on it — move those
// pairs, or just deactivate the shelf, which is the usual "retire it" move and keeps
// the history intact. Sold/shipped units are detached so an old, long-empty shelf can
// still be removed. Warehouse + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { deleteLocation, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const id = Number(body.id) || 0;
  if (!id) return send(res, 400, { ok: false, error: 'Missing location id.' });

  try {
    const r = await deleteLocation(id);
    if (r.notFound) return send(res, 404, { ok: false, error: 'Location not found.' });
    if (!r.deleted) {
      return send(res, 409, {
        ok: false,
        error: `${r.live} pair${r.live === 1 ? ' is' : 's are'} still shelved here. Move them to another shelf first, or deactivate this one instead.`,
        itemCount: r.live,
      });
    }
    return send(res, 200, { ok: true, location: r.location, detached: r.detached });
  } catch (e) {
    console.error('[locations/delete]', e.message);
    return send(res, 500, { ok: false, error: 'Could not delete the shelf.' });
  }
}
