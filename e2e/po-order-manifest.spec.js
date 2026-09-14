// TWO LISTS on one order (`manifest_scope='order+box'`).
//
// A buying request knows what was bought the moment its receipt is read, so the purchase
// order it raises carries that receipt as its ORDER-level list — what we are owed — and
// the buyer then packs, giving every box its own list saying which carton a pair is in.
//
// The order used to be raised EMPTY, and the cost of that was one specific failure: a
// pair the buyer never put in a box was not SHORT, it was INVISIBLE. Reconciliation only
// counted lines on labels that shipped, so the order came out clean while the shoe was
// nowhere and only the request's own checklist ever noticed.
//
// Putting the receipt on the order fixes that and creates one problem of its own: for
// most of a shipment's life `expected` legitimately exceeds `received` and nothing is
// wrong. So the gap is split three ways, and these tests are that arithmetic. Getting it
// wrong in either direction is bad in a different way — cry wolf on every order in
// transit, or go quiet on a pair that never left.
import { test, expect } from '@playwright/test';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`;
const made = [];

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  for (const poId of made) {
    const items = await q('SELECT id FROM items WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q('DELETE FROM items WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
    await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
    await q('DELETE FROM batches WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
    await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
  await pool.end();
});

/**
 * One order: 5 pairs of a shoe on the RECEIPT, packed into boxes, some of it received.
 *
 * @param packed   how many pairs the buyer actually put in box 1
 * @param boxState box 1's status — 'shipped' means it has left, 'pending' means the
 *                 buyer is still filling it
 * @param received how many pairs the warehouse counted in
 * @param secondBox add a second, still-pending label (so the order is "still filling")
 */
async function order({ ordered = 5, packed, boxState, received, secondBox = false }, tag) {
  const po = (await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope, raised_by, tag_code)
     VALUES ($1,'E2E Buyer','receiving',$2,'order+box','supplier',$3) RETURNING id`,
    [`PO-ORDMAN-${stamp}-${tag}`, secondBox ? 2 : 1, `BC-E2E-${tag}`]))[0];
  const poId = Number(po.id);
  made.push(poId);

  // THE ORDER — the receipt, written when the order was raised. No box.
  await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, unit_cost, entered_on_behalf)
           VALUES ($1, NULL, 'DD1391-100', '9', 'Dunk Low Panda', $2, 63.02, true)`, [poId, ordered]);

  // THE PACKING LIST — the buyer's, per box.
  const box1 = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status)
     VALUES ($1, 1, $2, $3) RETURNING id`, [poId, `ORDMAN${stamp}${tag}`, boxState]))[0];
  if (packed > 0) {
    await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, entered_on_behalf)
             VALUES ($1, $2, 'DD1391-100', '9', 'Dunk Low Panda', $3, true)`, [poId, box1.id, packed]);
  }
  if (secondBox) {
    await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status)
             VALUES ($1, 2, $2, 'pending')`, [poId, `ORDMAN${stamp}${tag}B`]);
  }

  if (received > 0) {
    const batch = (await q(
      `INSERT INTO batches (batch_code, po_id, status, kind) VALUES ($1,$2,'closed','receiving') RETURNING id`,
      [`B-ORDMAN-${stamp}-${tag}`, poId]))[0];
    for (let i = 0; i < received; i += 1) {
      await q(`INSERT INTO items (vin, batch_id, name, sku, size, status)
               VALUES ($1,$2,'Dunk Low Panda','DD1391-100','9','needs_shelf')`,
        [`SBM-ORDMAN-${stamp}-${tag}-${i}`, batch.id]);
    }
  }
  const { getPoReconciliation } = await import('../api/_lib/db.js');
  const data = await getPoReconciliation(poId);
  return { poId, row: data.rows[0], summary: data.summary };
}

test('a box still on a truck is "still coming", never a shortage', async () => {
  // All 5 packed, but only box 1 has shipped — carrying 3. Two are in a box the buyer
  // has not sent yet. Nothing is wrong, and the order must not say anything is.
  const { row, summary } = await order(
    { packed: 3, boxState: 'shipped', received: 3, secondBox: true }, 'transit');
  expect(row.expected).toBe(5);
  expect(row.received).toBe(3);
  expect(row.awaiting).toBe(2);
  expect(row.short).toBe(0);
  expect(row.flag).toBe('awaiting');
  // The order is CLEAN. An order whose last box is in transit is not a discrepancy, and
  // a screen that goes amber for that stops being read for the things that are.
  expect(summary.clean).toBe(true);
  expect(summary.shortage).toBe(0);
  expect(summary.awaiting_units).toBe(2);
});

test('a pair that shipped and did not arrive is short', async () => {
  // Everything packed into one box, the box shipped, 4 of 5 counted in.
  const { row, summary } = await order(
    { packed: 5, boxState: 'shipped', received: 4 }, 'short');
  expect(row.expected).toBe(5);
  expect(row.received).toBe(4);
  expect(row.short).toBe(1);
  expect(row.awaiting).toBe(0);
  expect(row.flag).toBe('shortage');
  expect(summary.clean).toBe(false);
  expect(summary.shortage).toBe(1);
});

// THE ONE THIS WAS BUILT FOR. Under the old empty-order model this came out CLEAN:
// `expected` counted only what was on a shipped label, so the two pairs the buyer never
// boxed were never expected, never short, and never chased.
test('a pair the buyer never packed is a finding once the labels have gone', async () => {
  const { row, summary } = await order(
    { packed: 3, boxState: 'shipped', received: 3 }, 'unpacked');
  expect(row.expected).toBe(5);
  expect(row.received).toBe(3);
  expect(row.packed).toBe(3);
  expect(row.never_packed).toBe(2);
  // Not "short" — nothing was lost in transit. It never left, which is a different
  // conversation with a different person: the buyer, not the carrier.
  expect(row.short).toBe(0);
  expect(row.unpacked).toBe(2);
  expect(row.flag).toBe('unpacked');
  // And it HOLDS THE ORDER OPEN, which is the entire point.
  expect(summary.clean).toBe(false);
  expect(summary.unpacked).toBe(1);
  expect(summary.unpacked_units).toBe(2);
});

test('while a box is still open, unpacked pairs are not a finding yet', async () => {
  // Same shape as above — 3 of 5 packed — but box 1 has not shipped. The buyer is
  // mid-job. Flagging this would make every order amber from the moment it was raised.
  const { row, summary } = await order(
    { packed: 3, boxState: 'pending', received: 0 }, 'filling');
  expect(row.expected).toBe(5);
  expect(row.never_packed).toBe(2);
  expect(row.unpacked).toBe(0);
  expect(row.awaiting).toBe(5);
  expect(row.flag).toBe('awaiting');
  expect(summary.clean).toBe(true);
  expect(summary.still_filling).toBe(true);
});

test('everything packed, shipped and counted reads as a plain match', async () => {
  const { row, summary } = await order(
    { packed: 5, boxState: 'shipped', received: 5 }, 'match');
  expect(row.flag).toBe('match');
  expect(row.awaiting).toBe(0);
  expect(row.unpacked).toBe(0);
  expect(row.short).toBe(0);
  expect(summary.clean).toBe(true);
  expect(summary.expected_units).toBe(5);
  expect(summary.received_units).toBe(5);
});

// An overage must not turn into negative "awaiting" or quietly cancel a real shortage.
test('more arriving than was ordered is still an overage, and eats nothing', async () => {
  const { row, summary } = await order(
    { packed: 5, boxState: 'shipped', received: 7 }, 'over');
  expect(row.expected).toBe(5);
  expect(row.received).toBe(7);
  expect(row.awaiting).toBe(0);
  expect(row.unpacked).toBe(0);
  expect(row.short).toBe(0);
  expect(row.flag).toBe('overage');
  expect(summary.clean).toBe(false);
  expect(summary.overage).toBe(1);
});
