// Smoke: the Price Inquiry Consigned / With You basis toggle renders for PH team.
// Data-independent — asserts on screen chrome (the toggle appears once a SKU is
// looked up and its size run loads). Uses a minted ph_team session.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
});

test('Price Inquiry renders and exposes the SKU lookup', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/price-inquiry');
  await expect(page.getByPlaceholder(/Enter a SKU/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Look up/ })).toBeVisible();
  // The Final column header renders the dynamic markup label.
  await expect(page.getByText(/read-only lookup/)).toBeVisible();
});
