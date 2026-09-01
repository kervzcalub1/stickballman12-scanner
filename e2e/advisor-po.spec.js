// The advisor's purchase-order tools — po_status (one order) and po_list (the spread).
//
// Driven straight at `runTool`, like supplier-advisor.spec.js: the model's own words
// aren't ours to assert, but WHAT WE HAND IT is, and every trap this feature exists to
// avoid lives in that payload. The order below is built to carry all of them at once:
// a label still with the supplier, a shortage on a delivered one, and a size the two
// sides spell differently.
import { test, expect } from '@playwright/test';
import { runTool, toolsFor } from '../api/advisor/ask.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const STAFF = { name: 'E2E', role: 'warehouse' };
const SUPPLIER = { name: 'E2E Supplier', role: 'supplier' };

const CODE = 'PO-E2EADV';
const SUPPLIER_NAME = 'E2E Advisor Supply';
const BATCH = 'B-E2EADV';
const TRACK_SHIPPED = 'E2EADV0000001';   // delivered, and one pair short
const TRACK_WAITING = 'E2EADV0000002';   // still sitting with the supplier
let poId = null;

async function cleanup() {
  // purchase_orders.received_batch_id → batches is a circular FK (see the note in
  // docs/context/purchase-orders.md), so the order has to let go of the batch first.
  await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE po_code = $1', [CODE]);
  await q(`DELETE FROM item_events WHERE item_id IN
             (SELECT i.id FROM items i JOIN batches b ON b.id = i.batch_id WHERE b.batch_code = $1)`, [BATCH]);
  await q('DELETE FROM items WHERE batch_id IN (SELECT id FROM batches WHERE batch_code = $1)', [BATCH]);
  await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE batch_code = $1)', [BATCH]);
  await q('DELETE FROM batches WHERE batch_code = $1', [BATCH]);
  await q('DELETE FROM purchase_orders WHERE po_code = $1', [CODE]);
}

test.beforeAll(async () => {
  await cleanup();
  [{ id: poId }] = await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, tag_code, manifest_scope, date_of_purchase)
     VALUES ($1, $2, 'receiving', 'ADV', 'box', current_date) RETURNING id`, [CODE, SUPPLIER_NAME]);

  // Label 1 is delivered; label 2 never left them. An unshipped label's lines are
  // excluded from `expected` on purpose — it must never read as a shortage.
  const [b1] = await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'delivered') RETURNING id`,
    [poId, TRACK_SHIPPED]);
  const [b2] = await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 2, $2, 'pending') RETURNING id`,
    [poId, TRACK_WAITING]);

  // Box 1: 2 of DD1391-100 in a women's 7.5 (they write it bare) + 3 of CW2288-111 / 10.
  // Box 2 (never shipped): 4 pairs nobody should call missing.
  await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected) VALUES
             ($1, $2, 'DD1391-100', '7.5', 'Nike Dunk Low', 2),
             ($1, $2, 'CW2288-111', '10',  'Nike Air Force 1', 3),
             ($1, $3, 'FV5104-004', '9',   'Nike Air Max', 4)`, [poId, b1.id, b2.id]);

  const [batch] = await q(
    `INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, tracking_number, date_received)
     VALUES ($1, $2, 'committed', 'receiving', $3, $4, current_date) RETURNING id`,
    [BATCH, SUPPLIER_NAME, poId, TRACK_SHIPPED]);
  await q('UPDATE purchase_orders SET received_batch_id = $1 WHERE id = $2', [batch.id, poId]);
  const [box] = await q(
    `INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status)
     VALUES ($1, 1, $2, 'committed') RETURNING id`, [batch.id, TRACK_SHIPPED]);

  // What we actually counted out of box 1: BOTH Dunks — but stored as "7.5W", our
  // spelling of the same shoe — and only 2 of the 3 Air Force 1s.
  await q(`INSERT INTO items (vin, batch_id, box_id, sku, size, name, status) VALUES
             ('SBM-E2EADV-01', $1, $2, 'DD1391-100', '7.5W', 'Nike Dunk Low', 'needs_shelf'),
             ('SBM-E2EADV-02', $1, $2, 'DD1391-100', '7.5W', 'Nike Dunk Low', 'needs_shelf'),
             ('SBM-E2EADV-03', $1, $2, 'CW2288-111', '10',   'Nike Air Force 1', 'needs_shelf'),
             ('SBM-E2EADV-04', $1, $2, 'CW2288-111', '10',   'Nike Air Force 1', 'needs_shelf')`,
    [batch.id, box.id]);
});

test.afterAll(async () => { await cleanup(); await pool.end(); });

test('po_status opens the order by its code AND by any tracking number on it', async () => {
  const byCode = await runTool('po_status', { ref: CODE }, STAFF);
  expect(byCode.po.code).toBe(CODE);
  // The number a person actually has in hand is the one on the parcel.
  const byTracking = await runTool('po_status', { ref: TRACK_SHIPPED }, STAFF);
  expect(byTracking.po.code).toBe(CODE);
});

test('a label still with the supplier is NOT counted short', async () => {
  const r = await runTool('po_status', { ref: CODE }, STAFF);
  // 5 declared on the SHIPPED label only — box 2's four pairs are on neither side.
  expect(r.counts.declared_units).toBe(5);
  expect(r.counts.counted_units).toBe(4);
  expect(r.where_it_stands).toMatch(/still sitting with the supplier/i);
  expect(r.by_box.not_received_yet).toContain(2);
  // The one thing this must never do: report box 2's pairs as missing.
  expect(JSON.stringify(r.discrepancies)).not.toContain('FV5104-004');
});

test('"7.5" and our "7.5W" are one shoe, not a phantom shortage', async () => {
  const r = await runTool('po_status', { ref: CODE }, STAFF);
  // Comparing the raw text once turned a perfect 233-pair shipment into 154 wrong pairs.
  expect(r.discrepancies.some((d) => d.sku === 'DD1391-100')).toBe(false);
  expect(r.lines.wrong_size).toBe(0);
  expect(r.lines.not_on_their_list).toBe(0);
});

test('the real shortage is reported, and says WHICH BOX', async () => {
  const r = await runTool('po_status', { ref: CODE }, STAFF);
  const short = r.discrepancies.find((d) => d.sku === 'CW2288-111');
  expect(short).toMatchObject({ size: '10', declared: 3, counted: 2, delta: -1, flag: 'shortage' });
  const box1 = r.by_box.differ.find((b) => b.box === 1);
  expect(box1.missing).toContain('CW2288-111 10 x1');
});

test('a whole-order manifest refuses to invent a per-box expectation', async () => {
  await q('UPDATE purchase_orders SET manifest_scope = $1 WHERE id = $2', ['po', poId]);
  try {
    const r = await runTool('po_status', { ref: CODE }, STAFF);
    expect(r.by_box.differ).toBeUndefined();
    expect(r.by_box.note).toMatch(/Do not invent one/i);
    // And a label declares nothing of its own, so it must not print "declared: 0"
    // beside a box we counted four pairs out of.
    expect(r.labels[0].declared).toBeUndefined();
    expect(r.labels[0].counted).toBe(4);
  } finally {
    await q('UPDATE purchase_orders SET manifest_scope = $1 WHERE id = $2', ['box', poId]);
  }
});

test('an order nobody has heard of says so rather than inventing one', async () => {
  const r = await runTool('po_status', { ref: 'PO-NOPE-999' }, STAFF);
  expect(r.note).toMatch(/no purchase order matches/i);
  expect(r.po).toBeUndefined();
});

test('the payload stays well under the 8,000-char cut that would corrupt it', async () => {
  const r = await runTool('po_status', { ref: CODE }, STAFF);
  // A cut lands mid-JSON, and the model reads the wreckage as fact.
  expect(JSON.stringify(r).length).toBeLessThan(8000);
});

test('po_list finds the order, and windows on the EST day it was RAISED', async () => {
  const open = await runTool('po_list', { state: 'open', supplier: 'E2E Advisor' }, STAFF);
  expect(open.orders.map((o) => o.code)).toContain(CODE);
  expect(open.orders.find((o) => o.code === CODE)).toMatchObject({ status: 'receiving', counted_units: 4 });

  // Seeded now, so it is in today's window and not in a window that ended yesterday.
  const today = await runTool('po_list', { state: 'all', supplier: 'E2E Advisor', days: 1 }, STAFF);
  expect(today.orders.map((o) => o.code)).toContain(CODE);
  expect(today.scope.window).toMatch(/raised today/);

  // An un-windowed call must not claim a date — the pending_work lesson.
  const undated = await runTool('po_list', { state: 'all', supplier: 'E2E Advisor' }, STAFF);
  expect(undated.scope.window).toMatch(/not a date-filtered count/i);
});

test('suppliers are never shown the PO tools, and are refused if they invent them', async () => {
  const names = toolsFor(SUPPLIER).map((t) => t.function.name);
  expect(names).not.toContain('po_status');
  expect(names).not.toContain('po_list');
  // A tool list is a suggestion to a model; the allowlist is not.
  for (const tool of ['po_status', 'po_list']) {
    const out = await runTool(tool, { ref: CODE }, SUPPLIER);
    expect(out.error).toMatch(/not available on this account/i);
    expect(JSON.stringify(out)).not.toContain(CODE);
  }
});
