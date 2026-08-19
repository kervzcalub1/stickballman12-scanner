// Per-LABEL reconciliation: which BOX a difference is in, not just which shoe.
//
// The order-level table says "one Dunk is missing"; `box_diffs` says "box 11", which is
// the difference between a message to the supplier and someone walking to a shelf.
//
// The three things that have to hold, all of which were wrong at some point:
//   • A dual style code (`315121-115/CW2288-111` vs the declared `CW2288-111`) and a
//     women's size suffix (`7.5W` vs `7.5`) must MATCH. Comparing the raw text reported
//     a fully-correct PO-100005 as 154 pairs wrong.
//   • An undeclared pair shows up as an extra against the box it came out of.
//   • A label that hasn't arrived yet is NOT a pile of missing pairs — that is how a
//     half-delivered order gets chased as a loss.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const auth = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };

const stamp = `${Date.now()}`;
const PO_CODE = `PO-BOXDIFF-${stamp}`;
const TRK = { a: `BOXDIFF${stamp}A`, b: `BOXDIFF${stamp}B`, c: `BOXDIFF${stamp}C` };
let poId = null;

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  if (poId) {
    const items = await q("SELECT id FROM items WHERE vin LIKE $1", [`SBM-BOXDIFF-${stamp}%`]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q("DELETE FROM items WHERE vin LIKE $1", [`SBM-BOXDIFF-${stamp}%`]);
    await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
    await q('DELETE FROM batches WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
    await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
  await pool.end();
});

test('box_diffs names the box, ignores notation, and never calls an unshipped label short', async ({ request, baseURL }) => {
  const po = (await q(
    "INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope) VALUES ($1,'E2E BoxDiff','receiving',3,'box') RETURNING id",
    [PO_CODE]))[0];
  poId = Number(po.id);
  const mkLabel = async (n, t) => (await q(
    "INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1,$2,$3,'shipped') RETURNING id", [poId, n, t]))[0];
  const l1 = await mkLabel(1, TRK.a); const l2 = await mkLabel(2, TRK.b); await mkLabel(3, TRK.c);
  const line = (box, sku, size, qty, name) => q(
    'INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, entered_on_behalf) VALUES ($1,$2,$3,$4,$5,$6,true)',
    [poId, box.id, sku, size, name, qty]);
  await line(l1, 'DD1391-100', '9', 2, 'Dunk Low Panda');
  await line(l2, 'CW2288-111', '10', 1, 'AF1 White');            // declared under ONE code
  await line(l2, 'HV8288-001', '7.5', 1, 'Wmns AJ1');            // declared WITHOUT the W
  await line(l2, 'IQ5338-400', '11', 1, 'Kobe 3');               // declared, not received

  const batch = (await q("INSERT INTO batches (batch_code, po_id, status, kind) VALUES ($1,$2,'closed','receiving') RETURNING id",
    [`B-BOXDIFF-${stamp}`, poId]))[0];
  const mkBox = async (n, t) => (await q(
    "INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1,$2,$3,'received') RETURNING id", [batch.id, n, t]))[0];
  const r1 = await mkBox(1, TRK.a); const r2 = await mkBox(2, TRK.b);   // label 3 never arrives
  let v = 0;
  const item = (box, sku, size, name) => q(
    "INSERT INTO items (vin, batch_id, box_id, name, sku, size, status) VALUES ($1,$2,$3,$4,$5,$6,'needs_shelf')",
    [`SBM-BOXDIFF-${stamp}-${++v}`, batch.id, box.id, name, sku, size]);
  await item(r1, 'DD1391-100', '9', 'Dunk Low Panda');
  await item(r1, 'DD1391-100', '9', 'Dunk Low Panda');
  await item(r2, '315121-115/CW2288-111', '10', 'AF1 White');    // DUAL code — must match
  await item(r2, 'HV8288-001', '7.5W', 'Wmns AJ1');              // W suffix — must match
  await item(r2, 'IB8863-122', '7', 'Nike C1TY');                // never declared

  const res = await request.get(`${baseURL}/api/po/reconciliation?poId=${poId}`, { headers: auth });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const byBox = Object.fromEntries((body.box_diffs || []).map((b) => [b.box_number, b]));

  // Box 1: straightforward match.
  expect(byBox[1].diffs).toHaveLength(0);

  // Box 2: the dual code and the W suffix matched, so the ONLY difference is the C1TY.
  expect(byBox[2].diffs.filter((d) => d.kind === 'extra').map((d) => d.sku)).toEqual(['IB8863-122']);
  expect(byBox[2].diffs.filter((d) => d.kind === 'missing').map((d) => d.sku)).toEqual(['IQ5338-400']);

  // Box 3 hasn't arrived: outstanding, not short.
  expect(byBox[3].received).toBe(false);
  expect(byBox[3].expected_units).toBe(0);   // its lines live on labels 1-2 in this fixture
});
