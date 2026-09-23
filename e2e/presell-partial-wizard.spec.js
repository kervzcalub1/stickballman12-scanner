// The intake half of pre-sell, on the actual screen.
//
// 2026-09-23 (Brent): there is no "all of it / only some" question any more. Ticking
// "Pre-sell shipment" makes every shoe START pre-sell, and the ones that weren't sold
// are unticked on their cards. The API tests in presell.spec.js pin what the server does
// with the per-shoe flags; this pins the screen — the default, the untick, the stated
// count, and that what was unticked really lands unheld.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
test.afterAll(async () => { await pool.end(); });

async function step1(page) {
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('.batch-form select').first().selectOption('Nike');
  await page.locator('.no-track-check input').check();          // keeps the tracking half out of the way
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
}

test('ticking pre-sell asks nothing more — Next goes straight to scanning', async ({ page }) => {
  await step1(page);
  await page.locator('.presell-check input').check();
  await expect(page.locator('.presell-scope')).toHaveCount(0);
  await expect(page.locator('.presell-note')).toContainText('starts marked Pre-sell');
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.scanbar')).toBeVisible();
});

// The catalogue is stubbed for the two tests that need cart rows: a real SKU lookup
// goes out to Alias/StockX, which is 20-45s of somebody else's latency and nothing to do
// with what is being tested here.
async function stubCatalogue(page) {
  await page.route('**/api/sku-search', async (route) => {
    const sku = JSON.parse(route.request().postData() || '{}').sku || 'E2E-PSW';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, product: { name: `Shoe ${sku}`, sku, source: 'manual', scannedSize: '9', sizes: ['8', '9', '10'] } }),
    });
  });
}

async function addShoe(page, sku) {
  await page.getByRole('button', { name: /Add manually/i }).click();
  const modal = page.locator('.modal.additem');
  await modal.getByPlaceholder(/Scan or type/i).fill(sku);
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(modal.locator('.additem-draft')).toBeVisible();
  await modal.getByRole('button', { name: /Complete item/i }).click();
  await expect(modal).toHaveCount(0);
}

test('every shoe starts pre-sell; unticking one frees it, and the commit says so', async ({ page }) => {
  await stubCatalogue(page);
  await step1(page);
  await page.locator('.presell-check input').check();
  await page.getByRole('button', { name: 'Next →' }).click();

  const stamp = Date.now().toString(36).toUpperCase();
  const SOLD = `E2E-PSW-SOLD-${stamp}`, PLAIN = `E2E-PSW-PLAIN-${stamp}`;
  await addShoe(page, SOLD);
  await addShoe(page, PLAIN);
  await expect(page.locator('.recv-item')).toHaveCount(2);

  // Both start ticked — and the count says so before anybody touches anything.
  await expect(page.locator('.recv-item .presell-chip-toggle input:checked')).toHaveCount(2);
  await expect(page.locator('.presell-tally')).toContainText('2 of 2 shoes marked');

  await page.locator('.recv-item', { hasText: PLAIN }).locator('.presell-chip-toggle input').uncheck();
  await expect(page.locator('.presell-tally')).toContainText('1 of 2 shoes marked');

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator('.presell-tally')).toContainText('1 of 2 shoes marked');
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  const rows = (await pool.query(
    `SELECT sku, pre_sell FROM items WHERE sku = ANY($1) ORDER BY sku`, [[SOLD, PLAIN]])).rows;
  expect(rows).toEqual([{ sku: PLAIN, pre_sell: false }, { sku: SOLD, pre_sell: true }]);
  await pool.query(`DELETE FROM items WHERE sku = ANY($1)`, [[SOLD, PLAIN]]);
});

test('a SCANNED shoe starts pre-sell too — the rapid-scan path, which is how the floor works', async ({ page }) => {
  await stubCatalogue(page);
  await step1(page);
  await page.locator('.presell-check input').check();
  await page.getByRole('button', { name: 'Next →' }).click();
  const code = `E2E-PSW-SCAN-${Date.now().toString(36).toUpperCase()}`;
  await page.locator('.scanbar input').first().fill(code);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  const line = page.locator(`.recv-item[data-sku="${code}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  await expect(line.locator('.presell-chip-toggle input')).toBeChecked();
  await expect(page.locator('.presell-tally')).toContainText('1 of 1 shoe marked');
});

test('every shoe unticked cannot reach Review — it says to untick the shipment instead', async ({ page }) => {
  await stubCatalogue(page);
  await step1(page);
  await page.locator('.presell-check input').check();
  await page.getByRole('button', { name: 'Next →' }).click();
  await addShoe(page, 'E2E-PSW-NONE-300');
  await page.locator('.recv-item .presell-chip-toggle input').first().uncheck();

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator('.error')).toContainText(/untick “Pre-sell shipment”/i);
  await expect(page.locator('.scanbar')).toBeVisible();   // still on the Items step
});
