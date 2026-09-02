// Shared receiving-intake helpers used by both the single-batch commit
// (api/batches/commit.js) and the multi-box box-commit (api/batches/box-commit.js):
// item normalization, per-unit defect-issue parsing, and best-effort Alias
// Global-Indicator price enrichment.
import { cleanSku } from './util.js';
import { VIN_RE } from './vins.js';
import {
  getProductByUpc, getCatalogIdBySku, upsertProduct, setItemGlobalIndicators,
  refreshItemGi, getPriceMarkupMult,
} from './db.js';
import { aliasProductByUpc, aliasCatalogBySku, aliasPriceWithBasis, aliasPriceInsights } from './alias.js';
import { priceBasisLabel } from './pricing.js';

// Final price = global indicator × markup. The markup is the configurable price
// margin (default 1.2 = +20%), fetched per call via getPriceMarkupMult().

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
// Blank means "nobody told us", NOT $0 — and the two must never collapse into each
// other, because $0 is a real claim that reads as a free pair and nothing downstream
// can tell it back apart from a gap (the Costs backlog looks for NULL). The obvious
// one-liner got this wrong: `Number('')` and `Number(null)` are both 0, so every
// skipped cost box was silently stored as a free shoe. A deliberate zero still works
// — type 0. Exported because commit / box-commit / create-open all need the same
// answer; they each had their own copy of the broken version.
export const toCost = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
// Final price rounds to the nearest whole dollar (GI × margin → e.g. 94.30 → 94).
const roundFinal = (v) => Math.round(v);
const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };

// Normalize raw client items. A unit whose VIN is in `noBoxVins` (flagged with a
// 'no_box' defect) follows the no-box rules too — status no_box / with_box=false.
export function normalizeItems(rawItems, { defaultCost = null, noBoxVins = new Set(), preSell = false } = {}) {
  return rawItems.map((it) => {
    const vin = VIN_RE.test(String(it.vin || '')) ? it.vin : null;
    const withBox = (it.withBox !== false) && !(vin && noBoxVins.has(vin.toUpperCase()));
    return {
      name: cleanName(it.name) || 'Unknown',
      sku: normSku(it.sku),
      size: String(it.size ?? '').trim().slice(0, 24),
      upc: String(it.upc ?? '').replace(/\D/g, '').slice(0, 14) || null,
      image: it.image || null,
      cost: toCost(it.cost) ?? defaultCost,
      source: ['stockx', 'alias', 'kicksdb', 'manual'].includes(it.source) ? it.source : 'manual',
      gender: ['Men', 'Women', 'Youth', 'Toddler', 'Unisex'].includes(it.gender) ? it.gender : null,
      colorway: String(it.colorway ?? '').trim().slice(0, 120) || null,
      // An EMPTY BOX carries the carton's size as well as the shoe size it was made for.
      // Null on every pair, which is also what tells the two apart downstream.
      dimensions: String(it.dimensions ?? '').trim().slice(0, 60) || null,
      notes: String(it.notes ?? '').trim().slice(0, 500) || null,
      withBox,
      // Declared once for the whole shipment at intake, then carried per unit — release
      // is per unit, so the batch's own flag can't be the source of truth afterwards.
      preSell: preSell === true,
      goatOnly: it.goatOnly === true, // list to Alias(GOAT)+II only; StockX/Shopify N/A
      status: withBox ? 'needs_shelf' : 'no_box',
      vin,
    };
  });
}

// Per-unit defect issues: [{ vin, type, note, photos:[https…] }].
export function parseUnitIssues(body) {
  return (Array.isArray(body?.unitIssues) ? body.unitIssues : [])
    .map((u) => ({
      vin: String(u?.vin || '').trim().toUpperCase(),
      type: String(u?.type ?? '').trim().slice(0, 40) || 'other',
      note: String(u?.note ?? '').trim().slice(0, 500),
      photos: (Array.isArray(u?.photos) ? u.photos : [])
        .filter((p) => /^https:\/\//.test(String(p))).map((p) => String(p).slice(0, 500)).slice(0, 6),
    }))
    .filter((u) => VIN_RE.test(u.vin));
}

// Resolve an item's Alias catalog_id (UPC search first, then SKU). Cached per key.
async function resolveCatalogId(it, cache) {
  const key = it.upc ? `upc:${it.upc}` : (it.sku ? `sku:${it.sku}` : null);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key);
  let catalogId = null;
  try {
    if (it.upc) {
      const cached = await getProductByUpc(it.upc);
      if (cached?.catalog_id) catalogId = cached.catalog_id;
      else {
        const p = await aliasProductByUpc(it.upc);
        if (p) { await upsertProduct({ ...p, size: it.size }); catalogId = p.catalogId; }
      }
    } else if (it.sku) {
      catalogId = await getCatalogIdBySku(it.sku);
      if (!catalogId) {
        const p = await aliasCatalogBySku(it.sku);
        if (p) { await upsertProduct({ ...p, upc: null, sku: it.sku, size: it.size }); catalogId = p.catalogId; }
      }
    }
  } catch { /* best-effort */ }
  cache.set(key, catalogId);
  return catalogId;
}

// Best-effort: price each received unit off the Alias hierarchy (PRICE_HIERARCHY
// — GI → Lowest → Last Sold → Highest, consigned before "With You") and seed the
// final price. `created` are the inserted [{id}] rows aligned with normalized
// `items`. The level that priced each unit lands on `items.gi_basis`.
export async function enrichGlobalIndicators(created, items) {
  if (!process.env.ALIAS_API_KEY) return;
  const mult = await getPriceMarkupMult();
  const catalogCache = new Map();
  const giByKey = new Map();
  const updates = [];
  for (let i = 0; i < created.length; i++) {
    const it = items[i];
    const id = created[i]?.id;
    if (!id || !it?.size || (!it?.upc && !it?.sku)) continue;
    try {
      const catalogId = await resolveCatalogId(it, catalogCache);
      if (!catalogId) continue;
      const key = `${catalogId}|${it.size}`;
      if (!giByKey.has(key)) giByKey.set(key, await aliasPriceWithBasis({ catalogId, size: it.size }));
      const { value: gi, basis } = giByKey.get(key);
      if (gi == null) continue;
      updates.push({ id, global_indicator: gi, gi_basis: basis, basis_label: priceBasisLabel(basis), price: roundFinal(gi * mult) });
    } catch { /* best-effort — skip this unit */ }
  }
  if (updates.length) await setItemGlobalIndicators(updates);
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// Re-price EXISTING items off the Alias hierarchy and recompute the final price
// (value + 20%). Used by the PH Report / New Inventory "Refresh prices" button.
// `rows` are existing items: [{ id, upc, sku, size, global_indicator, price }].
// preserveOverrides (default true): a row whose current price ISN'T the auto
// value+20% (a PH hand-typed override) keeps its price — only the indicator is
// refreshed. Skips rows where neither the value, the price, nor the basis changes,
// so no-op refreshes are silent. Returns { updated, checked, configured, fallbacks,
// byBasis } — `fallbacks` counts sizes that came from anything below rank 1.
export async function refreshGiForItems(rows, { preserveOverrides = true } = {}) {
  if (!process.env.ALIAS_API_KEY) return { updated: 0, checked: 0, configured: false };
  const mult = await getPriceMarkupMult();
  const catalogCache = new Map();
  const giByKey = new Map();
  const updates = [];
  const list = Array.isArray(rows) ? rows : [];
  for (const it of list) {
    if (!it?.id || !it?.size || (!it?.upc && !it?.sku)) continue;
    try {
      const catalogId = await resolveCatalogId(it, catalogCache);
      if (!catalogId) continue;
      const key = `${catalogId}|${it.size}`;
      if (!giByKey.has(key)) giByKey.set(key, await aliasPriceWithBasis({ catalogId, size: it.size }));
      const { value: gi, basis } = giByKey.get(key);
      if (gi == null) continue;

      const oldGi = it.global_indicator != null ? Number(it.global_indicator) : null;
      const oldPrice = it.price != null ? Number(it.price) : null;
      const autoOld = oldGi != null ? roundFinal(oldGi * mult) : null;
      const isOverride = oldPrice != null && (autoOld == null || !near(oldPrice, autoOld));
      // Preserve a manual price override only for LISTED units (on II or synced to any
      // store) — don't disturb a live listing's price. UNLISTED units always take the
      // freshly-computed Final = GI × current margin, so a margin change actually lands
      // on "Refresh prices" (an old-margin auto price otherwise looks like an override).
      const isListed = !!(it.added_to_intel_inv || it.synced_alias || it.synced_stockx || it.synced_shopify);
      const keptOverride = preserveOverrides && isListed && isOverride;
      const newPrice = keptOverride ? oldPrice : roundFinal(gi * mult);

      const giChanged = oldGi == null || !near(gi, oldGi);
      const priceChanged = oldPrice == null || !near(newPrice, oldPrice);
      const basisChanged = (it.gi_basis || null) !== (basis || null);
      if (!giChanged && !priceChanged && !basisChanged) continue; // nothing moved — stay quiet
      updates.push({ id: it.id, global_indicator: gi, gi_basis: basis, basis_label: priceBasisLabel(basis), price: newPrice, keptOverride: keptOverride && !priceChanged });
    } catch { /* best-effort — skip this unit */ }
  }
  if (updates.length) await refreshItemGi(updates);
  // How many sizes fell below rank 1, and to what — the grid turns this into the
  // "N priced below the Global Indicator" notice so a soft market is visible.
  const byBasis = {};
  for (const u of updates) if (u.gi_basis && u.gi_basis !== 'consigned') byBasis[u.gi_basis] = (byBasis[u.gi_basis] || 0) + 1;
  const fallbacks = Object.values(byBasis).reduce((a, b) => a + b, 0);
  return { updated: updates.length, checked: list.length, configured: true, fallbacks, byBasis };
}

// Price a SKU across a set of sizes off the Alias hierarchy (+ Final = value + 20%).
// Used by the New-Inventory per-group "Get GI" fill and the Rescale Requests
// listing editor (requests carry a SKU + sizes, not VINs). Resolves the SKU's
// catalog_id once, then walks PRICE_HIERARCHY per size.
// Returns { configured, results:[{ size, global_indicator, price, basis }] }.
export async function giForSkuSizes(sku, sizes) {
  if (!process.env.ALIAS_API_KEY) return { configured: false, results: [] };
  const s = normSku(sku);
  const list = [...new Set((Array.isArray(sizes) ? sizes : []).map((x) => String(x).trim()).filter(Boolean))];
  if (!s || !list.length) return { configured: true, results: [] };
  const catalogId = await resolveCatalogId({ sku: s }, new Map());
  if (!catalogId) return { configured: true, results: [] };
  const mult = await getPriceMarkupMult();
  const results = [];
  for (const size of list) {
    try {
      const { value: gi, basis } = await aliasPriceWithBasis({ catalogId, size });
      if (gi != null) results.push({ size, global_indicator: gi, price: roundFinal(gi * mult), basis });
    } catch { /* skip this size */ }
  }
  return { configured: true, results };
}

// Full price inquiry for a SKU across sizes — GI (+ Final = GI + 20%) PLUS the
// lowest listing / highest offer / last sold from Alias pricing insights. Powers
// the PH "Price Inquiry" page (a read-only lookup; nothing is saved). Resolves the
// catalog_id once, then prices each size. Returns { configured, results:[{ size,
// global_indicator, price, lowest_listing, highest_offer, last_sold }] } — a size
// is included whenever ANY of its fields came back (so a size with only a last
// sale, no GI, still shows). `consigned` picks the basis explicitly (the Price
// Inquiry toggle) — no auto-fallback here; the caller chooses.
export async function priceInquiryForSkuSizes(sku, sizes, { consigned = true } = {}) {
  if (!process.env.ALIAS_API_KEY) return { configured: false, results: [] };
  const s = normSku(sku);
  const list = [...new Set((Array.isArray(sizes) ? sizes : []).map((x) => String(x).trim()).filter(Boolean))];
  if (!s || !list.length) return { configured: true, results: [] };
  const catalogId = await resolveCatalogId({ sku: s }, new Map());
  if (!catalogId) return { configured: true, results: [] };
  const mult = await getPriceMarkupMult();
  const results = [];
  for (const size of list) {
    try {
      const p = await aliasPriceInsights({ catalogId, size, consigned });
      if (!p) continue;
      const gi = p.globalIndicator;
      const anyValue = gi != null || p.lowestListing != null || p.highestOffer != null || p.lastSold != null;
      if (!anyValue) continue;
      results.push({
        size,
        global_indicator: gi,
        price: gi != null ? roundFinal(gi * mult) : null,
        lowest_listing: p.lowestListing,
        highest_offer: p.highestOffer,
        last_sold: p.lastSold,
      });
    } catch { /* skip this size */ }
  }
  return { configured: true, results };
}
