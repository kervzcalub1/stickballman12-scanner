// GET  /api/settings           (any authenticated user) -> { ok, priceMarkupPct, shipTo }
// POST /api/settings { priceMarkupPct? , shipTo? }  (admin / superadmin)
//
// App-wide settings: the price margin percent (GI → Final markup), which every logged-in
// user needs to read but only admin/superadmin can change, and the ship-to address —
// where suppliers send their boxes, printed on the manifest. Suppliers read this one
// (requireAuth covers them), which is the point of it living here.

import { getJsonBody, send, applySecurity, rateLimit, requireAuth, requireAdmin } from './_lib/util.js';
import { getPriceMarkupPct, setSetting, recomputeUnlistedPrices, getShipTo, setShipTo, SHIP_TO_FIELDS, dbConfigured } from './_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  if (req.method === 'GET') {
    const user = requireAuth(req, res);
    if (!user) return;
    const priceMarkupPct = await getPriceMarkupPct();
    const shipTo = await getShipTo();
    return send(res, 200, { ok: true, priceMarkupPct, shipTo });
  }

  if (req.method === 'POST') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
      return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
    const body = await getJsonBody(req);
    const who = admin.name || admin.username || 'admin';

    // Ship-to is saved on its own — the two settings live on separate forms and a save of
    // one must not require (or silently rewrite) the other.
    if (body.shipTo !== undefined) {
      if (!body.shipTo || typeof body.shipTo !== 'object')
        return send(res, 400, { ok: false, error: 'Invalid shipping address.' });
      const patch = {};
      for (const f of SHIP_TO_FIELDS) if (body.shipTo[f] !== undefined) patch[f] = body.shipTo[f];
      if (!Object.keys(patch).length) return send(res, 400, { ok: false, error: 'Nothing to update.' });
      // The street and the city/state/zip line are what make a parcel deliverable; a
      // manifest that prints a name over a blank address is worse than no block at all.
      const next = { ...(await getShipTo()), ...patch };
      for (const f of ['name', 'street', 'city', 'state', 'zip']) {
        if (!String(next[f] ?? '').trim())
          return send(res, 400, { ok: false, error: 'Name, street, city, state and ZIP are all required.' });
      }
      const shipTo = await setShipTo(patch, who);
      return send(res, 200, { ok: true, shipTo });
    }

    const pct = Number(body.priceMarkupPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 200)
      return send(res, 400, { ok: false, error: 'Enter a margin between 0 and 200%.' });
    // Store a tidy number (drop trailing .0), e.g. 20, 22.5.
    const newPct = Math.round(pct * 100) / 100;
    const oldPct = await getPriceMarkupPct(); // before the write, to re-price unlisted items
    await setSetting('price_markup_pct', String(newPct), who);
    // Apply the new margin to still-unlisted items (off II + off every store),
    // preserving manual overrides. Best-effort — never fail the save on this.
    let repriced = 0;
    try { repriced = await recomputeUnlistedPrices(1 + oldPct / 100, 1 + newPct / 100); }
    catch (e) { console.error('[settings] reprice failed:', e.message); }
    return send(res, 200, { ok: true, priceMarkupPct: newPct, repriced });
  }

  return send(res, 405, { ok: false, error: 'Method not allowed' });
}
