// Pre-sell Listings → 🕘 History (owner, 2026-11-13: "when did I enter a pre-sale and what kind
// of shoes and sizes?"). Every time pairs were entered, newest first: when, who, shoes, sizes ×
// pairs, prices. Rows are seeded straight into our tables (presell_entries, or presell_listings
// for the rebuilt part) — no marketplace and no Telegram is touched. The one API write here is a
// Pairs… raise on a size with no listings, which never calls a marketplace.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SKU = `E2E-HI-${stamp}`;
const OLD = `E2E-HO-${stamp}`;
const RUN = `e2e-run-${stamp}`;
const PH = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };

test.describe.configure({ mode: 'serial' });
const ids = {};

test.beforeAll(async () => {
  const [a] = await q(`INSERT INTO presell_stock (sku, size, name, qty) VALUES ($1, '9', 'E2E History', 3) RETURNING id`, [SKU]);
  const [b] = await q(`INSERT INTO presell_stock (sku, size, name, qty) VALUES ($1, '10.5', 'E2E History', 2) RETURNING id`, [SKU]);
  ids.a = Number(a.id); ids.b = Number(b.id);
  // One paste sent in TWO create calls (same run_id) → one entry on the tab.
  const line = (id, size, qty, extra = {}) => ({ stock_id: id, sku: SKU, name: 'E2E History', size, qty, shelf: 110,
    alias: { price_cents: 18000, created: qty, failed: 0 }, stockx: { price_cents: 19000, created: qty - (extra.sxFail || 0), failed: extra.sxFail || 0 } });
  await q(`INSERT INTO presell_entries (run_id, kind, activate, in_transit, transit_note, supplier, lines, created_by, created_at)
           VALUES ($1, 'new', true, true, 'truck 2', 'E2E Supplier', $2::jsonb, 'Alex E2E', '2026-02-01T15:00:00Z'),
                  ($1, 'new', true, true, 'truck 2', 'E2E Supplier', $3::jsonb, 'Alex E2E', '2026-02-01T15:00:20Z')`,
  [RUN, JSON.stringify([line(ids.a, '9', 3)]), JSON.stringify([line(ids.b, '10.5', 2, { sxFail: 1 })])]);
  // From BEFORE the history table: listing rows only. Two minutes apart = one run; 2 h later = another.
  const [o] = await q(`INSERT INTO presell_stock (sku, size, name, qty) VALUES ($1, '8', 'E2E Old', 2) RETURNING id`, [OLD]);
  ids.o = Number(o.id);
  const L = (platform, at, n) => q(`INSERT INTO presell_listings (stock_id, platform, external_id, price_cents, status, created_by, created_at)
    VALUES ($1, $2, $3, 15000, 'live', 'Nikki E2E', $4::timestamptz)`, [ids.o, platform, `E2E-HO-${stamp}-${n}`, at]);
  await L('alias', '2025-01-05T15:00:00Z', 1); await L('alias', '2025-01-05T15:01:00Z', 2); await L('stockx', '2025-01-05T15:02:00Z', 3);
  await L('alias', '2025-01-05T17:30:00Z', 4);
});

test.afterAll(async () => {
  await q(`DELETE FROM presell_entries WHERE run_id = $1 OR EXISTS (SELECT 1 FROM jsonb_array_elements(lines) x WHERE x->>'sku' = ANY($2))`, [RUN, [SKU, OLD]]);
  await q('DELETE FROM presell_stock WHERE sku = ANY($1)', [[SKU, OLD]]);
  await pool.end();
});

const history = async (request, params) => {
  const r = await request.get(`/api/presell-listings/list?${new URLSearchParams({ tab: 'history', ...params })}`, { headers: PH });
  expect(r.status()).toBe(200);
  return (await r.json()).rows;
};

test('a paste sent in batches is ONE entry: when, who, sizes × pairs, prices, what failed', async ({ request }) => {
  const runs = await history(request, { sku: SKU });
  expect(runs).toHaveLength(1);
  const [r] = runs;
  expect(r).toMatchObject({ by: 'Alex E2E', kind: 'new', source: 'entry', in_transit: true, supplier: 'E2E Supplier', transit_note: 'truck 2', pairs: 5 });
  expect(new Date(r.at).toISOString()).toBe('2026-02-01T15:00:00.000Z');
  expect(r.shoes).toHaveLength(1);
  expect(r.shoes[0].sizes.map((z) => [z.size, z.qty])).toEqual([['9', 3], ['10.5', 2]]);
  expect(r.shoes[0].sizes[1].stockx).toMatchObject({ min: 19000, max: 19000, created: 1, failed: 1 });
  // The date filter is the EST day it was entered.
  expect(await history(request, { sku: SKU, from: '2026-02-02' })).toHaveLength(0);
  expect(await history(request, { sku: SKU, from: '2026-02-01', to: '2026-02-01' })).toHaveLength(1);
});

test('before the history started: rebuilt from the listing rows, a gap over 15 min = a new entry', async ({ request }) => {
  const runs = await history(request, { sku: OLD });
  expect(runs.map((r) => [r.source, r.by, r.pairs])).toEqual([['rebuilt', 'Nikki E2E', 1], ['rebuilt', 'Nikki E2E', 2]]);
  // 2 Alias + 1 StockX listing of size 8 in one sitting = 2 pairs.
  expect(runs[1].shoes[0].sizes[0]).toMatchObject({ size: '8', qty: 2 });
});

test('more pairs on a size (Stock → Pairs…) is an entry too; a cut is not', async ({ request }) => {
  const up = await request.post('/api/presell-listings/action', { headers: PH, data: { stockId: ids.a, action: 'qty', qty: 5 } });
  expect(up.status()).toBe(200);
  const down = await request.post('/api/presell-listings/action', { headers: PH, data: { stockId: ids.a, action: 'qty', qty: 4 } });
  expect(down.status()).toBe(200);
  const runs = await history(request, { sku: SKU });
  expect(runs).toHaveLength(2);
  expect(runs[0]).toMatchObject({ kind: 'pairs', by: 'E2E PH', pairs: 2 });
  expect(runs[0].shoes[0].sizes[0]).toMatchObject({ size: '9', qty: 2, from: 3, to: 5 });
});

test('the tab: one card per entry, sizes as chips, filter by who, fits a phone', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/presell-listings?tab=history&sku=${SKU}`);
  const cards = page.locator('.ap-hist-run');
  await expect(cards).toHaveCount(2);
  const paste = cards.filter({ hasText: 'Alex E2E' });
  await expect(paste).toContainText('5 pairs · 1 shoe');
  await expect(paste).toContainText('02/01/26 10:00 AM EST'); // the year shows — history goes back
  await expect(paste).toContainText('🚚 In transit');
  await expect(paste).toContainText('E2E Supplier · truck 2');
  await expect(paste.locator('.ap-hist-size')).toHaveText(['9 × 3', '10.5 × 2']);
  await expect(paste).toContainText('Alias $180');
  await expect(paste).toContainText('StockX $190 · 1 didn’t list');
  await expect(cards.filter({ hasText: 'E2E PH' })).toContainText('＋ Pairs added');
  await page.getByLabel('Entered by').selectOption('Alex E2E');
  await expect(cards).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/presell-history-phone.png', fullPage: true });
});
