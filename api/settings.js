// GET  /api/settings           (any authenticated user) -> { ok, priceMarkupPct }
// POST /api/settings { priceMarkupPct }  (admin / superadmin) -> { ok, priceMarkupPct }
//
// App-wide settings. Currently just the price margin percent (GI → Final markup),
// which every logged-in user needs to read (to render "GI + N%" and compute Final)
// but only admin/superadmin can change.

import { getJsonBody, send, applySecurity, rateLimit, requireAuth, requireAdmin } from './_lib/util.js';
import { getPriceMarkupPct, setSetting, dbConfigured } from './_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  if (req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;
    const priceMarkupPct = await getPriceMarkupPct();
    return send(res, 200, { ok: true, priceMarkupPct });
  }

  if (req.method === 'POST') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
      return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
    const body = await getJsonBody(req);
    const pct = Number(body.priceMarkupPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 200)
      return send(res, 400, { ok: false, error: 'Enter a margin between 0 and 200%.' });
    // Store a tidy number (drop trailing .0), e.g. 20, 22.5.
    const value = String(Math.round(pct * 100) / 100);
    await setSetting('price_markup_pct', value, admin.name || admin.username || 'admin');
    return send(res, 200, { ok: true, priceMarkupPct: Number(value) });
  }

  return send(res, 405, { ok: false, error: 'Method not allowed' });
}
