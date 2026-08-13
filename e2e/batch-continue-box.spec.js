// Continuing a multi-box batch from the Batch page.
//
// Reported from the floor: "How do I continue a batch? I go into Batches, click the
// batch, and there's no obvious way to continue or add items to any of the boxes
// marked 'pending'." He was right — a pending row was a dead end. The only visible
// action was "+ Add box", which creates box N+1 rather than filling the box in front
// of him, so following it would have quietly built a batch of empty boxes.
//
// A pending box now carries its own "Add items", and the scans land in THAT box —
// same row, same number, same tracking.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const authHeaders = () => ({
  Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}`,
});

const SUPPLIER = 'E2E Continue-Box Supplier';
const SKU = 'E2E-CONTBOX-A';
let batchId = null;
let batchCode = null;

// An open 3-box batch whose boxes are all recorded but empty — exactly the screen
// that prompted the report.
test.beforeAll(async ({ request }) => {
  const created = await request.post('/api/batches/create-open', {
    headers: authHeaders(),
    data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, dateReceived: '2026-08-13', expectedBoxes: 3 } },
  });
  expect(created.status()).toBe(200);
  ({ id: batchId, batchCode } = await created.json());
  const synced = await request.post('/api/batches/sync-boxes', {
    headers: authHeaders(),
    data: {
      batchId,
      boxes: [1, 2, 3].map((n) => ({ boxNumber: n, trackingNumber: `E2E-CONT-${n}` })),
    },
  });
  expect(synced.status()).toBe(200);
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  // Sweep the supplier, not just this run's batch — a spec that fails midway would
  // otherwise leave an open batch behind in the dev DB on every attempt.
  await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE supplier_name = $1)', [SUPPLIER]);
  await q('DELETE FROM batches WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

// /batches has no deep link — the batch is reached the way staff reach it.
async function openBatch(page) {
  await page.goto('/batches');
  await page.locator('.batch-nav-row').filter({ hasText: batchCode }).first().click();
  await expect(page.locator('.batch-page-code')).toContainText(batchCode);
}

test('a pending box offers "Add items", and scans land in THAT box', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await openBatch(page);

  const row2 = page.locator('.box-row-wrap').filter({ hasText: 'Box 2' });
  await expect(row2).toContainText('pending');
  // The dead end this fixes: every pending row must offer the way forward.
  await expect(page.locator('.box-row-add')).toHaveCount(3);

  await row2.getByRole('button', { name: 'Add items' }).click();

  // Box mode, aimed at box 2 — not "Add a box", which is the other thing entirely.
  await expect(page.locator('.box-context')).toContainText('Box 2');
  await expect(page.locator('.rows-title').first()).toContainText('Continue box 2');
  // Its tracking comes along, so re-typing it isn't the price of continuing.
  await expect(page.locator('.track-field input').first()).toHaveValue('E2E-CONT-2');

  // Stub the catalogue so this spec tests the box plumbing, not a third party.
  await page.route('**/api/items/find*', (r) => r.fulfill({ json: { ok: true, product: null, units: [] } }));
  await page.route('**/api/sku-search', (r) => r.fulfill({
    json: { ok: true, product: { name: 'E2E Continue Runner', sku: SKU, upc: null, image: null, brand: 'Nike', colorway: 'Black/White', sizes: ['9', '9.5'], gender: 'Men', source: 'alias' } },
  }));
  await page.getByRole('button', { name: 'Next →' }).click();
  // Rapid scan: the code goes straight into the cart, no dialog in between.
  await page.locator('.scanbar input').first().fill(SKU);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  const line = page.locator(`.recv-item[data-sku="${SKU}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  // The stub returns no scanned size, so the line lands needing one — fill it in
  // rather than losing the scan.
  await line.locator('.sz.need').fill('9.5');

  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: /Submit box/i }).click();
  await page.getByRole('button', { name: /Yes, (commit|submit)/i }).click();
  await expect(page.locator('.modal')).toContainText(/saved|received/i, { timeout: 15_000 });

  // The real assertion: the pair is in box 2 — the batch still has THREE boxes, and
  // no box 4 was quietly opened beside it.
  const boxes = await q('SELECT box_number, status, (SELECT count(*)::int FROM items i WHERE i.box_id = bx.id) AS n FROM batch_boxes bx WHERE batch_id = $1 ORDER BY box_number', [batchId]);
  expect(boxes.map((b) => b.box_number)).toEqual([1, 2, 3]);
  expect(boxes.find((b) => b.box_number === 2).n).toBe(1);
  expect(boxes.find((b) => b.box_number === 2).status).toBe('received');
  expect(boxes.filter((b) => b.box_number !== 2).every((b) => b.n === 0)).toBe(true);
});

test('a received box has no "Add items" — it is closed', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await openBatch(page);
  const row2 = page.locator('.box-row-wrap').filter({ hasText: 'Box 2' });
  await expect(row2).toContainText('received');
  await expect(row2.getByRole('button', { name: 'Add items' })).toHaveCount(0);
  // …while the ones still waiting keep theirs.
  await expect(page.locator('.box-row-add')).toHaveCount(2);
});
