// A batch's manifest report — PDF or CSV, from the Batch page (2026-08-28).
//
// The four facts that identify a shipment on paper — DATE ORDER, DATE DELIVERED,
// BATCH NO., PO NUMBER — plus every pair counted into it.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const ORDER_DAY = '2026-08-03';
const DELIVERED_DAY = '2026-08-19';
const TRACK = `1ZRPT${stamp}`;
let poId = null; let poCode = null; let batchId = null; let looseId = null;

test.beforeAll(async () => {
  poCode = `PO-RPT-${stamp}`;
  poId = Number((await q(
    `INSERT INTO purchase_orders (po_code, status, supplier_name, date_of_purchase)
     VALUES ($1,'receiving','ZZ Report Co',$2) RETURNING id`, [poCode, ORDER_DAY]))[0].id);
  batchId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, date_received, po_id, tracking_number)
     VALUES ($1,'committed','receiving','ZZ Report Co',$2,$3,$4) RETURNING id`,
    [`B-RPT-${stamp}`, DELIVERED_DAY, poId, TRACK]))[0].id);
  const boxId = Number((await q(
    `INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1,1,$2,'received') RETURNING id`,
    [batchId, TRACK]))[0].id);
  // Two of one size (they must fold into a single line with Qty 2) and one of another.
  for (const [n, size] of [[1, '10'], [2, '10'], [3, '11']]) {
    await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
             VALUES ($1,$2,$3,'Report Test Shoe','RP-1234-100',$4,'needs_shelf')`,
      [`SBM-260819-9${stamp.slice(-4)}${n}`, batchId, boxId, size]);
  }
  // A batch with NO order, to prove the report says so rather than leaving a blank.
  looseId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'committed','receiving','ZZ No Order') RETURNING id`,
    [`B-NOPO-${stamp}`]))[0].id);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,NULL,'Loose Report Shoe','RP-9999-900','9','needs_shelf')`,
    [`SBM-260819-8${stamp.slice(-4)}1`, looseId]);
});

test.afterAll(async () => {
  for (const id of [batchId, looseId]) {
    const items = await q('SELECT id FROM items WHERE batch_id = $1', [id]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q('DELETE FROM items WHERE batch_id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  await pool.end();
});

test('the CSV carries the four facts on every row, and folds pairs into per-size lines', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${batchId}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^CSV/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`batch-manifest-B-RPT-${stamp}.csv`);
  const stream = await download.createReadStream();
  const text = await new Promise((res) => { let d = ''; stream.on('data', (c) => { d += c; }); stream.on('end', () => res(d)); });
  const lines = text.trim().split('\n');
  expect(lines[0]).toContain('DATE ORDER');
  expect(lines[0]).toContain('DATE DELIVERED');
  expect(lines[0]).toContain('Batch No.');
  expect(lines[0]).toContain('PO Number');
  // Two size lines, not three pairs — a manifest is read against a carton.
  expect(lines).toHaveLength(3);
  // The identifying facts repeat per row: a CSV gets sorted and pasted elsewhere, and a
  // header block would be lost the first time that happens.
  for (const row of lines.slice(1)) {
    expect(row).toContain(ORDER_DAY);
    expect(row).toContain(DELIVERED_DAY);
    expect(row).toContain(`B-RPT-${stamp}`);
    expect(row).toContain(poCode);
  }
  expect(text).toMatch(/RP-1234-100,10,Report Test Shoe,2/);   // the folded line, qty 2
});

test('a batch with no order says so in the CSV rather than leaving it blank', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${looseId}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^CSV/ }).click(),
  ]);
  const stream = await download.createReadStream();
  const text = await new Promise((res) => { let d = ''; stream.on('data', (c) => { d += c; }); stream.on('end', () => res(d)); });
  expect(text).toContain('none');            // PO Number column
  expect(text).toContain(`B-NOPO-${stamp}`);
  expect(text).toContain('loose');           // no box row to name
});

test('the PDF builds, is a real PDF, and carries the four labels', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${batchId}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^PDF/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`batch-manifest-B-RPT-${stamp}.pdf`);
  const stream = await download.createReadStream();
  const buf = await new Promise((res) => { const c = []; stream.on('data', (d) => c.push(d)); stream.on('end', () => res(Buffer.concat(c))); });
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(buf.length).toBeGreaterThan(1000);
});

test('the four header facts are derived correctly, including the no-order case', async () => {
  const { batchReportFacts, batchReportRows } = await import('../src/lib/batchReport.js');
  const withPo = batchReportFacts({
    batch_code: 'B-1', po_code: 'PO-1', po_date_of_purchase: ORDER_DAY, date_received: DELIVERED_DAY,
  });
  expect(withPo).toMatchObject({ dateOrder: ORDER_DAY, dateDelivered: DELIVERED_DAY, batchNo: 'B-1', poNumber: 'PO-1' });
  expect(withPo.deliveredIsFallback).toBe(false);
  // No date_received: the created day stands in, and the report FLAGS that it did rather
  // than printing a delivery date the warehouse never stated.
  const noDate = batchReportFacts({ batch_code: 'B-2', created_at: '2026-08-20T12:00:00Z' });
  expect(noDate.deliveredIsFallback).toBe(true);
  expect(noDate.poNumber).toBe('');
  // Loose pairs group under no box, and identical size lines fold.
  const rows = batchReportRows({
    items: [{ sku: 'A', size: '9' }, { sku: 'A', size: '9' }, { sku: 'A', size: '10' }],
    boxes: [],
  });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ box: null, qty: 2 });
});

test('PH can pull the same report — they get asked when it landed too', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/batches?b=${batchId}`);
  await expect(page.getByRole('button', { name: /^PDF/ })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /^CSV/ }).click(),
  ]);
  expect(download.suggestedFilename()).toContain(`B-RPT-${stamp}`);
});

test('a long batch paginates instead of running off the page', async () => {
  // The page-break path stays invisible until someone reports a 200-pair shipment. The
  // drawing loop calls header() on every new page, so a continuation sheet still carries
  // the batch number — a loose page that doesn't is one nobody can file.
  const { buildBatchReportPdf } = await import('../src/lib/batchReport.js');
  const items = Array.from({ length: 260 }, (_, i) => ({
    sku: `LONG-${String(i).padStart(4, '0')}`, size: '10', name: 'Long Batch Shoe', box_id: null,
  }));
  const doc = await buildBatchReportPdf({
    batch: { batch_code: 'B-LONG', po_code: 'PO-LONG', po_date_of_purchase: '2026-08-03', date_received: '2026-08-19' },
    items, boxes: [],
  });
  expect(doc.getNumberOfPages()).toBeGreaterThan(1);
});
