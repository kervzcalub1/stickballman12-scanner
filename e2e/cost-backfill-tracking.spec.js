// Fill costs from POs — pairs whose batch was never LINKED to its PO (2026-10-01).
//
// HV6103-300 sat in a batch with no PO link while PO label …180655 carried its shelf
// price. The fill now reaches such a pair through the parcel's tracking number — the
// box's, or the batch's own for a loose receive — when exactly ONE shoes PO carries it:
//   · matched (spaces / case ignored) → filled, and the history says it was by tracking;
//   · a number on TWO POs → reported as ambiguous, never guessed;
//   · an in-store batch is never matched by tracking (not a supplier parcel).
import { test, expect } from '@playwright/test';
import { loadEnv } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { landedFromShelf } from '../src/lib/costs.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const SUPPLIER = `E2E BFT Supplier ${stamp}`;
const SKU = `E2E-BFT-${stamp}`;
const PRESET = { tipAmt: 5, shippingAmt: 8.25, taxPct: 8.25, giftPct: 8, storePct: 0, promoPct: 0, cashbackPct: 0 };
const TRK = `BFT${stamp}`;
const AMB = `BFTAMB${stamp}`;
const vin = (n) => `SBM-E2EBFT${stamp}${n}`;
const admin = { Authorization: `Bearer ${signToken({ uid: 'e2e-admin', username: 'e2e_admin', name: 'E2E admin', role: 'admin' })}` };
const po = []; const batches = [];

test.beforeAll(async () => {
  await q(`INSERT INTO payout_presets (name, tip_amt, shipping_amt, tax_pct, gift_pct, supplier_name)
           VALUES ($1, 5, 8.25, 8.25, 8, $2)`, [`E2E BFT Stack ${stamp}`, SUPPLIER]);
  const mkPo = async (code, tracking, shelf) => {
    const [p] = await q(`INSERT INTO purchase_orders (po_code, supplier_name, status) VALUES ($1, $2, 'receiving') RETURNING id`, [code, SUPPLIER]);
    po.push(Number(p.id));
    const [bx] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'delivered') RETURNING id`, [p.id, tracking]);
    await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, unit_cost) VALUES ($1, $2, $3, '9', 'E2E BFT Shoe', 2, $4)`, [p.id, bx.id, SKU, shelf]);
    return Number(p.id);
  };
  await mkPo(`PO-E2EBFT-${stamp}`, TRK, 120);
  await mkPo(`PO-E2EBFA-${stamp}`, AMB, 130);   // AMB is on two POs
  await mkPo(`PO-E2EBFB-${stamp}`, AMB, 140);
  const mkBatch = async (code, kind, tracking) => {
    const [b] = await q(`INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, tracking_number, date_received)
                         VALUES ($1, $2, 'committed', $3, NULL, $4, current_date) RETURNING id`, [code, SUPPLIER, kind, tracking]);
    batches.push(Number(b.id));
    return Number(b.id);
  };
  // Loose receive (no box row), batch tracking typed with a space and lower case.
  const loose = await mkBatch(`B-E2EBFT-${stamp}`, 'receiving', `bft ${stamp}`);
  const amb = await mkBatch(`B-E2EBFA-${stamp}`, 'receiving', AMB);
  const instore = await mkBatch(`B-E2EBFI-${stamp}`, 'instore', TRK);
  await q(`INSERT INTO items (vin, batch_id, sku, size, name, status, cost) VALUES
             ($1, $4, $7, '9', 'E2E BFT Shoe', 'in_stock', NULL),
             ($2, $5, $7, '9', 'E2E BFT Shoe', 'in_stock', NULL),
             ($3, $6, $7, '9', 'E2E BFT Shoe', 'in_stock', NULL)`, [vin(1), vin(2), vin(3), loose, amb, instore, SKU]);
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [batches]);
  await q('DELETE FROM po_lines WHERE po_id = ANY($1)', [po]);
  await q('DELETE FROM po_boxes WHERE po_id = ANY($1)', [po]);
  await q('DELETE FROM purchase_orders WHERE id = ANY($1)', [po]);
  await q('DELETE FROM payout_presets WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

test('an unlinked batch is filled through its tracking number — once, and only when it is unambiguous', async ({ request }) => {
  const prev = await (await request.get('/api/items/cost-backfill', { headers: admin })).json();
  expect(prev.plan.byTracking).toBeGreaterThanOrEqual(1);
  expect(prev.plan.ambiguous).toBeGreaterThanOrEqual(1);
  expect(prev.plan.byPo.find((p) => p.poCode === `PO-E2EBFT-${stamp}`)).toMatchObject({ pairs: 1, byTracking: 1 });

  const run = await request.post('/api/items/cost-backfill', { headers: admin, data: { apply: true } });
  expect(run.ok(), await run.text()).toBeTruthy();
  const cost = async (n) => (await q('SELECT cost FROM items WHERE vin = $1', [vin(n)]))[0].cost;
  expect(Number(await cost(1))).toBeCloseTo(landedFromShelf(120, null, PRESET), 2);
  expect(await cost(2)).toBeNull();   // on two POs — not guessed
  expect(await cost(3)).toBeNull();   // in-store batch — never matched by tracking
  const [ev] = await q(`SELECT e.details->>'text' AS text FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.vin = $1`, [vin(1)]);
  expect(ev.text).toContain(`PO-E2EBFT-${stamp}`);
  expect(ev.text).toContain('matched by tracking');
});
