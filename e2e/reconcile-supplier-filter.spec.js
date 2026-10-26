// PO Reconciliation: one supplier's orders, reconciled or not (Kevin, 2026-10-27).
// The list is filtered in the browser over /api/po/reconcile-list, so what's under test is
// the dropdowns, the count line and the URL — not a query.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SUP = `E2E Recon Alpha ${stamp}`;
const OTHER = `E2E Recon Bravo ${stamp}`;
const CODE = { open: `PO-RSA1-${stamp}`, done: `PO-RSA2-${stamp}`, gone: `PO-RSA3-${stamp}`, draft: `PO-RSA4-${stamp}`, other: `PO-RSB1-${stamp}` };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const mk = (code, supplier, status) => q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes) VALUES ($1, $2, $3, 1)`, [code, supplier, status]);
  await mk(CODE.open, SUP, 'receiving');
  // Typed with different case and a trailing space — still the same supplier.
  await mk(CODE.done, `${SUP.toLowerCase()} `, 'reconciled');
  await mk(CODE.gone, SUP, 'closed');
  await mk(CODE.draft, SUP, 'draft');
  await mk(CODE.other, OTHER, 'receiving');
});

test.afterAll(async () => {
  await q(`DELETE FROM purchase_orders WHERE po_code = ANY($1)`, [Object.values(CODE)]);
  await pool.end();
});

const codes = (page) => page.locator('.po-list .po-code');

test('pick a supplier: only their POs, reconciled or not, with the count of each', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/reconcile');
  await expect(codes(page).filter({ hasText: CODE.other })).toHaveCount(1);

  await page.getByLabel('Supplier').selectOption(SUP);
  await expect(codes(page).filter({ hasText: CODE.open })).toHaveCount(1);
  await expect(codes(page).filter({ hasText: CODE.done })).toHaveCount(1);
  await expect(codes(page).filter({ hasText: CODE.other })).toHaveCount(0);
  await expect(page.locator('.rcn-tally')).toHaveText(
    `${SUP}: 2 active POs — 1 not reconciled · 1 reconciled · 1 archived (see them) · 1 not received yet (on Purchase Orders)`);

  // Narrow to the ones still to do.
  await page.getByLabel('Reconciled or not').selectOption('open');
  await expect(codes(page).filter({ hasText: CODE.open })).toHaveCount(1);
  await expect(codes(page).filter({ hasText: CODE.done })).toHaveCount(0);

  // In the URL, so a refresh (or a pasted link) comes back to the same view.
  await expect(page).toHaveURL(/supplier=.*rstate=open|rstate=open.*supplier=/);
  await page.reload();
  await expect(page.getByLabel('Supplier')).toHaveValue(SUP);
  await expect(codes(page).filter({ hasText: CODE.done })).toHaveCount(0);

  // The archived one is a tap away, still filtered to the supplier.
  await page.getByLabel('Reconciled or not').selectOption('');
  await page.locator('.rcn-tally').getByRole('button', { name: 'see them' }).click();
  await expect(codes(page).filter({ hasText: CODE.gone })).toHaveCount(1);
});
