// Shared receiving-intake helpers used by both the single-batch commit
// (api/batches/commit.js) and the multi-box box-commit (api/batches/box-commit.js):
// item normalization, per-unit defect-issue parsing, and best-effort Alias
// Global-Indicator price enrichment.
import { cleanSku } from './util.js';
import {
  getProductByUpc, getCatalogIdBySku, upsertProduct, setItemGlobalIndicators,
} from './db.js';
import { aliasProductByUpc, aliasCatalogBySku, aliasGlobalIndicator } from './alias.js';

export const GI_MARKUP = 1.2; // Final price = global indicator + 20%
const VIN_RE = /^SBM-\d{6}-\d{6}$/;

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const toCost = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const normSku = (s) => { const c = cleanSku(s); return c ? c.replace(/\s+/g, '-') : null; };

// Normalize raw client items. A unit whose VIN is in `noBoxVins` (flagged with a
// 'no_box' defect) follows the no-box rules too — status no_box / with_box=false.
export function normalizeItems(rawItems, { defaultCost = null, noBoxVins = new Set() } = {}) {
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
      notes: String(it.notes ?? '').trim().slice(0, 500) || null,
      withBox,
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

// Best-effort: fetch each received unit's Alias global indicator and seed price.
// `created` are the inserted [{id}] rows aligned with normalized `items`.
export async function enrichGlobalIndicators(created, items) {
  if (!process.env.ALIAS_API_KEY) return;
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
      if (!giByKey.has(key)) giByKey.set(key, await aliasGlobalIndicator({ catalogId, size: it.size }));
      const gi = giByKey.get(key);
      if (gi == null) continue;
      updates.push({ id, global_indicator: gi, price: Math.round(gi * GI_MARKUP * 100) / 100 });
    } catch { /* best-effort — skip this unit */ }
  }
  if (updates.length) await setItemGlobalIndicators(updates);
}
