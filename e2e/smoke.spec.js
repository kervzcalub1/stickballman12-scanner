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
    ['/sop', 'Standard operating procedures'],
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
    ['/ph/sop', 'Standard operating procedures'],
  ];
  for (const [route, marker] of PH_ROUTES) {
    test(`ph_team ${route}`, async ({ page }) => {
      await loginAs(page, 'ph_team');
      await page.goto(route);
      await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
    });
  }
});

// The SOP library is static data, so these assert the wiring (routing, role
// filtering, search) rather than the prose — the prose is reviewed, not tested.
test.describe('SOP & Help', () => {
  test('search narrows to a matching procedure', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/sop');
    await page.locator('.sop-search').fill('no box');
    // Scope to the result card — the same title also appears as a FAQ cross-link.
    await expect(page.locator('.sop-item-title', { hasText: 'Resolve the No Box queue' })).toBeVisible();
  });

  test('opening an article is deep-linkable and shows its steps', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/sop?a=shelve-putaway');
    await expect(page.locator('.sop-title')).toHaveText('Shelve / put-away');
    await expect(page.locator('.sop-steps > li').first()).toBeVisible();
  });

  // A warehouse/PH/supplier account is SCOPED to its own role — not offered a filter.
  test('a non-admin account is locked to its own role', async ({ page }) => {
    await loginAs(page, 'warehouse');
    // ?role= is deliberately ignored: a pasted link must not walk someone into
    // another desk's procedures.
    await page.goto('/sop?role=supplier');
    await expect(page.locator('.sop-role')).toHaveCount(0);               // no role switcher
    await expect(page.locator('.sop-item-title', { hasText: 'Resolve the No Box queue' })).toBeVisible();
    await expect(page.locator('.sop-item-title', { hasText: 'Scan out what you are shipping' })).toHaveCount(0);
    // Cross-cutting procedures stay available to everyone.
    await expect(page.locator('.sop-item-title', { hasText: 'Statuses and what they mean' })).toBeVisible();
  });

  test('admin keeps the role switcher and can browse another desk', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/sop');
    // All roles + warehouse + PH + supplier + gift cards + auditor + admin + superadmin.
    // The last two arrived with the gift-card process, which splits releasing the money
    // from verifying it — see docs/context/buy-cart.md.
    await expect(page.locator('.sop-role')).toHaveCount(8);
    await page.getByRole('tab', { name: 'Supplier' }).click();
    await expect(page.locator('.sop-item-title', { hasText: 'Scan out what you are shipping' })).toBeVisible();
    await expect(page.locator('.sop-item-title', { hasText: 'Resolve the No Box queue' })).toHaveCount(0);
  });
});

// Manifest PDF is one shared component (components/ManifestPrint.jsx) on three
// surfaces. Assert it is WIRED on each — building the PDF itself is jsPDF's job.
//
// These lists load async, so presence is checked with waitFor(), NOT isVisible():
// isVisible() resolves immediately and would report "empty" while the fetch is still
// in flight, turning real coverage into a silent skip. Only a genuine timeout skips.
const appears = async (loc, ms = 6000) => {
  try { await loc.waitFor({ state: 'visible', timeout: ms }); return true; }
  catch { return false; }
};

test.describe('manifest print', () => {
  test('warehouse: on the Receiving PO banner once a PO is linked', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/receiving');
    await page.locator('.po-receive-btn').click();
    const first = page.locator('.po-picker .po-card').first();
    // Nothing open to receive against on this DB — the banner can't exist, so skip
    // rather than fail on unrelated data.
    if (!(await appears(first))) test.skip(true, 'no open POs');
    await first.click();
    const mf = page.locator('.po-receive-banner .mf-print');
    await expect(mf).toBeVisible();
    // Assert the CONTROLS, not a button count. `.mf-print` holds the two downloads the
    // banner always offers, the PDF|CSV picker that governs them, and up to two more
    // buttons that appear only once stock has been received or a box actually differs.
    // A bare toHaveCount(2) was written before the format picker existed, so it broke
    // the moment a PO with any data was on screen — and it passed in CI only because
    // the seeded DB has no open PO, which skips the test entirely. Green by absence.
    await expect(mf.getByRole('button', { name: 'Per box' })).toBeVisible();
    await expect(mf.getByRole('button', { name: 'Whole order' })).toBeVisible();
    await expect(mf.locator('.mf-fmt .seg-btn')).toHaveCount(2); // PDF | CSV
  });

  test('warehouse: on the PO Reconciliation report', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/reconcile');
    const card = page.locator('.rcn-card, .po-card').first();
    if (!(await appears(card))) test.skip(true, 'no POs to reconcile');
    await card.click();
    // A blind receipt has no manifest to print, so the block is legitimately absent.
    const blind = await page.locator('.rcn-no-manifest').isVisible().catch(() => false);
    if (blind) await expect(page.locator('.mf-print')).toHaveCount(0);
    else await expect(page.locator('.mf-print')).toBeVisible();
  });

  test('PH: on the Purchase Orders overview', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph/po-status');
    const head = page.locator('.po-ov-head').first();
    if (!(await appears(head))) test.skip(true, 'no POs');
    await head.click();
    await expect(page.locator('.mf-print')).toBeVisible();
  });
});

test.describe('warehouse role', () => {
  test('Report hides pricing (view only)', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/report');
    await expect(page.getByText('view only')).toBeVisible();
  });
});
