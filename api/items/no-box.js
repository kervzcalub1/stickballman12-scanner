// GET /api/items/no-box  ->  { ok, rows }
// The "No Box / Not Ready" worklist: all units still marked Bought Without Box.
// Readable by PH team (view-only) and warehouse/admin (who change the status via
// /api/items/event). Not month-scoped — it's a pending queue.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listNoBoxItems, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // PH team can view; warehouse/admin can view + resolve.
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const rows = await listNoBoxItems();
    return send(res, 200, { ok: true, rows });
  } catch (e) {
    console.error('[items/no-box]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the no-box list.' });
  }
}
