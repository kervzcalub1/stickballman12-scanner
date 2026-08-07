// GET|POST /api/get-price?sku=DQ8426-109[&size=9]  ->  { ok, sku, catalogId, results }
//
// PUBLIC, NO-AUTH pricing endpoint (same access model as /api/gi-check). Given a
// SKU it resolves the Alias catalog_id and returns the TRUE Alias pricing for
// BOTH bases — consigned AND With You — per size, using the exact aliasApiGet
// settings as the app (region 3, New / Good box).
//
// Per size it returns { size, consigned:{ global, lowest, last_sold, highest },
// with_you:{ global, lowest, last_sold, highest } }. GI is per-size, so with just
// a SKU it returns one row per size in the catalog run. Pass ?size=9 for one size.
// Reads `sku`/`size` from the query string (easy to curl in bulk) or a JSON body.

import { getJsonBody, send, applySecurity, rateLimit, cleanSku } from './_lib/util.js';
import { aliasCatalogBySku, aliasPriceInsights } from './_lib/alias.js';
import { PRICE_HIERARCHY } from './_lib/pricing.js';

// A price of 0 (or missing) from Alias means "no data for that basis" (e.g. no last
// sale / no live offer) — treat it as an empty price so "all available prices" only
// surfaces real ones.
const price = (x) => (x == null || Number(x) === 0 ? null : Number(x));

// Reshape an aliasPriceInsights result into the { global, lowest, last_sold,
// highest } block this endpoint returns (empty = null).
function priceBlock(p) {
  return {
    global: price(p?.globalIndicator),
    lowest: price(p?.lowestListing),
    last_sold: price(p?.lastSold),
    highest: price(p?.highestOffer),
  };
}

// aliasPriceInsights field -> the key it takes in the blocks above.
const BLOCK_FIELD = { globalIndicator: 'global', lowestListing: 'lowest', lastSold: 'last_sold', highestOffer: 'highest' };

// The pricing hierarchy (1 = most preferred), flattened per size so a consumer can
// read it in priority order. Walks the SAME PRICE_HIERARCHY the PH listing paths
// price off (api/_lib/pricing.js), so this endpoint and the app can never drift.
// `resolved` is the first non-empty price down that list — the price PH would list
// at, before margin.
function hierarchy(consigned, with_you) {
  const prices = PRICE_HIERARCHY.map((h) => ({
    rank: h.rank,
    label: h.label,
    basis: h.key,
    value: (h.consigned ? consigned : with_you)[BLOCK_FIELD[h.field]],
  }));
  const resolved = prices.find((p) => p.value != null) || null;
  return { prices, resolved };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Generous cap so bulk runs work, but still shields the upstream Alias API.
  // Each size fires TWO upstream calls (consigned + With You).
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
      // Both bases per size: consigned and With You.
      const [consignedP, withYouP] = await Promise.all([
        aliasPriceInsights({ catalogId: c.catalogId, size, consigned: true }),
        aliasPriceInsights({ catalogId: c.catalogId, size, consigned: false }),
      ]);
      const consigned = priceBlock(consignedP);
      const with_you = priceBlock(withYouP);
      return {
        size,
        consigned,
        with_you,
        ...hierarchy(consigned, with_you), // { prices: [rank,label,value ×8], resolved }
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
