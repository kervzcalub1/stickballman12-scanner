// POST /api/items/restock-done { vins:[] } -> { ok, updated }
// Clears restock_pending so the unit(s) leave the Rescale worklist and behave as
// normal inventory. For the team working restocks (warehouse/admin/ph_team).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { markRestocked, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = (Array.isArray(body.vins) ? body.vins : [body.vin])
    .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean);
  if (!vins.length) return send(res, 400, { ok: false, error: 'Missing VIN(s).' });
  if (vins.length > 1000) return send(res, 400, { ok: false, error: 'Too many items.' });

  try {
    const updated = await markRestocked(vins, user.name || user.username || '');
    return send(res, 200, { ok: true, updated });
  } catch (e) {
    console.error('[items/restock-done]', e.message);
    return send(res, 500, { ok: false, error: 'Could not mark restocked.' });
  }
}
