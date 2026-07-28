// GET /api/po/archived  (warehouse / ph_team / admin)
// Archived (status 'closed') POs, newest first. Its own endpoint rather than a flag on
// reconcile-list: this list only grows and is opened rarely, so the active queue must
// never pay to load it.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { listArchivedPos, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const pos = await listArchivedPos({ limit: 100 });
    // `rc` mirrors the shape reconcile-list returns, so the same card renders both
    // tabs — but read from the FROZEN snapshot, never recomputed. An archived order's
    // numbers are history and must not shift under a later data change.
    return send(res, 200, {
      ok: true,
      pos: pos.map(({ snapshot_summary, ...p }) => ({ ...p, rc: snapshot_summary || null })),
    });
  } catch (e) {
    console.error('[po/archived]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load archived purchase orders.' });
  }
}
