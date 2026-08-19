// POST /api/vins/mint  { count }  ->  { ok, runId, vins }
// Mint blank pre-printed 1ID stickers ("VIN Project"). These carry no shoe — they're
// printed in bulk ahead of time so intake never waits on a label printer.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { mintVinStock, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  // Minting burns sequence numbers permanently, so it's rate-limited harder than a
  // read. A stuck button shouldn't eat 20,000 numbers.
  if (!rateLimit(req, { windowMs: 60_000, max: 10 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const count = Number(body.count) || 0;
  if (count < 1 || count > 2000) return send(res, 400, { ok: false, error: 'Choose between 1 and 2000 stickers.' });

  try {
    const by = user.name || user.username || '';
    const { runId, vins } = await mintVinStock(count, by);
    return send(res, 200, { ok: true, runId, vins });
  } catch (e) {
    console.error('[vins/mint]', e.message);
    return send(res, 500, { ok: false, error: 'Could not mint the stickers.' });
  }
}
