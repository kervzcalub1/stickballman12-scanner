// POST /api/items/check-vins { vins: [...] } -> { ok, results: [{ vin, result, item?, sticker?, deleted? }], counts }
//
// Inventory's "Bulk · check all": a warehouse walk scans a hundred-plus VINs first and asks
// once — "which of these are registered?" — instead of one lookup per trigger pull. Same
// answers a single scan gives (a pair, a 1ID sticker's state, not found), plus the deleted
// archive, for the whole list in three reads (checkVinsBulk in db.js). A read, no writes.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { checkVinsBulk, dbConfigured } from '../_lib/db.js';

const MAX = 1000;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // The same people who can look a pair up on Inventory.
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = Array.isArray(body.vins) ? body.vins : [];
  if (!vins.length) return send(res, 400, { ok: false, error: 'Scan at least one VIN.' });
  if (vins.length > MAX) return send(res, 400, { ok: false, error: `That's ${vins.length} — check at most ${MAX} at a time.` });

  try {
    const results = await checkVinsBulk(vins.map((v) => String(v ?? '').slice(0, 40)));
    const counts = {};
    for (const r of results) counts[r.result] = (counts[r.result] || 0) + 1;
    return send(res, 200, { ok: true, results, counts });
  } catch (e) {
    console.error('[items/check-vins]', e.message);
    return send(res, 500, { ok: false, error: 'Could not check those VINs.' });
  }
}
