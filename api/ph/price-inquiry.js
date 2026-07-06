// POST /api/ph/price-inquiry { sku, sizes:[…] }
//   -> { ok, configured, results:[{ size, global_indicator, price,
//                                   lowest_listing, highest_offer, last_sold }] }
// Read-only Alias price lookup for a SKU across sizes — GI (+ Final = GI + 20%)
// plus lowest listing / highest offer / last sold. Nothing is saved; it just
// answers "what's this worth right now?" for the PH team. PH Team + admin only
// (pricing is hidden from warehouse). See docs/context/ph-report.md.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { priceInquiryForSkuSizes } from '../_lib/intake.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']); // admin auto-allowed
  if (!user) return;
  // Alias-heavy (one upstream call per size) — keep well throttled.
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Please wait a moment before looking up again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const sku = String(body.sku ?? '').trim();
  const sizes = (Array.isArray(body.sizes) ? body.sizes : [])
    .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 100);
  if (!sku) return send(res, 400, { ok: false, error: 'Missing SKU.' });
  if (!sizes.length) return send(res, 400, { ok: false, error: 'No sizes to price.' });

  try {
    const { configured, results } = await priceInquiryForSkuSizes(sku, sizes);
    return send(res, 200, { ok: true, configured, results });
  } catch (e) {
    console.error('[ph/price-inquiry]', e.message);
    return send(res, 500, { ok: false, error: 'Could not fetch prices.' });
  }
}
