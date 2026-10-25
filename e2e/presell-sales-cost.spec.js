// Pre-sell Sales report: the cost of every sale, and WHY a sale has none (owner, 2026-10-25:
// "we set the shelf price but the report says no cost"), plus the SKU filter next to the dates.
// Cost rule = presellUnitCost: the shelf price IS the cost, fees on top when picked. Resolved at
// read time (withPresellCost), so nothing here writes a cost. No marketplace / Telegram is touched.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SUPPLIER = `E2E SalesCost ${stamp}`;
const SKU = `E2E-SC-${stamp}`;
const OTHER = `E2E-ZZ-${stamp}`;
const PH = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };
const DAY = '2026-10-24';

test.describe.configure({ mode: 'serial' });
let po; const row = {};

test.beforeAll(async () => {
  [po] = await q(`INSERT INTO purchase_orders (supplier_name, status, manifest_scope, created_by) VALUES ($1, 'shipped', 'po', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  // The PO's order list carries a shelf price for size 9 only.
  await q(`INSERT INTO po_lines (po_id, sku, size, name, qty_expected, unit_cost) VALUES ($1, $2, '9', 'E2E SC', 5, 120)`, [po.id, SKU]);
  const mk = async (k, sku, size, extra) => {
    const [r] = await q(`INSERT INTO presell_stock (sku, size, name, qty, sold, po_id, supplier, shelf_price, unit_cost, cost_stack)
                         VALUES ($1, $2, 'E2E SC', 5, 1, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
      [sku, size, po.id, SUPPLIER, extra.shelf ?? null, extra.cost ?? null, extra.stack ? JSON.stringify(extra.stack) : null]);
    row[k] = Number(r.id);
    await q(`INSERT INTO presell_sales (stock_id, platform, order_id, price_cents, payout_cents, sold_at, po_id)
             VALUES ($1, 'alias', $2, 20000, 18000, $3::timestamptz, $4)`, [r.id, `E2E-SC-${stamp}-${k}`, `${DAY}T16:00:00Z`, po.id]);
  };
  await mk('entered', SKU, '8', { shelf: 100, cost: 110 });       // a cost saved on the row
  await mk('shelfOnly', SKU, '8.5', { shelf: 90 });                // shelf, no cost saved (pre-backfill row)
  await mk('fromPo', SKU, '9', {});                                 // nothing on the row; the PO line says $120
  await mk('none', SKU, '10', {});                                  // no shelf anywhere
  await mk('other', OTHER, '9', { shelf: 50, cost: 50 });          // a different SKU, for the filter
});

test.afterAll(async () => {
  await q('DELETE FROM presell_stock WHERE sku = ANY($1)', [[SKU, OTHER]]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

const sales = async (request, params) => {
  const r = await request.get(`/api/presell-listings/list?${new URLSearchParams({ tab: 'sales', ...params })}`, { headers: PH });
  expect(r.status()).toBe(200);
  return (await r.json()).rows;
};

test('every sale gets its cost the way the Stock tab does, and a sale without one says why', async ({ request }) => {
  const rows = await sales(request, { from: DAY, sku: SKU });
  const by = Object.fromEntries(rows.map((x) => [x.size, x]));
  expect(Object.keys(by).sort()).toEqual(['10', '8', '8.5', '9']);
  expect(by['8']).toMatchObject({ unit_cost: '110.00', cost_source: 'entered' });
  // Shelf typed, cost never saved → the shelf IS the cost (presellUnitCost), read live.
  expect(by['8.5']).toMatchObject({ unit_cost: 90, cost_source: 'shelf' });
  // Nothing on the row → the shelf price on the PO line for that SKU + size.
  expect(by['9']).toMatchObject({ unit_cost: 120, cost_source: 'po', cost_shelf: 120 });
  // No shelf anywhere → blank, with the reason.
  expect(by['10']).toMatchObject({ unit_cost: null, cost_source: null, cost_reason: 'no_shelf' });
  // Nothing was written — the rows still hold no cost.
  expect((await q('SELECT unit_cost FROM presell_stock WHERE id = ANY($1) ORDER BY id', [[row.shelfOnly, row.fromPo, row.none]])).every((r) => r.unit_cost == null)).toBe(true);
});

test('SKU filter: part of a SKU, any case, together with the dates', async ({ request }) => {
  expect((await sales(request, { from: DAY, sku: `sc-${stamp}` })).map((x) => x.sku).every((s) => s === SKU)).toBe(true);
  expect(await sales(request, { from: DAY, sku: `sc-${stamp}` })).toHaveLength(4);
  expect((await sales(request, { from: DAY, sku: `zz-${stamp}` })).map((x) => x.size)).toEqual(['9']);
  // A day with no sales of that SKU → none.
  expect(await sales(request, { from: '2026-10-26', sku: SKU })).toHaveLength(0);
});

test('the page: SKU box next to the dates, kept in the URL; totals say why sales have no cost', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/presell-listings?tab=sales&from=${DAY}&sku=${SKU.toLowerCase()}`);
  await expect(page.getByLabel('SKU filter')).toHaveValue(SKU.toLowerCase());
  await expect(page.getByText('4 sales')).toBeVisible();
  await expect(page.getByText(/1 without a cost/)).toBeVisible();
  await expect(page.getByText(/Without a cost: 1 no shelf price/)).toBeVisible();
  await expect(page.getByText(/1 sale costed from the shelf price on the purchase order/)).toBeVisible();
  // Changing the box updates the URL, and a refresh keeps it.
  await page.getByLabel('SKU filter').fill(`zz-${stamp}`);
  await expect(page).toHaveURL(new RegExp(`sku=zz-${stamp}`));
  await page.reload();
  await expect(page.getByLabel('SKU filter')).toHaveValue(`zz-${stamp}`);
  await expect(page.getByText('1 sale', { exact: true })).toBeVisible();
});
