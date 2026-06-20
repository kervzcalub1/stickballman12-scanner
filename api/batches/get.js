// GET /api/batches/get?id=123  ->  { ok, batch, items, issues }
import { send, applySecurity, requireRole } from '../_lib/util.js';
import { getBatch, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse'])) return;
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const id = parseInt(new URL(req.url, 'http://x').searchParams.get('id'), 10);
  if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'Invalid batch id.' });

  try {
    const data = await getBatch(id);
    if (!data) return send(res, 404, { ok: false, error: 'Batch not found.' });
    return send(res, 200, { ok: true, ...data });
  } catch (e) {
    console.error('[batches/get]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the batch.' });
  }
}
