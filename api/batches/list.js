// GET /api/batches/list  ->  { ok, batches }
// Recent receiving batches with item counts/totals.
import { send, applySecurity, requireAuth } from '../_lib/util.js';
import { listBatches, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  try {
    return send(res, 200, { ok: true, batches: await listBatches(100) });
  } catch (e) {
    console.error('[batches/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load batches.' });
  }
}
