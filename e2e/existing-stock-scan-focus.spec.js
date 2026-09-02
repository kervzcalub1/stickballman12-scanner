// The scan field on Existing Stock has to stay hot for a HID gun between scans.
//
// Reported by the warehouse with a screen recording: after scanning a shoe, the field for
// the 1ID sticker was not focused, so the sticker could not be scanned without tapping the
// field first — and when it was scanned anyway, the count came back
// "No product found for that SKU" on a perfectly good sticker.
//
// Two causes, both guarded here:
//   1. `disabled={busy}` on the input. A disabled field is blurred by the browser, and a
//      gun fires ~20 characters in a few hundred ms — so the middle of the next barcode
//      landed nowhere and the stump got submitted as a SKU.
//   2. The re-focus effect keyed on `rows.length`. Re-scanning a shoe already on the shelf
//      bumps a qty and binding a sticker fills a `vins` array; neither changes the count,
//      so the field went cold in exactly the two moves this screen is made of.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

const SHELF = 'MNH-WH-B1-01';   // a real shelf in the seeded location tree
const UPC = '196604049588';
const SKU = 'E2E-EXST-1';

// The catalogue is a live third-party call and is not the subject here.
const stubCatalog = async (page) => {
  for (const path of ['**/api/upc-search', '**/api/sku-search']) {
    await page.route(path, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, product: { name: 'E2E Existing Runner', sku: SKU, scannedSize: '9', sizes: ['8', '9', '10'] } }),
    }));
  }
  await page.route('**/api/vin-stock/check*', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, state: 'available' }),
  }));
};

const focused = (page) => page.evaluate(() => document.activeElement?.getAttribute('placeholder') || document.activeElement?.tagName);
// The screen focuses the field on a short timer, so a gun that fires the instant the page
// paints would miss it in the test the same way a real one never does. Wait for the field
// to actually be hot, then scan into it.
const waitHot = async (page, re) => {
  await expect.poll(() => focused(page), { timeout: 10_000 }).toMatch(re);
};
// A HID gun types into whatever holds focus, then sends Enter. Typing into the PAGE
// rather than the locator is the whole point: if the field isn't focused, this goes
// nowhere, exactly as it does in the warehouse.
const gunScan = async (page, code) => {
  // Wait for the field to be hot before firing. A real gun fires into whatever holds
  // focus; if we type before the screen has taken it, the test measures its own race
  // rather than the app's behaviour.
  await expect.poll(() => focused(page), { timeout: 10_000 }).toMatch(/Scan|1ID/);
  await page.keyboard.type(code);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
};

test.beforeEach(async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.addInitScript(() => localStorage.setItem('sb_prefs', JSON.stringify({ rawVins: true })));
  await stubCatalog(page);
  await page.goto('/existing-stock');
  await expect(page.getByPlaceholder(/Scan a shelf barcode/)).toBeVisible({ timeout: 15_000 });
  await waitHot(page, /shelf barcode/i);
  await gunScan(page, SHELF);
  await expect(page.getByText(/Counting onto/).first()).toBeVisible({ timeout: 15_000 });
});

test('the field stays hot through the whole two-beat loop', async ({ page }) => {
  // Beat 1: the shoe. Beat 2: its sticker. Then round again — the loop that was broken.
  await gunScan(page, UPC);
  await waitHot(page, /1ID/);                       // after the shoe, ready for its sticker

  await gunScan(page, `SBM-R-9${Date.now().toString().slice(-6)}`);
  await waitHot(page, /UPC/);                       // after the sticker, ready for the next shoe

  // The qty-bump path: the SAME shoe again. rows.length does not change here, which is
  // what the old `rows.length` dependency missed.
  await gunScan(page, UPC);
  await waitHot(page, /1ID/);
});

test('the scan field is never disabled, so a gun cannot lose half a barcode', async ({ page }) => {
  // Hold the lookup open and scan into the field while it is in flight.
  let release;
  await page.route('**/api/upc-search', async (route) => {
    await new Promise((r) => { release = r; });
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, product: { name: 'E2E Existing Runner', sku: SKU, scannedSize: '9', sizes: ['9'] } }) });
  });
  await page.keyboard.type(UPC);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const input = page.locator('.searchrow input').first();
  await expect(input, 'a disabled field drops the gun’s keystrokes').toBeEnabled();
  release?.();
  await page.waitForTimeout(500);
});

test('a half-read sticker says so instead of blaming the catalogue', async ({ page }) => {
  await gunScan(page, UPC);
  // What the gun actually produced when the field was disabled mid-scan: a stump.
  await gunScan(page, 'SBM-R');
  await expect(page.getByText(/only part of it read/i)).toBeVisible();
  await expect(page.getByText(/No product found/i)).toHaveCount(0);
});
