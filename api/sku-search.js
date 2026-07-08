// POST /api/sku-search  { sku }  ->  { ok, product }
// Looks a SKU up on the official Alias catalog (api.alias.org) — Alias has the
// canonical shoe titles + colorway and gives us the catalog_id. Replaces the old
// KicksDB lookup. The API key stays server-side.

import {
  getJsonBody, send, applySecurity, rateLimit, requireRole, cleanSku,
  cacheGet, cacheSet, normalizeGender,
} from './_lib/util.js';
import { aliasCatalogBySku } from './_lib/alias.js';

// Sort sizes numerically (1, 1.5, 2 … 13) — Alias usually returns them in order,
// but normalize defensively so the UI's size table is always ascending.
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

// Map the Alias catalog hit to our shared product shape. Alias writes the SKU
// with a space ("DQ8426 109"); normalize to the dash form the app uses. No UPC
// here (the catalog is per-SKU; UPCs are per-size) — same as the old behavior.
function normalize(c, querySku) {
  if (!c) return null;
  const sku = (c.sku || querySku || '').replace(/\s+/g, '-') || null;
  return {
    name: c.name || 'Unknown product',
    sku,
    upc: null,
    image: c.image || null,
    brand: c.brand || null,
    colorway: c.colorway || null,
    sizes: sortSizes(c.sizes || []),
    gender: normalizeGender(c.gender, { size: c.sizes?.[0] || '', title: c.name || '' }),
    source: 'alias',
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team', 'supplier'])) return; // PH: rescale-request form · supplier: PO scan-out product lookup
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  if (!process.env.ALIAS_API_KEY) return send(res, 500, { ok: false, error: 'Server is missing the Alias API key.' });

  const body = await getJsonBody(req);
  const sku = cleanSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'Invalid SKU.' });

  // Repeat lookups of the same SKU skip the upstream round trip.
  const cacheKey = `sku:${sku.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return send(res, 200, { ok: true, product: cached, cached: true });

  try {
    const c = await aliasCatalogBySku(sku);
    const normalized = normalize(c, sku);
    if (!normalized) return send(res, 404, { ok: false, error: 'No product found for that SKU.' });

    cacheSet(cacheKey, normalized);
    return send(res, 200, { ok: true, product: normalized });
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message || 'Upstream error.' });
  }
}
