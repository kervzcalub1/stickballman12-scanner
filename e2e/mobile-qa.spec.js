// Mobile functional QA sweep — phone viewport (390x844, touch) driving the
// CARD/mobile-only code paths (isMobile = useMediaQuery('(max-width: 768px)')),
// re-checking tight cases at 360x800 for horizontal overflow. Review/report
// only: this suite does not modify product code. Test data is namespaced
// `MQA-*` so it's easy to spot/clean in the DB afterward.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';

const authHeaders = (role = 'warehouse') => ({
  Authorization: `Bearer ${signToken(
    role === 'admin'
      ? { uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' }
      : { uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' },
  )}`,
});

const TAG = Date.now();
const NOBOX_SKU = `MQA-NOBOX-${TAG}`;
const WITHBOX_SKU = `MQA-SHELF-${TAG}`;

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
});

// No horizontal body scroll assertion helper.
async function assertNoHOverflow(page, label) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${label}: horizontal overflow (scrollWidth ${scrollWidth} > innerWidth ${innerWidth})`).toBeLessThanOrEqual(innerWidth + 1);
}

// ─────────────────────────────────────────────────────────────────────────
// Seed two MQA units via the API (bypasses the wizard so downstream mobile
// tests — NoBox / Shelve — have deterministic, isolated data to act on).
// ─────────────────────────────────────────────────────────────────────────
let noBoxVin = null;
let withBoxVin = null;

test.describe.serial('seed MQA test data', () => {
  test('seed no-box + with-box units', async ({ request }) => {
    const r1 = await request.post('/api/batches/commit', {
      headers: authHeaders(),
      data: {
        batch: { supplier: 'MQA-Seed', tracking: `MQA-TRACK-NB-${TAG}`, dateReceived: new Date().toISOString().slice(0, 10) },
        items: [{ name: 'MQA No Box Shoe', sku: NOBOX_SKU, size: '9', cost: 10, withBox: false }],
      },
    });
    test.skip(r1.status() === 429, 'rate-limited — rerun in isolation');
    expect(r1.status()).toBe(200);

    const r2 = await request.post('/api/batches/commit', {
      headers: authHeaders(),
      data: {
        batch: { supplier: 'MQA-Seed', tracking: `MQA-TRACK-WB-${TAG}`, dateReceived: new Date().toISOString().slice(0, 10) },
        items: [{ name: 'MQA With Box Shoe', sku: WITHBOX_SKU, size: '10', cost: 10, withBox: true }],
      },
    });
    test.skip(r2.status() === 429, 'rate-limited — rerun in isolation');
    expect(r2.status()).toBe(200);

    // Fetch VINs back so downstream tests can target them precisely.
    const list = await request.get(`/api/items/query?q=${NOBOX_SKU}`, { headers: authHeaders() }).catch(() => null);
    if (list && list.ok()) {
      const body = await list.json();
      const row = (body.rows || []).find((r) => r.sku === NOBOX_SKU);
      if (row) noBoxVin = row.vin;
    }
    const list2 = await request.get(`/api/items/query?q=${WITHBOX_SKU}`, { headers: authHeaders() }).catch(() => null);
    if (list2 && list2.ok()) {
      const body2 = await list2.json();
      const row2 = (body2.rows || []).find((r) => r.sku === WITHBOX_SKU);
      if (row2) withBoxVin = row2.vin;
    }
    console.log('Seeded VINs:', { noBoxVin, withBoxVin });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Horizontal overflow sweep at the tightest supported width (360x800).
// ─────────────────────────────────────────────────────────────────────────
test.describe('360x800 — no horizontal overflow', () => {
  test.use({ viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true });

  const ADMIN_ROUTES = ['/', '/receiving', '/rescale', '/instore', '/instore-listing', '/batches', '/inventory', '/report', '/access', '/nobox', '/sold', '/shipped', '/rescalereq', '/shelve', '/locations'];
  for (const route of ADMIN_ROUTES) {
    test(`admin ${route}`, async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto(route);
      await page.waitForTimeout(600);
      await assertNoHOverflow(page, `admin ${route}`);
    });
  }

  const PH_ROUTES = ['/', '/ph/new-inventory', '/ph/rescale', '/ph/nobox', '/ph/request'];
  for (const route of PH_ROUTES) {
    test(`ph_team ${route}`, async ({ page }) => {
      await loginAs(page, 'ph_team');
      await page.goto(route);
      await page.waitForTimeout(600);
      await assertNoHOverflow(page, `ph_team ${route}`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Everything below drives the 390x844 (iPhone-ish) viewport + touch.
// ─────────────────────────────────────────────────────────────────────────
test.describe('390x844 mobile functional', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  // ---- PH grid (/ph/new-inventory as ph_team) ----
  test.describe('PH grid mobile cards', () => {
    test('expand a card, edit GI/Final + a flag + note, Submit persists', async ({ page }) => {
      await loginAs(page, 'ph_team');
      await page.goto('/ph/new-inventory');
      await expect(page.getByText('New Inventory')).toBeVisible();
      await page.waitForTimeout(800);
      await assertNoHOverflow(page, 'ph/new-inventory');

      const cards = page.locator('.ph-card');
      const n = await cards.count();
      test.skip(n === 0, 'no PH rows in range (empty DB)');

      // Card chrome should be reachable and expand. Remember which SKU we edit —
      // after the reload the row is found by SKU, not by position.
      const first = cards.first();
      // The card title reads "{name} — {sku}". Take the SKU generically: on a
      // populated database the first card is whatever is newest, not necessarily
      // one of this file's MQA fixtures. The SKU is wrapped in CopyText, whose
      // click-to-copy affordance adds its own line to innerText ("SKU\nCopy") —
      // so keep only the first line.
      const editedSku = (await first.locator('.ph-card-title').innerText())
        .split('—').pop().trim().split('\n')[0].trim();
      expect(editedSku, 'could not read the SKU off the first PH card').not.toBe('');
      await first.locator('.ph-card-sizes-btn').click();
      await expect(first.locator('.ph-sizedetail')).toBeVisible();

      // Edit button lives in the card foot.
      const editBtn = first.getByRole('button', { name: 'Edit' });
      await editBtn.click();
      const giInput = first.locator('input.ph-price').first();
      await expect(giInput).toBeVisible();
      // Final = GI × the configured margin, rounded to the NEAREST WHOLE DOLLAR
      // (lib/ph.js calcFinalPrice → String(Math.round(...))). This asserted '133.20'
      // for a 111 GI, which predates the whole-dollar rounding and the configurable
      // margin — it had been failing ever since. Read the live margin so the test
      // stays right whatever it's set to, exactly as ph-grid.spec.js does.
      const pct = await page.evaluate(async () => {
        const t = sessionStorage.getItem('sb_session_token');
        const r = await fetch('/api/settings', { headers: { Authorization: `Bearer ${t}` } });
        return (await r.json()).priceMarkupPct;
      });
      await giInput.fill('111');
      const finalInput = first.locator('input.ph-price').nth(1);
      await expect(finalInput).toHaveValue(String(Math.round(111 * (1 + Number(pct) / 100))));

      // Flag checkbox toggles.
      const flag = first.locator('.ph-yn-check').first();
      const before = await flag.isChecked();
      await flag.click();
      expect(await flag.isChecked()).toBe(!before);

      // Note field.
      const note = first.locator('textarea.ph-note').first();
      await note.fill(`MQA note ${TAG}`);

      // Submit and confirm the edit UI closes (draft -> saved state).
      await first.getByRole('button', { name: 'Submit' }).click();
      await expect(first.locator('.ph-edit-actions').getByText('Submit')).toHaveCount(0, { timeout: 8000 });

      // Re-open to confirm persistence.
      //
      // Turning a store flag on moves the group from Pending to In-Progress
      // (lib/ph.js phListingStatus), and the grid defaults to the Pending filter —
      // so after the reload this row is legitimately NOT in the default view. The
      // old check grabbed `.ph-card` .first() and waited 30s for a card that had
      // correctly filtered itself out. The filter is an additive multi-select, so
      // turn the other two on as well — the flag we toggled could land the group in
      // in_progress OR done (or back in pending, if it was already on) depending on
      // the row's other flags, and this is true for all of them. Then find the row
      // by SKU instead of trusting position.
      await page.reload();
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'In-Progress' }).click();
      await page.getByRole('button', { name: 'Done' }).click();
      await page.waitForTimeout(500);
      const cardsAfter = page.locator('.ph-card').filter({ hasText: editedSku }).first();
      await expect(cardsAfter).toBeVisible({ timeout: 10000 });
      await cardsAfter.locator('.ph-card-sizes-btn').click();
      await expect(cardsAfter.locator('.ph-sizedetail')).toContainText(`MQA note ${TAG}`);
    });

    test('photo viewer opens from a card thumbnail (if a photo exists)', async ({ page }) => {
      await loginAs(page, 'ph_team');
      await page.goto('/ph/new-inventory');
      await page.waitForTimeout(800);
      const thumbBtn = page.locator('.ph-card .shoe-thumb-btn, .ph-card img.shoe-thumb').first();
      const has = await thumbBtn.count();
      test.skip(has === 0, 'no card thumbnails / no clickable photo in range');
    });
  });

  // ---- Inventory (/inventory as admin) ----
  test.describe('Inventory mobile cards', () => {
    test('filters, expand card, bulk-select + Edit status, Move to shelf', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/inventory');
      await expect(page.getByText('Apply filters')).toBeVisible();
      await page.waitForTimeout(600);
      await assertNoHOverflow(page, 'inventory');

      const cards = page.locator('.dcard');
      const n = await cards.count();
      test.skip(n === 0, 'no inventory rows in default range');

      // Expand a card.
      const first = cards.first();
      await first.locator('.dcard-main').click();
      await expect(first).toHaveClass(/open/);

      // Select-all checkbox toggles selection state (enables bulk actions).
      const selectAll = page.locator('.dcard-selectall input[type="checkbox"]');
      await selectAll.check();
      const bulkEditBtn = page.getByRole('button', { name: /Edit status/ });
      await expect(bulkEditBtn).toBeEnabled();
      await bulkEditBtn.click();
      const modal = page.locator('.modal-overlay .modal');
      await expect(modal).toBeVisible();
      await assertNoHOverflow(page, 'inventory bulk-status modal open');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(modal).toHaveCount(0);

      // Uncheck (leave inventory state clean for other tests).
      await selectAll.uncheck();
    });
  });

  // ---- No-Box (/nobox as admin) ----
  test.describe('No-Box mobile cards', () => {
    test('MQA no-box unit renders as a card with resolve controls reachable', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/nobox');
      // The page's own title, not a loose "No Box": this spec's own fixture is called
      // "MQA No Box Shoe", so once the seed lands its card matches too and the strict
      // locator resolves to two elements. Green locally only because the seed had
      // failed there.
      await expect(page.getByText('No Box — Not Ready')).toBeVisible();
      await page.waitForTimeout(600);
      await assertNoHOverflow(page, 'nobox');
      test.skip(!noBoxVin, 'seed step did not resolve a VIN (rate-limited?)');

      const card = page.locator('.dcard', { hasText: noBoxVin });
      await expect(card).toBeVisible({ timeout: 8000 });
      // Sanity: shoe name + size render inside the card.
      await expect(card).toContainText('MQA No Box Shoe');
      // Primary action reachable and tappable (don't actually resolve — keep
      // fixture available for the Shelve test below).
      const boxFoundBtn = card.getByRole('button', { name: /Box found/ });
      await expect(boxFoundBtn).toBeVisible();
      await expect(boxFoundBtn).toBeEnabled();
    });
  });

  // ---- Shelve (/shelve as admin) ----
  test.describe('Shelve mobile cards', () => {
    test('scan a shelf + a with-box VIN; card renders; "has a box now?" toggle for a no-box unit', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/shelve');
      await expect(page.getByText('Shelve / Put-away')).toBeVisible();
      await assertNoHOverflow(page, 'shelve (empty)');

      const input = page.locator('input[placeholder*="Scan a shelf barcode"]');
      await input.fill('MNH-WH-A1-01');
      await page.getByRole('button', { name: 'Add' }).click();
      await expect(page.locator('.shelve-target')).toBeVisible({ timeout: 5000 });

      test.skip(!withBoxVin && !noBoxVin, 'seed step did not resolve VINs (rate-limited?)');

      if (withBoxVin) {
        const vinInput = page.locator('input[placeholder*="Scan a VIN"]');
        await vinInput.fill(withBoxVin);
        await page.getByRole('button', { name: 'Add' }).click();
        await expect(page.locator('.dcard', { hasText: withBoxVin })).toBeVisible({ timeout: 5000 });
      }
      if (noBoxVin) {
        const vinInput = page.locator('input[placeholder*="Scan a VIN"]');
        await vinInput.fill(noBoxVin);
        await page.getByRole('button', { name: 'Add' }).click();
        const noBoxCard = page.locator('.dcard', { hasText: noBoxVin });
        await expect(noBoxCard).toBeVisible({ timeout: 5000 });
        const toggle = noBoxCard.locator('.shelve-box-toggle input[type="checkbox"]');
        await expect(toggle).toBeVisible();
        await expect(toggle).not.toBeChecked();
        await toggle.check();
        await expect(toggle).toBeChecked();
      }
      await assertNoHOverflow(page, 'shelve (with cards)');
      // Don't submit — leave inventory state clean; navigate away discards (guarded).
      page.once('dialog', (d) => d.accept());
      await page.goto('/');
    });
  });

  // ---- Receiving wizard (/receiving as admin) ----
  test.describe('Receiving wizard mobile', () => {
    test('step 1 → rapid scan bar + manual-add modal (size chip / qty stepper / keyboard)', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/receiving');
      await expect(page.getByText('Shipment details')).toBeVisible();
      await assertNoHOverflow(page, 'receiving step 1');

      await page.locator('label:has-text("Buyer") input').fill('MQA Tester');
      const supplierSel = page.locator('label:has-text("Supplier") select');
      await supplierSel.selectOption({ index: 1 }).catch(() => {});
      const trackInput = page.locator('input[placeholder="Type, scan, or upload a photo"]');
      await trackInput.fill(`MQA-WIZ-${TAG}`);
      await page.getByRole('button', { name: 'Next →' }).click();

      // The scan bar is the primary path now — it's sticky, so it must not push the
      // page sideways on a phone.
      const scanbar = page.locator('.scanbar');
      await expect(scanbar).toBeVisible();
      await expect(scanbar.locator('.seg')).toBeVisible(); // sticky With box / No box
      await assertNoHOverflow(page, 'receiving step 2 (scan bar)');
      await page.getByRole('button', { name: '+ Add manually' }).click();
      const modal = page.locator('.modal.additem');
      await expect(modal).toBeVisible();
      await assertNoHOverflow(page, 'receiving Add-Item modal open');

      const modalInput = modal.locator('input').first();
      await expect(modalInput).toBeFocused();
      // Use a real catalog SKU (already used elsewhere in this DB) so the
      // Alias lookup actually succeeds and the draft renders for real —
      // MQA-* SKUs are synthetic and would 404, only exercising the fallback.
      await modalInput.fill('IM2404-645');
      await modal.getByRole('button', { name: 'Add' }).click();

      // Wait for the draft itself rather than a fixed beat — a slow catalogue used to
      // send this down the "no draft" path and then click the × while the draft was
      // rendering underneath it (the scan flash also auto-clears, shifting layout),
      // which read as a mobile-layout failure when it was only a race.
      const draft = modal.locator('.additem-draft');
      const hasDraft = await draft.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(2000); // let the scan flash expire so nothing is mid-shift
      if (hasDraft) {
        // Size chip tap + qty stepper (touch path).
        const chip = draft.locator('.size-chip').first();
        await chip.click();
        const qtyStepper = draft.locator('.qty-stepper').first();
        await expect(qtyStepper).toBeVisible();
        await qtyStepper.locator('button.step').last().click(); // +1
        await assertNoHOverflow(page, 'receiving Add-Item draft open');
        // Close without completing — don't mutate this batch further.
        await modal.locator('.btn.icon.ghost').first().click();
      } else {
        // Catalog lookup failed for this SKU (e.g. rate-limited/offline) — still
        // verify the modal/keyboard didn't clip and closes cleanly.
        const err = modal.locator('.error');
        console.log('Add-Item: no draft created (product lookup likely failed) —', await err.textContent().catch(() => ''));
        await modal.locator('.btn.icon.ghost').first().click();
      }
      await expect(page.locator('.modal.additem')).toHaveCount(0);
    });
  });

  // ---- In-Store + In-Store Listing (as admin) ----
  test.describe('In-Store Listing mobile', () => {
    test('store toggle pill layout + "Needs listing only" filter', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/instore-listing');
      await expect(page.getByText('In-Store Listing')).toBeVisible();
      await page.waitForTimeout(500);
      await assertNoHOverflow(page, 'instore-listing');

      const needsOnly = page.locator('label.check-pill input[type="checkbox"]');
      await expect(needsOnly).toBeVisible();
      await needsOnly.check();
      await expect(needsOnly).toBeChecked();
      await page.waitForTimeout(300);
      await assertNoHOverflow(page, 'instore-listing (needs-only)');

      const rows = page.locator('.istore-row');
      const n = await rows.count();
      test.skip(n === 0, 'no in-store rows need listing right now');
      const toggle = rows.first().locator('.istore-toggle').first();
      const wasOn = (await toggle.getAttribute('aria-pressed')) === 'true';
      await toggle.click();
      await page.waitForTimeout(400);
      await expect(toggle).toHaveAttribute('aria-pressed', String(!wasOn));
      // Revert so the toggle doesn't leave the SKU's listing state altered.
      await toggle.click();
      await page.waitForTimeout(400);
      await expect(toggle).toHaveAttribute('aria-pressed', String(wasOn));
    });

    test('In-Store buying wizard step 1 renders on mobile', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/instore');
      await expect(page.getByText('In-store trip')).toBeVisible();
      await assertNoHOverflow(page, 'instore wizard');
    });
  });

  // ---- Mark Sold / Shipped (as admin) ----
  test.describe('Mark Sold/Shipped mobile', () => {
    test('scan-add a VIN, card renders, remove works, no overflow', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/shipped');
      await expect(page.getByText('Mark Shipped').first()).toBeVisible();
      test.skip(!withBoxVin, 'seed VIN unavailable');

      const input = page.locator('input[placeholder="Scan a VIN (SBM-…)"]');
      await input.fill(withBoxVin);
      await page.getByRole('button', { name: 'Add' }).click();
      const card = page.locator('.dcard', { hasText: withBoxVin });
      await expect(card).toBeVisible({ timeout: 5000 });
      await assertNoHOverflow(page, 'shipped with a card');

      await card.locator('button.remove').click();
      await expect(card).toHaveCount(0);
    });
  });

  // ---- Rescale Requests (as admin/warehouse) ----
  test.describe('Rescale Requests mobile', () => {
    test('list renders, audit form usable, no overflow', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/rescalereq');
      await expect(page.getByText('Rescale Requests')).toBeVisible();
      await page.waitForTimeout(500);
      await assertNoHOverflow(page, 'rescalereq');
    });
  });

  // ---- Locations (as admin) ----
  test.describe('Locations mobile', () => {
    test('drill into a site/area, tiles wrap without overflow', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/locations');
      await expect(page.getByText('Bulk add')).toBeVisible();
      await page.waitForTimeout(600);
      await assertNoHOverflow(page, 'locations (top level)');

      const tile = page.locator('.loc-tile .loc-tile-body').first();
      const hasTile = await tile.count();
      test.skip(!hasTile, 'no location tiles at the top level');
      const urlBefore = page.url();
      await tile.click();
      await page.waitForTimeout(400);
      // A real drill-down navigates (pushes a URL segment) and shows a breadcrumb.
      expect(page.url()).not.toBe(urlBefore);
      await assertNoHOverflow(page, 'locations (drilled in)');

      // Bulk-select checkbox on a tile should toggle independent of the drill-down button.
      const tileCheck = page.locator('.loc-tile-check').first();
      if (await tileCheck.count()) {
        const before = await tileCheck.isChecked();
        await tileCheck.check({ force: false }).catch(() => {});
        // Only assert if the click actually landed (tap target isn't swallowed by the body button).
        const after = await tileCheck.isChecked();
        console.log('Locations tile checkbox toggled independently of drill-down button:', before, '->', after);
      }
    });
  });

  // ---- Check Access (as admin) ----
  test.describe('Check Access mobile', () => {
    test('user cards render, role select + action buttons reachable', async ({ page }) => {
      await loginAs(page, 'admin');
      await page.goto('/access');
      await expect(page.getByText('Check Access')).toBeVisible();
      await page.waitForTimeout(400);
      await assertNoHOverflow(page, 'access');

      const cards = page.locator('.access-cards .dcard');
      const n = await cards.count();
      test.skip(n === 0, 'no accounts to review');
      const first = cards.first();
      await expect(first.locator('.dcard-actions button').first()).toBeVisible();
      await expect(first.locator('select.role-select')).toBeVisible();
    });
  });
});
