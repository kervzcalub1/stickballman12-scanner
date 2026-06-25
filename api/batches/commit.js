// POST /api/batches/commit
//   { batch:{buyer,supplier,tracking,dateReceived,defaultCost,notes,specialRules},
//     items:[{name,sku,size,upc,image,cost,source,notes,withBox}],
//     issues:[{type,description,expectedCount,receivedCount}] }
//   -> { ok, batchCode, count, vins }
//
// Persists a whole receiving batch to the database (one VIN per item, atomic
// inserts) and records shipment issues. The database is the single source of
// truth (V5 — Google Sheets removed). Each item's history starts with
// "Scanned by <user>" then "Received into inventory".

import {
  getJsonBody, send, applySecurity, rateLimit, requireRole, cleanSku,
} from '../_lib/util.js';
import {
  createBatch, insertItems, insertIntakeEvents, insertIssues,
  setItemGlobalIndicators, upsertProduct, getProductByUpc, getCatalogIdBySku,
  addSupplier, dbConfigured,
} from '../_lib/db.js';
import { aliasProductByUpc, aliasCatalogBySku, aliasGlobalIndicator } from '../_lib/alias.js';

const MAX_ITEMS = 2000;
const GI_MARKUP = 1.2; // Final price = global indicator + 20%

// Resolve an item's Alias catalog_id (needed for GI). Prefers the UPC (Alias UPC
// search), falls back to the SKU (official catalog search) for SKU-scanned units
// that carry no UPC. Uses the products-table cache first; caches per UPC|SKU key.
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

// Best-effort: fetch the Alias global indicator price for each received unit and
// store it (seeding the final price). catalog_id comes from UPC (preferred) or
// SKU; GI is one official api.alias.org call per (catalog_id, size), memoized per
// batch. Any failure is swallowed — GI just stays null and PH fills it by hand.
async function enrichGlobalIndicators(created, items) {
  if (!process.env.ALIAS_API_KEY) return; // GI needs the official pricing key
  const catalogCache = new Map();   // upc:/sku: key -> catalog_id | null
  const giByKey = new Map();        // `${catalogId}|${size}` -> dollars | null
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

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
const toCost = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const normSku = (s) => {
  const c = cleanSku(s);
  return c ? c.replace(/\s+/g, '-') : null;
};

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const header = body.batch || {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const kind = body.kind === 'rescale' ? 'rescale' : 'receiving';
  // Rescale has no shipment, so it carries no shipment issues.
  const issues = kind === 'rescale' ? [] : (Array.isArray(body.issues) ? body.issues : []);

  if (!rawItems.length)
    return send(res, 400, { ok: false, error: 'Add at least one item before committing the batch.' });
  if (rawItems.length > MAX_ITEMS)
    return send(res, 400, { ok: false, error: `Too many items (max ${MAX_ITEMS}).` });

  const createdBy = user.name || user.username || '';
  const defaultCost = toCost(header.defaultCost);

  // Normalize items. "With Box" unchecked → status 'no_box' + with_box=false.
  const items = rawItems.map((it) => {
    const withBox = it.withBox !== false;
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
      // Reserved VIN (assigned during receiving). Validated; else server generates.
      vin: /^SBM-\d{6}-\d{6}$/.test(String(it.vin || '')) ? it.vin : null,
    };
  });

  // Rescale carries no shipment — buyer/supplier/tracking are dropped.
  const bh = {
    buyer: kind === 'rescale' ? null : cleanName(header.buyer),
    supplier: kind === 'rescale' ? null : cleanName(header.supplier),
    tracking: kind === 'rescale' ? null : (String(header.tracking ?? '').trim().slice(0, 120) || null),
    dateReceived: header.dateReceived || null,
    defaultCost,
    notes: String(header.notes ?? '').trim().slice(0, 2000) || null,
    specialRules: String(header.specialRules ?? '').trim().slice(0, 2000) || null,
    kind,
    origin: kind === 'rescale' ? (String(header.origin ?? '').trim().slice(0, 80) || null) : null,
    // Set by the client when staff proceed past the duplicate-tracking warning.
    duplicateOf: kind === 'rescale' ? null : (Number.isInteger(header.duplicateOf) ? header.duplicateOf : null),
  };

  try {
    const batch = await createBatch(bh, createdBy);
    // Auto-save the supplier name so custom vendors (e.g. "JD Sports") show up in
    // the dropdown next time. Best-effort — never fail the commit over this.
    if (kind === 'receiving' && bh.supplier) addSupplier(bh.supplier, createdBy).catch(() => {});
    const created = await insertItems(batch.id, items, createdBy, bh.dateReceived);
    // First history per item: "Scanned by <user>" then received / rescaled.
    await insertIntakeEvents(created.map((r) => r.id), createdBy, kind);
    await insertIssues(batch.id, issues, createdBy);

    send(res, 200, {
      ok: true,
      batchCode: batch.batch_code,
      count: created.length,
      vins: created.map((r) => r.vin),
    });

    // Best-effort, AFTER responding (slow/flaky Alias must never delay the
    // commit): pull each unit's global indicator price and seed the final price.
    // A failure just leaves GI null for PH to fill in by hand.
    enrichGlobalIndicators(created, items)
      .catch((e) => console.warn('[batches/commit] GI enrichment failed:', e.message));
    return;
  } catch (e) {
    console.error('[batches/commit]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the batch. Please try again.' });
  }
}
