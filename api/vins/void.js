// POST /api/vins/void  { vins:[] }  ->  { ok, voided }
// A torn, lost or misprinted sticker. Voided, never reused — same rule as the dated
// VINs: numbering gaps are fine, a reused number is not. A sticker already ON a shoe
// can't be voided (the server filters `status <> 'assigned'`).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { voidVinStock, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const vins = Array.isArray(body.vins) ? body.vins.slice(0, 500) : [];
  if (!vins.length) return send(res, 400, { ok: false, error: 'No stickers given.' });

  try {
    const by = user.name || user.username || '';
    const rows = await voidVinStock(vins, by);
    return send(res, 200, { ok: true, voided: rows.map((r) => r.vin) });
  } catch (e) {
    console.error('[vins/void]', e.message);
    return send(res, 500, { ok: false, error: 'Could not void those stickers.' });
  }
}
