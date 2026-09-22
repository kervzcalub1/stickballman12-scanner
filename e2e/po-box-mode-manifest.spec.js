// Box 2 of a PO-linked batch gets the supplier's list too (2026-09-23).
//
// Reported from the floor: "Brent created a batch, received it against a PO, the PO has
// a manifest. He did box 1 — checked all items, committed. Went to the home page and
// proceeded to box 2. Box 2 doesn't have the items listed, unlike box 1."
//
// Box mode — the way any box that arrives after the rest is received, from the Batch
// page — was deliberately NOT PO mode (`isPoReceive = receivingPo && !isBoxMode`). The
// commit still reconciled server-side, so nothing was lost; what was missing was the one
// thing the person holding the carton needs: the list to check it against. Same order,
// same label, same manifest — the only difference was which screen it was reached from.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const wh = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` };

const stamp = `${Date.now()}`.slice(-8);
const PO_CODE = `PO-BOXMODE-${stamp.slice(-5)}`;
const SKU1 = `E2E-BM1-${stamp}`;   // on label 1 only
const SKU2 = `E2E-BM2-${stamp}`;   // on label 2 only
const UPC2 = `7${stamp}001`.slice(0, 12);
const TRACK2 = `BOXMODE2${stamp}`;
let poId; let batchId; let box2Id;

test.beforeAll(async () => {
  poId = Number((await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
     VALUES ($1,'E2E BoxMode Supplier','shipped',2,'box') RETURNING id`, [PO_CODE]))[0].id);
  const l1 = (await q(`INSERT INTO po_boxes (po_id,box_number,tracking_number,status) VALUES ($1,1,$2,'shipped') RETURNING id`, [poId, `BOXMODE1${stamp}`]))[0];
  const l2 = (await q(`INSERT INTO po_boxes (po_id,box_number,tracking_number,status) VALUES ($1,2,$2,'shipped') RETURNING id`, [poId, TRACK2]))[0];
  await q(`INSERT INTO po_lines (po_id,po_box_id,sku,size,name,qty_expected,entered_on_behalf) VALUES ($1,$2,$3,'9','BoxMode Shoe One',1,true)`, [poId, l1.id, SKU1]);
  await q(`INSERT INTO po_lines (po_id,po_box_id,sku,size,name,qty_expected,upc,entered_on_behalf) VALUES
             ($1,$2,$3,'10','BoxMode Shoe Two',2,$4,true),
             ($1,$2,$3,'11','BoxMode Shoe Two',1,NULL,true)`, [poId, l2.id, SKU2, UPC2]);

  // The batch as it stands after box 1: linked to the PO, box 1 received, box 2 recorded
  // with its tracking but not yet scanned — which is exactly the row the Batch page
  // offers "Add items" on.
  batchId = Number((await q(
    `INSERT INTO batches (batch_code,status,kind,supplier_name,po_id,po_link_source,expected_boxes)
     VALUES ($1,'open','receiving','E2E BoxMode Supplier',$2,'receiving',2) RETURNING id`,
    [`B-BOXMODE-${stamp}`, poId]))[0].id);
  await q(`UPDATE purchase_orders SET received_batch_id = $1, status = 'receiving' WHERE id = $2`, [batchId, poId]);
  const b1 = (await q(`INSERT INTO batch_boxes (batch_id,box_number,tracking_number,status) VALUES ($1,1,$2,'received') RETURNING id`, [batchId, `BOXMODE1${stamp}`]))[0];
  await q(`INSERT INTO items (vin,batch_id,box_id,name,sku,size,status) VALUES ($1,$2,$3,'BoxMode Shoe One',$4,'9','needs_shelf')`,
    [`SBM-666666-${stamp}1`, batchId, b1.id, SKU1]);
  box2Id = Number((await q(`INSERT INTO batch_boxes (batch_id,box_number,tracking_number,status) VALUES ($1,2,$2,'pending') RETURNING id`, [batchId, TRACK2]))[0].id);
});

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE batch_id = $1', [batchId]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE batch_id = $1', [batchId]);
  await q('DELETE FROM batch_boxes WHERE batch_id = $1', [batchId]);
  await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [poId]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
  await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
  await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  await pool.end();
});

test('continuing box 2 from the Batch page shows THAT label’s manifest, and scans onto it', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${batchId}`);
  const row2 = page.locator('.box-row-wrap').filter({ hasText: 'Box 2' });
  await row2.getByRole('button', { name: 'Add items' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();

  // The list the carton is checked against — box 2's, not box 1's.
  const sheet = page.locator('.po-manifest');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(SKU2);
  await expect(sheet).not.toContainText(SKU1);
  await expect(sheet).toContainText('size 10');
  await expect(sheet).toContainText('size 11');

  // And the scan bar that makes it a scoreboard rather than a form: the pair in hand
  // goes up on its own row, in whatever order the box comes out.
  const bar = page.locator('.po-scan-bar');
  await expect(bar).toBeVisible();
  const rowFor = (sku, size) => page.locator('.po-manifest-item', { hasText: sku }).locator('.po-manifest-size', { hasText: `size ${size}` });
  await bar.locator('input').fill(UPC2);
  await bar.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(rowFor(SKU2, '10').locator('input.qty')).toHaveValue('1');
  await expect(rowFor(SKU2, '11').locator('input.qty')).toHaveValue('0');

  // Committing the box still files the pairs under box 2 of this batch.
  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: /Submit box/i }).click();
  await page.getByRole('button', { name: /Yes, (commit|submit)/i }).click();
  await expect(page.locator('.modal')).toContainText(/saved|received/i, { timeout: 15_000 });
  const got = await q('SELECT sku, size, box_id FROM items WHERE batch_id = $1 AND sku = $2', [batchId, SKU2]);
  expect(got).toHaveLength(1);
  expect(Number(got[0].box_id)).toBe(box2Id);
  expect(got[0].size).toBe('10');
});
