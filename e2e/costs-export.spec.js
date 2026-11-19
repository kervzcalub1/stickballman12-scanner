// Costs → filter by supplier + a typed date range, and Export CSV (2026-11-20). What has
// to hold:
//   · the CSV is ONE row per SKU whatever the size or shipment, with the shoe's name and
//     its sizes in one cell;
//   · the supplier filter and the From / To dates narrow the page AND the file the same way;
//   · "From" with no "To" means until today; a refresh keeps the filters.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import pg from 'pg';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SKU_A = `E2E-CX-${stamp}-100`;
const SKU_B = `E2E-CX-${stamp}-200`;
const SUP_A = `E2E CX Alpha ${stamp}`;
const SUP_B = `E2E CX Beta ${stamp}`;
const vin = (n) => `SBM-E2ECX-${stamp}${n}`;
let batchIds = []; let today; let longAgo;

test.beforeAll(async () => {
  [{ today, long_ago: longAgo }] = await q(
    `SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS today,
            ((now() AT TIME ZONE 'America/New_York')::date - 45)::text AS long_ago`);
  const mk = async (code, sup) => Number((await q(
    `INSERT INTO batches (batch_code, supplier_name, status, kind, date_received)
     VALUES ($1, $2, 'committed', 'receiving', current_date) RETURNING id`, [code, sup]))[0].id);
  const a1 = await mk(`B-E2ECX1-${stamp}`, SUP_A);
  const a2 = await mk(`B-E2ECX2-${stamp}`, SUP_A);
  const b1 = await mk(`B-E2ECX3-${stamp}`, SUP_B);
  batchIds = [a1, a2, b1];
  await q(`INSERT INTO items (vin, batch_id, sku, size, name, status, cost, created_at) VALUES
             ($1, $7, $10, '9',  'E2E CX Runner', 'in_stock', NULL, now()),
             ($2, $7, $10, '9',  'E2E CX Runner', 'in_stock', NULL, now()),
             ($3, $7, $10, '10', 'E2E CX Runner', 'in_stock', NULL, now()),
             ($4, $8, $10, '11', 'E2E CX Runner', 'in_stock', NULL, now() - interval '40 days'),
             ($5, $9, $11, '8',  'E2E CX Other',  'in_stock', NULL, now()),
             ($6, $7, $10, '12', 'E2E CX Runner', 'in_stock', 95,   now())`,
  [vin(1), vin(2), vin(3), vin(4), vin(5), vin(6), a1, a2, b1, SKU_A, SKU_B]);
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = ANY($1))', [[SKU_A, SKU_B]]);
  await q('DELETE FROM items WHERE sku = ANY($1)', [[SKU_A, SKU_B]]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [batchIds]);
  await pool.end();
});

const readCsv = async (dl) => fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split('\r\n');

test('supplier + date range narrow the page and the CSV, one row per SKU', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/costs');

  // From 45 days ago, no To = until today: both shipments of supplier Alpha are in.
  await page.getByLabel('From date').fill(longAgo);
  await expect(page.locator('.cost-range-on')).toContainText('until today');
  await page.getByLabel('Supplier').selectOption(SUP_A);
  const cards = page.locator('.cost-card');
  await expect(cards).toHaveCount(2);                      // one per shipment on screen
  await expect(page.locator('.cost-groups')).not.toContainText('E2E CX Other');
  await expect(page.getByLabel('Supplier').locator('option:checked')).toContainText('(4)');

  let [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export CSV \(1 SKU\)/ }).click()]);
  expect(dl.suggestedFilename()).toContain(`${longAgo}-to-${today}`);
  let lines = await readCsv(dl);
  expect(lines[0]).toContain('SKU,Name');
  expect(lines).toHaveLength(2);                            // header + ONE row for the SKU
  expect(lines[1]).toContain(SKU_A);
  expect(lines[1]).toContain('E2E CX Runner');
  expect(lines[1]).toContain(',4,');                        // 4 pairs without a cost (the $95 pair is not one)
  expect(lines[1]).toMatch(/9 ×2 · 10 ×1 · 11 ×1/);
  expect(lines[1]).toContain(SUP_A);

  // From today: the 40-day-old pair drops off the page and out of the file.
  await page.getByLabel('From date').fill(today);
  await expect(cards).toHaveCount(1);
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export CSV/ }).click()]);
  lines = await readCsv(dl);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(',3,');
  expect(lines[1]).not.toContain('11 ×1');

  // A refresh keeps both filters.
  await page.reload();
  await expect(page.getByLabel('Supplier')).toHaveValue(SUP_A);
  await expect(page.getByLabel('From date')).toHaveValue(today);
  await expect(cards).toHaveCount(1);

  // Every supplier: both SKUs, still one row each.
  await page.getByLabel('Supplier').selectOption('');
  [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export CSV/ }).click()]);
  const all = (await readCsv(dl)).join('\n');
  expect(all).toContain(SKU_A);
  expect(all).toContain(SKU_B);

  // The filter is the SERVER's: one supplier's pairs come back even when the range holds
  // more pairs than the page loads (a filter over a capped list would lose them).
  const token = signToken({ uid: 'e2e-cx', username: 'e2e_cx', name: 'E2E CX', role: 'warehouse' });
  const res = await page.request.get(`/api/items/costs?from=${longAgo}&supplier=${encodeURIComponent(SUP_A.toUpperCase())}`,
    { headers: { Authorization: `Bearer ${token}` } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  expect(body.rows).toHaveLength(4);
  expect(body.total).toBe(4);
  expect(body.suppliers.find((x) => x.value === SUP_B).pairs).toBe(1);

  // Clear filters brings the period bar back.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.cal-bar')).toBeVisible();
});
