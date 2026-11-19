// POST /api/cross-listing/prices { catalogId, sizes:[{ label, value }] }   (≤ 45 sizes)
//   -> { ok, prices: { "<label>": { lowestListing, lastSold, highestOffer, globalIndicator } } }
// One SKU's Alias market per size, in dollars (null = none). "With You" prices — these
// pairs ship from us, they are not consigned. Read-only.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { aliasPriceInsights } from '../_lib/alias.js';

const real = (v) => (Number(v) > 0 ? Number(v) : null);   // Alias says "0" for a price it doesn't have

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Please wait a moment before looking up prices again.' });
  const b = await getJsonBody(req);
  const catalogId = String(b.catalogId ?? '').trim().slice(0, 200);
  const sizes = (Array.isArray(b.sizes) ? b.sizes : []).map((s) => ({ label: String(s?.label ?? '').trim().slice(0, 12), value: Number(s?.value) }))
    .filter((s) => s.label && Number.isFinite(s.value)).slice(0, 45);
  if (!catalogId || !sizes.length) return send(res, 400, { ok: false, error: 'Which shoe and sizes?' });
  const prices = {};
  const q = [...sizes];
  await Promise.all(Array.from({ length: Math.min(4, q.length) }, async () => {
    while (q.length) {
      const s = q.shift();
      try {
        const p = await aliasPriceInsights({ catalogId, size: s.value, consigned: false });
        prices[s.label] = { lowestListing: real(p?.lowestListing), lastSold: real(p?.lastSold), highestOffer: real(p?.highestOffer), globalIndicator: real(p?.globalIndicator) };
      } catch { prices[s.label] = { error: true }; }
    }
  }));
  return send(res, 200, { ok: true, prices });
}
