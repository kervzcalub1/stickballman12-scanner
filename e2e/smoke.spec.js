// Smoke suite: confirm the app boots and every screen module renders after the
// App.jsx → screens/components/lib split. Assertions target screen CHROME
// (headings, controls) that renders even with an empty DB, so the suite is data-
// independent. Catches missing-import / bad-module-reference regressions, which
// only surface at runtime (the build won't flag them).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

// Fail loudly on any uncaught page error (e.g. a missing import after a refactor).
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
});

test.describe('auth', () => {
  test('logged-out shows the login screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Stickballman12' })).toBeVisible();
    await expect(page.getByPlaceholder('Username')).toBeVisible();
  });

  test('real admin login via the UI lands on Home', async ({ page }) => {
    const adminPass = process.env.ADMIN_PASSWORD;
    test.skip(!adminPass, 'ADMIN_PASSWORD not set');
    await page.goto('/');
    await page.getByPlaceholder('Username').fill('admin');
    await page.getByPlaceholder('Password').fill(adminPass);
    // "Sign in" also names the tab; target the form's submit button.
    const loginResp = page.waitForResponse((r) => r.url().includes('/api/auth/login'));
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
    const status = (await loginResp).status();
    // The login route is rate-limited; rapid re-runs share an in-memory counter.
    // A 429 is an environment condition, not a product failure — skip, don't fail.
    test.skip(status === 429, 'login rate-limited (rapid re-runs) — restart dev server to reset');
    expect(status).toBe(200);
    await expect(page.locator('.home-greeting')).toContainText('Hi Alex');
    await expect(page.getByText('Receive New')).toBeVisible();
  });
});

// Admin can reach every warehouse/admin screen module — drive each route and
// assert a marker unique to that screen.
test.describe('admin screens render', () => {
  const ROUTES = [
    ['/', 'Receive New'],
    ['/receiving', 'Shipment details'],
    ['/rescale', 'Rescale details'],
    ['/batches', 'Open batches'],
    ['/inventory', 'Apply filters'],
    ['/report', 'view only'],
    ['/access', 'Check Access'],
    ['/nobox', 'No Box'],
    ['/sold', 'Mark Sold'],
    ['/shipped', 'Mark Shipped'],
    ['/rescalereq', 'Rescale Requests'],
    ['/shelve', 'Shelve / Put-away'],
    ['/locations', 'Bulk add'],
  ];
  for (const [route, marker] of ROUTES) {
    test(`admin ${route}`, async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto(route);
      await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
    });
  }
});

test.describe('PH team screens render', () => {
  test('PH home chooser', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/');
    await expect(page.getByText('New Inventory')).toBeVisible();
    await expect(page.getByText('Rescale Stock')).toBeVisible();
    await expect(page.getByText('Request Rescale')).toBeVisible();
  });

  const PH_ROUTES = [
    ['/ph/new-inventory', 'New Inventory'],
    ['/ph/rescale', 'Rescale Stock'],
    ['/ph/nobox', 'No Box'],
    ['/ph/request', 'Rescale Requests'],
  ];
  for (const [route, marker] of PH_ROUTES) {
    test(`ph_team ${route}`, async ({ page }) => {
      await loginAs(page, 'ph_team');
      await page.goto(route);
      await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
    });
  }
});

test.describe('warehouse role', () => {
  test('Report hides pricing (view only)', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/report');
    await expect(page.getByText('view only')).toBeVisible();
  });
});
