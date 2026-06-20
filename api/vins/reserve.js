// POST /api/vins/reserve  { count, dateReceived }  ->  { ok, vins }
// Reserves real VINs from the atomic sequence so the warehouse can see/sticker
// them during receiving (before submit). Concurrency-safe: each call gets a
// unique block. Warehouse/admin only.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { reserveVins, dbConfigured } from '../_lib/db.js';

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const count = Number(body.count) || 0;
  if (count < 1 || count > 2000) return send(res, 400, { ok: false, error: 'Invalid count.' });
  const dateReceived = isDate(body.dateReceived) ? body.dateReceived : null;

  try {
    const vins = await reserveVins(count, dateReceived);
    return send(res, 200, { ok: true, vins });
  } catch (e) {
    console.error('[vins/reserve]', e.message);
    return send(res, 500, { ok: false, error: 'Could not reserve VINs.' });
  }
}
