// Official StockX **Public API** client (api.stockx.com/v2) — catalogue lookup and
// per-size market data (lowest ask / highest bid) for the Payout Calculator.
//
// This is the sanctioned developer API, reached with an approved account's own
// credentials. It is deliberately NOT the `gateway.stockx.com/api/graphql` mobile
// gateway that scraper projects use with a key lifted from the decompiled Android
// APK and a spoofed OkHttp TLS fingerprint: that route is bot-detection evasion, it
// breaks the moment StockX rotates the key, and its failure mode is silent wrong
// prices on a buy call. If a future session finds `okhttp4_android_13`,
// `tlsclientwrapper`, or a hardcoded `x-api-key` default anywhere near this file,
// that is the thing to delete.
//
// Verified against developer.stockx.com/portal/authentication (read 2026-08-22).
// The refresh call there is exactly: POST accounts.stockx.com/oauth/token, form-encoded,
// grant_type=refresh_token + client_id + client_secret + audience=gateway.stockx.com +
// refresh_token — `audience` IS required here, though the authorization_code exchange
// omits it. The docs also state a refresh token is NOT rotated on use ("you will receive
// a new access_token but not a new refresh_token"), so the stored value stays put and
// nothing here tries to write one back.
//
// Auth is TWO credentials at once (both required on every call):
//   · `x-api-key: <STOCKX_API_KEY>`      — the app key from developer.stockx.com
//   · `Authorization: Bearer <JWT>`      — a short-lived access token (~12 h)
// The access token is minted here from a long-lived REFRESH token. Getting that
// refresh token the first time is a browser flow on StockX's side (PerimeterX
// guards it), so a human does it once in the portal and drops the result into
// STOCKX_REFRESH_TOKEN — the server never automates that step.
//
// Quota is 25,000 requests / 24 h for the whole account, which is why every layer
// here caches: the catalogue barely moves, only the money does.
import { fetchWithTimeout, cacheGet, cacheSet, primarySku } from './util.js';

export const STOCKX_BASE = process.env.STOCKX_API_BASE || 'https://api.stockx.com/v2';
const TOKEN_URL = process.env.STOCKX_TOKEN_URL || 'https://accounts.stockx.com/oauth/token';
// StockX issues tokens per audience; the API sits behind the gateway audience.
const TOKEN_AUDIENCE = process.env.STOCKX_AUDIENCE || 'gateway.stockx.com';
// NO `country` parameter. The published OpenAPI spec still lists one as optional on
// market-data, but the live API rejects it outright:
//   400 · "The \"country\" query parameter is not supported anymore. Market data will
//          be based on your market. Please try again without the country parameter"
// Caught by scripts/probe-stockx.mjs on the first real call — a spec is a promise, not
// a response. Don't re-add it from the docs.


const PRODUCT_TTL = 12 * 60 * 60 * 1000; // catalogue: a shoe's id and size run don't move
const MARKET_TTL = 10 * 60 * 1000;       // money: fresh enough to trade on, cheap enough to cache

// All four are needed. A half-configured install must report "not configured" and
// show nothing, never a blank price that reads as "no demand".
export function stockxConfigured() {
  return !!(process.env.STOCKX_API_KEY
    && process.env.STOCKX_CLIENT_ID
    && process.env.STOCKX_CLIENT_SECRET
    && process.env.STOCKX_REFRESH_TOKEN);
}

let tokenCache = { value: null, expires: 0 };
export function clearStockxToken() { tokenCache = { value: null, expires: 0 }; }

// Exchange the long-lived refresh token for an access token. Cached across warm
// invocations and renewed early, so a 12 h token never expires mid-request.
export async function stockxAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  if (!stockxConfigured()) throw new Error('StockX API is not configured.');
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.STOCKX_CLIENT_ID,
    client_secret: process.env.STOCKX_CLIENT_SECRET,
    refresh_token: process.env.STOCKX_REFRESH_TOKEN,
    audience: TOKEN_AUDIENCE,
  });
  const r = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  }, 12000);
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.access_token) {
    // A dead refresh token is an ops problem a human must fix in the portal — say so
    // rather than letting it surface as "no StockX prices for this shoe".
    throw new Error(`StockX token refresh failed (${r.status})${data?.error ? `: ${data.error}` : ''}`);
  }
  const ttl = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 12 * 60 * 60 * 1000;
  tokenCache = { value: data.access_token, expires: Date.now() + Math.max(60_000, ttl - 5 * 60 * 1000) };
  return tokenCache.value;
}

// ONE queue for every StockX call this server makes (2026-10-10). A 145-pair pre-sell run
// fired its creates back to back while the watcher polled operations, and StockX answered
// 429 "Too Many Requests": 69 StockX listings were never made and 37 sat pending. StockX
// doesn't publish its limit, so: calls go out at most one per STOCKX_MIN_GAP_MS (default
// 400 ms, ~2.5/s), and a 429 waits (Retry-After when StockX sends it, else 2 s, 4 s, 8 s…)
// and tries again, up to 5 times, before the 429 is handed back to the caller.
const MIN_GAP_MS = () => Number(process.env.STOCKX_MIN_GAP_MS) || 400;
let sxNext = 0;
async function sxSlot() {
  const now = Date.now();
  const at = Math.max(now, sxNext);
  sxNext = at + MIN_GAP_MS();
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sxFetch(url, init, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    await sxSlot();
    const r = await fetchWithTimeout(url, init, timeoutMs);
    if (r.status !== 429 || attempt >= 5) return r;
    const ra = Number(r.headers?.get?.('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : 2000 * 2 ** attempt;
    // Everyone else waits too: the limit is per account, not per call.
    sxNext = Math.max(sxNext, Date.now() + wait);
    await sleep(wait);
  }
}

// GET a v2 path with both credentials attached. Retries ONCE on a 401 with a fresh
// token: unlike the old bypass host, the official API's token genuinely expires on a
// clock, so re-minting and retrying is correct rather than a login loop.
async function sxGet(path, query = {}, { retry = true } = {}) {
  const token = await stockxAccessToken();
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v != null && v !== ''),
  ).toString();
  const url = `${STOCKX_BASE}${path}${qs ? `?${qs}` : ''}`;
  const r = await sxFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-api-key': process.env.STOCKX_API_KEY,
      Accept: 'application/json',
    },
  }, 12000);
  if (r.status === 401 && retry) {
    clearStockxToken();
    return sxGet(path, query, { retry: false });
  }
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

/* ------------------------------------------------------------------ */
/* Field extraction — names taken from the OpenAPI spec                */
/* (developer.stockx.com/swagger.json, "StockX Public API" 2.0.0,      */
/* read 2026-08-22). Exact, not guessed.                                */
/* ------------------------------------------------------------------ */

// Money comes back as a decimal STRING ("100"), not a number — the spec types every
// amount as `string`. No cents-vs-dollars guessing: these are whole currency units,
// so a $150,000 grail must not be "helpfully" divided by 100.
const amount = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const normSize = (s) => String(s ?? '')
  .replace(/^US\s*/i, '')
  .replace(/\s*\((M|W|Y|C)\)$/i, '')
  .trim();

// A variant's size. `variantValue` is the canonical one ("10.5"), but the size chart
// carries the same size in every convention it publishes, so a US row is the fallback
// when variantValue holds something else (the spec's own example is "PSA 10" — this
// catalogue is not only sneakers).
function variantSize(v) {
  const direct = normSize(v?.variantValue);
  if (direct) return direct;
  const conv = v?.sizeChart?.availableConversions || [];
  const us = conv.find((c) => /^us/i.test(c?.type || ''));
  return normSize(us?.size || conv[0]?.size);
}

// The catalogue row for a SKU. `search` is a text endpoint, so the style ID is
// matched EXACTLY afterwards — "DZ5485" must not silently return "DZ5485-400".
export async function stockxProductBySku(sku) {
  const want = primarySku(sku);
  if (!want) return null;
  const key = `sx:prod:${want.toUpperCase()}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;

  const { ok, data } = await sxGet('/catalog/search', { query: want, pageSize: 20 });
  if (!ok) return null;
  const rows = data?.products || [];
  const exact = rows.find((p) => String(p?.styleId || '').toUpperCase() === want.toUpperCase());
  const row = exact || rows[0] || null;
  if (!row) { cacheSet(key, null, MARKET_TTL); return null; }
  const product = {
    id: row.productId,
    styleId: row.styleId,
    title: row.title,
    urlKey: row.urlKey,
    colorway: row.productAttributes?.colorway || null,
    // An inexact hit is still useful (it's usually the right shoe in another
    // colourway) but the screen must be able to say so instead of implying certainty.
    exact: !!exact,
  };
  cacheSet(key, product, PRODUCT_TTL);
  return product;
}

// Every size of a product, with its variant id — market data is per VARIANT.
export async function stockxVariants(productId) {
  if (!productId) return [];
  const key = `sx:vars:${productId}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  // The spec types this response as a bare ARRAY of ProductVariant.
  const { ok, data } = await sxGet(`/catalog/products/${encodeURIComponent(productId)}/variants`);
  if (!ok) return [];
  const rows = Array.isArray(data) ? data : [];
  // `gtins` is the variant's barcodes — `[{ type: 'UPC'|'EAN', identifier }]`. Kept
  // (UPC first) because it answers "what is the UPC of this size" for a pair we have
  // never held: the Box Labels tool used to ask a person to read it off the tongue
  // label, and StockX had it all along. Verified live on 305381-007: size 12 →
  // 198965021212, the same number already on our own SBM-R-004922.
  const gtin = (v) => {
    const list = Array.isArray(v?.gtins) ? v.gtins : [];
    const pick = list.find((g) => /upc/i.test(g?.type)) || list.find((g) => /ean/i.test(g?.type)) || list[0];
    const digits = String(pick?.identifier || '').replace(/\D/g, '');
    return /^\d{8,14}$/.test(digits) ? digits : null;
  };
  const variants = rows
    .map((v) => ({ id: v?.variantId, size: variantSize(v), upc: gtin(v) }))
    .filter((v) => v.id);
  cacheSet(key, variants, PRODUCT_TTL);
  return variants;
}

// The UPC of ONE size of a style, off the catalogue — for a label on a pair we have
// no record of. Two cached requests (product, variants); the size is matched the same
// way the price lookup matches it. Returns `{ upc, product }` with `upc` null when the
// size is not in the run or carries no barcode, and null when the style is unknown.
export async function stockxUpcForSkuSize(sku, size) {
  const product = await stockxProductBySku(sku);
  if (!product) return null;
  const want = normSize(size);
  const variants = await stockxVariants(product.id);
  const v = variants.find((x) => x.size === want) || null;
  return { upc: v?.upc || null, product };
}

// Live money for one size.
export async function stockxVariantMarket(productId, variantId, currencyCode = 'USD') {
  if (!productId || !variantId) return null;
  const key = `sx:mkt:${variantId}:${currencyCode}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const { ok, data } = await sxGet(
    `/catalog/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}/market-data`,
    { currencyCode },
  );
  if (!ok) return null;
  const m = data || {};
  const market = {
    // Top-level amounts are the headline market. `standardMarketData` mirrors them for
    // the standard (non-Flex, non-Direct) programme and is the fallback if the
    // top-level pair is ever absent — Flex/Direct are deliberately ignored: those are
    // other fulfilment programmes and would quote a price we can't actually sell at.
    lowest_ask: amount(m.lowestAskAmount) ?? amount(m.standardMarketData?.lowestAsk),
    highest_bid: amount(m.highestBidAmount) ?? amount(m.standardMarketData?.highestBidAmount),
    // StockX's own seller nudges: the ask that becomes lowest, and the one that
    // maximises earnings. Both are inclusive of duties and taxes.
    sell_faster: amount(m.sellFasterAmount) ?? amount(m.standardMarketData?.sellFaster),
    earn_more: amount(m.earnMoreAmount) ?? amount(m.standardMarketData?.earnMore),
    currency: m.currencyCode || currencyCode,
  };
  // NOTE: there is no last-sale field anywhere in the Public API spec. StockX's own
  // site shows one and the Android gateway returns one, but the sanctioned API does
  // not — so the calculator shows ask and bid for StockX and nothing else. Don't add a
  // "Last sale" column here expecting it to fill in.
  cacheSet(key, market, MARKET_TTL);
  return market;
}

/**
 * Resolve a variant straight from a barcode. `/catalog/products/variants/gtins/{gtin}`
 * returns the productId AND variantId in ONE call, with no text search and no size
 * matching — so when a UPC is in hand this is both cheaper (1 request instead of 2)
 * and strictly more accurate: it cannot land on the wrong colourway or the wrong size,
 * which are the only two ways the SKU path can go wrong.
 */
export async function stockxVariantByGtin(gtin) {
  const g = String(gtin || '').replace(/\D/g, '');
  if (!g) return null;
  const key = `sx:gtin:${g}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const { ok, data } = await sxGet(`/catalog/products/variants/gtins/${encodeURIComponent(g)}`);
  if (!ok || !data?.variantId || !data?.productId) { cacheSet(key, null, MARKET_TTL); return null; }
  const out = { productId: data.productId, variantId: data.variantId, size: variantSize(data) };
  cacheSet(key, out, PRODUCT_TTL);
  return out;
}

// A scanned barcode → the shoe and its exact size, off the OFFICIAL catalogue. Two
// cached calls (the GTIN, then its product). Same catalogue the keyless UPC proxy reads
// — verified 2026-09-30, 16 new-release UPCs, identical answers and identical gaps — so
// upc-search calls this only when that proxy is DOWN, never for extra coverage.
// Null when unconfigured or unknown; throws nothing.
export async function stockxProductByUpc(upc) {
  if (!stockxConfigured()) return null;
  let v = null;
  try { v = await stockxVariantByGtin(upc); } catch { return null; }
  if (!v) return null;
  const key = `sx:pid:${v.productId}`;
  let p = cacheGet(key);
  if (p === null) {
    const r = await sxGet(`/catalog/products/${encodeURIComponent(v.productId)}`).catch(() => ({ ok: false }));
    if (!r.ok || !r.data?.styleId) return null;
    p = r.data;
    cacheSet(key, p, PRODUCT_TTL);
  }
  return {
    ambiguous: false,
    sku: String(p.styleId).trim().replace(/\s+/g, '-'),
    scannedSize: v.size || null,
    name: p.title || null,
    colorway: p.productAttributes?.colorway || null,
    brand: p.brand || null,
    image: null,   // the Public API carries no imagery; the Alias catalogue supplies it
    gender: p.productAttributes?.gender || null,
  };
}

/**
 * The one call the Payout Calculator makes: SKU + size → that size's StockX market.
 * Three upstream requests on a cold cache (search → variants → market data), one on
 * a warm one, and none at all when StockX isn't configured.
 *
 * Returns `null` for "no data" and throws only on a genuine outage/misconfiguration,
 * so the screen can tell "StockX has no ask for this size" apart from "StockX is
 * down" — those are different answers to "should I buy this".
 */
export async function stockxPriceForSkuSize(sku, size, { upc } = {}) {
  if (!stockxConfigured()) return null;
  // A barcode beats a name search every time — take it when the caller has one.
  if (upc) {
    const byGtin = await stockxVariantByGtin(upc);
    if (byGtin) {
      const market = await stockxVariantMarket(byGtin.productId, byGtin.variantId);
      return {
        product: { id: byGtin.productId, exact: true },
        size: byGtin.size || normSize(size),
        variant: { id: byGtin.variantId, size: byGtin.size },
        market,
      };
    }
  }
  const product = await stockxProductBySku(sku);
  if (!product?.id) return null;
  const variants = await stockxVariants(product.id);
  const want = normSize(size);
  const variant = variants.find((v) => v.size === want)
    // "10" vs "10.0" — match on the number when the strings differ.
    || variants.find((v) => Number(v.size) === Number(want) && Number.isFinite(Number(want)));
  if (!variant) return { product, size: want, variant: null, market: null };
  const market = await stockxVariantMarket(product.id, variant.id);
  return { product, size: want, variant, market };
}

/* ------------------------------------------------------------------ */
/* Selling — Pre-sell Listings (docs/context/presell-listings.md)      */
/* ------------------------------------------------------------------ */
// Every write is ASYNC on StockX: the call returns { listingId, operationId,
// operationStatus: 'PENDING' } and the result arrives later — the worker polls
// GET /selling/listings/{id}/operations/{operationId} (api/_lib/presell-worker.js).
// We list as DIRECT, like every listing already on the account (checked 2026-10-07).
async function sxCall(method, path, body = null, { query = {}, retry = true } = {}) {
  const token = await stockxAccessToken();
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString();
  const r = await sxFetch(`${STOCKX_BASE}${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, 'x-api-key': process.env.STOCKX_API_KEY, Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  // Selling calls answer in ~1 s normally but stall past 20 s at times (seen 2026-10-07).
  }, 30000);
  if (r.status === 401 && retry) { clearStockxToken(); return sxCall(method, path, body, { query, retry: false }); }
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}
export const stockxError = (r) => r?.data?.errorMessage || r?.data?.message || r?.data?.error || (Array.isArray(r?.data?.errors) ? r.data.errors.map((e) => e.message || e).join('; ') : null) || `StockX answered HTTP ${r?.status}`;
export const STOCKX_INVENTORY_TYPE = 'DIRECT';

// SKU + size → the exact variant. Inexact catalogue hits are REFUSED here: listing the
// wrong colourway is a sale we can't fill.
export async function stockxVariantFor(sku, size, { upc } = {}) {
  if (upc) {
    const v = await stockxVariantByGtin(upc).catch(() => null);
    if (v) return { productId: v.productId, variantId: v.variantId, size: v.size };
  }
  const product = await stockxProductBySku(sku);
  if (!product?.id || !product.exact) return null;
  const want = normSize(size);
  const variants = await stockxVariants(product.id);
  const v = variants.find((x) => x.size === want)
    || variants.find((x) => Number(x.size) === Number(want) && Number.isFinite(Number(want)));
  return v ? { productId: product.id, variantId: v.id, size: v.size } : null;
}

export const stockxCreateListing = ({ variantId, amount, active }) => sxCall('POST', '/selling/listings', {
  variantId, amount: String(amount), currencyCode: 'USD', active: !!active, inventoryType: STOCKX_INVENTORY_TYPE,
});
export const stockxGetListing = (id) => sxCall('GET', `/selling/listings/${encodeURIComponent(id)}`);
export const stockxListingOperation = (id, opId) => sxCall('GET', `/selling/listings/${encodeURIComponent(id)}/operations/${encodeURIComponent(opId)}`);
export const stockxUpdateListing = (id, amount) => sxCall('PATCH', `/selling/listings/${encodeURIComponent(id)}`, { amount: String(amount), currencyCode: 'USD' });
export const stockxActivateListing = (id, amount = null) => sxCall('PUT', `/selling/listings/${encodeURIComponent(id)}/activate`, amount != null ? { amount: String(amount), currencyCode: 'USD' } : {});
export const stockxDeactivateListing = (id) => sxCall('PUT', `/selling/listings/${encodeURIComponent(id)}/deactivate`, {});
export const stockxDeleteListing = (id) => sxCall('DELETE', `/selling/listings/${encodeURIComponent(id)}`);
// Sales in progress, newest activity included — matched to our listings by listingId.
export const stockxActiveOrders = (pageSize = 100) => sxCall('GET', '/selling/orders/active', null, { query: { pageNumber: 1, pageSize } });

// The DIRECT market for one size, in StockX's own words (we list DIRECT). Falls back to
// the headline numbers when the Direct block is absent.
export async function stockxDirectMarket(productId, variantId) {
  const key = `sx:dmkt:${variantId}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const { ok, data } = await sxGet(`/catalog/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}/market-data`, { currencyCode: 'USD' });
  if (!ok) return null;
  const d = data?.directMarketData || {};
  const m = {
    lowestAsk: amount(d.lowestAsk) ?? amount(data?.lowestAskAmount),
    highestBid: amount(d.highestBidAmount) ?? amount(data?.highestBidAmount),
    sellFaster: amount(d.sellFaster) ?? amount(data?.sellFasterAmount),
    earnMore: amount(d.earnMore) ?? amount(data?.earnMoreAmount),
    beatUS: amount(d.beatUS),
  };
  cacheSet(key, m, MARKET_TTL);
  return m;
}
