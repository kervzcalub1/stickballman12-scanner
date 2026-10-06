// POST /api/upc-search  { upc }  ->  { ok, product }
//
// UPC scan flow:
//   1. RESOLVE the UPC to a SKU + the exact scanned size, first answer wins:
//        a. StockX proxy (keyless)   — SKU + size.
//        b. StockX official API      — SKU + size, ONLY when (a) is down. Same
//                                      catalogue, same gaps (verified on 16 new
//                                      releases), so it is a spare, not more reach.
//        c. Nike product feed        — SKU + size for Nike/Jordan. Fills the size
//                                      ranges StockX has no barcode for yet on new
//                                      releases (J Balvin 4: StockX 12/25, Nike 25/25).
//        d. Our own received pairs   — a UPC typed in by hand once is known from then
//                                      on; only a unanimous SKU + size counts.
//        e. Alias proxy              — SKU only (no per-UPC size → size left blank).
//                                      Last, because it can name the wrong style (it
//                                      answered an adult Space Jam 9 with the GS code).
//   2. DETAILS from the official Alias catalog (by SKU): canonical title,
//      colorway, gender, image, full size run (the resolver's own details are
//      only a fallback if the catalog lookup misses).
// The scanned size is what auto-fills + auto-increments per scan in receiving, so
// it must come from step 1 — every source but Alias provides it.

import {
  getJsonBody, send, applySecurity, rateLimit, requireRole, cleanUpc,
  fetchWithTimeout, cacheGet, cacheSet, normalizeGender, skuCodes,
} from './_lib/util.js';
import { aliasProductByUpc, aliasCatalogBySku } from './_lib/alias.js';
import { knownSkuAmong, dbConfigured, productFromOwnStockByUpc } from './_lib/db.js';
import { stockxProductByUpc } from './_lib/stockx.js';
import { nikeProductByUpc } from './_lib/nike.js';

const STOCKX_BASE = 'https://bypass-stock-x-host-railway-stock-x.up.railway.app';

const normSku = (s) => (s ? String(s).trim().replace(/\s+/g, '-') : null);

// Sort sizes numerically (1, 1.5 … 13); non-numeric sort last by string.
function sortSizes(list) {
  const num = (s) => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; };
  return [...list].sort((a, b) => {
    const na = num(a); const nb = num(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return String(a).localeCompare(String(b));
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  });
}

// PROXY 1 — StockX: resolve a UPC to its SKU + the exact scanned size. Also keeps
// the StockX title/colorway as a fallback if the Alias catalog later misses.
// Returns null on no match; throws on a hard upstream error (so we rotate).
// EXPORTED because it is the only source that resolves a UPC to its exact size,
// which is what makes `items/backfill-upc` safe to run off a plain search.
export async function stockxUpcLookup(upc) {
  const r = await fetchWithTimeout(`${STOCKX_BASE}/stockx-upc-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upc }),
  });
  if (!r.ok) throw new Error(`StockX search failed (${r.status})`);
  let data = null;
  try { data = await r.json(); } catch { return null; }
  if (data?.ok === false) return null;
  const variants = data?.result?.data?.variants || [];
  const variant = variants[0];
  const product = variant?.product;
  const sku = normSku(product?.styleId || product?.sku);
  if (!sku) return null;
  const size = variant?.traits?.size || variant?.sizeChart?.baseSize || variant?.sizeChart?.displayOptions?.[0]?.size || null;
  // One barcode can come back with variants belonging to SEVERAL products (it has
  // been seen returning three). Taking `variants[0]` then makes both the style and
  // the size a coin toss — so say when that happened, and let the caller decide
  // whether a human should look at it before anything is written.
  const ambiguous = new Set(variants.map((v) => normSku(v?.product?.styleId || v?.product?.sku)).filter(Boolean)).size > 1;
  return {
    ambiguous,
    sku,
    scannedSize: size ? String(size).trim() : null,
    name: product?.title || product?.primaryTitle || null,
    colorway: product?.secondaryTitle || null,
    brand: product?.brand || null,
    image: product?.media?.imageUrl || product?.media?.smallImageUrl || null,
    gender: product?.gender || product?.productCategory || null,
  };
}

// The full size run carries the scanned size's gender/age suffix ("W"/"Y") so the
// dropdown lines up with a women's/youth scan (Alias returns plain US numbers).
function withScannedSize(sizes, scannedSize) {
  const suffix = (scannedSize || '').match(/(W|Y)$/i)?.[1]?.toUpperCase() || '';
  const opts = suffix ? sizes.map((s) => (/[wy]$/i.test(s) ? s : `${s}${suffix}`)) : sizes;
  const scanned = scannedSize ? [scannedSize] : [];
  return sortSizes([...new Set([...scanned, ...opts])]);
}

// A multi-code shoe we have received before needs no question asked: resolve it to
// the code our own stock is already filed under. Deliberately runs OUTSIDE the cache
// (on the cached object too), because the answer changes the moment the warehouse
// commits the first pair — a resolution baked into a cached entry would keep asking
// long after it had been answered.
async function resolveCodes(product) {
  const opts = product?.skuOptions || [];
  if (opts.length < 2 || !dbConfigured()) return product;
  try {
    const known = await knownSkuAmong(opts);
    if (known) return { ...product, sku: known, skuOptions: opts, skuResolvedFrom: 'stock' };
  } catch (e) {
    // Best-effort: a DB hiccup must not stop a scan. The warehouse is asked instead.
    console.warn('[upc-search] known-sku lookup failed:', e.message);
  }
  return product;
}

/**
 * Step 1 on its own: which shoe and which SIZE is this barcode, by the first source that
 * answers (header order). Used by the scan endpoint above and by the rescale audit's
 * count (api/rescale-requests/audit-scan.js), which passes `ownStock: false, alias: false`
 * — a count that checks OUR records can't take its answer from them, and Alias names no
 * size. Returns { sku, scannedSize, via, ambiguous, fb } or null. Never throws.
 */
const resolveCache = new Map();
export async function resolveUpc(upc, { ownStock = true, alias = true } = {}) {
  const key = `${upc}|${ownStock ? 1 : 0}${alias ? 1 : 0}`;
  const c = resolveCache.get(key);
  if (c && Date.now() - c.at < c.ttl) return c.hit;
  let hit = null;
  const take = (r, via) => {
    if (!r?.sku) return false;
    hit = { sku: normSku(r.sku), scannedSize: r.scannedSize || null, via, ambiguous: !!r.ambiguous, fb: r };
    return true;
  };
  let proxyDown = false;
  try { take(await stockxUpcLookup(upc), 'stockx'); } catch (e) {
    proxyDown = true;
    console.warn('[upc-search] StockX proxy failed:', e.message);
  }
  try { if (!hit && proxyDown) take(await stockxProductByUpc(upc), 'stockx-official'); } catch (e) {
    console.warn('[upc-search] StockX official failed:', e.message);
  }
  try { if (!hit) take(await nikeProductByUpc(upc), 'nike'); } catch (e) {
    console.warn('[upc-search] Nike feed failed:', e.message);
  }
  if (!hit && ownStock && dbConfigured()) {
    try { take(await productFromOwnStockByUpc(upc), 'own-stock'); } catch (e) {
      console.warn('[upc-search] own-stock lookup failed:', e.message);
    }
  }
  if (!hit && alias) {
    // LAST — Alias proxy: SKU only (no scanned size → size left blank).
    try {
      const al = await aliasProductByUpc(upc);
      if (al?.sku) hit = { sku: normSku(al.sku), scannedSize: null, via: 'alias', ambiguous: false, fb: al };
    } catch (e) {
      console.warn('[upc-search] Alias proxy failed:', e.message);
    }
  }
  // Only CATALOGUE answers are kept (a gun fires the same box code again and again).
  // Our own stock is cheap to ask and changes the moment a pair is received, and a miss
  // is never kept: a code typed in by hand once is known from then on, and a new
  // release can reach the catalogue later the same day.
  // The one exception: a catalogue-only caller (the audit count) keeps a MISS for ten
  // minutes, so a shelf of an unlisted box doesn't ask StockX and Nike on every scan.
  const keep = hit ? ['stockx', 'stockx-official', 'nike'].includes(hit.via) : !ownStock;
  if (keep) {
    resolveCache.set(key, { hit, at: Date.now(), ttl: hit ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000 });
    if (resolveCache.size > 5000) resolveCache.clear();
  }
  return hit;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team', 'supplier'])) return; // PH: Alias Pre-sell scan · supplier: PO scan-out product lookup (scan a UPC)
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const body = await getJsonBody(req);
  const upc = cleanUpc(body.upc);
  if (!upc) return send(res, 400, { ok: false, error: 'Invalid UPC. Expected 8–14 digits.' });

  const cacheKey = `upc:${upc}`;
  const cached = cacheGet(cacheKey);
  if (cached) return send(res, 200, { ok: true, product: await resolveCodes(cached), cached: true });

  // 1) Resolve SKU + scanned size — first source to answer wins (see the header).
  const hit = await resolveUpc(upc);
  const sku = hit?.sku || null;
  const scannedSize = hit?.scannedSize || null;
  const fb = hit?.fb || null;
  const via = hit?.via || null;
  if (!sku) return send(res, 404, { ok: false, error: 'No product found for that UPC.' });

  // 2) Authoritative details from the official Alias catalog (by SKU).
  let cat = null;
  try { cat = await aliasCatalogBySku(sku); } catch (e) { console.warn('[upc-search] Alias catalog failed:', e.message); }

  const name = cat?.name || fb?.name || null;
  if (!name) return send(res, 404, { ok: false, error: 'Found the SKU but no product details.' });
  const sizes = withScannedSize(cat?.sizes?.length ? cat.sizes : [], scannedSize);
  const gender = cat?.gender || fb?.gender || null;
  // The proxy's styleId carries every code the shoe was sold under; the Alias
  // catalog answers with only the one it matched, so taking it verbatim threw the
  // second code away. Keep what the product record declared whenever it declared
  // more than one — Alias still wins the single-code case, where it is the
  // canonical spelling. Downstream already splits on "/" everywhere it matters
  // (db.js SKU matching, shopify.js, PO reconciliation).
  const codes = skuCodes(sku);
  const product = {
    name,
    sku: codes.length > 1 ? codes.join('/') : (normSku(cat?.sku) || sku),
    // Every code this shoe is sold under. One entry is the ordinary case and the
    // client ignores it; two or more is the pick the warehouse has to make.
    skuOptions: codes.length > 1 ? codes : [],
    upc,
    image: cat?.image || fb?.image || null,
    brand: cat?.brand || fb?.brand || null,
    colorway: cat?.colorway || fb?.colorway || null,
    sizes,
    scannedSize,
    gender: normalizeGender(gender, { size: scannedSize || sizes[0] || '', title: name }),
    source: 'alias',
    // Which resolver named the shoe — for diagnosing a wrong or missed scan.
    upcSource: via,
  };

  cacheSet(cacheKey, product);
  return send(res, 200, { ok: true, product: await resolveCodes(product) });
}
