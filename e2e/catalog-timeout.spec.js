// A slow catalogue is not a missing product.
//
// The Alias catalogue is the ONLY source for a SKU lookup, it answers in ~3s on a good
// day, and `aliasApiGet` was using fetchWithTimeout's short 9s default — the one meant for
// UPC search, which has a fallback to rotate to. A spike past 9s therefore surfaced as
// "No product found for that SKU" plus the raw abort text, which says the SKU doesn't
// exist. It does; we gave up waiting.
//
// Reported as "why can't I call the API on localhost" — the API and the key were both
// fine, and the same SKU resolved on a retry.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const SUPPLIER = 'E2E Timeout Supplier';
let SUP;

test.beforeAll(async () => {
  SUP = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,'e2e_timeout_sup','x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier', name=$1 RETURNING id`, [SUPPLIER]))[0].id);
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_user_id = $1', [SUP]);
  await q(`DELETE FROM users WHERE username = 'e2e_timeout_sup'`);
  await pool.end();
});

test('a catalogue timeout says so, and does not claim the SKU is missing', async ({ page }) => {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, expected_boxes, status)
     VALUES ($1,$2,'supplier',1,'draft') RETURNING *`, [SUPPLIER, SUP]))[0];
  await q(`INSERT INTO po_boxes (po_id, box_number, status) VALUES ($1, 1, 'pending')`, [po.id]);

  const tok = signToken({ uid: SUP, username: 'e2e_timeout_sup', name: SUPPLIER, role: 'supplier' });
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u);
  }, [tok, JSON.stringify({ username: 'e2e_timeout_sup', name: SUPPLIER, role: 'supplier' })]);

  // What a stalled upstream produces once the server gives up waiting.
  await page.route('**/api/sku-search', (route) => route.fulfill({
    status: 504, contentType: 'application/json',
    body: JSON.stringify({ ok: false, timeout: true, error: 'The product catalogue didn’t answer in time. Try that scan again.' }),
  }));

  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: /^Add items$/ }).first().click();
  await page.getByPlaceholder(/Scan or type UPC/i).fill('IR0088-001');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // It says what actually happened, and offers the thing that fixes it.
  await expect(page.getByText(/Catalogue timed out/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/didn’t answer in time/i)).toBeVisible();
  // And it does NOT claim the SKU doesn't exist.
  await expect(page.getByText(/^Not found$/)).toHaveCount(0);
});
