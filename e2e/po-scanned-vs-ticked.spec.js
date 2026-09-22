// A tick and a scan write the same number — and they are not the same claim (2026-09-23).
//
// Asked from the floor: "so scanning them will mark them as check? isn't it a bit
// confusing?" It was, in three specific ways, and all three matter because the reason to
// check a PO box against its label at all is to VERIFY it:
//   · the tick was checked as soon as anything landed (`got > 0`), so a row scanned once
//     of an expected two looked done while its own "short 1" flag said otherwise;
//   · ticking claims a whole row in one tap, and afterwards looked identical to pairs
//     that were each scanned in somebody's hand;
//   · un-ticking silently zeroed the row, scanned pairs and all.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const PO_CODE = `PO-PROV-${stamp.slice(-5)}`;
const SKU = `E2E-PROV-${stamp}`;
const UPC = `6${stamp}001`.slice(0, 12);
let poId;

test.beforeAll(async () => {
  poId = Number((await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
     VALUES ($1,'E2E Prov Supplier','shipped',1,'box') RETURNING id`, [PO_CODE]))[0].id);
  const box = (await q(`INSERT INTO po_boxes (po_id,box_number,tracking_number,status) VALUES ($1,1,$2,'shipped') RETURNING id`, [poId, `PROV${stamp}`]))[0];
  await q(`INSERT INTO po_lines (po_id,po_box_id,sku,size,name,qty_expected,upc,entered_on_behalf) VALUES
             ($1,$2,$3,'9','Provenance Shoe',2,$4,true),
             ($1,$2,$3,'10','Provenance Shoe',1,NULL,true)`, [poId, box.id, SKU, UPC]);
});

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
  await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [poId]);
  await q('DELETE FROM batches WHERE po_id = $1', [poId]);
  await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
  await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
  await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  await pool.end();
});

const rowFor = (page, size) => page.locator('.po-manifest-item', { hasText: SKU }).locator('.po-manifest-size', { hasText: `size ${size}` });

test('a scanned row and a ticked row say which they are, and the tick means DONE', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('label:has-text("Buyer") input').fill('e2e');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.locator('.po-picker input').fill(PO_CODE);
  await page.locator('.po-picker').getByRole('button', { name: 'Find' }).click();
  await page.getByRole('button', { name: 'Add items' }).first().click();

  const bar = page.locator('.po-scan-bar');
  const scan = async (code) => {
    await bar.locator('input').fill(code);
    await bar.getByRole('button', { name: 'Add', exact: true }).click();
  };
  const nine = rowFor(page, '9');
  const ten = rowFor(page, '10');
  const box9 = nine.locator('input[type="checkbox"]');

  // One of an expected two. The row is NOT done, and the tick must not claim it is.
  await scan(UPC);
  await expect(nine.locator('input.qty')).toHaveValue('1');
  await expect(box9).not.toBeChecked();
  expect(await box9.evaluate((el) => el.indeterminate)).toBe(true);
  await expect(nine.locator('.po-flag.short')).toHaveText('short 1');
  await expect(nine.locator('.po-flag.scanned')).toHaveText('1 scanned');
  await expect(nine.locator('.po-flag.byhand')).toHaveCount(0);

  // The second one, scanned: now the row is done and the tick says so.
  await scan(UPC);
  await expect(box9).toBeChecked();
  expect(await box9.evaluate((el) => el.indeterminate)).toBe(false);
  await expect(nine.locator('.po-flag.scanned')).toHaveText('2 scanned');

  // Size 10 has no barcode on the manifest — ticked by hand, and it says so rather than
  // looking like the two pairs that were read off a box.
  await ten.locator('input[type="checkbox"]').check();
  await expect(ten.locator('input.qty')).toHaveValue('1');
  await expect(ten.locator('.po-flag.byhand')).toHaveText('1 by hand');
  await expect(ten.locator('.po-flag.scanned')).toHaveCount(0);

  // A third pair on size 9: scanned two, one by hand, and both are named.
  await nine.getByRole('button', { name: '+' }).click();
  await expect(nine.locator('.po-flag.scanned')).toHaveText('2 scanned');
  await expect(nine.locator('.po-flag.byhand')).toHaveText('+1 by hand');
  await nine.getByRole('button', { name: '−' }).click();

  // Clearing a row that holds scanned pairs asks first.
  await box9.click();
  await expect(page.locator('.modal')).toContainText(/2 pairs were scanned/);
  await page.getByRole('button', { name: 'Keep the count' }).click();
  await expect(nine.locator('input.qty')).toHaveValue('2');

  // Review carries the distinction through to whoever reads the count.
  await page.getByRole('button', { name: 'Review →' }).click();
  const how = page.locator('.po-summary-how');
  await expect(how).toContainText('2 scanned');
  await expect(how).toContainText('1 counted by hand');
  await expect(how).toContainText(`${SKU} size 10`);
});
