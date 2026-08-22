// StockX Public API client (api/_lib/stockx.js) — the one piece of the Payout
// Calculator that cannot be exercised by using the app, because it needs credentials
// nobody has in CI. So it gets tested against fixtures shaped exactly like StockX's
// OpenAPI spec (developer.stockx.com/swagger.json, Public API 2.0.0).
//
// These run in Node under the Playwright runner — no browser, no page. That's
// deliberate: `npm run e2e` is what CI runs, so living here is what makes them run at
// all. `globalThis.fetch` is stubbed, so nothing leaves the machine.
//
// NOTE on isolation: the client caches through util.js's process-wide LRU, which has
// no clear() export. Every test therefore uses its OWN style ID / product id, so one
// test can never read another's cached rows.
import { test, expect } from '@playwright/test';
import {
  stockxConfigured, clearStockxToken, stockxAccessToken,
  stockxProductBySku, stockxVariants, stockxVariantMarket,
  stockxVariantByGtin, stockxPriceForSkuSize,
} from '../api/_lib/stockx.js';

const ENV = {
  STOCKX_API_KEY: 'test-api-key',
  STOCKX_CLIENT_ID: 'test-client',
  STOCKX_CLIENT_SECRET: 'test-secret',
  STOCKX_REFRESH_TOKEN: 'test-refresh',
};

let calls = [];
let realFetch;

// Route by URL fragment. Each handler gets the request and returns
// [status, bodyObject]; anything unrouted fails loudly rather than silently 404ing,
// so a typo'd path in the client shows up as a test error naming the URL.
function mockFetch(routes) {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    for (const [frag, handler] of routes) {
      // Patterns may be RegExp — necessary because these paths nest: the market-data
      // URL contains "/variants", so a plain substring route would swallow it.
      const hit = frag instanceof RegExp ? frag.test(u) : u.includes(frag);
      if (hit) {
        const [status, body] = await handler(u, opts);
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }
    }
    throw new Error(`unrouted fetch: ${u}`);
  };
}

const TOKEN_OK = ['accounts.stockx.com/oauth/token', async () => [200, { access_token: 'access-1', expires_in: 43200 }]];

test.beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  Object.assign(process.env, ENV);
  clearStockxToken();
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
  clearStockxToken();
});

/* ------------------------------ configuration ----------------------------- */

test('all four credentials are required, and a missing one means no calls at all', async () => {
  mockFetch([TOKEN_OK]);
  expect(stockxConfigured()).toBe(true);
  for (const k of Object.keys(ENV)) {
    const keep = process.env[k];
    delete process.env[k];
    expect(stockxConfigured(), `${k} missing should read as unconfigured`).toBe(false);
    process.env[k] = keep;
  }
  // Half-configured must fail silent-and-early, never half-call upstream: a blank
  // price reads on the buy screen as "no demand", which is a different claim.
  delete process.env.STOCKX_REFRESH_TOKEN;
  expect(await stockxPriceForSkuSize('AA0000-001', '10')).toBe(null);
  expect(calls).toHaveLength(0);
});

/* --------------------------------- token ---------------------------------- */

test('the token call sends exactly the five params StockX documents', async () => {
  mockFetch([TOKEN_OK]);
  await stockxAccessToken();
  const body = new URLSearchParams(calls[0].opts.body);
  expect(body.get('grant_type')).toBe('refresh_token');
  expect(body.get('client_id')).toBe('test-client');
  expect(body.get('client_secret')).toBe('test-secret');
  expect(body.get('refresh_token')).toBe('test-refresh');
  // `audience` is required on the REFRESH call even though the authorization_code
  // exchange omits it — the asymmetry is easy to "tidy away" by mistake.
  expect(body.get('audience')).toBe('gateway.stockx.com');
  expect(calls[0].opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
});

test('the access token is cached, not re-minted per request', async () => {
  mockFetch([TOKEN_OK]);
  await stockxAccessToken();
  await stockxAccessToken();
  await stockxAccessToken();
  expect(calls.filter((c) => c.url.includes('/oauth/token'))).toHaveLength(1);
});

test('a dead refresh token surfaces as an error, not as "no prices"', async () => {
  mockFetch([['oauth/token', async () => [403, { error: 'invalid_grant' }]]]);
  await expect(stockxAccessToken()).rejects.toThrow(/invalid_grant|403/);
});

test('a 401 re-mints the token and retries once — and only once', async () => {
  let tokens = 0;
  let searches = 0;
  mockFetch([
    ['oauth/token', async () => { tokens += 1; return [200, { access_token: `access-${tokens}`, expires_in: 43200 }]; }],
    ['/catalog/search', async () => { searches += 1; return [401, { error: 'expired' }]; }],
  ]);
  const out = await stockxProductBySku('RETRY-401');
  expect(out).toBe(null);          // still a failure — but a bounded one
  expect(searches).toBe(2);        // original + exactly one retry, never a loop
  expect(tokens).toBe(2);          // the retry used a freshly minted token
});

/* -------------------------------- catalogue -------------------------------- */

const searchBody = (products) => [200, { count: products.length, pageSize: 10, pageNumber: 1, hasNextPage: false, products }];

test('the exact styleId wins, even when it is not the first result', async () => {
  mockFetch([
    TOKEN_OK,
    ['/catalog/search', async () => searchBody([
      { productId: 'p-wrong', styleId: 'DZ5485-400', title: 'Wrong colourway', urlKey: 'wrong' },
      { productId: 'p-right', styleId: 'DZ5485-612', title: 'Right one', urlKey: 'right', productAttributes: { colorway: 'Red' } },
    ])],
  ]);
  const p = await stockxProductBySku('DZ5485-612');
  expect(p.id).toBe('p-right');
  expect(p.exact).toBe(true);
  expect(p.colorway).toBe('Red');
});

test('a near-miss is returned but FLAGGED, so the screen can warn', async () => {
  mockFetch([
    TOKEN_OK,
    ['/catalog/search', async () => searchBody([
      { productId: 'p-other', styleId: 'XX1111-100', title: 'Reverse Panda', urlKey: 'rev' },
    ])],
  ]);
  const p = await stockxProductBySku('XX1111-999');
  expect(p.id).toBe('p-other');
  // Silently pricing the wrong colourway is the failure mode this guards.
  expect(p.exact).toBe(false);
});

test('variants read variantValue, and fall back to a US size-chart row', async () => {
  mockFetch([
    TOKEN_OK,
    [/\/variants(\?|$)/, async () => [200, [
      { variantId: 'v1', variantValue: '10.5' },
      { variantId: 'v2', variantValue: '', sizeChart: { availableConversions: [{ size: '11', type: 'us m' }, { size: '45', type: 'eu' }] } },
      { variantId: 'v3', variantValue: 'US 12' },
      // No variantId at all — unaddressable, so it must be dropped.
      { variantName: 'orphan', variantValue: '13' },
    ]]],
  ]);
  const vs = await stockxVariants('prod-sizes');
  expect(vs.map((v) => `${v.id}:${v.size}`)).toEqual(['v1:10.5', 'v2:11', 'v3:12']);
});

/* ------------------------------- market data ------------------------------- */

test('amounts are decimal strings — parsed, never cents-corrected', async () => {
  mockFetch([
    TOKEN_OK,
    ['/market-data', async () => [200, {
      productId: 'p', variantId: 'v', currencyCode: 'USD',
      lowestAskAmount: '145', highestBidAmount: '101',
      earnMoreAmount: '152', sellFasterAmount: '144',
    }]],
  ]);
  const m = await stockxVariantMarket('p-amounts', 'v-amounts');
  expect(m).toMatchObject({ lowest_ask: 145, highest_bid: 101, earn_more: 152, sell_faster: 144, currency: 'USD' });
});

test('a five-figure grail is NOT divided by 100', async () => {
  mockFetch([
    TOKEN_OK,
    ['/market-data', async () => [200, { lowestAskAmount: '150000', highestBidAmount: '120000' }]],
  ]);
  const m = await stockxVariantMarket('p-grail', 'v-grail');
  // The bug this pins: a "looks too big, must be cents" heuristic turned a $150,000
  // ask into $1,500 — a terrible buy dressed up as the deal of the year.
  expect(m.lowest_ask).toBe(150000);
  expect(m.highest_bid).toBe(120000);
});

test('standardMarketData is the fallback; flex and direct are ignored', async () => {
  mockFetch([
    TOKEN_OK,
    ['/market-data', async () => [200, {
      // Top-level absent — the standard programme still answers.
      standardMarketData: { lowestAsk: '200', highestBidAmount: '180', earnMore: '210', sellFaster: '195' },
      // These quote other fulfilment programmes; using them would price a sale we
      // cannot actually make.
      flexMarketData: { lowestAsk: '1', highestBidAmount: '2' },
      directMarketData: { lowestAsk: '3', highestBidAmount: '4' },
      flexLowestAskAmount: '1',
    }]],
  ]);
  const m = await stockxVariantMarket('p-std', 'v-std');
  expect(m.lowest_ask).toBe(200);
  expect(m.highest_bid).toBe(180);
});

test('zero and null read as "no market", not as a $0 price', async () => {
  mockFetch([
    TOKEN_OK,
    ['/market-data', async () => [200, { lowestAskAmount: '0', highestBidAmount: null }]],
  ]);
  const m = await stockxVariantMarket('p-empty', 'v-empty');
  expect(m.lowest_ask).toBe(null);
  expect(m.highest_bid).toBe(null);
});

test('the market request names the currency and the country', async () => {
  mockFetch([TOKEN_OK, ['/market-data', async () => [200, { lowestAskAmount: '100' }]]]);
  await stockxVariantMarket('p-query', 'v-query');
  const url = calls.find((c) => c.url.includes('/market-data')).url;
  expect(url).toContain('currencyCode=USD');
  // Left implicit, StockX picks the market for us — and we are a US business.
  expect(url).toContain('country=US');
});

/* ---------------------------------- GTIN ---------------------------------- */

test('a UPC resolves the variant in ONE call and cannot mismatch', async () => {
  mockFetch([
    TOKEN_OK,
    ['/variants/gtins/', async () => [200, {
      productId: 'p-gtin', variantId: 'v-gtin', variantValue: '10',
      gtins: [{ identifier: '887231059577', type: 'UPC' }],
    }]],
    ['/market-data', async () => [200, { lowestAskAmount: '210', highestBidAmount: '190' }]],
  ]);
  const hit = await stockxPriceForSkuSize('IGNORED-SKU', '10', { upc: '887231059577' });
  expect(hit.product.exact).toBe(true);
  expect(hit.variant.id).toBe('v-gtin');
  expect(hit.market.lowest_ask).toBe(210);
  // The whole point: no /catalog/search, no /variants listing, so there is no text
  // match and no size match that could land on the wrong pair.
  expect(calls.some((c) => c.url.includes('/catalog/search'))).toBe(false);
});

test('non-digits in a scanned UPC are stripped before the lookup', async () => {
  mockFetch([TOKEN_OK, ['/variants/gtins/', async () => [200, { productId: 'p', variantId: 'v', variantValue: '9' }]]]);
  await stockxVariantByGtin(' 887231-059578 ');
  expect(calls.find((c) => c.url.includes('gtins')).url).toContain('/gtins/887231059578');
});

test('an unknown UPC falls back to the SKU path rather than giving up', async () => {
  mockFetch([
    TOKEN_OK,
    ['/variants/gtins/', async () => [404, { error: 'not found' }]],
    ['/catalog/search', async () => searchBody([{ productId: 'p-fb', styleId: 'FB1234-001', title: 'Fallback', urlKey: 'fb' }])],
    [/\/variants(\?|$)/, async () => [200, [{ variantId: 'v-fb', variantValue: '10' }]]],
    ['/market-data', async () => [200, { lowestAskAmount: '99' }]],
  ]);
  const hit = await stockxPriceForSkuSize('FB1234-001', '10', { upc: '000000000000' });
  expect(hit.market.lowest_ask).toBe(99);
  expect(hit.variant.id).toBe('v-fb');
});

/* ------------------------------ size matching ------------------------------ */

test('size 10 matches a variant labelled 10.0', async () => {
  mockFetch([
    TOKEN_OK,
    ['/catalog/search', async () => searchBody([{ productId: 'p-sz', styleId: 'SZ0001-001', title: 'Sizes', urlKey: 'sz' }])],
    [/\/variants(\?|$)/, async () => [200, [{ variantId: 'v-10', variantValue: '10.0' }]]],
    ['/market-data', async () => [200, { lowestAskAmount: '120' }]],
  ]);
  const hit = await stockxPriceForSkuSize('SZ0001-001', '10');
  expect(hit.variant.id).toBe('v-10');
  expect(hit.market.lowest_ask).toBe(120);
});

test('a size StockX does not carry returns no market, not the wrong size', async () => {
  mockFetch([
    TOKEN_OK,
    ['/catalog/search', async () => searchBody([{ productId: 'p-miss', styleId: 'MS0001-001', title: 'Missing', urlKey: 'ms' }])],
    [/\/variants(\?|$)/, async () => [200, [{ variantId: 'v-8', variantValue: '8' }]]],
  ]);
  const hit = await stockxPriceForSkuSize('MS0001-001', '13');
  expect(hit.variant).toBe(null);
  expect(hit.market).toBe(null);
  // Falling back to "any variant" here would quote size 8's price for a size 13.
  expect(calls.some((c) => c.url.includes('/market-data'))).toBe(false);
});
