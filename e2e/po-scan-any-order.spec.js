// Receiving against a PO, in the order the box comes out.
//
// The manifest checklist used to be the INPUT: find the row for the pair in hand, tick
// it, then (in raw-1ID mode) scan its sticker — which landed on the first ticked row in
// DISPLAY order. A shoe UPC scanned at the bar was refused. The floor read that as "scan
// them in the app's order" and went round it through the Batch page (Brent, Sept 2026).
//
// What has to hold now: a scanned UPC lands on its own size row whatever the order; a
// SKU with one open size lands there too, and one with several says which sizes rather
// than guessing; an over-count is recorded and named; undo steps the row back; a pair
// that is on no row becomes an unexpected line that can be typed in; and Review states
// expected / received / missing / not-on-PO before anything is committed.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`;
const PO_CODE = `PO-ANYORD-${stamp.slice(-6)}`;
const PO_RAW = `PO-ANYORD-${stamp.slice(-6)}R`;
const RUN = 9997;
const VIN_BASE = Number(stamp.slice(-5)) * 10 + 5;
let poIdRaw; let stickers = [];
const SKU_A = `E2E-ANYA-${stamp.slice(-6)}`;
const SKU_B = `E2E-ANYB-${stamp.slice(-6)}`;
// Twelve digits so they read as UPCs; the leading zero on U10 is the "printed with a
// zero, scanned without one" case.
const U9 = `9${stamp.slice(-11)}`;
const U10 = `0${stamp.slice(-11)}`;
let poId;

test.beforeAll(async () => {
  const po = (await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
     VALUES ($1, 'E2E AnyOrder Supplier', 'shipped', 1, 'box') RETURNING id`, [PO_CODE]))[0];
  poId = Number(po.id);
  const box = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`,
    [poId, `ANYORD${stamp}`]))[0];
  await q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, upc, entered_on_behalf) VALUES
       ($1, $2, $3, '9',  'Any Order Shoe A', 1, $4, true),
       ($1, $2, $3, '10', 'Any Order Shoe A', 2, $5, true),
       ($1, $2, $6, '8',  'Any Order Shoe B', 1, NULL, true)`,
    [poId, box.id, SKU_A, U9, U10, SKU_B]);
  // A second, identical order for the raw-1ID test — the first one's box is left open.
  const po2 = (await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
     VALUES ($1, 'E2E AnyOrder Supplier', 'shipped', 1, 'box') RETURNING id`, [PO_RAW]))[0];
  poIdRaw = Number(po2.id);
  const box2 = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`,
    [poIdRaw, `ANYORDR${stamp}`]))[0];
  await q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, upc, entered_on_behalf) VALUES
       ($1, $2, $3, '9',  'Any Order Shoe A', 1, $4, true),
       ($1, $2, $3, '10', 'Any Order Shoe A', 2, $5, true)`,
    [poIdRaw, box2.id, SKU_A, U9, U10]);
  const rows = await q(
    `INSERT INTO vin_stock (vin, run_id, printed_by)
     SELECT 'SBM-R-' || lpad(($2::bigint + g)::text, 6, '0'), $1, 'e2e'
     FROM generate_series(1, 2) g RETURNING vin`, [RUN, VIN_BASE]);
  stickers = rows.map((r) => r.vin).sort();
});

test.afterAll(async () => {
  for (const sku of [SKU_A, SKU_B]) {
    const items = await q('SELECT id FROM items WHERE sku = $1', [sku]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q('DELETE FROM items WHERE sku = $1', [sku]);
  }
  for (const id of [poId, poIdRaw]) {
    await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [id]);
    await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [id]);
    await q('DELETE FROM batches WHERE po_id = $1', [id]);
    await q('DELETE FROM po_lines WHERE po_id = $1', [id]);
    await q('DELETE FROM po_boxes WHERE po_id = $1', [id]);
    await q('DELETE FROM purchase_orders WHERE id = $1', [id]);
  }
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await pool.end();
});

const rowFor = (page, sku, size) => page.locator('.po-manifest-item', { hasText: sku }).locator('.po-manifest-size', { hasText: `size ${size}` });
const qtyOf = (row) => row.locator('input.qty');

test('the matching rule and the summary arithmetic (pure)', async () => {
  const { matchManifestRow, manifestSummary } = await import('../src/lib/manifestScan.js');
  const items = [
    { key: 1, expected: true, sku: 'DD1391-100', name: 'Dunk', sizes: [
      { key: 11, size: '9', upc: '00196604935555', qty: 0, expectedQty: 2 },
      { key: 12, size: '10', upc: '196604935562', qty: 0, expectedQty: 1 },
    ] },
    { key: 2, expected: true, sku: 'IH8223', name: 'Samba', sizes: [{ key: 21, size: '7.5', upc: '', qty: 0, expectedQty: 1 }] },
    { key: 3, code: 'ZZZ-1', sku: '', name: 'Stray', sizes: [{ key: 31, size: '8', qty: 1 }] },
    { key: 4, pending: true, sku: 'DD1391-100', sizes: [] },
  ];
  // UPC with/without leading zeros is the same barcode; SKU spelling is forgiven.
  expect(matchManifestRow(items, '196604935555')).toMatchObject({ by: 'upc', size: { size: '9' } });
  expect(matchManifestRow(items, 'ih8223')).toMatchObject({ by: 'sku', size: { size: '7.5' } });
  expect(matchManifestRow(items, 'DD1391 100')).toMatchObject({ by: 'ambiguous' });
  expect(matchManifestRow(items, 'DD1391 100').candidates.map((z) => z.size)).toEqual(['9', '10']);
  // An unexpected line is never a target; a pending one is never a target.
  expect(matchManifestRow(items, 'ZZZ-1')).toBeNull();
  // Once size 10 is full the style code has one open size.
  items[0].sizes[1].qty = 1;
  expect(matchManifestRow(items, 'DD1391-100')).toMatchObject({ by: 'sku', size: { size: '9' } });
  // Every size full → still ambiguous over all sizes (an extra pair is a real thing).
  items[0].sizes[0].qty = 2;
  expect(matchManifestRow(items, 'DD1391-100')).toMatchObject({ by: 'ambiguous' });

  items[0].sizes[0].qty = 3;          // over on 9
  items[1].sizes[0].qty = 0;          // missing 7.5
  const { rows, totals } = manifestSummary(items);
  expect(rows.map((r) => `${r.sku || '?'}:${r.size}:${r.state}:${r.delta}`)).toEqual([
    'IH8223:7.5:missing:-1', 'ZZZ-1:8:unexpected:1', 'DD1391-100:9:over:1', 'DD1391-100:10:ok:0',
  ]);
  // received is AGAINST the label: 2 (capped) + 1 + 0; the stray is extra.
  expect(totals).toEqual({ expected: 4, received: 3, missing: 1, extra: 2, rows: 4, clean: false });
});

test('the box is scanned in the order it comes out, and Review says what differs from the label', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('label:has-text("Buyer") input').fill('e2e');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.locator('.po-picker input').fill(PO_CODE);
  await page.locator('.po-picker').getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('.po-receive-banner')).toContainText(PO_CODE);
  await page.getByRole('button', { name: 'Add items' }).first().click();
  await expect(page.locator('.po-manifest')).toBeVisible();

  const bar = page.locator('.po-scan-bar');
  await expect(bar).toBeVisible();
  const scan = async (code) => {
    await bar.locator('input').fill(code);
    await bar.getByRole('button', { name: 'Add' }).click();
  };

  // Size 10 first, though the list shows 9 above it — and without its leading zero.
  await scan(U10.replace(/^0+/, ''));
  await expect(qtyOf(rowFor(page, SKU_A, '10'))).toHaveValue('1');
  await expect(qtyOf(rowFor(page, SKU_A, '9'))).toHaveValue('0');
  await expect(bar.locator('.scan-flash')).toContainText('1 of 2');

  // Shoe B by its style code: one open size, so it lands there without a hunt.
  await scan(SKU_B.toLowerCase());
  await expect(qtyOf(rowFor(page, SKU_B, '8'))).toHaveValue('1');

  // Shoe A by style code while BOTH its sizes are still open — the scan can't know
  // which pair this is, so it names them instead of guessing.
  await scan(SKU_A);
  await expect(bar.locator('.scan-flash')).toContainText(/sizes 9, 10/);
  await expect(qtyOf(rowFor(page, SKU_A, '9'))).toHaveValue('0');

  // Second size-10 pair, then a third: the third is over the label and says so.
  await scan(U10);
  await expect(qtyOf(rowFor(page, SKU_A, '10'))).toHaveValue('2');
  await scan(U10);
  await expect(qtyOf(rowFor(page, SKU_A, '10'))).toHaveValue('3');
  await expect(bar.locator('.scan-flash')).toContainText(/declared 2/);
  await expect(rowFor(page, SKU_A, '10').locator('.po-flag.over')).toHaveText('+1');
  // Undo steps that row back — the row stays, it was expected.
  await bar.getByRole('button', { name: /Undo last scan/ }).click();
  await expect(qtyOf(rowFor(page, SKU_A, '10'))).toHaveValue('2');

  // Now size 10 is full, so shoe A's style code has ONE open size left.
  await scan(SKU_A);
  await expect(qtyOf(rowFor(page, SKU_A, '9'))).toHaveValue('1');

  // A pair that is on no row: resolved through the catalogue like any rapid scan. The
  // lookup is stubbed to fail, which is the worst case — the line still lands, below
  // the sheet, typeable, flagged as not on the PO.
  await page.route('**/api/sku-search', (route) => route.fulfill({ status: 404, json: { ok: false, error: 'Not found' } }));
  await scan('E2E-STRAY-1');
  const stray = page.locator('.po-manifest-item.overage');
  await expect(stray).toHaveCount(1);
  await expect(stray).toContainText('Nothing found for');
  await expect(stray.locator('.po-chip')).toHaveText('Overage · not on PO');
  await expect(page.locator('.po-manifest-item').last()).toHaveClass(/overage/);   // below the sheet, not on top
  await stray.locator('input.cart-name').fill('Stray Pair');
  await stray.locator('.po-size-input').fill('11');
  await stray.locator('.po-size-input').blur();

  // Take shoe B back out (its pair went back in the wrong box, say): a row at 0 on
  // Review is a MISSING pair, said as one.
  await rowFor(page, SKU_B, '8').locator('input[type="checkbox"]').uncheck();

  await page.getByRole('button', { name: /Review →/ }).click();
  const sum = page.locator('.po-summary');
  await expect(sum).toBeVisible();
  await expect(sum).toContainText('3 of 4 expected pairs received');
  await expect(sum.locator('.po-summary-stat.bad')).toContainText('1 missing');
  await expect(sum.locator('.po-summary-stat.warn')).toContainText('1 extra / not on PO');
  const rows = sum.locator('.po-summary-row');
  await expect(rows).toHaveCount(2);                       // only what differs from the label
  await expect(rows.nth(0)).toHaveClass(/missing/);
  await expect(rows.nth(0)).toContainText(SKU_B);
  await expect(rows.nth(0).locator('.po-flag')).toHaveText('Missing');
  await expect(rows.nth(1)).toHaveClass(/unexpected/);
  await expect(rows.nth(1)).toContainText('E2E-STRAY-1');
  await expect(rows.nth(1).locator('.po-flag')).toHaveText('Not on PO');
});

test('in raw-1ID mode the sticker follows the pair just scanned, not the first row on the list', async ({ page }) => {
  await page.addInitScript(() => {
    const cur = JSON.parse(localStorage.getItem('sb_prefs') || '{}');
    localStorage.setItem('sb_prefs', JSON.stringify({ ...cur, rawVins: true }));
  });
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('label:has-text("Buyer") input').fill('e2e');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.locator('.po-picker input').fill(PO_RAW);
  await page.locator('.po-picker').getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('.po-receive-banner')).toContainText(PO_RAW);
  await page.getByRole('button', { name: 'Add items' }).first().click();
  await expect(page.locator('.po-manifest')).toBeVisible();

  const bar = page.locator('.po-scan-bar');
  const scan = async (code) => {
    await bar.locator('input').fill(code);
    await bar.getByRole('button', { name: 'Add' }).click();
  };

  // Size 10 comes out of the box first. Size 9 sits ABOVE it on the sheet — the old
  // rule ("first short row in display order") would have filed the sticker there.
  await scan(U10);
  await expect(qtyOf(rowFor(page, SKU_A, '10'))).toHaveValue('1');
  await expect(bar.locator('.rawvin-beat')).toContainText('size 10');
  await expect(rowFor(page, SKU_A, '10')).toHaveClass(/awaiting/);
  await scan(stickers[0]);
  await expect(rowFor(page, SKU_A, '10').locator('.po-flag.id')).toHaveText('1ID 1/1');
  await expect(rowFor(page, SKU_A, '9').locator('.po-flag.id')).toHaveCount(0);

  // Then a size 9 by hand-tick — the sticker follows the tick the same way.
  await rowFor(page, SKU_A, '9').locator('input[type="checkbox"]').check();
  await expect(rowFor(page, SKU_A, '9')).toHaveClass(/awaiting/);
  await scan(stickers[1]);
  await expect(rowFor(page, SKU_A, '9').locator('.po-flag.id')).toHaveText('1ID 1/1');
  await expect(bar.locator('.rawvin-beat')).toContainText('Every pair has its 1ID');
});
