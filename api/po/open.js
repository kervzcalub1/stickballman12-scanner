// GET /api/po/open  (warehouse / ph_team / admin)
// Purchase orders available to receive against — 'shipped' or already 'receiving'.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { listOpenPos, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const pos = await listOpenPos();
    return send(res, 200, { ok: true, pos });
  } catch (e) {
    console.error('[po/open]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load open purchase orders.' });
  }
}
