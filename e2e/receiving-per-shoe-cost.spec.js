// Cost per SHOE at receiving.
//
// Receiving used to carry one "Default cost" for the whole batch and stamp it on every
// pair — fifteen SKUs at fifteen prices meant fifteen corrections on the Costs page
// afterwards, and a box received against a PO ignored the cost the supplier had
// already typed for every size. What has to hold now, most specific first:
//   typed on the shoe's card  →  the PO line for that SKU + size  →  the batch default
// and a blank at every level lands as NULL ("not known"), never as $0 — a typed 0 is
// the only way to record a free pair.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-6);

const SKU_A = `E2E-COST-A-${stamp}`;
const SKU_B = `E2E-COST-B-${stamp}`;
const SKU_C = `E2E-COST-C-${stamp}`;
const SKU_X = `E2E-COST-X-${stamp}`;   // PO: priced 80 / 90 by size
const SKU_Y = `E2E-COST-Y-${stamp}`;   // PO: no cost declared
const SKU_Z = `E2E-COST-Z-${stamp}`;   // PO: 60, overridden on the card
const ALL = [SKU_A, SKU_B, SKU_C, SKU_X, SKU_Y, SKU_Z];
const PO_CODE = `PO-COST-${stamp}`;
let poId = null;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  const items = await q('SELECT id, batch_id FROM items WHERE sku = ANY($1)', [ALL]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = ANY($1)', [ALL]);
  const batchIds = [...new Set(items.map((i) => i.batch_id).filter(Boolean))];
  if (poId != null) {
    await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [poId]);
    await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
    await q('DELETE FROM batches WHERE po_id = $1', [poId]);
  }
  for (const id of batchIds) {
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  if (poId != null) {
    await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
    await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
  await pool.end();
});

// The catalogue is stubbed so this tests our flow, not a third party.
async function stubCatalogue(page) {
  await page.route('**/api/sku-search', async (route) => {
    const sku = String(route.request().postDataJSON()?.sku || '').toUpperCase();
    if (!ALL.includes(sku)) return route.fulfill({ status: 404, json: { ok: false, error: 'No product found' } });
    return route.fulfill({ json: { ok: true, product: { name: `E2E Cost ${sku.slice(-8)}`, sku, image: '', source: 'manual', scannedSize: '9', sizes: ['9', '10'] } } });
  });
}

const scan = async (page, code) => {
  await page.locator('.scanbar input').first().fill(code);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  const line = page.locator(`.recv-item[data-sku="${code}"]`);
  await expect(line).toBeVisible({ timeout: 10_000 });
  return line;
};
const costBox = (line) => line.locator('.recv-item-cost input');
const costSrc = (line) => line.locator('.recv-item-cost-src');

const costsOnFile = async (sku) => (await q('SELECT size, cost FROM items WHERE sku = $1 ORDER BY size', [sku]))
  .map((r) => ({ size: r.size, cost: r.cost == null ? null : Number(r.cost) }));

test('each shoe carries its own cost; blank stays blank and 0 is a real 0', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await stubCatalogue(page);
  await page.goto('/receiving');
  await expect(page.getByText('Shipment details')).toBeVisible();
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(`E2E-COST-${stamp}`);
  // No batch default on purpose — the card has to say so.
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.scanbar')).toBeVisible();

  const a = await scan(page, SKU_A);
  const b = await scan(page, SKU_B);
  const c = await scan(page, SKU_C);

  // Nothing typed, nothing to fall back on: the card says the pair will land uncosted.
  await expect(costSrc(a)).toContainText('no cost');
  await expect(costBox(a)).toHaveAttribute('placeholder', '—');

  await costBox(a).fill('55');
  await expect(costSrc(a)).toHaveText('typed');
  await costBox(c).fill('0');
  await expect(costSrc(c)).toHaveText('typed');

  // The Review card shows the same box with the same answer.
  await page.getByRole('button', { name: 'Review →' }).click();
  const ra = page.locator(`.recv-items.review .recv-item[data-sku="${SKU_A}"]`);
  await expect(costBox(ra)).toHaveValue('55');
  await expect(costSrc(page.locator(`.recv-items.review .recv-item[data-sku="${SKU_B}"]`))).toContainText('no cost');

  // The confirm says out loud which pairs are about to land with no cost.
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await expect(page.getByText('Commit this batch?')).toBeVisible();
  await expect(page.locator('.confirm-summary')).toContainText('total $55.00');
  await expect(page.locator('.confirm-summary .warn-line')).toContainText('1 pair with no cost');
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  expect(await costsOnFile(SKU_A)).toEqual([{ size: '9', cost: 55 }]);
  expect(await costsOnFile(SKU_B)).toEqual([{ size: '9', cost: null }]);
  expect(await costsOnFile(SKU_C)).toEqual([{ size: '9', cost: 0 }]);
});

// A blank cost used to print as "$0.00" on the pair's own page, and the only way to
// fix a figure from there was to know the Costs page existed and retype the SKU.
test('Inventory shows "no cost" rather than $0.00, and the pencil lands on the Costs page with the SKU searched', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(SKU_B);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.locator('.inv-caret, .dcard-main').first().click();
  const cost = page.locator('.inv-metrics dd').filter({ has: page.locator('.inv-cost-edit') }).first();
  await expect(cost).toContainText('no cost');
  await cost.locator('.inv-cost-edit').click();

  await expect(page).toHaveURL(new RegExp(`/costs\\?q=${SKU_B}`));
  await expect(page.locator('.cost-search-input')).toHaveValue(SKU_B);
  const card = page.locator('.cost-card').filter({ hasText: SKU_B });
  await expect(card).toBeVisible();
  await expect(card).toContainText('1 pair still without a cost');

  // …and the fix is one save away, written per size to the pairs themselves.
  await card.locator('.cost-size input').first().fill('42');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.ok')).toContainText('Saved 1 size');
  expect(await costsOnFile(SKU_B)).toEqual([{ size: '9', cost: 42 }]);
});

test('a box received against a PO inherits the cost the supplier declared per size', async ({ page }) => {
  const po = (await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
     VALUES ($1, 'E2E Cost Supplier', 'shipped', 1, 'box') RETURNING id`, [PO_CODE]))[0];
  poId = Number(po.id);
  const box = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`,
    [poId, `COST${stamp}A`]))[0];
  const line = (sku, size, cost) => q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, unit_cost, entered_on_behalf)
     VALUES ($1, $2, $3, $4, $5, 1, $6, true)`, [poId, box.id, sku, size, `E2E Cost ${sku.slice(-8)}`, cost]);
  await line(SKU_X, '9', 80);
  await line(SKU_X, '10W', 90);   // "10W" on the manifest, "10" on the shoe: numeric match
  await line(SKU_Y, '9', null);
  await line(SKU_Z, '9', 60);

  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('label:has-text("Buyer") input').fill('e2e');
  await page.locator('label:has-text("Default cost") input').fill('40');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.locator('.po-picker input').fill(PO_CODE);
  await page.locator('.po-picker').getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('.po-receive-banner')).toContainText(PO_CODE);
  await page.getByRole('button', { name: 'Add items' }).first().click();
  await expect(page.locator('.po-manifest')).toBeVisible();

  for (const row of await page.locator('.po-manifest-size').all()) await row.locator('input[type="checkbox"]').check();

  await page.getByRole('button', { name: /Review →/ }).click();
  await expect(page.locator('.recv-items.review')).toBeVisible();
  const card = (sku) => page.locator(`.recv-items.review .recv-item[data-sku="${sku}"]`);

  // X: two sizes at two prices → a range, so nobody reads one size's price as both.
  await expect(costSrc(card(SKU_X))).toContainText('from PO · $80.00–$90.00 by size');
  // Y: the supplier skipped it → the batch default steps in.
  await expect(costSrc(card(SKU_Y))).toContainText('batch default');
  await expect(costBox(card(SKU_Y))).toHaveAttribute('placeholder', '40.00');
  // Z: the PO said 60; the person unpacking knows better.
  await expect(costBox(card(SKU_Z))).toHaveAttribute('placeholder', '60.00');
  await costBox(card(SKU_Z)).fill('65');

  await page.getByRole('button', { name: /Next →/ }).click();
  await page.getByRole('button', { name: 'Submit box' }).click();
  await expect(page.locator('.confirm-summary')).toContainText('total $275.00'); // 80 + 90 + 40 + 65
  await expect(page.locator('.confirm-summary .warn-line')).toHaveCount(0);
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.locator('.modal.success, .modal')).toContainText(/Box saved/i);

  expect(await costsOnFile(SKU_X)).toEqual([{ size: '10W', cost: 90 }, { size: '9', cost: 80 }]);
  expect(await costsOnFile(SKU_Y)).toEqual([{ size: '9', cost: 40 }]);
  expect(await costsOnFile(SKU_Z)).toEqual([{ size: '9', cost: 65 }]);
});
