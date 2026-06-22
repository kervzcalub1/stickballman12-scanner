// POST /api/sku-search  { sku }  ->  { ok, product }
// Queries KicksDB (StockX products) by SKU. API key stays server-side.

import {
  getJsonBody, send, applySecurity, rateLimit, requireRole, cleanSku,
  fetchWithTimeout, cacheGet, cacheSet, normalizeGender,
} from './_lib/util.js';

const KICKS_BASE = 'https://api.kicks.dev/v3/stockx/products';

// Sort sizes by numeric value (1, 1.5, 2 … 13) instead of the lexicographic
// order that puts 10–13 before 2. Non-numeric sizes sort last by string.
function sortSizes(list) {
  const num = (s) => {
    const m = String(s).match(/[\d.]+/);
    return m ? parseFloat(m[0]) : NaN;
  };
  return [...list].sort((a, b) => {
    const na = num(a);
    const nb = num(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return String(a).localeCompare(String(b));
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return na - nb;
  });
}

function normalize(item, querySku) {
  if (!item) return null;
  // KicksDB returns the size run under `variants` (requested via
  // display[variants]=true). Each variant's `size` is the StockX primary size
  // (e.g. "10", "8.5W"); take the visible ones so the UI shows the same
  // size/quantity table as an Alias result.
  const variants = Array.isArray(item.variants) ? item.variants : [];
  const sizes = sortSizes([
    ...new Set(
      variants
        .filter((v) => !v.hidden && v.size != null && String(v.size).trim())
        .map((v) => String(v.size).trim())
    ),
  ]);
  return {
    name: item.title || item.model || 'Unknown product',
    sku: item.sku || querySku || null,
    upc: item.upc || item.gtin || null, // present only if KicksDB returns it
    image: item.image || (Array.isArray(item.gallery) ? item.gallery[0] : null) || null,
    brand: item.brand || null,
    colorway: item.secondary_title || null,
    sizes,
    gender: normalizeGender(item.gender || item.category, { size: sizes[0] || '', title: item.title || item.model || '' }),
    source: 'kicksdb',
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return; // PH uses it to look up a SKU on the rescale-request form
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const key = process.env.KICKSDB_KEY;
  if (!key) return send(res, 500, { ok: false, error: 'Server is missing the KicksDB key.' });

  const body = await getJsonBody(req);
  const sku = cleanSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'Invalid SKU.' });

  // Repeat lookups of the same SKU skip the upstream round trip.
  const cacheKey = `sku:${sku.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return send(res, 200, { ok: true, product: cached, cached: true });

  try {
    // display[variants]=true returns the size run in the same call (no second
    // round trip); limit=1 keeps the payload small since we use the top match.
    const url = `${KICKS_BASE}?query=${encodeURIComponent(sku)}&display[variants]=true&limit=1`;
    const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return send(res, 502, { ok: false, error: `KicksDB failed (${r.status})` });

    const data = await r.json();
    const item = Array.isArray(data?.data) ? data.data[0] : null;
    const normalized = normalize(item, sku);
    if (!normalized) return send(res, 404, { ok: false, error: 'No product found for that SKU.' });

    cacheSet(cacheKey, normalized);
    return send(res, 200, { ok: true, product: normalized });
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message || 'Upstream error.' });
  }
}
