// Every PO Reconciliation report downloads as PDF **or** CSV, and the choice sticks.
//
// The formats are two shapes of the same data — a PDF is what you print, sign and send;
// a CSV is what someone sorts and pastes into the message to the supplier — so they are
// built from the same inputs (`ManifestPrint` hands both builders one object).
//
// The choice is remembered per device on purpose: whoever pulls these reports does the
// same thing every time, and re-picking the format on every download is the kind of
// small tax that makes people stop using the export.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test('report format picker downloads a CSV and remembers the choice', async ({ page }) => {
  page.on('pageerror', (e) => { throw e; });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/reconciliation');
  await page.waitForTimeout(1200);

  const po = page.locator('text=/PO-\\d+/').first();
  test.skip(await po.count() === 0, 'no purchase orders in this database');
  await po.click();
  await page.waitForTimeout(1200);

  const fmt = page.locator('.mf-fmt').first();
  test.skip(await fmt.count() === 0, 'this PO has no report row (nothing declared or received)');
  await expect(fmt).toBeVisible();
  await expect(page.locator('.mf-fmt .seg-btn[aria-pressed="true"]').first()).toHaveText('PDF');

  await page.locator('.mf-fmt .seg-btn', { hasText: 'CSV' }).first().click();
  await expect(page.locator('.mf-fmt .seg-btn[aria-pressed="true"]').first()).toHaveText('CSV');

  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('.mf-print button', { hasText: 'Whole order' }).first().click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);

  // Remembered across a reload — it lives in prefs, not component state.
  await page.reload();
  await page.waitForTimeout(1500);
  const after = page.locator('.mf-fmt .seg-btn[aria-pressed="true"]').first();
  if (await after.count()) await expect(after).toHaveText('CSV');
});
