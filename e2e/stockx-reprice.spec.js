// StockX Listings + Reprice (docs/context/stockx-reprice.md, 2026-11-03).
// Our ~1,750 Direct asks vs the market; bulk "match the Standard lowest ask", never under the
// profit floor, only lower. The test server runs with STOCKX_REPRICE_WORKER=off — dev and prod
// share ONE StockX account, so nothing here may ever reach StockX: changes stay QUEUED.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { planListing, floorPrice, rulePrice, gapPct } from '../src/lib/stockxReprice.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const PH = { Authorization: `Bearer ${signToken({ uid: 'sx-ph', username: 'sx_ph', name: 'SX PH', role: 'ph_team' })}` };
const stamp = `${Date.now()}`.slice(-7);
const ID = (n) => `e2e-sx-${stamp}-${n}`;
const NAME = `E2E SX Shoe ${stamp}`;
const SKU = `E2ESX-${stamp}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // 1: $170 ask, Standard $48, cost $30 → floor ⌈35/0.9⌉ = 39 → match $48.
  // 2: $120, Standard $48, cost $60 → floor 73 → held at the floor ($73).
  // 3: $70, Standard $48, cost $60 → floor 73 ≥ today → the floor stops it.
  // 4: $45, Standard $48 → already under.  5: no cost (another style).  6: Standard missing.
  const rows = [
    [ID(1), SKU, '9', 170, 48, 170, 40], [ID(2), SKU, '10', 120, 48, 120, 40], [ID(3), SKU, '11', 70, 48, 70, 40],
    [ID(4), SKU, '12', 45, 48, 60, 40], [ID(5), `${SKU}-NC`, '9', 150, 50, 150, 40], [ID(6), SKU, '13', 140, null, 140, null],
  ];
  for (const [id, sku, size, amt, std, dir, bid] of rows) {
    await q(`INSERT INTO stockx_listings (listing_id, variant_id, product_id, product_name, style_id, size, amount, inventory_type, sx_created_at, standard_lowest, direct_lowest, highest_bid, market_at)
             VALUES ($1, $1, 'p', $2, $3, $4, $5, 'DIRECT', now() - interval '90 days', $6, $7, $8, now())`, [id, NAME, sku, size, amt, std, dir, bid]);
  }
  // Our cost for the style, per size (average of our pairs).
  for (const [size, cost] of [['9', 30], ['10', 60], ['11', 60], ['12', 30], ['13', 30]]) {
    await q(`INSERT INTO items (vin, name, sku, size, cost, status, with_box) VALUES ($1, $2, $3, $4, $5, 'in_stock', true)`,
      [`SBM-990101-${stamp.slice(-5)}${size.padStart(2, '0')}`, NAME, SKU, size, cost]);
  }
});

test.afterAll(async () => {
  await q(`DELETE FROM stockx_price_edits WHERE listing_id LIKE $1`, [`e2e-sx-${stamp}-%`]);
  await q(`DELETE FROM stockx_price_locks WHERE listing_id LIKE $1`, [`e2e-sx-${stamp}-%`]);
  await q(`DELETE FROM stockx_listings WHERE listing_id LIKE $1`, [`e2e-sx-${stamp}-%`]);
  await q(`DELETE FROM items WHERE sku = $1`, [SKU]);
  await pool.end();
});

test('the rules: match the Standard lowest ask, never under the floor, only lower (pure)', () => {
  expect(floorPrice(30, 5)).toBe(39);                       // ⌈35 / 0.9⌉
  expect(floorPrice(null, 5)).toBeNull();
  const row = { amount: 170, standard_lowest: 48, highest_bid: 40, cost: 30 };
  expect(planListing(row)).toMatchObject({ state: 'change', price: 48 });
  expect(planListing({ ...row, cost: 60 })).toMatchObject({ state: 'floored', price: 73, target: 48 });
  expect(planListing({ ...row, amount: 70, cost: 60 }).state).toBe('below_floor');
  expect(planListing({ ...row, amount: 45 }).state).toBe('kept');
  expect(planListing({ ...row, cost: null }).state).toBe('no_cost');
  expect(planListing({ ...row, cost: null }, { allowNoCost: true })).toMatchObject({ state: 'change', price: 48 });
  expect(planListing({ ...row, locked: true }).state).toBe('locked');
  expect(planListing({ ...row, presell: true }).state).toBe('presell');
  expect(planListing({ ...row, standard_lowest: null }).state).toBe('no_market');
  expect(rulePrice(row, 'standard_minus', 2)).toBe(46);
  expect(planListing(row, { rule: 'bid' })).toMatchObject({ state: 'change', price: 40 });
  expect(gapPct(row)).toBeCloseTo(254.2, 1);
});

test('the server works out the prices itself, queues them, and skips what it shouldn’t touch', async ({ request }) => {
  const list = await (await request.get('/api/stockx/listings', { headers: PH })).json();
  const mine = list.rows.filter((r) => r.listing_id.startsWith(`e2e-sx-${stamp}`));
  expect(mine).toHaveLength(6);
  expect(Number(mine.find((r) => r.listing_id === ID(1)).cost)).toBe(30);
  expect(mine.find((r) => r.listing_id === ID(5)).cost).toBeNull();

  // Lock #2 — the exception.
  const lk = await request.post('/api/stockx/lock', { headers: PH, data: { listingIds: [ID(2)], lock: true, note: 'holding' } });
  expect((await lk.json()).count).toBe(1);

  const r = await request.post('/api/stockx/reprice', { headers: PH, data: { listingIds: [1, 2, 3, 4, 5, 6].map(ID), rule: 'standard', minProfit: 5 } });
  const out = await r.json();
  expect(out.queued).toBe(1);                                // only #1
  const why = Object.fromEntries(out.skipped.map((s) => [s.listingId, s.state]));
  expect(why).toEqual({ [ID(2)]: 'locked', [ID(3)]: 'below_floor', [ID(4)]: 'kept', [ID(5)]: 'no_cost', [ID(6)]: 'no_market' });
  const queued = await q(`SELECT status, old_amount, new_amount, rule FROM stockx_price_edits WHERE listing_id = $1`, [ID(1)]);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ status: 'queued', old_amount: '170.00', new_amount: '48.00' });
  expect(queued[0].rule).toMatch(/Match the Standard lowest ask · min profit \$5/);

  // A second run can't put a second change in flight on the same listing.
  const again = await (await request.post('/api/stockx/reprice', { headers: PH, data: { listingIds: [ID(1)] } })).json();
  expect(again.queued).toBe(0);
  expect(again.skipped[0].state).toBe('busy');

  // Unlock #2 → it reprices, held at its floor.
  await request.post('/api/stockx/lock', { headers: PH, data: { listingIds: [ID(2)], lock: false } });
  const two = await (await request.post('/api/stockx/reprice', { headers: PH, data: { listingIds: [ID(2)] } })).json();
  expect(two.queued).toBe(1);
  expect((await q(`SELECT new_amount, rule FROM stockx_price_edits WHERE listing_id = $1`, [ID(2)]))[0]).toMatchObject({ new_amount: '73.00' });

  // Nothing is sent from the test server (worker off) — "Stop the rest" cancels what's queued.
  const stop = await (await request.post('/api/stockx/reprice', { headers: PH, data: { cancel: true } })).json();
  expect(stop.cancelled).toBeGreaterThanOrEqual(2);
  expect((await q(`SELECT status FROM stockx_price_edits WHERE listing_id = $1`, [ID(1)]))[0].status).toBe('cancelled');
});

test('the page: filters to what would drop, picks them, queues the reprice', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/stockx-listings');
  await page.getByLabel('Search StockX listings').fill(NAME);
  // Default "only ones that would drop": #1 ($170 → $48) and #2 (held at $73).
  await expect(page.locator('.sx-row')).toHaveCount(2);
  await expect(page.locator('.sx-row', { hasText: 'size 9 ·' })).toContainText('→ $48');
  await expect(page.locator('.sx-row', { hasText: 'size 10 ·' })).toContainText('Held at the floor ($73)');
  await page.getByLabel('Only ones that would drop').uncheck();
  await expect(page.locator('.sx-row')).toHaveCount(6);
  await page.getByLabel('Over the Standard lowest ask by at least percent').fill('200');
  await expect(page.locator('.sx-row')).toHaveCount(2);          // $170 vs $48, $150 vs $50
  await page.getByLabel('Over the Standard lowest ask by at least percent').fill('');
  await page.getByLabel('Only ones that would drop').check();
  await page.getByLabel(/Select all 2 that would drop/).check();
  await page.getByRole('button', { name: 'Reprice 2 on StockX' }).click();
  await page.getByRole('button', { name: 'Reprice 2', exact: true }).click();
  await expect(page.getByText(/2 price changes queued/)).toBeVisible();
  await expect(page.getByText(/Sending to StockX: 2 waiting/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop the rest' }).click();
  await expect(page.getByText(/2 queued changes stopped/)).toBeVisible();
});
