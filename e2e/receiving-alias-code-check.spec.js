// A barcode only Alias resolved has to be checked against the box before it can be
// saved. On 2026-10-22 Alias filed the Jordan 15 'Black Pack' boxes (IZ2585-001) under
// the Jordan 16 (IZ2586-001): StockX and Nike didn't know the new release yet, so
// Alias's answer went in unasked, and 7 pairs were listed and priced as the wrong shoe.
//
// The catalogue is stubbed so this tests our flow, not a third party.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();

const ALIAS_CODE = 'E2E-ALIAS-16';  // what "Alias" says the boxes are
const BOX_CODE = 'E2E-ALIAS-15';    // what the box label really says
const UPC_ALIAS_7 = '190000000031';
const UPC_ALIAS_9 = '190000000048';
const UPC_STOCKX = '190000000055';

async function stubCatalogue(page) {
  await page.route('**/api/sku-search', async (route) => {
    const sku = String(route.request().postDataJSON()?.sku || '').toUpperCase();
    if (sku === BOX_CODE) {
      return route.fulfill({ json: { ok: true, product: { name: 'E2E Retro 15 Black', sku: BOX_CODE, image: '', source: 'alias', sizes: ['7', '9'] } } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: 'No product found' } });
  });
  await page.route('**/api/upc-search', async (route) => {
    const upc = String(route.request().postDataJSON()?.upc || '');
    if (upc === UPC_ALIAS_7 || upc === UPC_ALIAS_9) {
      return route.fulfill({ json: { ok: true, product: { name: 'E2E Retro 16 Black', sku: ALIAS_CODE, upc, image: '', source: 'alias', sizes: [], upcSource: 'alias' } } });
    }
    if (upc === UPC_STOCKX) {
      return route.fulfill({ json: { ok: true, product: { name: 'E2E StockX Runner', sku: 'E2E-SX-1', upc, image: '', source: 'alias', sizes: ['10'], scannedSize: '10', upcSource: 'stockx' } } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: 'No product found' } });
  });
}

async function openItemsStep(page) {
  await loginAs(page, 'warehouse');
  await stubCatalogue(page);
  await page.goto('/receiving');
  await expect(page.getByText('Shipment details')).toBeVisible();
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-ALIASCHK-${Date.now()}`);
  await page.locator('.manifest-q').getByRole('button', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.scanbar')).toBeVisible();
}

const scan = async (page, code) => {
  await page.locator('.scanbar input').first().fill(code);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
};

async function leave(page) {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/', { waitUntil: 'commit' }).catch(() => {});
}

test('an Alias-only barcode blocks Review until the box is read, and a different code renames the shoe', async ({ page }) => {
  await openItemsStep(page);

  await scan(page, UPC_ALIAS_7);
  const line = page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  await expect(line).toHaveClass(/needs-fix/);
  await expect(line).toContainText('Only Alias knew this barcode');
  await line.locator('.sz.need').fill('7');

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator('.error')).toContainText(/style code printed on the box/i);
  await expect(page.locator('.scanbar')).toBeVisible(); // still on Items

  // The box says another code: it is looked up, so the NAME changes with it.
  await line.getByRole('button', { name: 'Box says a different code' }).click();
  await line.getByPlaceholder(/Code on the box/).fill(BOX_CODE.toLowerCase());
  await line.getByRole('button', { name: 'Use this code' }).click();
  const fixed = page.locator(`.recv-item[data-sku="${BOX_CODE}"]`);
  await expect(fixed).toBeVisible();
  await expect(fixed).toContainText('E2E Retro 15 Black');
  await expect(fixed).not.toContainText('Only Alias knew');
  await expect(page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`)).toHaveCount(0);

  // The same box again: answered once for this barcode, it files as the 15 unasked.
  await scan(page, UPC_ALIAS_7);
  await expect(fixed.locator('.recv-size-step .qty-val')).toHaveText('2');
  await expect(page.locator('.recv-item')).toHaveCount(1);

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.getByText(/^Review /)).toBeVisible();
  await leave(page);
});

test('confirming covers the boxes read; a new size barcode is asked again', async ({ page }) => {
  await openItemsStep(page);

  await scan(page, UPC_ALIAS_7);
  const line = page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  await line.locator('.sz.need').fill('7');
  await line.getByRole('button', { name: `✓ Box says ${ALIAS_CODE}` }).click();
  await expect(line).not.toContainText('Only Alias knew');
  await expect(line).not.toHaveClass(/needs-fix/);

  // Another size's box has its own barcode — nobody has read that one yet.
  await scan(page, UPC_ALIAS_9);
  await expect(line).toContainText('Only Alias knew this barcode');
  await expect(line).toHaveClass(/needs-fix/);
  await leave(page);
});

test('a barcode StockX resolved goes in without the check', async ({ page }) => {
  await openItemsStep(page);
  await scan(page, UPC_STOCKX);
  const line = page.locator('.recv-item[data-sku="E2E-SX-1"]');
  await expect(line).toBeVisible({ timeout: 10_000 });
  await expect(line).not.toContainText('Only Alias knew');
  await expect(line).not.toHaveClass(/needs-fix/);
  await leave(page);
});
