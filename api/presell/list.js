// GET /api/presell/list?batchId=  (warehouse / admin)
//   -> { ok, rows: [{ batch_id, batch_code, supplier_name, sku, name, size, arrived, sold, remains }] }
// The Pre-sell worklist: what arrived on pre-sell shipments, grouped by shipment → shoe →
// size. Those units are NOT listed to II or the stores — they were sold before they
// landed — so this page is the only place they surface until they are released.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listPreSellGroups, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const url = new URL(req.url, 'http://x');
  const raw = Number(url.searchParams.get('batchId'));
  const batchId = Number.isInteger(raw) && raw > 0 ? raw : null;
  try {
    return send(res, 200, { ok: true, rows: await listPreSellGroups({ batchId }) });
  } catch (e) {
    console.error('[presell/list]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the pre-sell list.' });
  }
}
