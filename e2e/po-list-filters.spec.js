// Filtering the PH Purchase Orders list by supplier and by purchase date.
//
// The list is filtered in the browser over the orders /api/po/list already returned, so
// what's under test is the matching rule, not a query: a supplier match, an inclusive
// date range, and the fallback for an order whose purchase date was left blank (it files
// under the EST day it was OPENED — the PH team's own clock is a day ahead and would
// file it a day late).
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SUP_A = `E2E Filter Alpha ${stamp}`;
const SUP_B = `E2E Filter Bravo ${stamp}`;
const CODE = { a1: `PO-FLTA1-${stamp}`, a2: `PO-FLTA2-${stamp}`, b: `PO-FLTB-${stamp}`, blank: `PO-FLTN-${stamp}` };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const mk = (code, supplier, dop, createdAt) => q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, date_of_purchase, created_at)
     VALUES ($1, $2, 'draft', 1, $3, $4)`, [code, supplier, dop, createdAt]);
  await mk(CODE.a1, SUP_A, '2026-03-02', '2026-03-02T15:00:00Z');
  await mk(CODE.a2, SUP_A, '2026-03-09', '2026-03-09T15:00:00Z');
  await mk(CODE.b, SUP_B, '2026-03-05', '2026-03-05T15:00:00Z');
  // No purchase date: opened 2026-03-06 21:30 EST, which is already the 7th in UTC.
  await mk(CODE.blank, SUP_B, null, '2026-03-07T02:30:00Z');
});

test.afterAll(async () => {
  await q(`DELETE FROM purchase_orders WHERE po_code = ANY($1)`, [Object.values(CODE)]);
  await pool.end();
});

const codes = (page) => page.locator('.po-ov .po-code');

test('supplier filter narrows the list to that supplier', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/po-status');
  await expect(codes(page).filter({ hasText: CODE.a1 })).toHaveCount(1);
  await expect(codes(page).filter({ hasText: CODE.b })).toHaveCount(1);

  await page.locator('.po-ov-filters select').selectOption(SUP_A);
  await expect(codes(page).filter({ hasText: CODE.a1 })).toHaveCount(1);
  await expect(codes(page).filter({ hasText: CODE.a2 })).toHaveCount(1);
  await expect(codes(page).filter({ hasText: CODE.b })).toHaveCount(0);

  // The filter rides in the URL, so a refresh comes back to the same view.
  await expect(page).toHaveURL(/supplier=/);
  await page.reload();
  await expect(codes(page).filter({ hasText: CODE.b })).toHaveCount(0);
  await expect(page.locator('.po-ov-filters select')).toHaveValue(SUP_A);
});

test('date range is inclusive at both ends, and combines with the supplier', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/po-status?from=2026-03-02&to=2026-03-05');
  await expect(codes(page).filter({ hasText: CODE.a1 })).toHaveCount(1); // on the "from" day
  await expect(codes(page).filter({ hasText: CODE.b })).toHaveCount(1);  // on the "to" day
  await expect(codes(page).filter({ hasText: CODE.a2 })).toHaveCount(0); // outside

  // Same range, one supplier: both conditions apply, not either.
  await page.locator('.po-ov-filters select').selectOption(SUP_A);
  await expect(codes(page).filter({ hasText: CODE.a1 })).toHaveCount(1);
  await expect(codes(page).filter({ hasText: CODE.b })).toHaveCount(0);
});

test('an order with no purchase date files under the EST day it was opened', async ({ page }) => {
  await loginAs(page, 'ph_team');
  // Opened 2026-03-07 02:30 UTC = 2026-03-06 21:30 EST. A UTC reading would miss it here…
  await page.goto('/ph/po-status?from=2026-03-06&to=2026-03-06');
  await expect(codes(page).filter({ hasText: CODE.blank })).toHaveCount(1);
  // …and wrongly find it here.
  await page.goto('/ph/po-status?from=2026-03-07&to=2026-03-07');
  await expect(codes(page).filter({ hasText: CODE.blank })).toHaveCount(0);
});

test('Clear puts every order back', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?supplier=${encodeURIComponent(SUP_A)}&from=2026-03-09`);
  await expect(codes(page).filter({ hasText: CODE.b })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(codes(page).filter({ hasText: CODE.b })).toHaveCount(1);
  await expect(page).not.toHaveURL(/supplier=|from=|to=/);
});
