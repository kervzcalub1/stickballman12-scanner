// POIZON Orders (docs/context/poizon-orders.md). What this pins:
//   · which Shopify orders are POIZON's (the app's name), and what we keep of one;
//   · the state in plain words (to ship · shipped · cancelled) and the pick entries: one per pair
//     STILL to ship (a shipped or refunded pair is not picked), SKU = the style code in the title;
//   · the sync: reads only what changed since its cursor, keeps POIZON's, moves the cursor on,
//     and says why when Shopify refuses;
//   · the real SQL (local DB): PH reads it, the warehouse can't; still-to-ship orders older than
//     the period are kept;
//   · the page: To ship first, tick → Download → a 4 x 6 PDF named by the EST day (browser in Manila).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { poizonOrderState, poizonOrdersSorted, poizonPickEntries, poizonToShip, pickListFileName } from '../src/lib/pickList.js';
import { isPoizonOrder, poizonOrderRow } from '../api/_lib/poizon-orders.js';

const node = (o = {}) => ({
  id: 'gid://shopify/Order/8546607792318', name: '21315226930833298', createdAt: '2026-11-16T11:43:00Z', updatedAt: '2026-11-16T11:50:00Z',
  cancelledAt: null, closedAt: null, displayFulfillmentStatus: 'UNFULFILLED', displayFinancialStatus: 'PAID', app: { name: 'POIZON' },
  lineItems: { edges: [{ node: { title: "Nike Sabrina 3 Me vs. Me Women's (IQ5085-102)", quantity: 1, currentQuantity: 1, unfulfilledQuantity: 1, variantTitle: '8W', sku: '10113918' } }] },
  fulfillments: [], ...o,
});
const line = (o = {}) => ({ title: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', size: '9', sku: '10100001', qty: 1, current: 1, unfulfilled: 1, ...o });

test.describe('POIZON orders — pure', () => {
  test('a POIZON order is one made by the POIZON app; other channels are not', () => {
    expect(isPoizonOrder({ app: { name: 'POIZON' } })).toBe(true);
    expect(isPoizonOrder({ app: { name: 'Poizon Seller' }, channelInformation: null })).toBe(true);
    expect(isPoizonOrder({ app: { name: 'x' }, channelInformation: { channelDefinition: { channelName: 'POIZON' } } })).toBe(true);
    for (const name of ['StockX', 'My Store: GOAT', 'Temu', 'eBay Integration - DPL', '']) expect(isPoizonOrder({ app: { name } })).toBe(false);
    expect(isPoizonOrder(null)).toBe(false);
  });

  test('what we keep of a Shopify order: number, times, lines with pairs still to ship, tracking', () => {
    const r = poizonOrderRow(node({ fulfillments: [{ status: 'SUCCESS', createdAt: '2026-11-16T15:00:00Z', trackingInfo: [{ number: '879660119638', company: 'FedEx', url: 'https://x' }] }, { status: 'SUCCESS', trackingInfo: [] }] }));
    expect(r.shopify_order_id).toBe('8546607792318');
    expect(r.order_no).toBe('21315226930833298');
    expect(r.lines).toEqual([{ title: "Nike Sabrina 3 Me vs. Me Women's (IQ5085-102)", size: '8W', sku: '10113918', qty: 1, current: 1, unfulfilled: 1 }]);
    expect(r.tracking).toEqual([{ number: '879660119638', company: 'FedEx', url: 'https://x', status: 'SUCCESS', at: '2026-11-16T15:00:00Z' }]);
    expect(r.shopify_updated_at).toBe('2026-11-16T11:50:00Z');
  });

  test('the state: cancelled wins, fulfilled = shipped, everything refunded = cancelled, else to ship', () => {
    expect(poizonOrderState({ lines: [line()] })).toBe('to_ship');
    expect(poizonOrderState({ fulfillment_status: 'PARTIALLY_FULFILLED', lines: [line({ unfulfilled: 0 }), line()] })).toBe('to_ship');
    expect(poizonOrderState({ fulfillment_status: 'FULFILLED', lines: [line({ unfulfilled: 0 })] })).toBe('shipped');
    expect(poizonOrderState({ fulfillment_status: 'UNFULFILLED', lines: [line({ unfulfilled: 0 })] })).toBe('shipped');
    // a real one (2026-11-10): shipped with a FedEx number, then cancelled on POIZON
    expect(poizonOrderState({ cancelled_at: '2026-11-12T06:46:21Z', fulfillment_status: 'UNFULFILLED', lines: [line({ unfulfilled: 0 })] })).toBe('cancelled');
    expect(poizonOrderState({ lines: [line({ current: 0, unfulfilled: 0 })] })).toBe('cancelled');
  });

  test('pick entries: one per pair still to ship, the style code as SKU, to-ship orders listed first', () => {
    const orders = poizonOrdersSorted([
      { order_no: 'C', ordered_at: '2026-11-16T00:00:00Z', cancelled_at: '2026-11-16T01:00:00Z', lines: [line()] },
      { order_no: 'S', ordered_at: '2026-11-15T00:00:00Z', fulfillment_status: 'FULFILLED', lines: [line({ unfulfilled: 0 })] },
      { order_no: 'A', ordered_at: '2026-11-12T00:00:00Z', lines: [line({ qty: 2, current: 2, unfulfilled: 2 }), line({ title: 'Refunded (AB1234-100)', current: 0, unfulfilled: 1 }), line({ title: 'Nike Air Max 2017 Wolf Grey', size: '10.5', unfulfilled: 1 })] },
      { order_no: 'B', ordered_at: '2026-11-14T00:00:00Z', lines: [line({ qty: 2, current: 2, unfulfilled: 1, size: '8W' })] },
    ]);
    expect(orders.map((o) => `${o.order_no}:${o.state}`)).toEqual(['B:to_ship', 'A:to_ship', 'S:shipped', 'C:cancelled']);
    expect(poizonToShip(line({ qty: 2, current: 1, unfulfilled: 2 }))).toBe(1);
    const e = poizonPickEntries(orders);
    expect(e.map((x) => [x.orderNo, x.sku, x.size, `${x.pair}/${x.pairs}`])).toEqual([
      ['B', 'DD1391-100', '8W', '1/1'],
      ['A', 'DD1391-100', '9', '1/3'], ['A', 'DD1391-100', '9', '2/3'],
      ['A', '10100001', '10.5', '3/3'],                    // no style code in the title: Shopify's own SKU
    ]);
    expect(pickListFileName('poizon', new Date('2026-11-13T03:30:00Z'))).toBe('pick-list-poizon-2026-11-12.pdf');
  });
});

/* ------------------------------ the sync + the real SQL ------------------------------ */
test.describe.serial('POIZON orders — sync and endpoint on the local database', () => {
  test.skip(!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || ''), 'needs the local database');
  const ph = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };
  const wh = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E WH', role: 'warehouse' })}` };
  const KEY = 'e2e_poizon_orders_sync';
  let pool;
  const clean = async () => {
    await pool.query(`DELETE FROM poizon_orders WHERE order_no LIKE 'E2EPZ%'`);
    await pool.query(`DELETE FROM app_settings WHERE key = $1`, [KEY]);
  };
  test.beforeAll(async () => { const pg = (await import('pg')).default; pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); await clean(); });
  test.afterAll(async () => { await clean(); await pool.end(); });

  test('the sync keeps only POIZON orders, moves its cursor on, rewrites a row only when Shopify changed it', async ({ request }) => {
    const { runPoizonOrdersSync, readSync } = await import('../api/_lib/poizon-orders.js');
    const { upsertPoizonOrders } = await import('../api/_lib/db.js');
    const recent = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const full = {
      'gid://shopify/Order/e2epz1': node({ id: 'gid://shopify/Order/e2epz1', name: 'E2EPZ1', createdAt: recent, updatedAt: recent }),
      'gid://shopify/Order/e2epz2': node({ id: 'gid://shopify/Order/e2epz2', name: 'E2EPZ2', createdAt: old, updatedAt: recent }),   // old, still to ship
      'gid://shopify/Order/e2epz3': node({ id: 'gid://shopify/Order/e2epz3', name: 'E2EPZ3', createdAt: old, updatedAt: recent, displayFulfillmentStatus: 'FULFILLED' }),
    };
    const calls = [];
    const io = {
      key: KEY, configured: () => true, save: upsertPoizonOrders,
      page: async (since, after) => {
        calls.push({ since, after });
        if (!after) return { ok: true, next: 'c1', orders: [{ id: 'gid://shopify/Order/other1', updatedAt: '2026-11-16T10:00:00Z', app: { name: 'StockX' } }, { id: 'gid://shopify/Order/e2epz1', updatedAt: '2026-11-16T11:00:00Z', app: { name: 'POIZON' } }] };
        return { ok: true, next: null, orders: [{ id: 'gid://shopify/Order/e2epz2', updatedAt: '2026-11-16T12:00:00Z', app: { name: 'POIZON' } }, { id: 'gid://shopify/Order/e2epz3', updatedAt: '2026-11-16T12:30:00Z', app: { name: 'POIZON' } }] };
      },
      full: async (ids) => ({ ok: true, orders: ids.map((id) => full[id]) }),
    };
    const r1 = await runPoizonOrdersSync({ by: 'e2e', io });
    expect(r1).toMatchObject({ ok: true, read: 4, found: 3, changed: 3, more: false });
    expect(Date.now() - Date.parse(calls[0].since)).toBeGreaterThan(29 * 86_400_000);      // first run: the last 30 days
    expect(calls[1].after).toBe('c1');
    const s = await readSync(KEY);
    expect(s).toMatchObject({ state: 'done', cursor: '2026-11-16T12:30:00Z', firstDone: true, by: 'e2e' });
    // again: from just before the cursor, and nothing is rewritten
    calls.length = 0;
    const r2 = await runPoizonOrdersSync({ by: 'e2e', io });
    expect(r2.changed).toBe(0);
    expect(calls[0].since).toBe('2026-11-16T12:28:00.000Z');
    // Shopify refuses → the reason is kept, the cursor is not lost
    const r3 = await runPoizonOrdersSync({ by: 'e2e', io: { ...io, page: async () => ({ error: 'x', code: 'denied' }) } });
    expect(r3.error).toContain('read_orders');
    expect(await readSync(KEY)).toMatchObject({ state: 'error', cursor: '2026-11-16T12:30:00Z' });

    // the endpoint: sold in the period + the old one still to ship; not the old shipped one
    const res = await request.get('/api/poizon/orders', { headers: ph });
    expect(res.status()).toBe(200);
    const mine = (await res.json()).orders.filter((o) => o.order_no.startsWith('E2EPZ')).map((o) => o.order_no).sort();
    expect(mine).toEqual(['E2EPZ1', 'E2EPZ2']);
    expect((await request.get('/api/poizon/orders', { headers: wh })).status()).toBe(403);
    expect((await request.get('/api/poizon/orders')).status()).toBe(401);
    expect((await request.post('/api/poizon/orders', { headers: wh, data: {} })).status()).toBe(403);
  });
});

/* ------------------------------------ the page ------------------------------------ */
async function readPdf(dl) {
  const bytes = fs.readFileSync(await dl.path());
  const doc = await PDFDocument.load(bytes);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) pages.push((await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join('\n'));
  return { count: doc.getPageCount(), sizes: doc.getPages().map((p) => p.getSize()), pages };
}
const NOW = new Date('2026-11-13T03:30:00Z');   // 12 Nov, 22:30 EST; already the 13th in Manila
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
const fixture = () => [
  { shopify_order_id: '1', order_no: '21315226930833298', ordered_at: iso(-3600_000), fulfillment_status: 'UNFULFILLED', lines: [line({ title: "Nike Sabrina 3 Me vs. Me Women's (IQ5085-102)", size: '8W' })], tracking: [] },
  { shopify_order_id: '2', order_no: '21315224973853298', ordered_at: iso(-86400_000), fulfillment_status: 'UNFULFILLED', lines: [line({ qty: 2, current: 2, unfulfilled: 2 }), line({ title: 'Jordan 4 Military Blue (FV5029-141)', size: '12' })], tracking: [] },
  { shopify_order_id: '3', order_no: '21315224195943298', ordered_at: iso(-2 * 86400_000), fulfillment_status: 'FULFILLED', lines: [line({ unfulfilled: 0 })], tracking: [{ number: '879660119638', company: 'FedEx' }] },
  { shopify_order_id: '4', order_no: '21315224179963298', ordered_at: iso(-3 * 86400_000), cancelled_at: iso(-3 * 86400_000 + 60_000), lines: [line()], tracking: [] },
];
const answer = (o = {}) => ({ ok: true, orders: fixture(), configured: true, auto: true, sync: { state: 'done', lastAt: NOW.toISOString(), firstDone: true }, ...o });

test.describe('POIZON orders — the page', () => {
  test.use({ timezoneId: 'Asia/Manila' });

  test('PH: opens on To ship, shows shipped + cancelled under All, tick → Download → a 4 x 6 PDF by the EST day', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    let posts = 0;
    await page.route('**/api/poizon/orders**', (r) => { if (r.request().method() === 'POST') { posts += 1; return r.fulfill({ json: { ok: true, started: true } }); } return r.fulfill({ json: answer() }); });
    await loginAs(page, 'ph_team');
    await page.goto('/ph');
    await page.getByText('POIZON Orders').first().click();
    await expect(page).toHaveURL(/\/ph\/poizon/);
    const rows = page.locator('[data-poizon-orders] .ebo-table tbody tr');
    await expect(rows).toHaveCount(2);                                         // To ship by default
    await expect(rows.first()).toContainText('21315226930833298');
    await expect(rows.first()).toContainText('IQ5085-102');
    await expect(page.locator('[data-poizon-sync]')).toContainText('Last checked');
    await expect(page.locator('[data-poizon-sync]')).toContainText('EST');
    await page.getByRole('button', { name: /^All/ }).click();
    await expect(rows).toHaveCount(4);
    await expect(page.locator('tr[data-order="21315224195943298"]')).toContainText('Shipped');
    await expect(page.locator('tr[data-order="21315224195943298"]')).toContainText('879660119638');
    await expect(page.locator('tr[data-order="21315224179963298"]')).toContainText('Cancelled');
    await expect(page.getByLabel('Pick order 21315224179963298')).toBeDisabled();
    await expect(page.getByLabel('Pick order 21315224195943298')).toBeDisabled();
    const bar = page.locator('[data-pick-bar="poizon"]');
    await bar.getByRole('button', { name: 'Select awaiting shipment (2)' }).click();
    await expect(bar.locator('[data-pick-count]')).toHaveText('2 orders · 4 pairs');
    const [dl] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download pick list (2)' }).click()]);
    expect(dl.suggestedFilename()).toBe('pick-list-poizon-2026-11-12.pdf');
    const pdf = await readPdf(dl);
    expect(pdf.count).toBe(1);
    expect(pdf.sizes).toEqual([{ width: 288, height: 432 }]);
    for (const w of ['POIZON pick list | 12 Nov 2026 EST', '#21315226930833298', 'SKU IQ5085-102', 'Size 8W', '#21315224973853298', '1 of 3', '3 of 3', 'SKU FV5029-141', 'Size 12', '4 pairs | 2 orders']) expect(pdf.pages[0]).toContain(w);
    expect(pdf.pages[0]).not.toContain('21315224195943298');
    await page.getByRole('button', { name: /Check now/ }).click();
    await expect.poll(() => posts).toBe(1);
    // a refresh keeps the filter
    await page.reload();
    await expect(rows).toHaveCount(4);
  });

  test('never read yet says so; an admin reaches it at /poizon; a phone fits', async ({ page }) => {
    await page.route('**/api/poizon/orders**', (r) => r.fulfill({ json: answer({ orders: [], sync: null, auto: false }) }));
    await loginAs(page, 'admin');
    await page.goto('/poizon');
    await expect(page.locator('[data-poizon-sync]')).toContainText('Not read yet');
    await expect(page.locator('[data-poizon-orders]')).toContainText('No POIZON orders read yet.');
    await page.unroute('**/api/poizon/orders**');
    await page.route('**/api/poizon/orders**', (r) => r.fulfill({ json: answer() }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/poizon?state=all');
    await expect(page.locator('.ebo-table tbody tr')).toHaveCount(4);
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className}`));
    expect(wide).toEqual([]);
  });
});
