// POST /api/upc-search  { upc }  ->  { ok, product }
//
// UPC scan flow:
//   1. PROXY lookup (UPC -> SKU + scanned size):
//        PRIMARY  StockX proxy — returns the SKU *and* the exact scanned size.
//        FALLBACK Alias proxy  — returns the SKU only (no per-UPC size), used
//                                when StockX has no match. Scanned size is left
//                                blank so the user picks from the size dropdown.
//   2. DETAILS from the official Alias catalog (by SKU): canonical title,
//      colorway, gender, image, full size run (StockX/Alias-proxy details are
//      only a fallback if the catalog lookup misses).
// The scanned size is what auto-fills + auto-increments per scan in receiving, so
// it must come from the UPC lookup (only StockX provides it).

import {
  getJsonBody, send, applySecurity, rateLimit, requireRole, cleanUpc,
  fetchWithTimeout, cacheGet, cacheSet, normalizeGender,
} from './_lib/util.js';
import { aliasProductByUpc, aliasCatalogBySku } from './_lib/alias.js';

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
async function stockxUpcLookup(upc) {
  const r = await fetchWithTimeout(`${STOCKX_BASE}/stockx-upc-search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upc }),
  });
  if (!r.ok) throw new Error(`StockX search failed (${r.status})`);
  let data = null;
  try { data = await r.json(); } catch { return null; }
  if (data?.ok === false) return null;
  const variant = data?.result?.data?.variants?.[0];
  const product = variant?.product;
  const sku = normSku(product?.styleId || product?.sku);
  if (!sku) return null;
  const size = variant?.traits?.size || variant?.sizeChart?.baseSize || variant?.sizeChart?.displayOptions?.[0]?.size || null;
  return {
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

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'supplier'])) return; // supplier: PO scan-out product lookup (scan a UPC)
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const body = await getJsonBody(req);
  const upc = cleanUpc(body.upc);
  if (!upc) return send(res, 400, { ok: false, error: 'Invalid UPC. Expected 8–14 digits.' });

  const cacheKey = `upc:${upc}`;
  const cached = cacheGet(cacheKey);
  if (cached) return send(res, 200, { ok: true, product: cached, cached: true });

  // 1) Resolve SKU (+ scanned size from StockX) via the proxies.
  let sku = null;
  let scannedSize = null;
  let fb = null; // proxy-supplied details, used only if the catalog lookup misses
  try {
    const sx = await stockxUpcLookup(upc);
    if (sx) { sku = sx.sku; scannedSize = sx.scannedSize; fb = sx; }
  } catch (e) {
    console.warn('[upc-search] StockX failed, rotating to Alias:', e.message);
  }
  if (!sku) {
    // FALLBACK — Alias proxy: SKU only (no scanned size → size left blank).
    try {
      const al = await aliasProductByUpc(upc);
      if (al?.sku) { sku = normSku(al.sku); scannedSize = null; fb = al; }
    } catch (e) {
      console.warn('[upc-search] Alias proxy failed:', e.message);
    }
  }
  if (!sku) return send(res, 404, { ok: false, error: 'No product found for that UPC.' });

  // 2) Authoritative details from the official Alias catalog (by SKU).
  let cat = null;
  try { cat = await aliasCatalogBySku(sku); } catch (e) { console.warn('[upc-search] Alias catalog failed:', e.message); }

  const name = cat?.name || fb?.name || null;
  if (!name) return send(res, 404, { ok: false, error: 'Found the SKU but no product details.' });
  const sizes = withScannedSize(cat?.sizes?.length ? cat.sizes : [], scannedSize);
  const gender = cat?.gender || fb?.gender || null;
  const product = {
    name,
    sku: normSku(cat?.sku) || sku,
    upc,
    image: cat?.image || fb?.image || null,
    brand: cat?.brand || fb?.brand || null,
    colorway: cat?.colorway || fb?.colorway || null,
    sizes,
    scannedSize,
    gender: normalizeGender(gender, { size: scannedSize || sizes[0] || '', title: name }),
    source: 'alias',
  };

  cacheSet(cacheKey, product);
  return send(res, 200, { ok: true, product });
}
