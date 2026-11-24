// Costs → bulk entry (2026-11-24). Searching a SKU returned one card per shipment, each with
// a box per size, and every box had to be typed by hand. What has to hold now:
//   · "Same cost for all shipments" + Fill all types one amount into every box on screen,
//     and NOTHING is saved until Save all;
//   · "Only sizes with no cost yet" leaves a cost that is already on file alone;
//   · a box can still be changed by hand after the fill, and Save all saves each its amount;
//   · the "All sizes" box on one card fills that shipment only;
//   · every pair gets its history note, like a cost typed one at a time.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-CB-${stamp}`;
const vin = (n) => `SBM-E2ECB-${stamp}${n}`;
const codes = [1, 2, 3].map((n) => `B-E2ECB${n}-${stamp}`);
let batchIds = [];
const costs = async () => Object.fromEntries((await q('SELECT vin, cost FROM items WHERE sku = $1', [SKU])).map((r) => [r.vin.slice(-1), r.cost == null ? null : Number(r.cost)]));
const reset = () => q(`UPDATE items SET cost = CASE WHEN vin = $2 THEN 80 ELSE NULL END WHERE sku = $1`, [SKU, vin(7)]);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  for (const code of codes) {
    batchIds.push(Number((await q(`INSERT INTO batches (batch_code, supplier_name, status, kind, date_received)
      VALUES ($1, 'E2E CB Supplier', 'committed', 'receiving', current_date) RETURNING id`, [code]))[0].id));
  }
  // Three shipments of one shoe: 9 + 10 (two pairs) · 9 + 11 · 10 + 12 (the 12 already costs $80).
  await q(`INSERT INTO items (vin, batch_id, sku, size, name, status, cost, created_at) VALUES
      ($1, $8,  $11, '9',  'E2E CB Runner', 'in_stock', NULL, now()),
      ($2, $8,  $11, '10', 'E2E CB Runner', 'in_stock', NULL, now()),
      ($3, $8,  $11, '10', 'E2E CB Runner', 'in_stock', NULL, now()),
      ($4, $9,  $11, '9',  'E2E CB Runner', 'in_stock', NULL, now()),
      ($5, $9,  $11, '11', 'E2E CB Runner', 'in_stock', NULL, now()),
      ($6, $10, $11, '10', 'E2E CB Runner', 'in_stock', NULL, now()),
      ($7, $10, $11, '12', 'E2E CB Runner', 'in_stock', 80,   now())`,
    [vin(1), vin(2), vin(3), vin(4), vin(5), vin(6), vin(7), batchIds[0], batchIds[1], batchIds[2], SKU]);
});

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  for (const id of batchIds) await q('DELETE FROM batches WHERE id = $1', [id]);
  await pool.end();
});

const card = (page, code) => page.locator('.cost-card').filter({ hasText: code });
const open = async (page) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/costs?q=${SKU}`);
  await expect(page.locator('.cost-card')).toHaveCount(3);
};

test('one amount for every shipment and size: filled, checked, then saved in one go', async ({ page }) => {
  await open(page);
  const bulk = page.locator('.cost-bulk');
  await expect(bulk).toContainText('Same cost for all 3 shipments');
  await expect(bulk).toContainText('7 pairs');
  await expect(page.getByRole('button', { name: /^Save all/ })).toBeDisabled();

  await bulk.locator('input[type=number]').fill('95');
  await bulk.getByRole('button', { name: 'Fill all' }).click();
  // Every box reads 95 — the one that had $80 too — and nothing has been written.
  for (const v of await page.locator('.cost-size input').evaluateAll((els) => els.map((e) => e.value))) expect(v).toBe('95');
  await expect(page.locator('.cost-bulk-save')).toContainText('6 sizes changed · 7 pairs · not saved yet');
  expect(Object.values(await costs()).filter((c) => c != null)).toEqual([80]);

  // One box corrected by hand after the fill keeps its own amount.
  await card(page, codes[1]).locator('.cost-size').filter({ hasText: 'US 11' }).locator('input').fill('101.5');
  await page.getByRole('button', { name: 'Save all (6)' }).click();
  await expect(page.locator('.ok')).toContainText('Saved 6 sizes · 7 pairs across 3 shipments.');
  expect(await costs()).toEqual({ 1: 95, 2: 95, 3: 95, 4: 95, 5: 101.5, 6: 95, 7: 95 });
  await expect(page.getByRole('button', { name: /^Save all/ })).toBeDisabled();
  // Each pair's history says what it was set to, as a cost typed one at a time does.
  const [{ n }] = await q(`SELECT count(*)::int n FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.sku = $1 AND e.details->>'text' LIKE 'Cost set to $%'`, [SKU]);
  expect(n).toBe(7);
});

test('"Only sizes with no cost yet" leaves a cost on file alone; Undo changes drops the fill', async ({ page }) => {
  await reset();
  await open(page);
  const bulk = page.locator('.cost-bulk');
  await bulk.locator('input[type=number]').fill('60');
  await bulk.locator('input[type=checkbox]').check();
  await bulk.getByRole('button', { name: 'Fill all' }).click();
  await expect(card(page, codes[2]).locator('.cost-size').filter({ hasText: 'US 12' }).locator('input')).toHaveValue(/^80(\.00)?$/);
  await expect(page.locator('.cost-bulk-save')).toContainText('5 sizes changed · 6 pairs');

  await page.getByRole('button', { name: 'Undo changes' }).click();
  await expect(page.getByRole('button', { name: /^Save all/ })).toBeDisabled();
  await expect(card(page, codes[0]).locator('.cost-size input').first()).toHaveValue('');

  await bulk.getByRole('button', { name: 'Fill all' }).click();
  await page.getByRole('button', { name: 'Save all (5)' }).click();
  await expect(page.locator('.ok')).toContainText('Saved 5 sizes · 6 pairs across 3 shipments.');
  expect(await costs()).toEqual({ 1: 60, 2: 60, 3: 60, 4: 60, 5: 60, 6: 60, 7: 80 });
});

test('"All sizes" on one card fills that shipment only, and its own Save saves it', async ({ page }) => {
  await reset();
  await open(page);
  const c = card(page, codes[0]);
  await c.locator('.cost-allsizes input').fill('72');
  await c.getByRole('button', { name: 'Fill 2 sizes' }).click();
  await expect(c.locator('.cost-size input').first()).toHaveValue('72');
  await expect(card(page, codes[1]).locator('.cost-size input').first()).toHaveValue('');
  await c.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.ok')).toContainText('Saved 2 sizes · 3 pairs');
  expect(await costs()).toEqual({ 1: 72, 2: 72, 3: 72, 4: null, 5: null, 6: null, 7: 80 });
});
