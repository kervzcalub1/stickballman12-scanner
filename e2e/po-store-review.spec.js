// The store-orders review (2026-10-25): the loopholes found in Joey's store orders and the
// pre-sell guard, each pinned so it can't come back.
//   · the audit compares the card with list + the supplier preset's sales tax, and flags a
//     card BELOW the list (the list is what the supplier is paid on);
//   · a receipt's prices are checked against the list, not only its quantities;
//   · one email receipt can only be one store's;
//   · a store's own tracking number can't be changed once pairs were received into the box;
//   · pre-sell: pairs added to a row already listed against an order are capped by it even
//     when no order is picked; re-pointing a row moves its count to the new order;
//     a cancelled or shipped sale is never "at risk".
// No marketplace or Telegram is reached: every refusal comes before a platform call.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { compareReceiptToList, receiptDiffSentence } from '../src/lib/storeAudit.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SUPPLIER = `E2E StoreReview ${stamp}`;
const SKU = `E2E-RV-${stamp}`;
const hdr = (c) => ({ Authorization: `Bearer ${signToken(c)}` });
const PH = hdr({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' });

test.describe.configure({ mode: 'serial' });
let SUP; let SUPH; let po; let A; let B; let label; let batchId; let presetId; const ers = [];

test.beforeAll(async () => {
  SUP = Number((await q(`INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,'e2e_rv_sup','x','supplier','approved')
                         ON CONFLICT (username) DO UPDATE SET role='supplier' RETURNING id`, [SUPPLIER]))[0].id);
  SUPH = hdr({ uid: SUP, username: 'e2e_rv_sup', name: SUPPLIER, role: 'supplier' });
  presetId = Number((await q(`INSERT INTO payout_presets (name, tax_pct, supplier_name) VALUES ($1, 8.25, $2) RETURNING id`,
    [`E2E RV Stack ${stamp}`, SUPPLIER]))[0].id);
  [po] = await q(`INSERT INTO purchase_orders (supplier_name, supplier_user_id, status, by_store, manifest_scope, created_by, landed_override_at, landed_override_by)
                  VALUES ($1, $2, 'receiving', true, 'po', 'e2e', now(), 'e2e') RETURNING id, po_code`, [SUPPLIER, SUP]);
  [A] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #1 Dallas', 1) RETURNING id`, [po.id]);
  [B] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #2 Austin', 2) RETURNING id`, [po.id]);
  // Each store lists $1,000 of shoes; with 8.25% tax the card should read $1,082.50.
  await q(`INSERT INTO po_lines (po_id, po_store_id, sku, size, name, qty_expected, unit_cost) VALUES
             ($1, $2, $4, '9', 'E2E RV Shoe', 10, 100), ($1, $3, $4, '10', 'E2E RV Shoe', 10, 100)`, [po.id, A.id, B.id, SKU]);
  [label] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, tracking_source, status, po_store_id)
                     VALUES ($1, 1, $2, 'store', 'delivered', $3) RETURNING id`, [po.id, `RVA${stamp}11`, A.id]);
  const [b] = await q(`INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, date_received)
                       VALUES ($1, $2, 'committed', 'receiving', $3, current_date) RETURNING id`, [`B-E2ERV-${stamp}`, SUPPLIER, po.id]);
  batchId = Number(b.id);
  const [bx] = await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, po_box_id) VALUES ($1, 1, $2, 'received', $3) RETURNING id`,
    [batchId, `RVA${stamp}11`, label.id]);
  await q(`INSERT INTO items (vin, batch_id, box_id, sku, size, name, status) VALUES ($1, $2, $3, $4, '9', 'E2E RV Shoe', 'in_stock')`,
    [`SBM-E2ERV${stamp}1`, batchId, bx.id, SKU]);
  // Dallas charged exactly list + tax; Austin's card came in at $950 — below its $1,000 list.
  await q(`INSERT INTO po_store_charges (po_store_id, amount) VALUES ($1, 1082.50), ($2, 950)`, [A.id, B.id]);
});

test.afterAll(async () => {
  await q('DELETE FROM presell_sales WHERE order_id LIKE $1', [`RV-${stamp}-%`]);
  await q('DELETE FROM presell_stock WHERE sku = $1', [SKU]);
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('DELETE FROM batch_boxes WHERE batch_id = $1', [batchId]);
  await q('UPDATE batches SET po_id = NULL WHERE id = $1', [batchId]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await q('DELETE FROM po_store_receipts WHERE po_store_id IN (SELECT id FROM po_stores WHERE po_id IN (SELECT id FROM purchase_orders WHERE supplier_name = $1))', [SUPPLIER]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM email_receipts WHERE id = ANY($1)', [ers]);
  await q('DELETE FROM payout_presets WHERE id = $1', [presetId]);
  await q(`DELETE FROM users WHERE username = 'e2e_rv_sup'`);
  await pool.end();
});

const audit = async (request) => (await request.get(`/api/po/audit?poId=${po.id}`, { headers: PH })).json();

test('the card is compared with list + the supplier\'s sales tax — and a card BELOW the list is flagged', async ({ request }) => {
  const { variance: v } = await audit(request);
  expect(v.tax_pct).toBe(8.25);
  const dallas = v.stores.find((s) => s.name === 'AF #1 Dallas');
  const austin = v.stores.find((s) => s.name === 'AF #2 Austin');
  // Dallas: $1,082.50 is exactly list + tax — not an "overcharge" any more.
  expect(dallas).toMatchObject({ expected_charge: 1082.5, charged_minus_expected: 0, charge_flag: 'ok', charged_minus_declared: 82.5 });
  // Austin: $950 against $1,082.50 — the list (what Joey is paid on) is above what was paid.
  expect(austin).toMatchObject({ charge_flag: 'under', charged_minus_expected: -132.5 });
  expect(v.totals).toMatchObject({ overcharge: 0, undercharge: 132.5 });
  // …and it is news on Telegram's side too.
  const { storeOutcomeForIntake } = await import('../api/_lib/db.js');
  expect(await storeOutcomeForIntake(po.id)).toMatchObject({ byStore: true, undercharge: 132.5, overcharge: 0 });
});

test('a receipt\'s prices are checked against the list, not only its quantities', () => {
  const store = { skus: [{ sizes: [{ sku: SKU, size: '9', declared: 10, price: 100 }] }] };
  const same = compareReceiptToList([{ sku: SKU, size: '9', qty: 10, totalPrice: 1000.4 }], store);
  expect(same.diffs).toEqual([]);                                   // within $1 is rounding
  const cheaper = compareReceiptToList([{ sku: SKU, size: '9', qty: 10, totalPrice: 850 }], store);
  expect(cheaper.diffs.map(receiptDiffSentence)).toEqual([
    `the receipt charged $85.00 each for ${SKU} size 9; the list says $100.00 — the list is higher than what was paid`,
  ]);
});

test('one email receipt can only be one store\'s', async ({ request }) => {
  const [er] = await q(`INSERT INTO email_receipts (message_key, received_at, total) VALUES ($1, now(), 1082.50) RETURNING id`, [`e2e-rv-${stamp}`]);
  ers.push(er.id);
  const first = await request.post('/api/po/audit', { headers: PH, data: { poId: po.id, action: 'receipt_email', storeId: A.id, emailReceiptId: er.id } });
  expect(first.status()).toBe(200);
  for (const storeId of [B.id, A.id]) {
    const again = await request.post('/api/po/audit', { headers: PH, data: { poId: po.id, action: 'receipt_email', storeId, emailReceiptId: er.id } });
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toMatch(/already attached to AF #1 Dallas/);
  }
});

test('the supplier can\'t change a store\'s tracking number once pairs were received into the box', async ({ request }) => {
  const r = await request.post('/api/po/store-tracking', { headers: SUPH, data: { boxId: Number(label.id), trackingNumber: `RVZ${stamp}99` } });
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toMatch(/already been received/);
});

test('pre-sell: a row listed against an order stays capped by it even when no order is picked', async ({ request }) => {
  const [row] = await q(`INSERT INTO presell_stock (sku, size, name, qty, po_id) VALUES ($1, '9', 'E2E RV Shoe', 10, $2) RETURNING id`, [SKU, po.id]);
  await q('INSERT INTO presell_stock_po (stock_id, po_id, qty) VALUES ($1, $2, 10)', [row.id, po.id]);
  // The order lists 10 of size 9 (Dallas); all 10 are pre-listed. Adding one with NO PO picked
  // used to slip in on the same row, uncounted.
  const r = await request.post('/api/presell-listings/create', { headers: PH,
    data: { activate: false, items: [{ sku: SKU, size: '9', qty: 1, alias: { price: 150 } }] } });
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toBe(`${po.po_code} lists 10 of ${SKU} size 9 — 10 already pre-listed, you're adding 1.`);
});

test('pre-sell: re-pointing a row to another order moves its count there', async ({ request }) => {
  // A row listed with no order at all, linked afterwards through ✎ Cost & shipment.
  const [loose] = await q(`INSERT INTO presell_stock (sku, size, name, qty) VALUES ($1, '10', 'E2E RV Shoe', 4) RETURNING id`, [SKU]);
  const r = await request.post('/api/presell-listings/action', { headers: PH, data: { action: 'details', stockIds: [loose.id], poId: po.id } });
  expect(r.status()).toBe(200);
  expect((await q('SELECT qty FROM presell_stock_po WHERE stock_id = $1 AND po_id = $2', [loose.id, po.id]))[0].qty).toBe(4);
  // …so the cap now sees those 4 against the order's 10 of size 10.
  const { presellPoCap } = await import('../api/_lib/db.js');
  expect(await presellPoCap(po.id, SKU, '10')).toMatchObject({ expected: 10, listed: 4 });
  // Moving it off the order takes the count with it.
  await request.post('/api/presell-listings/action', { headers: PH, data: { action: 'details', stockIds: [loose.id], poId: null } });
  expect(await q('SELECT qty FROM presell_stock_po WHERE stock_id = $1', [loose.id])).toEqual([]);
});

test('pre-sell: a cancelled or already-shipped sale is never "at risk"', async () => {
  const { presellPoStatus } = await import('../api/_lib/db.js');
  const [row] = await q(`SELECT id FROM presell_stock WHERE sku = $1 AND size = '9'`, [SKU]);
  // 3 sales of size 9 against the order; 1 pair of size 9 arrived on it (the order is landed).
  for (const [n, state] of [[1, null], [2, null], [3, null]]) {
    await q(`INSERT INTO presell_sales (stock_id, platform, order_id, price_cents, payout_cents, sold_at, raw, po_id, ship_state)
             VALUES ($1, 'alias', $2, 15000, 13000, now(), '{}'::jsonb, $3, $4)`, [row.id, `RV-${stamp}-${n}`, po.id, state]);
  }
  const risk = async () => (await presellPoStatus([po.id])).find((x) => x.stock_id === Number(row.id)).at_risk;
  expect(await risk()).toBe(2);
  // One is cancelled on the platform: it is no sale.
  await q(`UPDATE presell_sales SET ship_state = 'cancelled' WHERE order_id = $1`, [`RV-${stamp}-1`]);
  expect(await risk()).toBe(1);
  // Two live sales, one pair arrived: sale 2 ships on it, sale 3 is still waiting → 1 at risk.
  await q(`UPDATE presell_sales SET ship_state = 'shipped' WHERE order_id = $1`, [`RV-${stamp}-2`]);
  expect(await risk()).toBe(1);
  // Sale 3 ships too (a pair turned up from elsewhere): nothing is left at risk.
  await q(`UPDATE presell_sales SET ship_state = 'shipped' WHERE order_id = $1`, [`RV-${stamp}-3`]);
  expect(await risk()).toBe(0);
});
