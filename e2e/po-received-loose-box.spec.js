// A parcel received as its OWN single-box batch still belongs to its label (2026-08-28).
//
// The shape, straight off PO-100010: an order with four labels, where box 2's parcel was
// received on its own — a batch carrying that label's tracking number, items with
// `box_id` NULL, no box row — while the multi-box batch for the rest of the order kept an
// empty `pending` placeholder row for the same number.
//
// "What we received, box by box" built its rows from `batch_boxes` alone, so box 2 read
// "0 units · opened, nothing in it" while its thirteen pairs sat below under "Not
// recorded against a box". Both statements were wrong about one parcel, and `getPoBoxDiffs`
// then reported that label short by everything in it.
import { test, expect } from '@playwright/test';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const T1 = `1ZLOOSE1${stamp}`;   // received inside a box row, the ordinary multi-box way
const T2 = `1ZLOOSE2${stamp}`;   // received as its own batch — the case under test
const T3 = `1ZLOOSE3${stamp}`;   // a label nothing ever arrived for
let poId = null; let multiId = null; let looseId = null; let strayId = null;

test.beforeAll(async () => {
  poId = Number((await q(
    `INSERT INTO purchase_orders (po_code, status, supplier_name) VALUES ($1,'receiving','E2E Loose') RETURNING id`,
    [`PO-LOOSE-${stamp}`]))[0].id);
  for (const [n, t] of [[1, T1], [2, T2], [3, T3]]) {
    await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, kind)
             VALUES ($1,$2,$3,'delivered','original')`, [poId, n, t]);
  }
  // The multi-box batch: box 1 received, box 2 an empty placeholder for T2.
  multiId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, po_id) VALUES ($1,'open','receiving',$2) RETURNING id`,
    [`B-LM-${stamp}`, poId]))[0].id);
  const b1 = Number((await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status)
                              VALUES ($1,1,$2,'received') RETURNING id`, [multiId, T1]))[0].id);
  await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status)
           VALUES ($1,2,$2,'pending')`, [multiId, T2]);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,$3,'Boxed Pair','LB-1111-100','9','needs_shelf')`,
    [`SBM-LB-${stamp}`, multiId, b1]);
  // Box 2's parcel, received on its own: tracking on the BATCH, items with no box.
  looseId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, po_id, tracking_number)
     VALUES ($1,'committed','receiving',$2,$3) RETURNING id`,
    [`B-LL-${stamp}`, poId, T2]))[0].id);
  for (const size of ['10', '10.5']) {
    await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
             VALUES ($1,$2,NULL,'Loose Pair','LL-2222-200',$3,'needs_shelf')`,
      [`SBM-LL-${stamp}-${size}`, looseId, size]);
  }
  // A linked batch with NO tracking number at all — genuinely unattributable, and it must
  // stay that way rather than being guessed onto a label.
  strayId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, po_id) VALUES ($1,'committed','receiving',$2) RETURNING id`,
    [`B-LS-${stamp}`, poId]))[0].id);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,NULL,'Stray Pair','LS-3333-300','11','needs_shelf')`,
    [`SBM-LS-${stamp}`, strayId]);
});

test.afterAll(async () => {
  for (const id of [multiId, looseId, strayId]) {
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

test('a parcel received as its own batch is reported under its label, not as an orphan', async () => {
  const { getPoReceivedBoxes } = await import('../api/_lib/db.js');
  const out = await getPoReceivedBoxes(poId);
  const box2 = out.find((b) => b.box_number === 2);
  expect(box2, 'box 2 missing from the evidence list').toBeTruthy();
  // The thirteen-pair case in miniature: the label's own parcel counted under it.
  expect(box2.units).toBe(2);
  expect(box2.tracking_number).toBe(T2);
  expect(box2.matched_label).toBe(true);
  // …and the empty placeholder row for the same number is not left claiming to be pending.
  expect(box2.status).toBe('received');
  expect(out.filter((b) => b.box_number === 2)).toHaveLength(1);
  // Box 1 is untouched by any of this.
  expect(out.find((b) => b.box_number === 1).units).toBe(1);
});

test('a batch with no tracking number stays unattributed rather than being guessed onto a label', async () => {
  const { getPoReceivedBoxes } = await import('../api/_lib/db.js');
  const out = await getPoReceivedBoxes(poId);
  const orphan = out.find((b) => b.box_number == null);
  expect(orphan, 'the untrackable batch should still be reported').toBeTruthy();
  expect(orphan.units).toBe(1);
  expect(orphan.matched_label).toBe(false);
  // Nothing invented for the label nothing arrived for.
  expect(out.find((b) => b.box_number === 3)).toBeFalsy();
});

test('the per-label diffs stop reading that label as short', async () => {
  const { getPoBoxDiffs } = await import('../api/_lib/db.js');
  // Declare what box 2 was supposed to hold — exactly what arrived in it.
  const box2Id = Number((await q('SELECT id FROM po_boxes WHERE po_id = $1 AND box_number = 2', [poId]))[0].id);
  for (const size of ['10', '10.5']) {
    await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected)
             VALUES ($1,$2,'LL-2222-200',$3,'Loose Pair',1)`, [poId, box2Id, size]);
  }
  const diffs = await getPoBoxDiffs(poId);
  const box2 = diffs.find((d) => d.box_number === 2);
  expect(box2.received_units, 'the parcel arrived — reporting 0 makes it a shortage').toBe(2);
  expect(box2.diffs, 'a complete box must show no discrepancies').toHaveLength(0);
  await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
});
