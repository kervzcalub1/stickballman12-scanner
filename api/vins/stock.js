// GET /api/vins/stock            ->  { ok, counts, runs }
// GET /api/vins/stock?run=7      ->  { ok, run, vins }   (reprint a jammed run)
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getVinStockSummary, getVinRun, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const run = new URL(req.url, 'http://x').searchParams.get('run');
  try {
    if (run) {
      const vins = await getVinRun(run);
      return send(res, 200, { ok: true, run: Number(run), vins });
    }
    const { counts, runs } = await getVinStockSummary();
    return send(res, 200, { ok: true, counts, runs });
  } catch (e) {
    console.error('[vins/stock]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the sticker stock.' });
  }
}
