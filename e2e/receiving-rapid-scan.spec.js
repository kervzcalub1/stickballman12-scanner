// Rapid scan (Items step). Brent's ask: no dialog between scans — the gun fires at
// box after box and every code lands in the cart on its own. The trade that buys is
// that a wrong catalogue answer is no longer caught mid-scan, so the two things this
// spec really guards are: (1) nothing a scan produced can be silently lost, and
// (2) nothing incomplete can reach a commit.
//
// The catalogue is stubbed so this tests our flow, not a third party.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();

const SKU_A = 'E2E-RAPID-A';
const SKU_B = 'E2E-RAPID-B';   // resolves, but the catalogue has no size for it
const SKU_X = 'E2E-RAPID-X';   // resolves to nothing at all

async function stubCatalogue(page) {
  await page.route('**/api/sku-search', async (route) => {
    const sku = String(route.request().postDataJSON()?.sku || '').toUpperCase();
    if (sku === SKU_A) {
      return route.fulfill({ json: { ok: true, product: { name: 'E2E Rapid Runner', sku: SKU_A, image: '', source: 'manual', scannedSize: '9', sizes: ['9', '9.5', '10'] } } });
    }
    if (sku === SKU_B) {
      return route.fulfill({ json: { ok: true, product: { name: 'E2E Rapid Trainer', sku: SKU_B, image: '', source: 'manual', sizes: [] } } });
    }
    return route.fulfill({ status: 404, json: { ok: false, error: 'No product found' } });
  });
}

// Step 1 → Items, ready to scan.
async function openItemsStep(page) {
  await loginAs(page, 'warehouse');
  await stubCatalogue(page);
  await page.goto('/receiving');
  await expect(page.getByText('Shipment details')).toBeVisible();
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-RAPID-${Date.now()}`);
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.scanbar')).toBeVisible();
}

const scan = async (page, code) => {
  await page.locator('.scanbar input').first().fill(code);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
};

// Leave without committing — the unsaved guard asks first. Nothing here is ever
// committed, so this is only hygiene: accept the guard and don't wait around for
// the new page to settle (a beforeunload prompt racing `goto` hung this file).
async function leave(page) {
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/', { waitUntil: 'commit' }).catch(() => {});
}

test('scans land straight in the cart and re-scans stack by size — no dialog in between', async ({ page }) => {
  await openItemsStep(page);

  await scan(page, SKU_A);
  const line = page.locator(`.recv-item[data-sku="${SKU_A}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  // No modal was ever opened — that's the whole point.
  await expect(page.locator('.modal.additem')).toHaveCount(0);
  await expect(line.locator('.recv-size-qty')).toHaveText('×1');

  // The same shoe scanned again is +1 on its size, still one line.
  await scan(page, SKU_A);
  await expect(line.locator('.recv-size-qty')).toHaveText('×2');
  await expect(page.locator('.recv-item')).toHaveCount(1);
  await expect(page.getByText('Items (2 units)')).toBeVisible();

  await leave(page);
});

test('Undo pulls the last scan back out', async ({ page }) => {
  await openItemsStep(page);
  await scan(page, SKU_A);
  const line = page.locator(`.recv-item[data-sku="${SKU_A}"]`);
  await expect(line.locator('.recv-size-qty')).toHaveText('×1');
  await scan(page, SKU_A);
  await expect(line.locator('.recv-size-qty')).toHaveText('×2');

  await page.getByRole('button', { name: /Undo last scan/ }).click();
  await expect(line.locator('.recv-size-qty')).toHaveText('×1');
  // Undo is one-shot — it can't keep eating the cart on repeat taps.
  await expect(page.getByRole('button', { name: /Undo last scan/ })).toHaveCount(0);

  await leave(page);
});

test('the sticky No-box mode applies to every scan and keeps the two apart', async ({ page }) => {
  await openItemsStep(page);
  await scan(page, SKU_A);
  await expect(page.locator(`.recv-item[data-sku="${SKU_A}"]`)).toHaveCount(1);

  await page.locator('.scanbar').getByRole('button', { name: /No box/ }).click();
  await scan(page, SKU_A);
  // Same shoe, different box status — boxed and no-box pairs are tracked apart.
  await expect(page.locator(`.recv-item[data-sku="${SKU_A}"]`)).toHaveCount(2);
  await expect(page.locator('.recv-item.nobox')).toHaveCount(1);

  await leave(page);
});

test('a scan the catalogue cannot resolve stays in the cart and blocks Review', async ({ page }) => {
  await openItemsStep(page);

  await scan(page, SKU_X);
  // The scan is NOT thrown away with a flash message nobody was watching.
  const failed = page.locator('.recv-item.needs-fix');
  await expect(failed).toBeVisible({ timeout: 10_000 });
  await expect(failed).toContainText(SKU_X);

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator('.error')).toContainText(/highlighted line/i);
  await expect(page.locator('.scanbar')).toBeVisible(); // still on Items
  // The error line lives below the fold on a long cart, so being blocked has to
  // land the cursor in the field that's missing — not just print a message.
  await expect(failed.getByPlaceholder('Product name')).toBeFocused();

  // Typing the shoe in by hand clears the block.
  await failed.getByPlaceholder('Product name').fill('Hand-typed Shoe');
  await failed.locator('.sz.need').fill('11');
  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.getByText(/^Review /)).toBeVisible();

  await leave(page);
});

test('a product with no size from the catalogue lands with a size? row that must be filled', async ({ page }) => {
  await openItemsStep(page);

  await scan(page, SKU_B);
  const line = page.locator(`.recv-item[data-sku="${SKU_B}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  await expect(line).toHaveClass(/needs-fix/);
  await expect(line.locator('.sz.need')).toBeVisible();

  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.locator('.error')).toContainText(/highlighted line/i);

  await line.locator('.sz.need').fill('10.5');
  await expect(line).not.toHaveClass(/needs-fix/);
  await page.getByRole('button', { name: 'Review →' }).click();
  await expect(page.getByText(/^Review /)).toBeVisible();

  await leave(page);
});

test('listing photos open from the shoe’s own row, and Review can correct the product', async ({ page }) => {
  await openItemsStep(page);
  await scan(page, SKU_A);
  const line = page.locator(`.recv-item[data-sku="${SKU_A}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });

  // Photos hang off the cart row now — the scan flow is never interrupted by them.
  await line.locator('.recv-photo-btn').click();
  await expect(page.locator('.modal.additem .listing-photos')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.listing-photos')).toHaveCount(0);

  // Review is the safety net for a catalogue that answered with the wrong shoe.
  await page.getByRole('button', { name: 'Review →' }).click();
  const reviewLine = page.locator(`.recv-item[data-sku="${SKU_A}"]`);
  await reviewLine.getByPlaceholder('Product name').fill('Corrected Shoe Name');
  await reviewLine.getByPlaceholder('SKU').fill('CORRECTED-1');
  await expect(page.locator('.recv-item[data-sku="CORRECTED-1"]')).toHaveCount(1);

  await leave(page);
});
