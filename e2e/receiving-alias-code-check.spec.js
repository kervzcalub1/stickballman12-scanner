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

test('a new size barcode is asked on its own line, and joins the shoe once answered', async ({ page }) => {
  await openItemsStep(page);

  await scan(page, UPC_ALIAS_7);
  const line = page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  await line.locator('.sz.need').fill('7');
  await expect(line).toContainText('the size 7 box');
  await line.getByRole('button', { name: `✓ Box says ${ALIAS_CODE}` }).click();
  await expect(line).not.toContainText('Only Alias knew');
  await expect(line).not.toHaveClass(/needs-fix/);

  // Another size's box has its own barcode — nobody has read that one yet. It waits on
  // a line of its own, so "different code" on it could never carry the checked 7.
  await scan(page, UPC_ALIAS_9);
  await expect(page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`)).toHaveCount(2);
  const waiting = page.locator(`.recv-item.needs-fix[data-sku="${ALIAS_CODE}"]`);
  await expect(waiting).toContainText('Only Alias knew this barcode');
  await waiting.locator('.sz.need').fill('9');
  await waiting.getByRole('button', { name: `✓ Box says ${ALIAS_CODE}` }).click();
  // Answered → it joins the shoe already in the cart.
  await expect(page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`)).toHaveCount(1);
  await expect(page.getByText('Items (2 units)')).toBeVisible();
  await leave(page);
});

test('a wrong tap is undone by removing the line — the next scan asks again', async ({ page }) => {
  await openItemsStep(page);
  await scan(page, UPC_ALIAS_7);
  const line = page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  await line.getByRole('button', { name: `✓ Box says ${ALIAS_CODE}` }).click();
  await expect(line).not.toContainText('Only Alias knew');
  await line.getByTitle('Remove item', { exact: true }).click();
  await expect(page.locator('.recv-item')).toHaveCount(0);
  await scan(page, UPC_ALIAS_7);
  await expect(page.locator(`.recv-item[data-sku="${ALIAS_CODE}"]`)).toContainText('Only Alias knew this barcode', { timeout: 10_000 });
  await leave(page);
});

test('Add manually: a code typed over the Alias code in the draft still asks to look it up, so the name changes too', async ({ page }) => {
  await openItemsStep(page);
  await page.getByRole('button', { name: '+ Add manually' }).click();
  const modal = page.locator('.modal.additem');
  await modal.locator('form input').first().fill(UPC_ALIAS_7);
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(modal.getByPlaceholder('SKU', { exact: true })).toHaveValue(ALIAS_CODE, { timeout: 10_000 });
  // The person reads the box and types its code straight into the draft.
  await modal.getByPlaceholder('SKU', { exact: true }).fill(BOX_CODE);
  await modal.getByRole('button', { name: '+ Custom' }).click();
  await modal.locator('.size-line input.sz').fill('7');
  await modal.getByRole('button', { name: 'Complete item ✓' }).click();

  // The code is right, but the name is still Alias's shoe — the line says so.
  const line = page.locator(`.recv-item[data-sku="${BOX_CODE}"]`);
  await expect(line).toContainText('E2E Retro 16 Black');
  await expect(line).toHaveClass(/needs-fix/);
  await line.getByRole('button', { name: `Look up ${BOX_CODE}` }).click();
  await expect(line).toContainText('E2E Retro 15 Black');
  await expect(line).not.toHaveClass(/needs-fix/);
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
