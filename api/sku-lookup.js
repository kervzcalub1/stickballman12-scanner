// GET|POST /api/sku-lookup?sku=DQ8426-109  ->  { ok, sku, name, brand, colorway, gender, image, catalogId, sizes }
//
// PUBLIC, NO-AUTH: what shoe is this style code? Same access model as /api/get-price
// and /api/gi-check — no session, rate-limited per IP — and the same single upstream:
// the OFFICIAL Alias catalogue (api.alias.org, `aliasCatalogBySku`), which is the only
// source here that returns a full name, colourway and a catalog_id. Nothing from our own
// inventory is in the answer: this says what the code IS, never what we hold.
//
// One upstream call per request (get-price fires two per size), so the cap is the same.
// Reads `sku` from the query string (easy to curl) or a JSON body.
import { getJsonBody, send, applySecurity, rateLimit, cleanSku } from './_lib/util.js';
import { aliasCatalogBySku } from './_lib/alias.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });
  if (!process.env.ALIAS_API_KEY) return send(res, 500, { ok: false, error: 'Server is missing the Alias API key.' });

  const url = new URL(req.url, 'http://localhost');
  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const sku = cleanSku(url.searchParams.get('sku') ?? body.sku);
  if (!sku) return send(res, 400, { ok: false, error: 'Missing/invalid `sku`.' });

  try {
    const c = await aliasCatalogBySku(sku);
    if (!c?.catalogId) return send(res, 404, { ok: false, error: 'No product found for that SKU.' });
    return send(res, 200, {
      ok: true,
      sku,
      name: c.name,
      brand: c.brand,
      colorway: c.colorway,
      gender: c.gender,
      image: c.image,
      catalogId: c.catalogId,
      // The catalogue's own code for the match — usually the same, but a re-release or
      // a dual-code style can answer with a different spelling, and the caller should
      // see that rather than assume.
      aliasSku: c.sku,
      sizes: c.sizes,
      source: 'alias',
    });
  } catch (e) {
    // A catalogue timeout is Alias being slow (20–45s TTFB is normal for it), not a
    // bad code — say so, so the caller retries instead of dropping the SKU.
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
      return send(res, 504, { ok: false, error: 'The Alias catalogue did not answer in time — try again.' });
    console.error('[sku-lookup]', e.message);
    return send(res, 502, { ok: false, error: 'Could not reach the Alias catalogue.' });
  }
}
