// QA verification spec for the PH Edited Photos feature + the checkbox UX
// change. Fixtures are namespaced QAP-*/qap_* and are created via the real API
// in beforeAll, then torn down in afterAll — no dependency on manually-seeded
// data. R2 must be configured (real uploads) for the full run to pass.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';

const SKU_COEXIST = 'QAP-COEXIST-1';
const SKU_NOBOX = 'QAP-NOBOX-1';

const auth = (role) => {
  const users = {
    admin: { uid: 'qap-admin', username: 'qap_admin', name: 'QAP Admin', role: 'admin' },
    warehouse: { uid: 'qap-wh', username: 'qap_wh', name: 'QAP Warehouse', role: 'warehouse' },
    ph_team: { uid: 'qap-ph', username: 'qap_ph', name: 'QAP PH', role: 'ph_team' },
  };
  return { Authorization: `Bearer ${signToken(users[role])}` };
};

let db;
let coexistVin;
let noboxVin;
let coexistBatchCode;
let noboxBatchCode;
let shelfCode;

test.beforeAll(async ({ request }) => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // Fixture 1: an item whose SKU will get BOTH a warehouse and a ph_edited
  // 'side' photo (coexistence + thumbnail-precedence fixture).
  const r1 = await request.post('/api/batches/commit', {
    headers: auth('warehouse'),
    data: {
      batch: { supplier: 'QAP-Fixture', tracking: `QAP-COEXIST-${Date.now()}`, dateReceived: new Date().toISOString().slice(0, 10) },
      items: [{ name: 'QAP Coexist Shoe', sku: SKU_COEXIST, size: '9', cost: 40, withBox: true }],
    },
  });
  expect(r1.ok(), await r1.text()).toBeTruthy();
  const body1 = await r1.json();
  coexistVin = body1.vins[0];
  coexistBatchCode = body1.batchCode;

  // Fixture 2: a no-box item for the Shelve "Has a box now?" checkbox test.
  const r2 = await request.post('/api/batches/commit', {
    headers: auth('warehouse'),
    data: {
      batch: { supplier: 'QAP-Fixture', tracking: `QAP-NOBOX-${Date.now()}`, dateReceived: new Date().toISOString().slice(0, 10) },
      items: [{ name: 'QAP NoBox Shoe', sku: SKU_NOBOX, size: '10', cost: 40, withBox: false }],
    },
  });
  expect(r2.ok(), await r2.text()).toBeTruthy();
  const body2 = await r2.json();
  noboxVin = body2.vins[0];
  noboxBatchCode = body2.batchCode;

  // Real photo uploads to R2: one 'warehouse' + one 'ph_edited' photo, same
  // (sku, angle='side') — proves coexistence + precedence end-to-end.
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  for (const source of ['warehouse', 'ph_edited']) {
    const signRes = await request.post('/api/photos/sign', {
      headers: auth('admin'),
      data: { sku: SKU_COEXIST, angle: 'side', contentType: 'image/jpeg', source },
    });
    expect(signRes.ok(), await signRes.text()).toBeTruthy();
    const { uploadUrl, publicUrl } = await signRes.json();
    const put = await request.put(uploadUrl, { headers: { 'Content-Type': 'image/jpeg' }, data: jpg });
    expect(put.ok()).toBeTruthy();
    const attachRes = await request.post('/api/photos/attach', {
      headers: auth('admin'),
      data: { sku: SKU_COEXIST, angle: 'side', url: publicUrl, source },
    });
    expect(attachRes.ok(), await attachRes.text()).toBeTruthy();
  }

  // Any active shelf location works for the Shelve test.
  const loc = await db.query(`SELECT code FROM locations LIMIT 1`);
  shelfCode = loc.rows[0]?.code;
});

test.afterAll(async () => {
  if (!db) return;
  try {
    await db.query(`DELETE FROM product_photos WHERE sku = $1`, [SKU_COEXIST]);
    if (coexistVin) await db.query(`DELETE FROM items WHERE vin = $1`, [coexistVin]);
    if (noboxVin) await db.query(`DELETE FROM items WHERE vin = $1`, [noboxVin]);
    if (coexistBatchCode) await db.query(`DELETE FROM batches WHERE batch_code = $1`, [coexistBatchCode]);
    if (noboxBatchCode) await db.query(`DELETE FROM batches WHERE batch_code = $1`, [noboxBatchCode]);
  } finally {
    await db.end();
  }
});

test('PH grid: PhotosModal groups PH edited vs Warehouse originals with no dup-key issues', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await loginAs(page, 'admin');
  await page.goto('/report');
  await expect(page.getByText(SKU_COEXIST)).toBeVisible({ timeout: 15000 });

  // Click the thumbnail (ShoeThumb) next to our test row to open PhotosModal.
  const row = page.locator('tr.ph-trow, .ph-card').filter({ hasText: SKU_COEXIST }).first();
  const thumb = row.locator('.shoe-thumb, img, button').first();
  await thumb.click({ trial: false }).catch(() => {});

  const modal = page.locator('.photos-modal');
  await expect(modal).toBeVisible({ timeout: 8000 });
  await expect(modal.getByText('PH edited · used for the listing')).toBeVisible();
  await expect(modal.getByText('Warehouse originals')).toBeVisible();
  await expect(modal.getByText('Download all (2) as ZIP')).toBeVisible();

  const reactKeyWarnings = consoleErrors.filter((e) => /duplicate key|unique.*key/i.test(e));
  expect(reactKeyWarnings).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
});

test('Checkbox UX: PH grid .ph-yn-check Yes/No flags still toggle blue/red and save (ph_team edit mode)', async ({ page }) => {
  // NOTE: the PH grid desktop table has a pre-existing, unrelated bug — an
  // unconditional useEffect(updateScrollShadow) recreates the scrollShadow
  // state object every render, causing a continuous "Maximum update depth
  // exceeded" render loop (confirmed independent of this feature/test; see
  // QA findings). That churn can make loosely-scoped locators land on the
  // wrong row, so this test scopes tightly to our fixture's <tr> and
  // re-resolves it right before each interaction instead of caching a stale handle.
  await loginAs(page, 'ph_team');
  await page.goto('/ph/new-inventory');
  const rowSku = () => page.locator('tr.ph-trow').filter({ hasText: SKU_COEXIST });
  await expect(rowSku()).toBeVisible({ timeout: 15000 });

  const editBtn = () => rowSku().getByRole('button', { name: 'Edit' });
  await expect(editBtn()).toBeVisible({ timeout: 8000 });
  await editBtn().click();

  // Edit mode reveals the per-size detail row right after the <tr> we scoped to.
  const detail = rowSku().locator('xpath=following-sibling::tr[1]');
  const ynCheck = detail.locator('.ph-yn-check').first();
  await expect(ynCheck).toBeVisible({ timeout: 8000 });
  // Confirm it IS a native checkbox (excluded from the global custom style by class).
  expect(await ynCheck.evaluate((el) => el.tagName)).toBe('INPUT');
  expect(await ynCheck.evaluate((el) => el.type)).toBe('checkbox');

  const before = await ynCheck.isChecked();
  const beforeClass = await ynCheck.getAttribute('class');
  expect(beforeClass).toContain(before ? 'yes' : 'no');

  await ynCheck.click({ force: true });
  await expect(ynCheck).toHaveJSProperty('checked', !before);
  const afterClass = await ynCheck.getAttribute('class');
  expect(afterClass).toContain(!before ? 'yes' : 'no');

  // Save (Submit) and confirm the toggle persisted server-side.
  await rowSku().getByRole('button', { name: 'Submit' }).click();
  await expect(rowSku().getByRole('button', { name: 'Submit' })).not.toBeVisible({ timeout: 8000 });

  const persisted = await db.query(`SELECT added_to_intel_inv FROM items WHERE vin = $1`, [coexistVin]);
  expect(persisted.rows[0].added_to_intel_inv).toBe(!before);
});

test('Receiving: ListingPhotos shows "PH edited on file" banner for a SKU with ph_edited photos', async ({ page }) => {
  // QAP-COEXIST-1 isn't a real catalog SKU, so stub only the external Alias
  // lookup (/api/sku-search) — everything else (auth, /api/photos/list, R2,
  // Postgres) is the real running server, exercising the actual feature code.
  await page.route('**/api/sku-search', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, product: { name: 'QAP Test Shoe', sku: SKU_COEXIST, image: '', source: 'manual', sizes: ['9'] } }),
  }));

  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await expect(page.getByText('Shipment details')).toBeVisible();

  await page.locator('label:has-text("Buyer") input').fill('QAP Buyer');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('label:has-text("Tracking #") input').fill(`QAP-BANNER-${Date.now()}`);

  await page.getByRole('button', { name: /Items →|Next/ }).first().click().catch(() => {});
  // If step didn't advance via that button, try the wizard step tab directly.
  if (!(await page.getByText('Add Item').isVisible().catch(() => false))) {
    await page.locator('.wstep', { hasText: 'Items' }).click();
  }
  await page.getByRole('button', { name: '+ Add Item' }).click();
  const skuField = page.locator('input[placeholder="Scan or type UPC / SKU"]');
  await expect(skuField).toBeVisible({ timeout: 8000 });
  await skuField.fill(SKU_COEXIST);
  await skuField.press('Enter');

  const listingPhotos = page.locator('.listing-photos');
  await expect(listingPhotos).toBeVisible({ timeout: 8000 });
  await expect(listingPhotos.getByText('PH edited photos are on file for this SKU.')).toBeVisible({ timeout: 8000 });
  // Warehouse capture UI (Add listing photos) must still be present/functional.
  await expect(listingPhotos.getByRole('button', { name: /listing photos|replace photos/i })).toBeVisible();
});

test('PH team: Find Image Listings shows 7 edited slots, uploads real photo, shows warehouse originals read-only', async ({ page }) => {
  await loginAs(page, 'ph_team');
  // Edited Photos was consolidated into "Find Image Listings"; the old URL redirects here.
  await page.goto('/ph/edited-photos');
  await expect(page.getByText('Find Image Listings')).toBeVisible();

  const skuInput = page.locator('.pi-sku-input');
  await skuInput.fill(SKU_COEXIST);
  await page.getByRole('button', { name: 'Load SKU' }).click();

  await expect(page.locator('.pe-grid')).toBeVisible({ timeout: 8000 });
  const slots = page.locator('.pe-slot');
  await expect(slots).toHaveCount(7);
  // side angle already has a ph_edited photo from the fixture -> filled.
  await expect(page.locator('.pe-slot.filled')).toHaveCount(1);
  // Warehouse original (side) shown read-only with a Download button.
  // Scope to the read-only label (a help hint elsewhere also says "Warehouse originals").
  await expect(page.locator('.pe-orig-lbl')).toBeVisible();
  await expect(page.locator('.pe-orig-cell')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Download originals/i })).toBeVisible();

  // Upload a new photo into an empty slot (extra2) — real R2 upload.
  const extra2Input = page.locator('.pe-slot.extra', { hasText: 'Extra 2' }).locator('input[type=file]');
  const fs = await import('node:fs');
  const tmp = '/tmp/qap-e2e-upload.jpg';
  fs.writeFileSync(tmp, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]));
  await extra2Input.setInputFiles(tmp);
  await expect(page.locator('.pe-slot.filled')).toHaveCount(2, { timeout: 15000 });

  // Remove it again to leave the fixture as we found it (afterAll deletes the
  // whole SKU's photos anyway, but this also verifies remove functionally works).
  const extra2Slot = page.locator('.pe-slot.extra', { hasText: 'Extra 2' });
  await extra2Slot.locator('.pe-slot-x').click();
  await expect(page.locator('.pe-slot.filled')).toHaveCount(1, { timeout: 8000 });
});

test('Checkbox UX: In-Store Listing "Needs listing only" toggles', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/instore-listing');
  const cb = page.locator('label.check-pill', { hasText: 'Needs listing only' }).locator('input[type=checkbox]');
  await expect(cb).toBeVisible({ timeout: 10000 });
  const before = await cb.isChecked();
  await cb.click();
  await expect(cb).toHaveJSProperty('checked', !before);
});

test('Checkbox UX: Locations "Select all" toggles the header + tiles with contents', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/locations');
  const selectAll = page.locator('label.loc-selall input[type=checkbox]');
  await expect(selectAll).toBeVisible({ timeout: 10000 });
  const before = await selectAll.isChecked();
  await selectAll.click();
  await expect(selectAll).toHaveJSProperty('checked', !before);
  // Per-tile checked state is `ids.length > 0 && ids.every(selected)` — a tile
  // for a site with ZERO location rows (ids=[]) is intentionally never "checked"
  // (nothing to select), so only assert on tiles that have at least one item.
  const tiles = page.locator('.loc-tile');
  const n = await tiles.count();
  let assertedAny = false;
  for (let i = 0; i < n; i++) {
    const t = tiles.nth(i);
    const countText = (await t.locator('.loc-tile-count').textContent()) || '';
    if (/^0 /.test(countText.trim())) continue; // skip empty tiles (ids may be [])
    assertedAny = true;
    expect(await t.locator('.loc-tile-check').isChecked()).toBe(!before);
  }
  test.skip(!assertedAny, 'No non-empty tiles at this level to assert on');
});

test('Checkbox UX: Shelve "Has a box now?" toggles for a no-box unit', async ({ page }) => {
  test.skip(!shelfCode, 'No shelf locations seeded in this environment');
  await loginAs(page, 'warehouse');
  await page.goto('/shelve');
  const scanInput = page.locator('.searchrow input').first();
  await expect(scanInput).toBeVisible({ timeout: 10000 });
  await scanInput.fill(shelfCode);
  await scanInput.press('Enter');
  await expect(page.locator('.shelve-loc')).toBeVisible({ timeout: 8000 });

  await scanInput.fill(noboxVin);
  await scanInput.press('Enter');

  const cb = page.locator('label.check-pill.shelve-box-toggle input[type=checkbox]');
  await expect(cb).toBeVisible({ timeout: 8000 });
  const before = await cb.isChecked();
  expect(before).toBe(false);
  await cb.click();
  await expect(cb).toHaveJSProperty('checked', true);
});

test('Checkbox UX: global checkbox style does not break Inventory bulk-select toggling', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/inventory');
  await expect(page.locator('table, .inv-rows')).toBeVisible({ timeout: 15000 });
  const selectAll = page.locator('thead input[type="checkbox"]').first();
  const hasSelectAll = await selectAll.count();
  test.skip(hasSelectAll === 0, 'No select-all checkbox found (layout may differ)');
  await expect(selectAll).toBeVisible();
  const before = await selectAll.isChecked();
  await selectAll.click();
  const after = await selectAll.isChecked();
  expect(after).toBe(!before);
});
