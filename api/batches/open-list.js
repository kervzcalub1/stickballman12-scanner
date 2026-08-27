// GET /api/batches/open-list -> { ok, batches:[…] }
// Open (resumable) multi-box batches, newest first, with box progress. (Feature 7)
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listOpenBatches, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // PH reads this too (2026-08-27). No PH_EXCLUDED_KINDS guard is needed here and that
  // is not an oversight: listOpenBatches is `kind = 'receiving'` in its WHERE clause, so
  // an in-store or existing-stock batch cannot appear in it. If that ever widens, this
  // needs the same phSafe treatment as /api/batches/list.
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    const batches = await listOpenBatches();
    return send(res, 200, { ok: true, batches });
  } catch (e) {
    console.error('[batches/open-list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load open batches.' });
  }
}
