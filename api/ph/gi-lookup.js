// POST /api/ph/gi-lookup { sku, sizes:[…] }
//   -> { ok, configured, results:[{ size, global_indicator, price }] }
// Looks up the current Alias global indicator (+ Final = GI + 20%) per size for a
// SKU, WITHOUT saving anything — the client fills its edit draft. Used by the PH
// grid's per-group GI refresh and the Rescale Requests listing editor. PH Team +
// admin only (pricing is hidden from warehouse).
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { giForSkuSizes } from '../_lib/intake.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']); // admin auto-allowed
  if (!user) return;
  // Alias-heavy — keep well throttled.
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Please wait a moment before fetching again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const sku = String(body.sku ?? '').trim();
  const sizes = (Array.isArray(body.sizes) ? body.sizes : [])
    .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 100);
  if (!sku) return send(res, 400, { ok: false, error: 'Missing SKU.' });
  if (!sizes.length) return send(res, 400, { ok: false, error: 'No sizes to price.' });

  try {
    const { configured, results } = await giForSkuSizes(sku, sizes);
    return send(res, 200, { ok: true, configured, results });
  } catch (e) {
    console.error('[ph/gi-lookup]', e.message);
    return send(res, 500, { ok: false, error: 'Could not fetch prices.' });
  }
}
