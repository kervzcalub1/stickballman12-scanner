// GET|POST /api/gi-check?sku=DQ8426-109[&size=9]  ->  { ok, sku, catalogId, results }
//
// PUBLIC, NO-AUTH, TEMPORARY endpoint for bulk pricing-accuracy testing. Given a
// SKU it resolves the Alias catalog_id and returns the TRUE Alias pricing
// (Global Indicator + lowest listing / highest offer / last sold) using the
// exact aliasApiGet settings as the app (consigned, region 3, New / Good box).
//
// GI is per-size, so with just a SKU it returns one row per size in the catalog
// run. Pass ?size=9 to fetch a single size. Reads `sku`/`size` from the query
// string (easy to curl in bulk) or a JSON body.
//
// NOTE: no auth by request — delete this file when the pricing audit is done.

import { getJsonBody, send, applySecurity, rateLimit, cleanSku } from './_lib/util.js';
import { aliasCatalogBySku, aliasPriceInsights } from './_lib/alias.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Generous cap so bulk runs work, but still shields the upstream Alias API.
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  if (!process.env.ALIAS_API_KEY) return send(res, 500, { ok: false, error: 'Server is missing the Alias API key.' });

  // Params come from the query string or, for POST, the JSON body.
  const url = new URL(req.url, 'http://localhost');
  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const sku = cleanSku(url.searchParams.get('sku') ?? body.sku);
  const sizeParam = url.searchParams.get('size') ?? body.size ?? null;
  if (!sku) return send(res, 400, { ok: false, error: 'Missing/invalid `sku`.' });

  try {
    const c = await aliasCatalogBySku(sku);
    if (!c?.catalogId) return send(res, 404, { ok: false, error: 'No product found for that SKU.' });

    // One size (if asked) or the whole catalog size run.
    const sizes = sizeParam != null && String(sizeParam).trim() !== ''
      ? [String(sizeParam).trim()]
      : (c.sizes && c.sizes.length ? c.sizes : []);
    if (!sizes.length) return send(res, 404, { ok: false, error: 'No sizes available for that SKU.' });

    const results = await Promise.all(sizes.map(async (size) => {
      const p = await aliasPriceInsights({ catalogId: c.catalogId, size });
      return {
        size,
        globalIndicator: p?.globalIndicator ?? null,
        lowestListing: p?.lowestListing ?? null,
        highestOffer: p?.highestOffer ?? null,
        lastSold: p?.lastSold ?? null,
      };
    }));

    return send(res, 200, {
      ok: true,
      sku: c.sku || sku,
      name: c.name || null,
      catalogId: c.catalogId,
      results,
    });
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message || 'Upstream error.' });
  }
}
