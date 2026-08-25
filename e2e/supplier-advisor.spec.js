// The supplier's advisor — the same panel, a deliberately much smaller advisor behind it.
//
// A supplier is an outside partner, so theirs answers three questions: should we buy
// this style, how many, and how many do we already hold. The narrowing is enforced in
// three places (see api/advisor/ask.js) and this checks all three, because the prompt is
// the only one of them a model can talk its way past.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { toolsFor, runTool, supplierView, SUPPLIER_TOOLS } from '../api/advisor/ask.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const SUPPLIER = { role: 'supplier', uid: '999', name: 'E2E Supplier' };
const STAFF = { role: 'warehouse', uid: '1', name: 'E2E Warehouse' };

const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-ADV-${stamp}`;
let batchId = null;

test.beforeAll(async () => {
  batchId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'closed','receiving','E2E Advisor') RETURNING id`,
    [`B-ADV-${stamp}`]))[0].id);
  const add = (size, n, listed) => q(
    `INSERT INTO items (vin, batch_id, name, sku, size, status, cost, added_to_intel_inv, synced_alias, synced_stockx, synced_shopify)
     VALUES ($1,$2,'E2E Advisor Shoe',$3,$4,'needs_shelf',95,$5,$5,$5,$5)`,
    [`SBM-ADV-${stamp}-${n}`, batchId, SKU, size, listed]);
  await add('9', 1, false); await add('9', 2, true); await add('10', 3, false);
});

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await pool.end();
});

test('the model is only offered the three tools those questions need', () => {
  const names = toolsFor(SUPPLIER).map((t) => t.function.name);
  expect(new Set(names)).toEqual(SUPPLIER_TOOLS);
  // Nothing about our shelves, our backlog, our rankings or our procedures.
  for (const off of ['find_stock', 'pending_work', 'top_sellers', 'search_sop']) {
    expect(names).not.toContain(off);
  }
  // Staff are untouched.
  expect(toolsFor(STAFF).map((t) => t.function.name)).toContain('pending_work');
  expect(toolsFor(STAFF).length).toBeGreaterThan(names.length);
});

test('a tool off the list is refused even when called by name', async () => {
  // A tool list is a suggestion to a model; the allowlist is not. If this ever regressed
  // to filtering only the menu, a hallucinated call would walk straight through.
  for (const off of ['find_stock', 'pending_work', 'top_sellers', 'search_sop']) {
    const out = await runTool(off, { code: 'anything', query: 'anything' }, SUPPLIER);
    expect(out.error, `${off} answered a supplier`).toMatch(/not available/i);
    expect(JSON.stringify(out)).not.toMatch(/vin|pending_shelve|articles/i);
  }
  // …and the same call still works for staff.
  const staffOut = await runTool('pending_work', {}, STAFF);
  expect(staffOut.error).toBeUndefined();
});

test('"how many do we hold" comes back as counts, never our listing state', async () => {
  const out = await runTool('stock_status', { sku: SKU }, SUPPLIER);
  // Three pairs held: two US 9, one US 10 — regardless of how far PH got listing them.
  expect(out.on_hand_total).toBe(3);
  expect(out.sizes).toEqual([{ size: '9', on_hand: 2 }, { size: '10', on_hand: 1 }]);
  const json = JSON.stringify(out);
  for (const leak of ['pending', 'in_progress', 'listed', 'shopify_qty', 'no_box']) {
    expect(json, `leaked ${leak}`).not.toContain(leak);
  }
  // Staff still get the full three-bucket answer.
  const staffOut = await runTool('stock_status', { sku: SKU }, STAFF);
  expect(JSON.stringify(staffOut)).toContain('in_progress');
});

test('sku_history keeps the buy signal and drops where WE sell', () => {
  const raw = {
    inventory: { on_hand: 3, avg_cost: 95, last_cost: 90 },
    sales: { days: 30, sold: 12, per_week: 2.8, liquidity: 'weekly', avg_price: 210,
      channels: { GOAT: 9, StockX: 3 }, sizes: { 9: 7 }, last_sold: '2026-08-20' },
  };
  const out = supplierView('sku_history', raw);
  // What decides a buy stays: what we pay, how fast it moves, what it fetches.
  expect(out.inventory.avg_cost).toBe(95);
  expect(out.sales.per_week).toBe(2.8);
  expect(out.sales.liquidity).toBe('weekly');
  // Where we choose to list it is ours.
  expect(out.sales.channels).toBeUndefined();
  expect(JSON.stringify(out)).not.toContain('GOAT');
});

test('the panel is on the supplier portal, and its openers are the three questions', async ({ page }) => {
  await loginAs(page, 'supplier');
  await page.route('**/api/advisor/ask', (route) => route.fulfill({ json: { ok: true, reply: 'Pass — **7%** ROI.' } }));
  await page.goto('/');
  await page.locator('.advisor-fab').click();
  const suggest = page.locator('.advisor-suggest button');
  await expect(suggest).toHaveCount(3);
  await expect(suggest.nth(0)).toContainText('Should we buy');
  await expect(suggest.nth(1)).toContainText('How many should I get');
  await expect(suggest.nth(2)).toContainText('How many do we have');
  await expect(page.locator('.ah-sub')).toContainText('buy calls & stock');
});
