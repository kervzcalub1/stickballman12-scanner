// Rapid-scan QA: the paths the feature spec doesn't reach — what actually lands in
// the DB when a scanned cart is committed, the sticky no-box mode's effect on unit
// status, rescale VIN rescanning through the same bar, and the per-box reset in a
// multi-box batch. Everything is torn down at the end.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { isCameraReread, RESCAN_COOLDOWN_MS } from '../src/lib/codes.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const SKU_A = 'E2E-QA-RAPID-A';
const SKU_B = 'E2E-QA-RAPID-B';
const NAME_A = 'QA Rapid Runner';
const NAME_B = 'QA Rapid Trainer';

test.afterAll(async () => {
  const rows = await q('SELECT id, batch_id FROM items WHERE sku IN ($1,$2)', [SKU_A, SKU_B]);
  for (const r of rows) await q('DELETE FROM item_events WHERE item_id = $1', [r.id]);
  await q('DELETE FROM items WHERE sku IN ($1,$2)', [SKU_A, SKU_B]);
  const batchIds = [...new Set(rows.map((r) => r.batch_id).filter(Boolean))];
  for (const id of batchIds) {
    await q('DELETE FROM batch_issues WHERE batch_id = $1', [id]).catch(() => {});
    await q('DELETE FROM boxes WHERE batch_id = $1', [id]).catch(() => {});
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await pool.end();
});

async function stubCatalogue(page) {
  await page.route('**/api/sku-search', (route) => {
    const sku = String(route.request().postDataJSON()?.sku || '').toUpperCase();
    if (sku === SKU_B) {
      return route.fulfill({ json: { ok: true, product: { name: NAME_B, sku: SKU_B, image: '', source: 'manual', scannedSize: '11', sizes: ['11'] } } });
    }
    return route.fulfill({ json: { ok: true, product: { name: NAME_A, sku: SKU_A, image: '', source: 'manual', scannedSize: '9', sizes: ['9', '9.5'] } } });
  });
}

const scan = async (page, code) => {
  await page.locator('.scanbar input').first().fill(code);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
};

test('a scanned cart commits real units: one VIN each, box status from the sticky mode', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stubCatalogue(page);
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-QA-RAPID-${Date.now()}`);
  await page.getByRole('button', { name: 'Next →' }).click();

  // Two of the same shoe with a box…
  await scan(page, SKU_A);
  await scan(page, SKU_A);
  const lineA = page.locator(`.recv-item[data-sku="${SKU_A}"]`);
  await expect(lineA.locator('.recv-size-qty')).toHaveText('×2', { timeout: 10_000 });

  // …then flip the sticky switch and scan a pair that arrived without one.
  await page.locator('.scanbar').getByRole('button', { name: /No box/ }).click();
  await scan(page, SKU_B);
  const lineB = page.locator(`.recv-item[data-sku="${SKU_B}"]`);
  await expect(lineB).toHaveClass(/nobox/, { timeout: 10_000 });

  // Every unit shows its VIN before submit — the warehouse labels from these.
  await lineA.locator('.recv-size-row').click();
  const vinTexts = await lineA.locator('.recv-units .vin').allTextContents();
  expect(vinTexts).toHaveLength(2);
  expect(vinTexts.every((v) => /^SBM-\d{6}-\d{6}$/.test(v.trim()))).toBe(true);
  expect(new Set(vinTexts).size).toBe(2); // never the same VIN twice

  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  // The no-box pair is auto-listed as a shipment issue on the Issues step.
  await expect(page.locator('.auto-issue')).toContainText(SKU_B);
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await page.getByRole('button', { name: /Yes, commit/ }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 20_000 });

  // --- what actually landed in the database ---
  const a = await q('SELECT vin, size, with_box, status, name FROM items WHERE sku = $1', [SKU_A]);
  expect(a).toHaveLength(2);
  expect(a.every((r) => r.with_box === true)).toBe(true);
  expect(a.every((r) => r.size === '9')).toBe(true);
  expect(a.every((r) => r.name === NAME_A)).toBe(true);
  expect(new Set(a.map((r) => r.vin)).size).toBe(2);

  const b = await q('SELECT vin, size, with_box, status FROM items WHERE sku = $1', [SKU_B]);
  expect(b).toHaveLength(1);
  expect(b[0].with_box).toBe(false);
  expect(b[0].size).toBe('11');
  // Scanned under "No box" → the unit is received into the no-box queue, not stock.
  expect(b[0].status).toBe('no_box');

  // The intake event chain is intact for a rapid-scanned unit.
  const events = await q(
    `SELECT e.type FROM item_events e JOIN items i ON i.id = e.item_id
     WHERE i.vin = $1 ORDER BY e.id`, [a[0].vin],
  );
  expect(events.length).toBeGreaterThan(0);
});

test('the cart clears between boxes of a multi-box batch — no bleed, no stale Undo', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stubCatalogue(page);
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('label:has-text("Boxes expected") input').fill('2');
  const rows = page.locator('.box-build-row');
  await expect(rows.first()).toBeVisible();

  // Box 1: scan one pair in, then step back out to the box list without committing.
  await rows.nth(0).locator('input').first().fill(`E2E-QA-BOX1-${Date.now()}`);
  await rows.nth(0).getByRole('button', { name: /Add items/i }).click();
  await scan(page, SKU_A);
  await expect(page.locator(`.recv-item[data-sku="${SKU_A}"]`)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /Undo last scan/ })).toBeVisible();
  await page.getByRole('button', { name: /← Boxes/ }).click();

  // Box 2 starts empty — the previous box's cart and its Undo must not follow.
  await rows.nth(1).locator('input').first().fill(`E2E-QA-BOX2-${Date.now()}`);
  await rows.nth(1).getByRole('button', { name: /Add items/i }).click();
  await expect(page.locator('.recv-item')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Undo last scan/ })).toHaveCount(0);
  await expect(page.getByText('Items (0 units)')).toBeVisible();

  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/', { waitUntil: 'commit' }).catch(() => {});
});

test('rescale still rescans existing units by VIN through the same bar', async ({ page }) => {
  const existing = await q("SELECT vin FROM items WHERE vin IS NOT NULL ORDER BY id DESC LIMIT 1");
  test.skip(!existing.length, 'no existing inventory in this DB to rescan');
  const vin = existing[0].vin;

  await loginAs(page, 'warehouse');
  await page.goto('/rescale');
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.scanbar')).toBeVisible();
  // Rescale has no box-status switch — a VIN is an existing unit, not fresh stock.
  await expect(page.locator('.scanbar-mode')).toHaveCount(0);

  await scan(page, vin);
  await expect(page.locator('.rescan-row')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator('.rescan-row')).toContainText(vin);
  // A second scan of the same VIN is refused — it's one physical unit.
  await scan(page, vin);
  await expect(page.locator('.rescan-row')).toHaveCount(1);
  await expect(page.locator('.scan-flash')).toContainText(/Already added/i);

  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/', { waitUntil: 'commit' }).catch(() => {});
});

test('the manual-add modal still works for a code nothing resolves', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({ status: 404, json: { ok: false, error: 'No product found' } }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-QA-MANUAL-${Date.now()}`);
  await page.getByRole('button', { name: 'Next →' }).click();

  await page.getByRole('button', { name: '+ Add manually' }).click();
  const modal = page.locator('.modal.additem');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.modal-title')).toHaveText('Add manually');
  // Listing photos are gone from this dialog — they hang off the cart row now.
  await expect(modal.locator('.listing-photos')).toHaveCount(0);

  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/', { waitUntil: 'commit' }).catch(() => {});
});

// The camera can't be driven headlessly, so the re-read rule it depends on lives in
// src/lib/codes.js as a pure function and is tested directly. This is the rule that
// decides whether a scan counts — getting it wrong either loses real pairs or
// invents them.
test.describe('scan de-duplication rule', () => {
  test('a camera re-read inside the window is one scan; outside it, two', () => {
    const seen = { ABC: 1_000 };
    expect(isCameraReread(seen, 'ABC', 1_000 + RESCAN_COOLDOWN_MS - 1)).toBe(true);
    expect(isCameraReread(seen, 'ABC', 1_000 + RESCAN_COOLDOWN_MS)).toBe(false);
    expect(isCameraReread(seen, 'ABC', 9_999)).toBe(false);
  });

  test('a code never seen before is never a re-read', () => {
    expect(isCameraReread({}, 'NEW', 1_000)).toBe(false);
    expect(isCameraReread({ OTHER: 1_000 }, 'NEW', 1_000)).toBe(false);
    expect(isCameraReread(undefined, 'NEW', 1_000)).toBe(false);
  });

  test('a falsy timestamp still counts as seen (epoch 0 is a real time)', () => {
    expect(isCameraReread({ ABC: 0 }, 'ABC', 5)).toBe(true);
  });
});

test('two sizeless scans of one shoe fold together once the same size is typed', async ({ page }) => {
  await loginAs(page, 'warehouse');
  // Both scans come back with a product but no size — the case that produced two
  // separate "size?" rows.
  await page.route('**/api/sku-search', (route) => route.fulfill({
    json: { ok: true, product: { name: NAME_A, sku: SKU_A, image: '', source: 'manual', sizes: [] } },
  }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-QA-MERGE-${Date.now()}`);
  await page.getByRole('button', { name: 'Next →' }).click();

  await scan(page, SKU_A);
  await scan(page, SKU_A);
  const line = page.locator(`.recv-item[data-sku="${SKU_A}"]`);
  await expect(line.locator('.sz.need')).toHaveCount(2, { timeout: 10_000 });

  // Type it character by character: the field must survive the first keystroke.
  // (Rendering it on the live value unmounted it the moment "1" was typed, so a
  // size like "10" could never be entered at all.)
  const first = line.locator('.sz.need').first();
  await first.pressSequentially('10');
  await expect(first).toHaveValue('10');
  await first.blur();
  await expect(line.locator('.recv-size')).toHaveCount(2); // still two — only one is filled

  const second = line.locator('.sz.need').first();
  await second.pressSequentially('10');
  await second.blur();
  // Same size now on both → one row of ×2, and both VINs carried across.
  await expect(line.locator('.recv-size')).toHaveCount(1);
  await expect(line.locator('.recv-size-qty')).toHaveText('×2');
  await line.locator('.recv-size-row').click();
  await expect(line.locator('.recv-units .recv-unit')).toHaveCount(2);
  const vins = await line.locator('.recv-units .vin').allTextContents();
  expect(new Set(vins.map((v) => v.trim())).size).toBe(2);

  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto('/', { waitUntil: 'commit' }).catch(() => {});
});
