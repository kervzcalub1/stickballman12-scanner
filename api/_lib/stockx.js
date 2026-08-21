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
// market-data takes an optional `country`; ours is a US business, and leaving it
// implicit would let StockX pick the market for us.
const COUNTRY = process.env.STOCKX_COUNTRY || 'US';

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

// GET a v2 path with both credentials attached. Retries ONCE on a 401 with a fresh
// token: unlike the old bypass host, the official API's token genuinely expires on a
// clock, so re-minting and retrying is correct rather than a login loop.
async function sxGet(path, query = {}, { retry = true } = {}) {
  const token = await stockxAccessToken();
  const qs = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v != null && v !== ''),
  ).toString();
  const url = `${STOCKX_BASE}${path}${qs ? `?${qs}` : ''}`;
  const r = await fetchWithTimeout(url, {
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
  const variants = rows
    .map((v) => ({ id: v?.variantId, size: variantSize(v) }))
    .filter((v) => v.id);
  cacheSet(key, variants, PRODUCT_TTL);
  return variants;
}

// Live money for one size.
export async function stockxVariantMarket(productId, variantId, currencyCode = 'USD') {
  if (!productId || !variantId) return null;
  const key = `sx:mkt:${variantId}:${currencyCode}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const { ok, data } = await sxGet(
    `/catalog/products/${encodeURIComponent(productId)}/variants/${encodeURIComponent(variantId)}/market-data`,
    { currencyCode, country: COUNTRY },
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
