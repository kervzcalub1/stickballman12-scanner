// Click-to-copy on the Inventory page — the same affordance the PH grid has, for
// admin/warehouse. Shoe name, SKU, VIN and UPC are all copyable; copying must
// never double as selecting or expanding the row it sits in.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const SKU = 'E2E-COPY-A';
const UPC = '195244570999';
const NAME = 'E2E Copy Test Runner';
let vin = null;

test.beforeAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
});
test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q("DELETE FROM batches WHERE origin = 'E2E copy' AND NOT EXISTS (SELECT 1 FROM items WHERE batch_id = batches.id)");
  await pool.end();
});

// Fresh stock to look at, created through the real commit endpoint.
async function seed(page) {
  if (vin) return vin;
  const res = await page.evaluate(async ([sku, upc, name]) => {
    const r = await fetch('/api/batches/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
      body: JSON.stringify({
        kind: 'existing', noShelf: true, batch: { origin: 'E2E copy' },
        items: [{ name, sku, size: '9.5', upc, withBox: true, source: 'manual' }],
      }),
    });
    return { status: r.status, body: await r.json() };
  }, [SKU, UPC, NAME]);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  vin = res.body.vins[0];
  return vin;
}

// The "Copied ✓" cue only appears once the clipboard write actually resolved, so
// asserting the class is asserting the copy — no clipboard permission needed.
const copied = (loc) => expect(loc).toHaveClass(/copied/);

test.describe('Inventory · click-to-copy', () => {
  test('the shoe name and SKU copy from the list row', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    await seed(page);
    await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(SKU);
    await page.getByRole('button', { name: 'Go', exact: true }).click();

    const name = page.locator('.copytext', { hasText: NAME }).first();
    await expect(name).toBeVisible();
    await name.click();
    await copied(name);

    const sku = page.locator('.copytext', { hasText: SKU }).first();
    await sku.click();
    await copied(sku);
  });

  test('copying does not select or expand the row', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    await seed(page);
    await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(SKU);
    await page.getByRole('button', { name: 'Go', exact: true }).click();

    const before = await page.locator('.inv-detail').count();
    await page.locator('.copytext', { hasText: NAME }).first().click();
    // No row got checked, and nothing expanded.
    await expect(page.locator('input[type=checkbox]:checked')).toHaveCount(0);
    await expect(page.locator('.inv-detail')).toHaveCount(before);
  });

  test('the VIN and UPC copy from the expanded units list', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    const v = await seed(page);
    await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(SKU);
    await page.getByRole('button', { name: 'Go', exact: true }).click();

    // Expand via the caret — clicking the NAME copies it (that's the point), so
    // the row's expand target is everywhere except the copyable text, same as PH.
    await page.locator('.inv-caret, .dcard-main').first().click();
    const row = page.locator('.inv-unit-row').filter({ hasText: v });
    await expect(row).toBeVisible();

    const vinCell = row.locator('.copytext.vin');
    await vinCell.click();
    await copied(vinCell);

    const upcCell = row.locator('.copytext', { hasText: UPC });
    await upcCell.click();
    await copied(upcCell);
  });

  test('the item detail copies name, VIN, SKU and UPC', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    const v = await seed(page);
    await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(v);
    await page.getByRole('button', { name: 'Go', exact: true }).click();

    await expect(page.locator('.details h2')).toContainText(NAME);
    for (const value of [NAME, v, SKU, UPC]) {
      const cell = page.locator('.result .copytext', { hasText: value }).first();
      await cell.click();
      await copied(cell);
    }
  });
});
