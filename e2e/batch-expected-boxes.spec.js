// Correcting a batch's "boxes expected" — the 130 typed at Step 1 for a 30-box shipment.
//
// Lowering the count removes the EMPTY pending slots above it, and never anything that
// holds something (pairs, a tracking number, a PO label). A box with something in it
// numbered above the new count is refused by name, so it gets renumbered first.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const auth = (role = 'warehouse') => ({
  Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}`,
});

const SUPPLIER = 'E2E Expected-Boxes Supplier';
let batchId = null;
let batchCode = null;
const boxCount = async () => Number((await q('SELECT count(*) FROM batch_boxes WHERE batch_id = $1', [batchId]))[0].count);
const setExpected = (request, expectedBoxes, role) =>
  request.post('/api/batches/set-expected', { headers: auth(role), data: { batchId, expectedBoxes } });

// An open batch that says 130 boxes, with all 130 slots materialized: boxes 1 and 2
// have tracking typed in, box 40 too (the one that blocks), the rest are empty.
test.beforeAll(async ({ request }) => {
  await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE supplier_name = $1)', [SUPPLIER]);
  await q('DELETE FROM batches WHERE supplier_name = $1', [SUPPLIER]);
  const created = await request.post('/api/batches/create-open', {
    headers: auth(),
    data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, dateReceived: '2026-11-13', expectedBoxes: 130 } },
  });
  expect(created.status()).toBe(200);
  ({ id: batchId, batchCode } = await created.json());
  const tracked = new Set([1, 2, 40]);
  const synced = await request.post('/api/batches/sync-boxes', {
    headers: auth(),
    data: { batchId, boxes: Array.from({ length: 130 }, (_, i) => i + 1).map((n) => ({ boxNumber: n, trackingNumber: tracked.has(n) ? `E2E-EXP-${n}` : '' })) },
  });
  expect(synced.status()).toBe(200);
  expect(await boxCount()).toBe(130);
});

test.afterAll(async () => {
  await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE supplier_name = $1)', [SUPPLIER]);
  await q('DELETE FROM batches WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

test('a box with something in it above the new count is refused by name, nothing changes', async ({ request }) => {
  const r = await setExpected(request, 30);
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toContain('Box 40');
  expect(await boxCount()).toBe(130);
  expect((await q('SELECT expected_boxes FROM batches WHERE id = $1', [batchId]))[0].expected_boxes).toBe(130);
});

test('only warehouse/admin can change it', async ({ request }) => {
  const r = await setExpected(request, 30, 'ph_team');
  expect(r.status()).toBe(403);
});

test('130 → 30 removes the 100 empty slots above 30 and keeps the tracked ones', async ({ request }) => {
  // Box 40 was the mistake: its tracking really belongs on box 3.
  await request.post('/api/batches/sync-boxes', { headers: auth(), data: { batchId, boxes: [{ boxNumber: 40, trackingNumber: '' }, { boxNumber: 3, trackingNumber: 'E2E-EXP-40' }] } });
  const r = await setExpected(request, 30);
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body).toMatchObject({ from: 130, to: 30, removed: 100 });
  expect(await boxCount()).toBe(30);
  const kept = await q("SELECT box_number FROM batch_boxes WHERE batch_id = $1 AND coalesce(tracking_number,'') <> '' ORDER BY box_number", [batchId]);
  expect(kept.map((x) => x.box_number)).toEqual([1, 2, 3]);
});

test('it can never go below the boxes that hold something', async ({ request }) => {
  const r = await setExpected(request, 2);
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toContain("can't expect fewer than 3");
  expect(await boxCount()).toBe(30);
});

test('the pencil on the Batch page changes it', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await page.locator('.batch-nav-row').filter({ hasText: batchCode }).first().click();
  await expect(page.locator('.batch-page-code')).toContainText(batchCode);
  await expect(page.locator('.batch-progress')).toContainText('0/30');
  await page.getByRole('button', { name: 'Change how many boxes this batch expects' }).click();
  await page.getByLabel('Boxes expected').fill('31');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.batch-progress')).toContainText('0/31');
  await expect(page.locator('.notice')).toContainText('Boxes expected: 30 → 31.');
});
