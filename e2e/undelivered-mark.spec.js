// Undelivered Tracking → "Mark delivered" by hand (docs/context/undelivered.md).
//
// Reported live: 17TRACK sat on "No update yet" for a UPS label whose own page showed
// Delivered (with a photo). Whoever checked the courier's page marks it delivered: the
// number leaves the list, reads Delivered on the PO side, a later lagging push can't put
// "Not found" back over it, and Undo restores every row exactly.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const WH = { Authorization: `Bearer ${signToken({ uid: 'e2e-und-wh', username: 'e2e_und_wh', name: 'E2E Und Warehouse', role: 'warehouse' })}` };
const SUP = { Authorization: `Bearer ${signToken({ uid: 'e2e-und-sup', username: 'e2e_und_sup', name: 'E2E Und Supplier', role: 'supplier' })}` };
const SUPPLIER = 'E2E Undelivered Supplier';

test.afterAll(async () => {
  await q(`DELETE FROM shipment_tracking WHERE tracking_number LIKE 'E2EUND%'`);
  await q(`DELETE FROM online_orders WHERE store = 'E2E-UND Store'`);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

const list = async (request) => (await (await request.get('/api/undelivered?days=all', { headers: WH })).json());
const mark = (request, data, headers = WH) => request.post('/api/undelivered/mark', { headers, data });

test('a PO label marked delivered by hand leaves the list, reads Delivered, survives a lagging push, and Undo restores it', async ({ request }) => {
  const num = `E2EUND${Date.now()}`;
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, tag_code, expected_boxes, status)
     VALUES ($1, $2, 1, 'draft') RETURNING id`, [SUPPLIER, `UND${Date.now() % 100000}`]))[0];
  const [box] = await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status, tracking_status, last_checkpoint)
     VALUES ($1, 1, $2, 'shipped', 'NotFound', 'Label created') RETURNING id`, [po.id, num]);
  await q(`INSERT INTO shipment_tracking (tracking_number, tracking_status, last_checkpoint) VALUES ($1, 'NotFound', 'Label created')`, [num]);

  expect((await list(request)).rows.some((r) => r.tracking_number === num)).toBe(true);

  // Guards first: a future day, a supplier, an unknown number.
  expect((await mark(request, { number: num, on: '2999-01-01' })).status()).toBe(400);
  expect((await mark(request, { number: num, on: '2026-09-22' }, SUP)).status()).toBe(403);
  expect((await mark(request, { number: `E2EUNDNOPE${Date.now()}`, on: '2026-09-22' })).status()).toBe(404);

  const r = await mark(request, { number: num, on: '2026-09-22', note: 'UPS photo at dock' });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await mark(request, { number: num, on: '2026-09-22' })).status()).toBe(409);   // once

  let after = await list(request);
  expect(after.rows.some((x) => x.tracking_number === num)).toBe(false);
  const m = after.marked.find((x) => x.tracking_number === num);
  expect(m).toMatchObject({ delivered_on: '2026-09-22', manual_by: 'E2E Und Warehouse', manual_note: 'UPS photo at dock' });

  const [b1] = await q('SELECT status, tracking_status, last_checkpoint FROM po_boxes WHERE id = $1', [box.id]);
  expect(b1.status).toBe('delivered');
  expect(b1.tracking_status).toBe('Delivered');
  expect(b1.last_checkpoint).toMatch(/^Marked delivered by hand \(2026-09-22\) by E2E Und Warehouse/);
  // Its only label is delivered, so the PO rolls off "Filling" like a real push would.
  expect((await q('SELECT status FROM purchase_orders WHERE id = $1', [po.id]))[0].status).toBe('shipped');

  // A lagging 17TRACK push through the same upsert the webhook uses can't undo the mark.
  const { upsertShipmentTracking } = await import('../api/_lib/db.js');
  await upsertShipmentTracking(num, { trackingStatus: 'NotFound', lastCheckpoint: 'still nothing' });
  expect((await q('SELECT tracking_status FROM shipment_tracking WHERE tracking_number = $1', [num]))[0].tracking_status).toBe('Delivered');

  // Undo puts both rows back the way they were.
  const u = await mark(request, { number: num, undo: true });
  expect(u.ok(), await u.text()).toBeTruthy();
  after = await list(request);
  expect(after.rows.some((x) => x.tracking_number === num)).toBe(true);
  expect(after.marked.some((x) => x.tracking_number === num)).toBe(false);
  const [b2] = await q('SELECT status, tracking_status, last_checkpoint FROM po_boxes WHERE id = $1', [box.id]);
  expect(b2).toEqual({ status: 'shipped', tracking_status: 'NotFound', last_checkpoint: 'Label created' });
  const [t2] = await q('SELECT tracking_status, manual_at FROM shipment_tracking WHERE tracking_number = $1', [num]);
  expect(t2).toEqual({ tracking_status: 'NotFound', manual_at: null });
  expect((await mark(request, { number: num, undo: true })).status()).toBe(409);
});

test('the page: Mark delivered moves the row to the "Marked delivered" tab', async ({ page }) => {
  const num = `E2EUNDUI${Date.now()}`;
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, tag_code, expected_boxes, status)
     VALUES ($1, $2, 1, 'draft') RETURNING id`, [SUPPLIER, `UNU${Date.now() % 100000}`]))[0];
  await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped')`, [po.id, num]);

  const { loginAs } = await import('./helpers/auth.js');
  await loginAs(page, 'warehouse');
  await page.goto(`/undelivered?days=all&q=${num}`);
  const row = page.locator('.und-table tbody tr', { hasText: num });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /Mark delivered/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark delivered' }).click();
  await expect(page.getByRole('status')).toContainText(`${num} marked delivered`);
  await expect(row).toHaveCount(0);
  await page.getByRole('tab', { name: /Marked delivered \(\d+\)/ }).click();
  await expect(page.locator('.und-table tbody tr', { hasText: num })).toHaveCount(1);
});

test('an online order with no 17TRACK record at all can be marked too, and undone', async ({ request }) => {
  const num = `E2EUNDOO${Date.now()}`;
  const [o] = await q(`INSERT INTO online_orders (store, tracking_number) VALUES ('E2E-UND Store', $1) RETURNING id`, [num]);
  await q(`INSERT INTO online_order_lines (order_id, sku, size, qty, unit_price) VALUES ($1, 'E2E-UND-1', '9', 1, 100)`, [o.id]);
  expect((await list(request)).rows.find((r) => r.tracking_number === num)?.has_feed).toBe(false);

  expect((await mark(request, { number: num, on: '2026-10-01' })).ok()).toBeTruthy();
  const after = await list(request);
  expect(after.rows.some((r) => r.tracking_number === num)).toBe(false);
  expect(after.marked.find((r) => r.tracking_number === num)).toMatchObject({ online_ids: [Number(o.id)], stores: 'E2E-UND Store' });

  expect((await mark(request, { number: num, undo: true })).ok()).toBeTruthy();
  expect((await list(request)).rows.some((r) => r.tracking_number === num)).toBe(true);
});
