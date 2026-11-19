// Costs → Upload filled CSV (2026-11-20): the export, with "Cost per pair" filled in, comes
// back and fills the backlog in bulk. What has to hold:
//   · the export is one row per SKU PER SUPPLIER, and the upload maps a cost by that
//     Supplier column: the same shoe from two suppliers gets two different costs;
//   · the preview writes nothing; Fill writes the cost + a history note on each pair;
//   · only blank costs are filled (a cost on file is never overwritten), and only pairs
//     inside the filters on screen;
//   · an empty cost cell is left alone; a bad amount / $0 is left out and named.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { readCostImport } from '../src/lib/costs.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SKU_A = `E2E-CI-${stamp}-100`;
const SKU_B = `E2E-CI-${stamp}-200`;
const SKU_C = `E2E-CI-${stamp}-300`;
const SUP_A = `E2E CI Alpha ${stamp}`;
const SUP_B = `E2E CI Beta ${stamp}`;
const vin = (n) => `SBM-E2ECI-${stamp}${n}`;
const WH = { Authorization: `Bearer ${signToken({ uid: 'e2e-ci', username: 'e2e_ci', name: 'E2E CI Brent', role: 'warehouse' })}` };
let batchIds = []; let today;
const costOf = async (n) => (await q('SELECT cost FROM items WHERE vin = $1', [vin(n)]))[0].cost;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  [{ today }] = await q(`SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS today`);
  const mk = async (code, sup) => Number((await q(
    `INSERT INTO batches (batch_code, supplier_name, status, kind, date_received)
     VALUES ($1, $2, 'committed', 'receiving', current_date) RETURNING id`, [code, sup]))[0].id);
  const a = await mk(`B-E2ECI1-${stamp}`, SUP_A);
  const b = await mk(`B-E2ECI2-${stamp}`, SUP_B);
  batchIds = [a, b];
  await q(`INSERT INTO items (vin, batch_id, sku, size, name, status, cost, created_at) VALUES
             ($1, $8, $10, '9',  'E2E CI Runner', 'in_stock', NULL, now()),
             ($2, $8, $10, '10', 'E2E CI Runner', 'in_stock', NULL, now()),
             ($3, $9, $10, '9',  'E2E CI Runner', 'in_stock', NULL, now()),
             ($4, $8, $10, '11', 'E2E CI Runner', 'in_stock', 80,   now()),
             ($5, $8, $11, '8',  'E2E CI Other',  'in_stock', NULL, now()),
             ($6, $9, $12, '8',  'E2E CI Third',  'in_stock', NULL, now()),
             ($7, $8, $10, '12', 'E2E CI Runner', 'in_stock', NULL, now() - interval '40 days')`,
  [vin(1), vin(2), vin(3), vin(4), vin(5), vin(6), vin(7), a, b, SKU_A, SKU_B, SKU_C]);
});

test.afterAll(async () => {
  const skus = [SKU_A, SKU_B, SKU_C];
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = ANY($1))', [skus]);
  await q('DELETE FROM items WHERE sku = ANY($1)', [skus]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [batchIds]);
  await pool.end();
});

test('the file reader: columns, blanks, bad amounts, a SKU twice', () => {
  expect(readCostImport('a,b\n1,2').error).toMatch(/SKU.*Cost per pair/);
  const r = readCostImport('﻿SKU,Name,Supplier,Cost per pair\r\nAB-1,"Shoe, red",Sunny,$95.50\r\nAB-2,x,Sunny,\r\nAB-3,x,Sunny,abc\r\nAB-4,x,Sunny,0\r\nAB-1,x,Kim,"1,020"\r\nAB-5,x,Sunny,10\r\nab 5,x,sunny,11\r\n');
  expect(r.bySupplier).toBe(true);
  expect(r.rows).toEqual([{ sku: 'AB-1', supplier: 'Sunny', cost: 95.5 }, { sku: 'AB-1', supplier: 'Kim', cost: 1020 }]);
  expect(r.blank).toBe(1);
  expect(r.skipped.map((s) => s.sku)).toEqual(['AB-3', 'AB-4', 'AB-5']);
  // Excel in some regions saves with semicolons.
  expect(readCostImport('SKU;Cost per pair\nAB-1;12').rows).toEqual([{ sku: 'AB-1', supplier: '', cost: 12 }]);
});

test('export, fill in, upload: each supplier’s pairs get their own cost', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/costs?cf=${today}`);
  await expect(page.locator('.cost-range-on')).toBeVisible();

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export CSV/ }).click()]);
  const lines = fs.readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split('\r\n');
  // The same SKU from two suppliers is two rows.
  const mine = lines.filter((l) => l.includes(`E2E-CI-${stamp}`));
  expect(mine.filter((l) => l.startsWith(SKU_A))).toHaveLength(2);

  // Fill the last column: Alpha's SKU_A = 100, Beta's SKU_A = 120, SKU_B left empty, SKU_C a typo.
  const filled = [lines[0], ...mine.map((l) => {
    const base = l.replace(/,$/, '');
    if (l.startsWith(SKU_A)) return `${base},${l.includes(SUP_A) ? '100' : '$120.00'}`;
    if (l.startsWith(SKU_C)) return `${base},n/a`;
    return `${base},`;
  })].join('\r\n');
  const file = path.join(os.tmpdir(), `e2e-costs-import-${stamp}.csv`);
  fs.writeFileSync(file, filled);

  await page.getByLabel('Filled CSV file').setInputFiles(file);
  const preview = page.getByRole('region', { name: 'Upload preview' });
  await expect(preview).toContainText('3 pairs across 1 SKU');
  await expect(preview).toContainText(`${SKU_A} · ${SUP_A} · $100.00 · 2 pairs`);
  await expect(preview).toContainText(`${SKU_A} · ${SUP_B} · $120.00 · 1 pair`);
  await expect(preview).toContainText('1 row left out');
  await expect(preview).toContainText('1 row with the cost still empty');
  expect(await costOf(1)).toBeNull();                       // the preview wrote nothing

  await preview.getByRole('button', { name: 'Fill 3 pairs' }).click();
  await expect(page.locator('.ok')).toContainText('Filled 3 pairs across 1 SKU');
  expect(Number(await costOf(1))).toBe(100);
  expect(Number(await costOf(2))).toBe(100);
  expect(Number(await costOf(3))).toBe(120);                 // the other supplier's own cost
  expect(Number(await costOf(4))).toBe(80);                  // a cost on file is not touched
  expect(await costOf(5)).toBeNull();                        // empty cell: left alone
  expect(await costOf(6)).toBeNull();                        // "n/a": left out
  expect(await costOf(7)).toBeNull();                        // received before the From date: outside the filter
  const [ev] = await q(`SELECT e.details->>'text' AS text, e.created_by FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.vin = $1 AND e.type = 'note'`, [vin(3)]);
  expect(ev.text).toBe('Cost set to $120.00 (CSV upload)');
  fs.unlinkSync(file);
});

test('the endpoint: preview writes nothing, no Supplier column fills whoever it came from, suppliers refused', async ({ request }) => {
  const body = { rows: [{ sku: SKU_A.toLowerCase().replace(/-/g, ' '), cost: 77 }, { sku: 'E2E-CI-NOPE', cost: 5 }] };
  let r = await (await request.post('/api/items/cost-import', { headers: WH, data: body })).json();
  expect(r).toMatchObject({ ok: true, applied: false, pairs: 1, skus: 1 });   // only the 40-day-old pair is still blank
  expect(r.unmatched).toEqual([{ sku: 'E2E-CI-NOPE', supplier: '' }]);
  expect(await costOf(7)).toBeNull();
  r = await (await request.post('/api/items/cost-import', { headers: WH, data: { ...body, apply: true } })).json();
  expect(r).toMatchObject({ applied: true, pairs: 1 });
  expect(Number(await costOf(7))).toBe(77);
  expect(Number(await costOf(1))).toBe(100);                 // already costed: not overwritten
  // The same again fills nothing.
  r = await (await request.post('/api/items/cost-import', { headers: WH, data: { ...body, apply: true } })).json();
  expect(r.pairs).toBe(0);
  const sup = { Authorization: `Bearer ${signToken({ uid: 'e2e-ci-s', username: 'e2e_ci_s', name: 'S', role: 'supplier' })}` };
  expect((await request.post('/api/items/cost-import', { headers: sup, data: body })).status()).toBe(403);
  expect((await request.post('/api/items/cost-import', { headers: WH, data: { rows: [{ sku: SKU_B, cost: 0 }] } })).status()).toBe(400);
});
