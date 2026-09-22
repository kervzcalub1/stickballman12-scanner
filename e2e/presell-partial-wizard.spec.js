// The intake half of part pre-sell, on the actual screen (2026-09-23).
//
// The API tests in presell.spec.js pin what the server does with the answers. This pins
// that the question can be answered at all — and that the wizard refuses to carry a half
// answer forward, which is where the damage came from: ticking "Pre-sell shipment" used
// to mean "all of it" silently, so a shipment with one spoken-for shoe in it held all
// fifteen back from listing with nothing on screen saying so.
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

test('ticking pre-sell asks how much, and Next is blocked until it is answered', async ({ page }) => {
  await step1(page);
  // Not asked at all until the shipment is a pre-sell one.
  await expect(page.locator('.presell-scope')).toHaveCount(0);

  await page.locator('.presell-check input').check();
  await expect(page.locator('.presell-scope')).toContainText('Is all of this shipment pre-sold?');
  // NOTHING is pre-selected — the old checkbox's silent "all of it" is the bug.
  await expect(page.locator('.presell-scope .seg-btn.on')).toHaveCount(0);

  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.error')).toContainText(/all of it, or only some/i);
  await expect(page.locator('.batch-form')).toBeVisible();      // still on step 1

  await page.getByRole('button', { name: 'No — only some shoes' }).click();
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

test('on "only some" the cart carries a per-shoe chip and a running count', async ({ page }) => {
  await stubCatalogue(page);
  await step1(page);
  await page.locator('.presell-check input').check();
  await page.getByRole('button', { name: 'No — only some shoes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();

  await addShoe(page, 'E2E-PSW-SOLD-100');
  await addShoe(page, 'E2E-PSW-PLAIN-200');
  await expect(page.locator('.recv-item')).toHaveCount(2);

  // The count is stated before anything is marked — 15 of 15 held, when one was meant
  // to be, is exactly what nobody could see last time.
  await expect(page.locator('.presell-tally')).toContainText('0 of 2 shoes marked');

  // Mark ONE of them. The chip lives on the row, beside Box / No box and GOAT only.
  const sold = page.locator('.recv-item', { hasText: 'E2E-PSW-SOLD-100' });
  await sold.locator('.presell-chip-toggle input').check();
  await expect(page.locator('.presell-tally')).toContainText('1 of 2 shoes marked');
  await expect(page.locator('.recv-item', { hasText: 'E2E-PSW-PLAIN-200' })
    .locator('.presell-chip-toggle input')).not.toBeChecked();
});

test('"only some" with nothing marked cannot reach Review', async ({ page }) => {
  await stubCatalogue(page);
  await step1(page);
  await page.locator('.presell-check input').check();
  await page.getByRole('button', { name: 'No — only some shoes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await addShoe(page, 'E2E-PSW-NONE-300');

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator('.error')).toContainText(/tick the shoes that are/i);
  await expect(page.locator('.scanbar')).toBeVisible();   // still on the Items step

  // Ticking it lets the step through — the refusal is about the missing answer, not
  // about pre-sell shipments being harder to receive.
  await page.locator('.recv-item .presell-chip-toggle input').first().check();
  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator('.recv-items.review')).toBeVisible();
  await expect(page.locator('.presell-tally')).toContainText('1 of 1 shoe marked');
});
