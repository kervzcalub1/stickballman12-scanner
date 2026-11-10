// Listings kept fresh by the SERVER (owner, 2026-11-10): docs/context/shopify-listings.md
// "Kept fresh by the server". Never calls the real Shopify, eBay, SHEIN or Alias:
//   • the stored copy: an unchanged row isn't rewritten, a product re-read drops sizes Shopify no longer has
//   • the market pass prices only in-stock ACTIVE sizes, and only what is missing or stale
//   • every Shopify webhook topic reaches the copy — and an error there never touches SHEIN's path
//   • SHEIN's re-read every 30 min (counted from when the last one finished); the worker switches
//   • the endpoint serves the copy + the server's market prices; the page shows them with no lookups
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
let pool;
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const PID = 'gid://shopify/Product/e2e-lw-1';
const vr = (n, size, qty, extra = {}) => ({
  variantId: `gid://shopify/ProductVariant/e2e-lw-${n}`, productId: PID, productTitle: 'E2E Watch Dunk (ZZ9001-100)',
  status: 'ACTIVE', handle: 'e2e', image: null, sku: `e2e-lw-${n}`, size, price: '100.00', compareAt: null, qty, style: 'ZZ9001-100', ...extra,
});

test.beforeAll(async () => { pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); });
test.afterAll(async () => {
  await q(`DELETE FROM shopify_listing_variants WHERE variant_id LIKE 'gid://shopify/ProductVariant/e2e-lw-%'`);
  await q(`DELETE FROM listing_market_prices WHERE sku LIKE 'ZZ9001%'`);
  await pool.end();
});

test('the stored copy: unchanged rows are not rewritten; a product re-read drops the sizes Shopify no longer has', async () => {
  const db = await import('../api/_lib/db.js');
  expect(await db.upsertShopifyListingVariants([vr(1, '9', 2), vr(2, '10', 0)])).toBe(2);
  expect(await db.upsertShopifyListingVariants([vr(1, '9', 2), vr(2, '10', 0)])).toBe(0);     // nothing changed → no write, no live notice
  expect(await db.upsertShopifyListingVariants([vr(1, '9', 1)])).toBe(1);                     // a stock change
  const out = await db.replaceShopifyListingProduct(PID, [vr(1, '9', 1), vr(3, '11', 4)]);   // size 10 gone, 11 new
  expect(out).toEqual({ changed: 1, removed: 1 });
  const mine = (await db.listShopifyListingVariants()).filter((x) => x.productId === PID).map((x) => [x.size, x.qty]).sort();
  expect(mine).toEqual([['11', 4], ['9', 1]]);
  expect((await db.replaceShopifyListingProduct(PID, [])).removed).toBe(2);                   // products/delete
});

test('the market pass prices in-stock ACTIVE sizes only, and only what is missing or stale', async () => {
  const { marketPass } = await import('../api/_lib/listings-watch.js');
  const asked = [];
  const price = async (sku, size) => { asked.push(`${sku}|${size}`); return { sku, size, status: 'ok', valueCents: 12300 }; };
  const variants = [vr(1, '9', 2), vr(2, '10', 0), vr(3, '11', 1, { status: 'DRAFT' }), vr(4, '12', null)];
  const first = await marketPass({ variants, price });
  expect(asked.sort()).toEqual(['ZZ9001-100|12', 'ZZ9001-100|9']);   // 10 = no stock, 11 = draft; null qty counts as in stock
  expect(first).toMatchObject({ sizes: 2, priced: 2, errors: 0 });
  asked.length = 0;
  expect((await marketPass({ variants, price })).due).toBe(0);         // fresh: not asked again
  expect(asked).toEqual([]);
  // A failed lookup is never stored as an answer — it is asked again next pass.
  await q(`UPDATE listing_market_prices SET checked_at = now() - interval '7 hours' WHERE sku = 'ZZ9001-100' AND size = '9'`);
  const failing = async (sku, size) => ({ sku, size, status: 'error', error: 'Alias down' });
  expect(await marketPass({ variants, price: failing })).toMatchObject({ due: 1, priced: 0, errors: 1 });
  const [row] = await q(`SELECT value_cents FROM listing_market_prices WHERE sku = 'ZZ9001-100' AND size = '9'`);
  expect(row.value_cents).toBe(12300);
});

test('every Shopify webhook topic reaches the stored copy; an error there never touches SHEIN or eBay', async () => {
  const { routeShopifyWebhook } = await import('../api/shopify/webhook.js');
  const calls = [];
  const hook = {
    shopifySkuForInventoryItem: async () => 'SKU-5', queuePush: (s) => calls.push(['shein', s]),
    listingProductChanged: (b) => calls.push(['shein-product', b.id]), listingProductDeleted: async (b) => calls.push(['shein-delete', b.id]),
    ebaySyncQueue: async (items) => calls.push(['ebay', items[0].kind]),
    shopifyListing: {
      stock: (id) => calls.push(['copy-stock', id]), product: (id) => calls.push(['copy-product', id]), deleted: (id) => calls.push(['copy-delete', id]),
    },
  };
  expect(await routeShopifyWebhook('inventory_levels/update', { inventory_item_id: 5 }, hook)).toEqual({ pushed: 'SKU-5' });
  await routeShopifyWebhook('products/create', { id: 7 }, hook);
  await routeShopifyWebhook('products/update', { id: 7 }, hook);
  await routeShopifyWebhook('products/delete', { id: 8 }, hook);
  expect(calls.filter((c) => c[0].startsWith('copy'))).toEqual([['copy-stock', 5], ['copy-product', 7], ['copy-product', 7], ['copy-delete', 8]]);
  // The copy throwing (sync or async) changes nothing for SHEIN's path.
  const broken = { ...hook, shopifyListing: { stock: () => { throw new Error('boom'); }, product: async () => { throw new Error('boom'); }, deleted: () => { throw new Error('boom'); } } };
  expect(await routeShopifyWebhook('inventory_levels/update', { inventory_item_id: 5 }, broken)).toEqual({ pushed: 'SKU-5' });
  expect(await routeShopifyWebhook('products/update', { id: 9 }, broken)).toEqual({ listing: 'queued' });
});

test('SHEIN re-reads every 30 min, counted from when the last one finished; the worker switches', async () => {
  const { snapshotDue } = await import('../api/_lib/shein-listing.js');
  const now = new Date('2026-11-10T15:00:00Z');
  expect(snapshotDue(null, now, 30)).toBe(true);
  expect(snapshotDue({ status: 'running', created_at: '2026-11-10T10:00:00Z' }, now, 30)).toBe(false);   // never two at once
  expect(snapshotDue({ status: 'queued', created_at: '2026-11-10T10:00:00Z' }, now, 30)).toBe(false);
  expect(snapshotDue({ status: 'done', created_at: '2026-11-10T13:00:00Z', finished_at: '2026-11-10T14:40:00Z' }, now, 30)).toBe(false); // finished 20 min ago
  expect(snapshotDue({ status: 'done', created_at: '2026-11-10T13:00:00Z', finished_at: '2026-11-10T14:29:00Z' }, now, 30)).toBe(true);
  expect(snapshotDue({ status: 'failed', created_at: '2026-11-10T14:00:00Z', finished_at: null }, now, 30)).toBe(true);
  expect(snapshotDue(null, now, 0)).toBe(false);   // 0 = back to the nightly only
  const { listingsWatchEnabled } = await import('../api/_lib/listings-watch-worker.js');
  expect(listingsWatchEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true);
  expect(listingsWatchEnabled({})).toBe(false);                                         // dev shares the store and the eBay account
  expect(listingsWatchEnabled({ RAILWAY_ENVIRONMENT_NAME: 'production', LISTINGS_WATCH: 'off' })).toBe(false);
  expect(listingsWatchEnabled({ LISTINGS_WATCH: 'on' })).toBe(true);
});

test('the page shows the server copy and its market prices — no lookups from the browser', async ({ page }) => {
  const asked = [];
  await loginAs(page, 'ph_team');
  await page.route('**/api/shopify-listings/variants', (r) => r.fulfill({ json: {
    ok: true, source: 'stored', adminStore: 'test-store', variants: [vr(1, '9', 2, { price: '150.00' }), vr(3, '11', 1)],
    check: { state: 'done', at: '2026-11-10T14:30:00Z', by: 'auto (every 30 min)' }, marketPass: { at: '2026-11-10T14:35:00Z' },
    market: [{ sku: 'ZZ9001-100', size: '9', status: 'ok', valueCents: 10000 }, { sku: 'ZZ9001-100', size: '11', status: 'ok', valueCents: 10000 }],
  } }));
  await page.route('**/api/ebay-reprice/prices', (r) => { asked.push(r.request().postDataJSON()); r.fulfill({ json: { ok: true, results: [] } }); });
  await page.route('**/api/shopify-listings/history', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
  await page.goto('/ph/shopify-listings');
  await expect(page.getByText('Kept up to date by the server')).toBeVisible();
  await expect(page.getByText(/Last full check/)).toBeVisible();
  // Market 100 + 12 % = 112: size 9 at $150 is off market; no "Get market prices" needed.
  await expect(page.getByRole('button', { name: /Use suggested for 2 sizes/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Get market prices/ })).toHaveCount(0);
  expect(asked).toEqual([]);
});
