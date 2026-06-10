// POST /api/upc-search  { upc }  ->  { ok, product }
//
// UPC lookup with automatic provider rotation:
//   1. PRIMARY  — StockX UPC Search (resolves the exact size for the scanned UPC).
//   2. FALLBACK — Alias, used ONLY when StockX returns null or errors.
// All credentials/keys stay server-side; the browser only sees the normalized
// product. The `source` field tells the UI which provider answered ('stockx'
// vs 'alias') so it can pick the right size/quantity layout.

import {
  getJsonBody, send, applySecurity, rateLimit, requireAuth, cleanUpc,
  fetchWithTimeout, cacheGet, cacheSet,
} from './_lib/util.js';

const ALIAS_BASE = 'https://bypass-alias-host-railway-alias.up.railway.app';
const STOCKX_BASE = 'https://bypass-stock-x-host-railway-stock-x.up.railway.app';

/* ===================================================================== */
/* PRIMARY: StockX UPC Search                                            */
/* ===================================================================== */

// Map the StockX UPC response to our shape. The response carries the single
// variant matching the scanned barcode:
//   result.data.variants[0] -> { product{title,styleId,brand,...}, traits{size},
//                                 sizeChart{baseSize, displayOptions[]} }
function normalizeStockx(data, upc) {
  const variant = data?.result?.data?.variants?.[0];
  const product = variant?.product;
  if (!variant || !product) return null;

  const name = product.title || product.primaryTitle || null;
  if (!name) return null;

  // sku / styleId
  const sku = product.styleId || product.sku || null;

  // size / baseSize (e.g. "8.5W"); fall back to a display option ("US W 8.5").
  const size =
    variant.traits?.size ||
    variant.sizeChart?.baseSize ||
    variant.sizeChart?.displayOptions?.[0]?.size ||
    null;

  return {
    name,
    sku,
    upc,
    image: product.media?.imageUrl || product.media?.smallImageUrl || null,
    brand: product.brand || null,
    colorway: product.secondaryTitle || null,
    sizes: size ? [String(size).trim()] : [], // StockX gives the exact size
    source: 'stockx',
  };
}

// Returns a normalized product or null (no match). Throws on a hard upstream
// error so the caller can rotate to Alias.
async function searchStockxByUpc(upc) {
  const r = await fetchWithTimeout(`${STOCKX_BASE}/stockx-upc-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upc }),
  });
  if (!r.ok) throw new Error(`StockX search failed (${r.status})`);

  let data = null;
  try { data = await r.json(); } catch { return null; }
  // Upstream signals "no match" with ok:false (or no variants).
  if (data?.ok === false) return null;
  return normalizeStockx(data, upc);
}

/* ===================================================================== */
/* FALLBACK: Alias                                                       */
/* ===================================================================== */

// Cache the Alias access token across warm invocations (expires in ~1h).
let tokenCache = { value: null, expires: 0 };

async function getAliasToken(email, password) {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;

  const r = await fetchWithTimeout(`${ALIAS_BASE}/alias-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`Alias login failed (${r.status})`);
  const data = await r.json();
  const token = data?.auth_token?.access_token;
  if (!token) throw new Error('Alias login returned no access_token');

  // Refresh a little early.
  tokenCache = { value: token, expires: Date.now() + 50 * 60 * 1000 };
  return token;
}

// True if a search response looks like an expired/invalid token — either by
// HTTP status (401/403) or by an auth-flavored message in the body. This
// catches upstreams that return 200/500 with an error body instead of a 401.
function looksLikeAuthFailure(status, data) {
  if (status === 401 || status === 403) return true;
  const text = JSON.stringify(data ?? '').toLowerCase();
  return (
    /unauthor/.test(text) ||
    /forbidden/.test(text) ||
    /\b(token|session)\b[^]*\b(expir|invalid|missing|revok)/.test(text) ||
    /\b(expir|invalid|missing|revok)[^]*\b(token|session)\b/.test(text) ||
    /not\s+authenticated/.test(text) ||
    /authentication\s+(failed|required)/.test(text)
  );
}

// Sort sizes by their numeric value so the list reads 1, 1.5, 2 … 13 instead
// of the lexicographic order the API returns (which puts 10.5–13 before 1–10).
// Non-numeric sizes fall back to a string compare and sort last.
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

function normalizeAlias(product, upc) {
  if (!product) return null;
  const sizes = Array.isArray(product.size_options)
    ? product.size_options.map((s) => String(s.name ?? s.value)).filter(Boolean)
    : [];
  return {
    name: product.name || product.nickname || 'Unknown product',
    sku: product.sku || null,
    upc: upc || null,
    image: product.main_picture_url || product.grid_picture_url || null,
    brand: product.brand || null,
    colorway: product.colorway || null,
    sizes: sortSizes(sizes), // full size list — the UI shows the size/qty table
    source: 'alias',
  };
}

// Returns a normalized product or null. Throws on a hard upstream error.
async function searchAlias(upc, email, password) {
  let token = await getAliasToken(email, password);

  // Runs the search and returns status + parsed body (read once so we can
  // inspect the body for auth failures without consuming it twice).
  const doSearch = async (authToken) => {
    const resp = await fetchWithTimeout(`${ALIAS_BASE}/alias-upc-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, authorization_token: authToken, upc }),
    });
    let parsed = null;
    try { parsed = await resp.json(); } catch { /* may not be JSON */ }
    return { status: resp.status, ok: resp.ok, data: parsed };
  };

  let r = await doSearch(token);
  // If the token expired — by status OR an auth error in the body — refresh
  // once with a brand-new token and retry the search.
  if (looksLikeAuthFailure(r.status, r.data)) {
    tokenCache = { value: null, expires: 0 };
    token = await getAliasToken(email, password);
    r = await doSearch(token);
  }
  if (!r.ok) throw new Error(`Alias search failed (${r.status})`);

  const product = r.data?.result?.results?.[0]?.product;
  return normalizeAlias(product, upc);
}

/* ===================================================================== */
/* Handler                                                               */
/* ===================================================================== */

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded. Slow down a moment.' });

  const body = await getJsonBody(req);
  const upc = cleanUpc(body.upc);
  if (!upc) return send(res, 400, { ok: false, error: 'Invalid UPC. Expected 8–14 digits.' });

  // 0) Cache — a repeat scan of the same barcode skips the upstream round trip.
  const cacheKey = `upc:${upc}`;
  const cached = cacheGet(cacheKey);
  if (cached) return send(res, 200, { ok: true, product: cached, cached: true });

  // 1) PRIMARY — StockX UPC Search. Any null result or error rotates to Alias.
  try {
    const product = await searchStockxByUpc(upc);
    if (product) {
      cacheSet(cacheKey, product);
      return send(res, 200, { ok: true, product });
    }
  } catch (e) {
    console.warn('[upc-search] StockX failed, rotating to Alias:', e.message);
  }

  // 2) FALLBACK — Alias.
  const email = process.env.ALIAS_EMAIL;
  const password = process.env.ALIAS_PASSWORD;
  if (!email || !password)
    return send(res, 404, {
      ok: false,
      error: 'No product found on StockX and the Alias fallback is not configured.',
    });

  try {
    const product = await searchAlias(upc, email, password);
    if (!product) return send(res, 404, { ok: false, error: 'No product found for that UPC.' });
    cacheSet(cacheKey, product);
    return send(res, 200, { ok: true, product });
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message || 'Upstream error.' });
  }
}
