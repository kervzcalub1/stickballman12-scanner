// Where a pair came from — batch, parcel, and whether it was received against a PO.
// (2026-08-28)
//
// The three identifiers people chase a pair by, none of which its history could answer.
// The trap it must not fall into is the loose case: the ordinary receive keeps tracking
// on the BATCH and leaves items.box_id NULL, while a multi-box batch has a different
// number per box — reading the batch's number for a boxed pair names the wrong parcel.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const BOX_TRACK = `1ZPROVBOX${stamp}`;
const BATCH_TRACK = `1ZPROVBATCH${stamp}`;
// Real VIN shape (SBM-YYMMDD-######) on purpose: the Inventory box only opens a detail
// for something that looks like one, and treats anything else as a keyword search. A
// made-up shape would have tested a path no scanner can reach.
const seq = stamp.slice(-5);
const VIN_BOXED = `SBM-260828-1${seq}`;
const VIN_LOOSE = `SBM-260828-2${seq}`;
const VIN_NOPO = `SBM-260828-3${seq}`;
let poId = null; let poCode = null; let boxedBatch = null; let looseBatch = null; let noPoBatch = null;

test.beforeAll(async () => {
  poCode = `PO-PROV-${stamp}`;
  poId = Number((await q(
    `INSERT INTO purchase_orders (po_code, status, supplier_name) VALUES ($1,'receiving','E2E Prov') RETURNING id`,
    [poCode]))[0].id);
  await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, kind)
           VALUES ($1,1,$2,'delivered','original'), ($1,2,$3,'delivered','original')`,
    [poId, BOX_TRACK, BATCH_TRACK]);

  // (a) a pair inside a BOX of a multi-box batch received against the order
  boxedBatch = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, po_id, po_link_source, po_linked_at, tracking_number)
     VALUES ($1,'open','receiving',$2,'receiving',now(),$3) RETURNING id`,
    [`B-PVB-${stamp}`, poId, BATCH_TRACK]))[0].id);
  const boxId = Number((await q(
    `INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1,1,$2,'received') RETURNING id`,
    [boxedBatch, BOX_TRACK]))[0].id);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,$3,'Prov Boxed','PV-1111-100','9','needs_shelf')`, [VIN_BOXED, boxedBatch, boxId]);

  // (b) a LOOSE pair: tracking on the batch, no box row — linked to the order afterwards
  looseBatch = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, po_id, po_link_source, po_linked_at, po_linked_by, tracking_number)
     VALUES ($1,'committed','receiving',$2,'linked',now(),'Super Admin',$3) RETURNING id`,
    [`B-PVL-${stamp}`, poId, BATCH_TRACK]))[0].id);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,NULL,'Prov Loose','PV-2222-200','10','needs_shelf')`, [VIN_LOOSE, looseBatch]);

  // (c) a pair from a batch with no order at all
  noPoBatch = Number((await q(
    `INSERT INTO batches (batch_code, status, kind) VALUES ($1,'committed','receiving') RETURNING id`,
    [`B-PVN-${stamp}`]))[0].id);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,NULL,'Prov NoPO','PV-3333-300','11','needs_shelf')`, [VIN_NOPO, noPoBatch]);
});

test.afterAll(async () => {
  for (const id of [boxedBatch, looseBatch, noPoBatch]) {
    const items = await q('SELECT id FROM items WHERE batch_id = $1', [id]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q('DELETE FROM items WHERE batch_id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
  await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  await pool.end();
});

test('a boxed pair reports ITS OWN box tracking number, not the batch’s', async () => {
  const { provenanceForVins } = await import('../api/_lib/db.js');
  const [p] = await provenanceForVins([VIN_BOXED]);
  expect(p.against_po).toBe(true);
  expect(p.po_code).toBe(poCode);
  expect(p.tracking).toBe(BOX_TRACK);        // the parcel it actually arrived in
  expect(p.tracking).not.toBe(BATCH_TRACK);  // the trap
  expect(p.po_label_number).toBe(1);         // matched to the label by that number
  expect(p.link_source).toBe('receiving');
});

test('a loose pair falls back to the batch’s tracking, and says it was linked afterwards', async () => {
  const { provenanceForVins } = await import('../api/_lib/db.js');
  const [p] = await provenanceForVins([VIN_LOOSE]);
  expect(p.against_po).toBe(true);
  expect(p.tracking).toBe(BATCH_TRACK);
  expect(p.box_number).toBeNull();
  expect(p.po_label_number).toBe(2);
  expect(p.link_source).toBe('linked');
  expect(p.linked_by).toBe('Super Admin');
});

test('a pair from no order says so outright rather than leaving a blank', async () => {
  const { provenanceForVins } = await import('../api/_lib/db.js');
  const [p] = await provenanceForVins([VIN_NOPO]);
  expect(p.against_po).toBe(false);
  expect(p.po_code).toBeNull();
  expect(p.batch_code).toBe(`B-PVN-${stamp}`);
});

test('the pair detail shows PO, batch and tracking — warehouse', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(VIN_BOXED);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const prov = page.locator('.prov');
  await expect(prov).toContainText(poCode);
  await expect(prov).toContainText(`B-PVB-${stamp}`);
  await expect(prov).toContainText(BOX_TRACK);
});

test('the SAME block is on the PH team’s /ph/inventory', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/inventory');
  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(VIN_LOOSE);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const prov = page.locator('.prov');
  await expect(prov).toContainText(poCode);
  await expect(prov).toContainText(BATCH_TRACK);
  await expect(prov).toContainText('attached to the order afterwards');
});

test('a pair with no order says it plainly on the detail', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(VIN_NOPO);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.locator('.prov')).toContainText('Not received against a purchase order');
});

test('the batch page says whether the shipment came in against an order', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${boxedBatch}`);
  await expect(page.locator('.batch-po')).toContainText(poCode);
  await page.goto(`/batches?b=${noPoBatch}`);
  await expect(page.locator('.batch-po')).toContainText('Not received against a purchase order');
});
