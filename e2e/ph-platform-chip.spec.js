// New Inventory's best-platform chip: where a line's pairs pay most after fees, and
// roughly what a pair makes there. The market comes from platform_quotes (what anyone
// priced in the last 12 hours — free), and only the styles nobody has priced go to
// api/payout/batch, which is mocked here so the suite never spends the StockX quota.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';

const WH = { Authorization: `Bearer ${signToken({ uid: 'ppc-wh', username: 'ppc_wh', name: 'PPC Warehouse', role: 'warehouse' })}` };
const PH = { Authorization: `Bearer ${signToken({ uid: 'ppc-ph', username: 'ppc_ph', name: 'PPC PH', role: 'ph_team' })}` };
const COSTED = 'QAPC-COSTED-1';   // cached: Alias wins, costed → "+$80/pr"
const NOCOST = 'QAPC-NOCOST-1';   // no cost, nothing cached → "No cost", and never priced
const FRESH = 'QAPC-FRESH-1';     // nothing cached → priced by the page, once
const OLD = 'QAPC-OLD-1';         // cached 2 days ago → too old to trust, re-priced

let db;
const batchCodes = [];

test.beforeAll(async ({ request }) => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const today = new Date().toISOString().slice(0, 10);
  for (const [sku, cost] of [[COSTED, 100], [NOCOST, null], [FRESH, 90], [OLD, 90]]) {
    const r = await request.post('/api/batches/commit', {
      headers: WH,
      data: {
        batch: { supplier: 'QAPC-Fixture', tracking: `${sku}-${Date.now()}`, dateReceived: today, manifestReceived: true },
        items: ['9', '10'].map((size) => ({ name: `QAPC ${sku}`, sku, size, ...(cost != null ? { cost } : {}), withBox: true })),
      },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    batchCodes.push((await r.json()).batchCode);
  }
  await db.query(`DELETE FROM platform_quotes WHERE sku LIKE 'QAPC-%'`);
  await db.query(`
    INSERT INTO platform_quotes (sku, size, consigned, alias_ask, stockx_ask, fetched_at) VALUES
      ($1, '9', true, 200, 150, now()), ($1, '10', true, 200, 150, now()),
      ($2, '9', true, 500, 500, now() - interval '2 days'), ($2, '10', true, 500, 500, now() - interval '2 days')`,
  [COSTED, OLD]);
});

test.afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM platform_quotes WHERE sku LIKE 'QAPC-%'`);
  await db.query(`DELETE FROM items WHERE sku LIKE 'QAPC-%'`);
  await db.query(`DELETE FROM batches WHERE batch_code = ANY($1)`, [batchCodes]).catch(() => {});
  await db.end();
});

test('the chip reads remembered prices and prices only what nobody has', async ({ page }) => {
  const priced = [];
  const hierarchyAsked = [];
  await page.route('**/api/payout/batch', async (route) => {
    const body = route.request().postDataJSON();
    priced.push(...body.skus.map((s) => s.sku));
    hierarchyAsked.push(body.hierarchy);
    const quotes = {};
    for (const s of body.skus) {
      // No consigned ask at all, a With You GI of 120: the FJ7126-003 12W case — Alias
      // must still be compared, at the hierarchy price (2026-10-09).
      quotes[s.sku] = {
        alias: { configured: true, results: s.sizes.map((size) => ({ size, lowest_listing: 0, global_indicator: 0, alias_price: 120, alias_basis: 'with_you' })) },
        stockx: { configured: true, results: s.sizes.map((size) => ({ size, lowest_ask: 60 })) },
      };
    }
    await route.fulfill({ json: { ok: true, quotes, consigned: true } });
  });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/new-inventory?q=QAPC');

  const chip = (sku) => page.locator('.ph-trow', { hasText: sku }).locator('.ph-plat-chip');
  // Alias 200 → 180.20 after 9.9%, less $100 landed.
  await expect(chip(COSTED)).toHaveText('Alias +$80/pr');
  await expect(chip(COSTED)).toHaveClass(/gain/);
  // No cost → no profit to compare, so it says so and is never sent to be priced.
  await expect(chip(NOCOST)).toHaveText('No cost');
  await expect(chip(NOCOST)).toHaveClass(/nocost/);
  // Priced by the page: Alias 120 → 108.12, less $90.
  await expect(chip(FRESH)).toHaveText('Alias +$18/pr');
  // A two-day-old quote is not an answer — it was priced again, at today's market.
  await expect(chip(OLD)).toHaveText('Alias +$18/pr');
  expect(priced.sort()).toEqual([FRESH, OLD].sort());
  // PH asks for the Alias price by the pricing hierarchy, never the bare lowest ask.
  expect(hierarchyAsked.every((h) => h === true)).toBe(true);

  // Tapping the chip opens the line, where "Where to sell" has the per-size table.
  await chip(COSTED).click();
  await expect(page.getByText('Where to sell').first()).toBeVisible();
});

test('the remembered prices are PH-only', async ({ request }) => {
  const wh = await request.get(`/api/ph/platform-quotes?skus=${COSTED}`, { headers: WH });
  expect(wh.status()).toBe(403);
  const ph = await (await request.get(`/api/ph/platform-quotes?skus=${COSTED},${OLD}`, { headers: PH })).json();
  // Only the fresh rows come back; the two-day-old ones were re-priced by the test above
  // (mocked, so nothing was written) and are still too old to return.
  expect(ph.quotes.filter((q) => q.sku === COSTED)).toHaveLength(2);
  expect(ph.quotes.filter((q) => q.sku === OLD)).toHaveLength(0);
});

// QA 2026-10-01: a search change used to price another 20 styles by itself, so filtering
// could walk the whole grid through the StockX quota. Only the first load auto-prices.
test('changing the search reads remembered prices, and never prices by itself', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/payout/batch', async (route) => {
    calls += 1;
    const body = route.request().postDataJSON();
    const quotes = {};
    for (const s of body.skus) quotes[s.sku] = { alias: { configured: true, results: [] }, stockx: { configured: true, results: [] } };
    await route.fulfill({ json: { ok: true, quotes, consigned: true } });
  });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/new-inventory?q=QAPC');
  await expect(page.locator('.ph-trow', { hasText: COSTED }).locator('.ph-plat-chip')).toHaveText('Alias +$80/pr');
  await page.waitForTimeout(500);
  const first = calls;
  await page.locator('.ph-search-input').fill('QAPC-FRESH');
  await page.waitForTimeout(800);
  await page.locator('.ph-search-input').fill('QAPC-OLD');
  await page.waitForTimeout(800);
  expect(calls).toBe(first);
});

