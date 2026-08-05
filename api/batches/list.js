// GET /api/batches/list  ->  { ok, batches }
// Recent receiving batches with item counts/totals.
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { listBatches, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const kindParam = new URL(req.url, 'http://x').searchParams.get('kind');
  const kind = ['rescale', 'receiving', 'instore', 'existing'].includes(kindParam) ? kindParam : null;
  try {
    return send(res, 200, { ok: true, batches: await listBatches(100, kind) });
  } catch (e) {
    console.error('[batches/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load batches.' });
  }
}
