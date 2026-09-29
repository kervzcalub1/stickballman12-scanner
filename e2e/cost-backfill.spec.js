// Fill costs from POs (2026-09-30).
//
// A pair's cost is written once, at receiving, and only on a receive against the PO — so
// pairs received before their PO carried a shelf price showed "without a cost" on the
// Platform Profit report while the PO beside them plainly had one. The backfill works
// the landed cost out the way receiving does. What has to hold:
//   · each pair takes ITS OWN label's line (matched by the box's tracking number) when
//     the same SKU + size is priced differently on two labels;
//   · landed = shelf through the supplier's preset, the line's own tip beating the preset's;
//   · a $0 and a real cost are never touched, a size the PO doesn't price is left blank;
//   · preview writes nothing; admin only; every filled pair gets a history note.
import { test, expect } from '@playwright/test';
import { loadEnv } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { landedFromShelf } from '../src/lib/costs.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SUPPLIER = `E2E Backfill Supplier ${stamp}`;
const SKU = `E2E-BF-${stamp}`;
const PO = `PO-E2EBF-${stamp}`;
const PRESET = { tipAmt: 5, shippingAmt: 8.25, taxPct: 8.25, giftPct: 8, storePct: 0, promoPct: 0, cashbackPct: 0 };
const vin = (n) => `SBM-E2EBF${stamp}${n}`;
const NP_SUPPLIER = `E2E BF NoPreset ${stamp}`;
const NP_PO = `PO-E2EBFN-${stamp}`;
let poId; let batchId; let presetId; let npPoId; let npBatchId;

const auth = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}` });
const costOf = async (n) => (await q('SELECT cost, shelf_price FROM items WHERE vin = $1', [vin(n)]))[0];

test.beforeAll(async () => {
  const [p] = await q(
    `INSERT INTO payout_presets (name, tip_amt, shipping_amt, tax_pct, gift_pct, supplier_name)
     VALUES ($1, 5, 8.25, 8.25, 8, $2) RETURNING id`, [`E2E BF Stack ${stamp}`, SUPPLIER]);
  presetId = Number(p.id);
  const [po] = await q(`INSERT INTO purchase_orders (po_code, supplier_name, status) VALUES ($1, $2, 'receiving') RETURNING id`, [PO, SUPPLIER]);
  poId = Number(po.id);
  const [l1] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'delivered') RETURNING id`, [poId, `BFA${stamp}`]);
  const [l2] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 2, $2, 'delivered') RETURNING id`, [poId, `BFB${stamp}`]);
  // Same SKU + size on two labels, priced differently — label 2 also carries its own tip.
  await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, unit_cost, tip) VALUES
             ($1, $2, $4, '9', 'E2E BF Shoe', 2, 150, NULL),
             ($1, $3, $4, '9', 'E2E BF Shoe', 1, 100, 7)`, [poId, l1.id, l2.id, SKU]);
  const [b] = await q(
    `INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, tracking_number, date_received)
     VALUES ($1, $2, 'committed', 'receiving', $3, $4, current_date) RETURNING id`, [`B-E2EBF-${stamp}`, SUPPLIER, poId, `BFA${stamp}`]);
  batchId = Number(b.id);
  const [bx1] = await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'received') RETURNING id`, [batchId, `BFA${stamp}`]);
  const [bx2] = await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1, 2, $2, 'received') RETURNING id`, [batchId, `bfb ${stamp}`]); // case + space differ
  // A second order from a supplier with NO preset: its shelf price is not a cost.
  const [np] = await q(`INSERT INTO purchase_orders (po_code, supplier_name, status) VALUES ($1, $2, 'receiving') RETURNING id`, [NP_PO, NP_SUPPLIER]);
  npPoId = Number(np.id);
  await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, unit_cost) VALUES ($1, NULL, $2, '10', 'E2E BF Shoe', 1, 80)`, [npPoId, SKU]);
  const [nb] = await q(
    `INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, tracking_number, date_received)
     VALUES ($1, $2, 'committed', 'receiving', $3, $4, current_date) RETURNING id`, [`B-E2EBFN-${stamp}`, NP_SUPPLIER, npPoId, `BFN${stamp}`]);
  npBatchId = Number(nb.id);
  await q(`INSERT INTO items (vin, batch_id, sku, size, name, status, cost) VALUES ($1, $2, $3, '10', 'E2E BF Shoe', 'in_stock', NULL)`, [vin(6), npBatchId, SKU]);

  await q(`INSERT INTO items (vin, batch_id, box_id, sku, size, name, status, cost) VALUES
             ($1, $6, $7, $9, '9',  'E2E BF Shoe', 'in_stock', NULL),   -- label 1 → 150 shelf
             ($2, $6, $8, $9, '9',  'E2E BF Shoe', 'in_stock', NULL),   -- label 2 → 100 shelf + own $7 tip
             ($3, $6, $7, $9, '9',  'E2E BF Shoe', 'in_stock', 0),      -- a $0 claim: untouched
             ($4, $6, $7, $9, '9',  'E2E BF Shoe', 'in_stock', 99),     -- a real cost: untouched
             ($5, $6, $7, $9, '12', 'E2E BF Shoe', 'in_stock', NULL)    -- size not on the PO: blank`,
    [vin(1), vin(2), vin(3), vin(4), vin(5), batchId, bx1.id, bx2.id, SKU]);
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('DELETE FROM batch_boxes WHERE batch_id = ANY($1)', [[batchId, npBatchId]]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [[batchId, npBatchId]]);
  await q('DELETE FROM po_lines WHERE po_id = ANY($1)', [[poId, npPoId]]);
  await q('DELETE FROM po_boxes WHERE po_id = ANY($1)', [[poId, npPoId]]);
  await q('DELETE FROM purchase_orders WHERE id = ANY($1)', [[poId, npPoId]]);
  await q('DELETE FROM payout_presets WHERE id = $1', [presetId]);
  await pool.end();
});

test('blank costs are filled from their own label on the PO, through the supplier preset', async ({ request }) => {
  // Admin only — it writes cost onto thousands of pairs at once.
  expect((await request.get('/api/items/cost-backfill', { headers: auth('warehouse') })).status()).toBe(403);
  expect((await request.get('/api/items/cost-backfill', { headers: auth('ph_team') })).status()).toBe(403);

  // Preview: names this PO and its two pairs, writes nothing.
  const pre = await request.get('/api/items/cost-backfill', { headers: auth('admin') });
  expect(pre.status()).toBe(200);
  const plan = (await pre.json()).plan;
  expect(plan.byPo.find((p) => p.poCode === PO)).toMatchObject({ pairs: 2, preset: `E2E BF Stack ${stamp}` });
  expect(plan.noLineSample.some((x) => x.what === `${SKU} · 12`)).toBe(true);
  // No preset → skipped and named, never costed at shelf (shelf + preset IS the cost).
  expect(plan.byPo.find((p) => p.poCode === NP_PO)).toBeUndefined();
  expect(plan.noPreset.find((p) => p.poCode === NP_PO)).toMatchObject({ supplier: NP_SUPPLIER, pairs: 1 });
  expect((await costOf(1)).cost).toBeNull();

  // A POST without `apply` does nothing either.
  expect((await request.post('/api/items/cost-backfill', { headers: auth('admin'), data: {} })).status()).toBe(400);

  const run = await request.post('/api/items/cost-backfill', { headers: auth('admin'), data: { apply: true } });
  expect(run.status()).toBe(200);
  expect((await run.json()).filled).toBeGreaterThanOrEqual(2);

  const a = await costOf(1); const b = await costOf(2);
  expect(Number(a.cost)).toBeCloseTo(landedFromShelf(150, null, PRESET), 2);   // label 1, preset tip
  expect(Number(a.shelf_price)).toBe(150);
  expect(Number(b.cost)).toBeCloseTo(landedFromShelf(100, 7, PRESET), 2);      // label 2, its own tip
  expect(Number(b.shelf_price)).toBe(100);
  expect(Number((await costOf(3)).cost)).toBe(0);     // $0 is a claim — left alone
  expect(Number((await costOf(4)).cost)).toBe(99);    // a real cost — left alone
  expect((await costOf(5)).cost).toBeNull();          // nothing on the PO for size 12
  expect((await costOf(6)).cost).toBeNull();          // no supplier preset: not known, left blank

  // Every filled pair says where its cost came from.
  const [ev] = await q(`SELECT e.details->>'text' AS text FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.vin = $1`, [vin(1)]);
  expect(ev.text).toContain(`Cost filled from ${PO}`);
  expect(ev.text).toContain('$150.00 shelf');

  // Running it again finds nothing more for this PO.
  const again = (await (await request.get('/api/items/cost-backfill', { headers: auth('admin') })).json()).plan;
  expect(again.byPo.find((p) => p.poCode === PO)).toBeUndefined();
});
