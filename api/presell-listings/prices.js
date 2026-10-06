// POST /api/presell-listings/prices { platform: 'alias'|'stockx', sku, sizes:[…], consigned? }
//   alias  → { "<size>": { globalIndicator, lowestListing, lastSold, highestOffer } }   consigned | With You
//   stockx → { "<size>": { lowestAsk, highestBid, sellFaster, earnMore, beatUS } }      the DIRECT market
// Each platform in ITS OWN words (owner, 2026-10-07). Read-only; shown to everyone on
// this screen — the warehouse prices these pairs itself. Dollars; null = none.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { aliasCatalogBySku, aliasPriceInsights } from '../_lib/alias.js';
import { stockxConfigured, stockxDirectMarket, stockxVariantFor } from '../_lib/stockx.js';

const CONCURRENCY = 4;
// Alias answers "0" for a price it doesn't have — that's none, never a $0 price.
const real = (v) => (Number(v) > 0 ? Number(v) : null);

async function pool(items, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Please wait a moment before looking up prices again.' });
  const b = await getJsonBody(req);
  const platform = b.platform === 'stockx' ? 'stockx' : 'alias';
  const sku = String(b.sku ?? '').trim().toUpperCase().slice(0, 60);
  const sizes = [...new Set((Array.isArray(b.sizes) ? b.sizes : []).map((s) => String(s ?? '').trim()).filter(Boolean))].slice(0, 40);
  if (!sku || !sizes.length) return send(res, 400, { ok: false, error: 'Which SKU and sizes?' });
  const prices = {};
  try {
    if (platform === 'alias') {
      const consigned = b.consigned !== false;
      const cat = await aliasCatalogBySku(sku);
      if (!cat?.catalogId) return send(res, 404, { ok: false, error: `Alias doesn't carry ${sku}.` });
      await pool(sizes, async (size) => {
        const value = Number.isFinite(cat.sizeValues?.[size]) ? cat.sizeValues[size] : size;
        try {
          const p = await aliasPriceInsights({ catalogId: cat.catalogId, size: value, consigned });
          prices[size] = { globalIndicator: real(p?.globalIndicator), lowestListing: real(p?.lowestListing), lastSold: real(p?.lastSold), highestOffer: real(p?.highestOffer) };
        } catch { prices[size] = { error: true }; }
      });
      return send(res, 200, { ok: true, platform, consigned, prices });
    }
    if (!stockxConfigured()) return send(res, 503, { ok: false, error: 'StockX is not configured on the server.' });
    await pool(sizes, async (size) => {
      try {
        const v = await stockxVariantFor(sku, size);
        if (!v) { prices[size] = { missing: true }; return; }
        const m = await stockxDirectMarket(v.productId, v.variantId);
        prices[size] = m ? { lowestAsk: m.lowestAsk, highestBid: m.highestBid, sellFaster: m.sellFaster, earnMore: m.earnMore, beatUS: m.beatUS } : { error: true };
      } catch { prices[size] = { error: true }; }
    });
    return send(res, 200, { ok: true, platform, prices });
  } catch (e) {
    console.error('[presell-listings/prices]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach the marketplace for prices.' });
  }
}
