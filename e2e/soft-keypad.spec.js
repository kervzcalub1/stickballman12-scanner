// The app's own on-screen keypad. iOS hides the phone's keyboard for every field once a
// Bluetooth scanner is paired (a scanner is a hardware keyboard to the OS), and there is
// no web API that brings it back — the floor was typing on a second phone and pasting.
// So the app draws a keypad that types into whichever field was tapped last, through the
// same path a keypress takes, and Enter does what the gun's Enter does.
import { test, expect, devices } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
const SKU = 'E2E-KEYPAD-A';

// A phone: the keypad only mounts on a touch device.
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

async function toItems(page) {
  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({ json: { ok: true, product: { name: 'E2E Keypad Runner', sku: SKU, image: '', source: 'manual', sizes: ['9', '10'] } } }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill('KEYPAD-1');
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.scanbar')).toBeVisible();
}

const key = (page, k) => page.locator('.keypad-key', { hasText: new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();

test('the keypad types into the last-tapped field and Enter submits it, like the gun', async ({ page }) => {
  await toItems(page);
  const fab = page.getByRole('button', { name: 'On-screen keypad' });
  await expect(fab).toBeVisible();
  await fab.click();
  const pad = page.locator('.keypad');
  await expect(pad).toBeVisible();
  // Nothing tapped yet — the keys are dead, and the sheet says why.
  await expect(pad).toContainText('Tap a field first');
  await expect(pad.locator('.keypad-key', { hasText: /^A$/ })).toBeDisabled();

  // Tap the scan field, type the SKU key by key, Enter. The cart line appears — the
  // same path a scanner's keystrokes + its trailing Enter take.
  const scan = page.locator('.scanbar input').first();
  await scan.click();
  await expect(pad).toContainText('Typing into');
  for (const ch of 'E2E-KEYPAD-A') await key(page, ch);
  await expect(scan).toHaveValue(SKU);
  await key(page, 'Enter');
  const line = page.locator(`.recv-item[data-sku="${SKU}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });

  // A different field: the size that the catalogue didn't give — with a backspace on
  // the way, and the field's own React state is what ends up committed.
  const need = line.locator('.sz.need').first();
  await expect(need).toBeVisible();
  // Playwright scrolls a target the minimum distance, which leaves it under the sheet;
  // a thumb scrolls it up first, so do that.
  await need.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await need.click();
  await key(page, '1');
  await key(page, '2');
  await key(page, '⌫');
  await key(page, '0');
  await expect(need).toHaveValue('10');
  await expect(line).not.toHaveClass(/needs-fix/);

  // While the sheet is up neither round button is on top of the keys; Hide brings
  // the ⌨ back for next time.
  await expect(fab).toBeHidden();
  await pad.getByRole('button', { name: 'Hide' }).click();
  await expect(pad).toHaveCount(0);
  await expect(fab).toBeVisible();
});

test('the preference turns it off, at once', async ({ page }) => {
  await toItems(page);
  await expect(page.getByRole('button', { name: 'On-screen keypad' })).toBeVisible();
  await page.locator('button[title="Preferences"]').click();
  const row = page.locator('.pref-row', { hasText: 'On-screen keypad' });
  await row.getByRole('button', { name: 'Off' }).click();
  await expect(page.getByRole('button', { name: 'On-screen keypad' })).toHaveCount(0);
  await row.getByRole('button', { name: 'On' }).click();
  await expect(page.getByRole('button', { name: 'On-screen keypad' })).toBeVisible();
});
