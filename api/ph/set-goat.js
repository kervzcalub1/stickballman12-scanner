// POST /api/ph/set-goat  { vins:[...], goatOnly } -> { ok, updated, goatOnly }
// Toggle "GOAT only" (list to Alias/GOAT + Intelligent Inventory only) across a
// SKU group's units from the PH grid. PH Team / superadmin only (same as editing).
import { getJsonBody, send, applySecurity, rateLimit, requireAuth } from '../_lib/util.js';
import { setItemsGoatOnly, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (user.role !== 'ph_team' && user.role !== 'superadmin')
    return send(res, 403, { ok: false, error: 'Only PH Team can change this.' });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = (Array.isArray(body.vins) ? body.vins : []).map((v) => String(v).trim().toUpperCase()).filter(Boolean).slice(0, 500);
  const goatOnly = body.goatOnly === true;
  if (!vins.length) return send(res, 400, { ok: false, error: 'No units specified.' });

  try {
    const rows = await setItemsGoatOnly(vins, goatOnly);
    return send(res, 200, { ok: true, updated: rows.length, goatOnly });
  } catch (e) {
    console.error('[ph/set-goat]', e.message);
    return send(res, 500, { ok: false, error: 'Could not update GOAT-only.' });
  }
}
