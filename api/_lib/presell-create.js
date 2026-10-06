// Pre-sell Listings — creating listings (docs/context/presell-listings.md).
// `topUp` is the one way listings get made: it lists a stock row on ONE platform up to
// the pairs left (qty − sold − what that platform already holds open), so the same pair
// count can never be listed twice on a platform — the cart and the Stock tab's "List"
// button both come through here.
import { aliasCatalogBySku } from './alias.js';
import { stockxVariantFor } from './stockx.js';
import { openPresellListings, insertPresellListing } from './db.js';
import { PLATFORMS } from './presell.js';

const sizeNumber = (s) => { const m = String(s || '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : NaN; };

// What a platform needs to list this SKU + size. Cached per request by the caller.
export async function resolveRef(platform, stock, cache = {}) {
  const key = `${platform}|${stock.sku}|${stock.size}`;
  if (cache[key] !== undefined) return cache[key];
  let ref = null;
  try {
    if (platform === 'alias') {
      const cat = await aliasCatalogBySku(stock.sku);
      if (!cat?.catalogId) ref = { error: `Alias doesn't carry ${stock.sku}.` };
      else {
        const v = Number.isFinite(cat.sizeValues?.[stock.size]) ? cat.sizeValues[stock.size] : sizeNumber(stock.size);
        ref = Number.isFinite(v) ? { catalogRef: cat.catalogId, sizeValue: v, name: cat.name, image: cat.image } : { error: `"${stock.size}" isn't a size Alias can list.` };
      }
    } else {
      const v = await stockxVariantFor(stock.sku, stock.size, { upc: stock.upc });
      ref = v ? { catalogRef: v.productId, variantId: v.variantId, sizeValue: sizeNumber(stock.size) } : { error: `StockX has no exact match for ${stock.sku} size ${stock.size}.` };
    }
  } catch (e) {
    ref = { error: e?.name === 'AbortError' || e?.name === 'TimeoutError' ? `${platform === 'alias' ? 'Alias' : 'StockX'} timed out — try again.` : `${platform === 'alias' ? 'Alias' : 'StockX'} lookup failed: ${e.message}` };
  }
  cache[key] = ref;
  return ref;
}

// → { platform, wanted, created, results:[{ ok, id?, status?, error? }] }
export async function topUp(stock, platform, { priceCents, active }, actor, cache = {}) {
  const left = Math.max(0, Number(stock.qty) - Number(stock.sold));
  const open = (await openPresellListings(stock.id)).filter((l) => l.platform === platform).length;
  const wanted = Math.max(0, left - open);
  const out = { platform, wanted, created: 0, results: [] };
  if (!wanted) return out;
  const ref = await resolveRef(platform, stock, cache);
  if (!ref || ref.error) {
    for (let i = 0; i < wanted; i++) out.results.push({ ok: false, error: ref?.error || 'Lookup failed.' });
    return out;
  }
  for (let i = 0; i < wanted; i++) {
    try {
      const r = await PLATFORMS[platform].create({ catalogRef: ref.catalogRef, variantId: ref.variantId, sizeValue: ref.sizeValue, priceCents, active });
      if (!r.ok || !r.external_id) { out.results.push({ ok: false, error: r.error || 'No listing id came back.' }); continue; }
      const status = r.status || (active ? 'live' : 'off');
      const id = await insertPresellListing({
        stock_id: stock.id, platform, external_id: r.external_id, catalog_ref: ref.catalogRef, variant_id: ref.variantId || null,
        size_value: r.size_value ?? ref.sizeValue, price_cents: r.price_cents ?? priceCents, status, platform_status: r.platform_status || null,
        pending_op: r.pending_op || null, pending_action: r.pending_op ? r.pending_action : null, raw: r.raw, actor,
      });
      out.created++;
      out.results.push({ ok: true, id, status });
    } catch (e) {
      // A timeout is "don't know" — the platform may have made it.
      out.results.push({ ok: false, error: e?.name === 'AbortError' || e?.name === 'TimeoutError' ? 'Timed out — check the marketplace before retrying, it may have been listed.' : `Could not reach ${platform === 'alias' ? 'Alias' : 'StockX'}.` });
    }
  }
  return out;
}
