// POST /api/sku-search  { sku }  ->  { ok, product }
// Queries KicksDB (StockX products) by SKU. API key stays server-side.

import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanSku,
} from './_lib/util.js';

const KICKS_BASE = 'https://api.kicks.dev/v3/stockx/products';

function normalize(item, querySku) {
  if (!item) return null;
  return {
    name: item.title || item.model || 'Unknown product',
    sku: item.sku || querySku || null,
    upc: item.upc || item.gtin || null, // present only if KicksDB returns it
    image: item.image || (Array.isArray(item.gallery) ? item.gallery[0] : null) || null,
    brand: item.brand || null,
    colorway: item.secondary_title || null,
    sizes: [],
    source: 'kicksdb',
  };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const key = process.env.KICKSDB_KEY;
  if (!key) return send(res, 500, { ok: false, error: 'Server is missing the KicksDB key.' });

  const body = await getJsonBody(req);
  const sku = cleanSku(body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'Invalid SKU.' });

  try {
    const url = `${KICKS_BASE}?query=${encodeURIComponent(sku)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return send(res, 502, { ok: false, error: `KicksDB failed (${r.status})` });

    const data = await r.json();
    const item = Array.isArray(data?.data) ? data.data[0] : null;
    const normalized = normalize(item, sku);
    if (!normalized) return send(res, 404, { ok: false, error: 'No product found for that SKU.' });

    return send(res, 200, { ok: true, product: normalized });
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message || 'Upstream error.' });
  }
}
