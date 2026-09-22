// POST /api/presell/hold  (warehouse / admin)  { batchId, sku }
// GET  /api/presell/hold?batchId=…                -> { ok, shoes: [{sku,name,held,free}] }
//
// Put a shoe BACK on hold — the mirror of release, and the reason it exists:
// pre-sell is declared per shoe now, so it can be got wrong in both directions.
// Over-holding is merely annoying and visible on the Pre-sell page. Under-holding is
// invisible and expensive: the pair reaches PH, gets listed, and can be sold to a
// second buyer while the first one's order still stands.
//
// The GET lists every shoe on the shipment with how many are held and how many are
// free, so the page can offer the unheld ones rather than making anyone type a code.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { holdPreSell, listBatchShoes, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const batchId = Number(req.method === 'GET'
    ? new URL(req.url, 'http://x').searchParams.get('batchId')
    : body.batchId);
  if (!Number.isInteger(batchId)) return send(res, 400, { ok: false, error: 'A valid shipment is required.' });

  try {
    if (req.method === 'GET') return send(res, 200, { ok: true, shoes: await listBatchShoes(batchId) });
    const sku = String(body.sku ?? '').trim().slice(0, 60);
    if (!sku) return send(res, 400, { ok: false, error: 'Which shoe?' });
    const r = await holdPreSell({ batchId, sku, createdBy: user.name || user.username || '' });
    if (!r.held) return send(res, 409, { ok: false, error: 'Nothing to hold there — those pairs are already held, sold or gone.' });
    return send(res, 200, { ok: true, ...r });
  } catch (e) {
    console.error('[presell/hold]', e.message);
    return send(res, 500, { ok: false, error: 'Could not hold that shoe.' });
  }
}
