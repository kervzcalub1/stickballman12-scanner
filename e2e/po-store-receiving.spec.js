// Store orders, receiving (PR C of docs/store-orders-plan.md, §4.4): every received box is
// tied to the label it IS (batch_boxes.po_box_id), so every pair is tied to the store that
// shipped and charged for it. The tie and the carton's tracking number must agree on a
// store order; a box received without one is shown loudly and tied later, never guessed;
// and a pair's cost is its own store's price.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { poLineMoney, landedFromShelf } from '../src/lib/costs.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SUPPLIER = `E2E StoreRcv ${stamp}`;
const SKU = `E2E-SR-${stamp}`;
const T = { a: `SRA${stamp}11`, b: `SRB${stamp}22`, own: `SRS${stamp}33`, stray: `SRX${stamp}44` };
const PRESET = { tipAmt: 5, shippingAmt: 8.25, taxPct: 8.25, giftPct: 8, storePct: 0, promoPct: 0, cashbackPct: 0 };
const auth = (role, extra = {}) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role, ...extra })}` });
const WH = auth('warehouse');
const PH = auth('ph_team');

test.describe.configure({ mode: 'serial' });

let SUP; let supTok; let otherTok; let presetId;
let po; let storeA; let storeB; let labelA; let labelB; let labelNoTrack; let batchId;

test.beforeAll(async () => {
  const mk = async (u) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$1,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier' RETURNING id`, [u]))[0].id);
  SUP = await mk('e2e_srcv_sup');
  const OTHER = await mk('e2e_srcv_other');
  supTok = { Authorization: `Bearer ${signToken({ uid: SUP, username: 'e2e_srcv_sup', name: SUPPLIER, role: 'supplier' })}` };
  otherTok = { Authorization: `Bearer ${signToken({ uid: OTHER, username: 'e2e_srcv_other', name: 'x', role: 'supplier' })}` };
  presetId = Number((await q(
    `INSERT INTO payout_presets (name, tip_amt, shipping_amt, tax_pct, gift_pct, supplier_name)
     VALUES ($1, 5, 8.25, 8.25, 8, $2) RETURNING id`, [`E2E SR Stack ${stamp}`, SUPPLIER]))[0].id);
  // Seeded with SQL: po/create is rate-limited per IP across the whole suite, and the order
  // is the setup here, not the thing under test.
  [po] = await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, tag_code, status, by_store, manifest_scope, expected_boxes, created_by)
     VALUES ($1, $2, $3, 'shipped', true, 'po', 3, 'e2e') RETURNING id, po_code`, [SUPPLIER, SUP, `SR${stamp}`]);
  [storeA] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #1 Dallas', 1) RETURNING id`, [po.id]);
  [storeB] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #2 Austin', 2) RETURNING id`, [po.id]);
  // The same shoe and size bought at two stores, at two prices.
  await q(`INSERT INTO po_lines (po_id, po_store_id, sku, size, name, qty_expected, unit_cost) VALUES
             ($1, $2, $4, '9', 'E2E SR Shoe', 2, 110), ($1, $3, $4, '9', 'E2E SR Shoe', 2, 130)`,
  [po.id, storeA.id, storeB.id, SKU]);
  [labelA] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, po_store_id) VALUES ($1, 1, $2, 'shipped', $3) RETURNING id`, [po.id, T.a, storeA.id]);
  [labelB] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, po_store_id) VALUES ($1, 2, $2, 'shipped', $3) RETURNING id`, [po.id, T.b, storeB.id]);
  // Store B's second box: shipped under the store's own label, number not known yet.
  [labelNoTrack] = await q(`INSERT INTO po_boxes (po_id, box_number, status, po_store_id) VALUES ($1, 3, 'pending', $2) RETURNING id`, [po.id, storeB.id]);
});

test.afterAll(async () => {
  await q('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE sku = $1)', [SKU]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  const batches = (await q('SELECT id FROM batches WHERE supplier_name = $1', [SUPPLIER])).map((r) => r.id);
  await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM batch_boxes WHERE batch_id = ANY($1)', [batches]);
  await q('UPDATE batches SET po_id = NULL WHERE id = ANY($1)', [batches]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [batches]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM payout_presets WHERE id = $1', [presetId]);
  await q(`DELETE FROM users WHERE username IN ('e2e_srcv_sup','e2e_srcv_other')`);
  await pool.end();
});

const addBox = (request, data) => request.post('/api/batches/add-box', { headers: WH, data: { batchId, ...data } });
const commit = (request, boxId, n = 1) => request.post('/api/batches/box-commit', {
  headers: WH,
  data: { batchId, boxId, items: Array.from({ length: n }, () => ({ name: 'E2E SR Shoe', sku: SKU, size: '9', withBox: true })) },
});
const full = async (request) => (await request.get(`/api/po/get?id=${po.id}`, { headers: PH })).json();

test('the price is the box\'s store\'s; a box tied to no store gets none, never another store\'s', () => {
  const lines = [
    { sku: SKU, size: '9', unit_cost: 110, po_store_id: 1, po_box_id: null },
    { sku: SKU, size: '9', unit_cost: 130, po_store_id: 2, po_box_id: null },
  ];
  expect(poLineMoney(lines, SKU, '9', null, 2).shelf).toBe(130);
  expect(poLineMoney(lines, SKU, '9', null, 1).shelf).toBe(110);
  expect(poLineMoney(lines, SKU, '9', null, null)).toBeNull();
  // Not a store order (no storeId passed): unchanged — the first priced line.
  expect(poLineMoney(lines, SKU, '9').shelf).toBe(110);
});

test('a store order is received box by box: no one-shot commit, no "no tracking number"', async ({ request }) => {
  const noTrack = await request.post('/api/batches/create-open', { headers: WH,
    data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, dateReceived: '2026-10-23', expectedBoxes: 3, poId: po.id, noTracking: true } } });
  expect(noTrack.status()).toBe(409);
  const single = await request.post('/api/batches/commit', { headers: WH,
    data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, dateReceived: '2026-10-23', tracking: T.a }, poId: po.id,
      items: [{ name: 'E2E SR Shoe', sku: SKU, size: '9' }] } });
  expect(single.status()).toBe(409);
  expect((await single.json()).error).toMatch(/box by box/);

  const open = await (await request.post('/api/batches/create-open', { headers: WH,
    data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, dateReceived: '2026-10-23', expectedBoxes: 3, poId: po.id } } })).json();
  batchId = Number(open.id);
  expect(batchId).toBeGreaterThan(0);
});

test('the slot\'s label and the carton\'s number must agree; agreeing ties the box to its label', async ({ request }) => {
  // Opened store A's box, but the carton carries store B's label → refused, says which.
  const wrong = await addBox(request, { trackingNumber: T.b, boxNumber: 1, poBoxId: Number(labelA.id) });
  expect(wrong.status()).toBe(409);
  const body = await wrong.json();
  expect(body.code).toBe('label_mismatch');
  expect(body.error).toMatch(/label 2's/);
  // A number on none of the order's labels, opened from nothing → refused too.
  expect((await (await addBox(request, { trackingNumber: T.stray, boxNumber: 4 })).json()).code).toBe('not_a_label');

  // Agreeing — and punctuation is no disagreement (alphanumeric matching).
  const ok = await addBox(request, { trackingNumber: `${T.a.slice(0, 4)}-${T.a.slice(4)}`, boxNumber: 1, poBoxId: Number(labelA.id) });
  expect(ok.status()).toBe(200);
  const { box } = await ok.json();
  expect(Number(box.po_box_id)).toBe(Number(labelA.id));
  expect((await commit(request, Number(box.id), 2)).status()).toBe(200);
  const d = await full(request);
  expect(d.boxes.find((b) => Number(b.id) === Number(labelA.id)).received_units).toBe(2);
  expect(d.untied_boxes).toEqual([]);
});

test('a store box with no number yet takes the carton\'s (the store\'s own label)', async ({ request }) => {
  const r = await addBox(request, { trackingNumber: T.own, boxNumber: 3, poBoxId: Number(labelNoTrack.id) });
  expect(r.status()).toBe(200);
  const { box } = await r.json();
  expect(Number(box.po_box_id)).toBe(Number(labelNoTrack.id));
  const [label] = await q('SELECT tracking_number, tracking_source FROM po_boxes WHERE id = $1', [labelNoTrack.id]);
  expect(label).toEqual({ tracking_number: T.own, tracking_source: 'store' });
  expect((await commit(request, Number(box.id), 1)).status()).toBe(200);
});

test('received without its label: shown loudly, tied later, and the tie counts', async ({ request }) => {
  // The person chose "receive it not tied to a store".
  const r = await addBox(request, { trackingNumber: T.stray, boxNumber: 4, untied: true });
  expect(r.status()).toBe(200);
  const { box } = await r.json();
  expect(box.po_box_id).toBeNull();
  await commit(request, Number(box.id), 2);
  let d = await full(request);
  expect(d.untied_boxes.map((b) => [b.tracking_number, b.units])).toEqual([[T.stray, 2]]);
  // The supplier never sees it.
  const sup = await (await request.get(`/api/po/get?id=${po.id}`, { headers: supTok })).json();
  expect(sup.untied_boxes).toBeUndefined();

  // Tie it to store B's first label: its pairs are now that label's, so store B's.
  const tie = await request.post('/api/po/tie-box', { headers: PH, data: { poId: po.id, batchBoxId: Number(box.id), poBoxId: Number(labelB.id) } });
  expect(tie.status()).toBe(200);
  d = await tie.json();
  expect(d.untied_boxes).toEqual([]);
  expect(d.boxes.find((b) => Number(b.id) === Number(labelB.id)).received_units).toBe(2);
  // The tie wins over the number: the label can't be deleted out from under the stock.
  const del = await request.post('/api/po/label-remove', { headers: PH, data: { boxId: Number(labelB.id), confirm: '2' } });
  expect(del.status()).toBe(409);
  expect((await del.json()).mustMove).toBe(true);
  const [c] = await q(`SELECT body FROM po_comments WHERE po_id = $1 AND body LIKE 'Tied received box%'`, [po.id]);
  expect(c.body).toMatch(/AF #2 Austin/);
  // A label from another order is refused.
  const [stranger] = await q(`INSERT INTO purchase_orders (supplier_name, status) VALUES ($1, 'draft') RETURNING id`, [SUPPLIER]);
  const [sl] = await q(`INSERT INTO po_boxes (po_id, box_number, status) VALUES ($1, 1, 'pending') RETURNING id`, [stranger.id]);
  expect((await request.post('/api/po/tie-box', { headers: PH, data: { poId: po.id, batchBoxId: Number(box.id), poBoxId: Number(sl.id) } })).status()).toBe(409);
});

test('pairs received before their price get their own store\'s price, through the preset', async ({ request }) => {
  // Box-commit costs what the client sent (nothing here), so every pair is blank.
  const pre = await (await request.get(`/api/po/fill-costs?poId=${po.id}`, { headers: PH })).json();
  expect(pre.plan.fillable).toBe(5);
  const r = await request.post('/api/po/fill-costs', { headers: PH, data: { poId: po.id, apply: true } });
  expect(r.status()).toBe(200);
  expect((await r.json()).filled).toBe(5);
  const rows = await q(`SELECT bx.po_box_id, i.cost::float AS cost FROM items i JOIN batch_boxes bx ON bx.id = i.box_id
                         WHERE i.sku = $1 ORDER BY i.id`, [SKU]);
  const a = landedFromShelf(110, null, PRESET);
  const b = landedFromShelf(130, null, PRESET);
  const byLabel = (id) => rows.filter((x) => Number(x.po_box_id) === Number(id)).map((x) => x.cost);
  expect(byLabel(labelA.id).every((c) => Math.abs(c - a) < 0.01)).toBe(true);
  expect(byLabel(labelB.id).every((c) => Math.abs(c - b) < 0.01)).toBe(true);
  expect(byLabel(labelNoTrack.id).every((c) => Math.abs(c - b) < 0.01)).toBe(true);
  // Supplier can't run it.
  expect((await request.get(`/api/po/fill-costs?poId=${po.id}`, { headers: supTok })).status()).toBe(403);
});

test('the supplier records a store\'s own tracking number on their store box — never over our label', async ({ request }) => {
  const [box4] = await q(`INSERT INTO po_boxes (po_id, box_number, status, po_store_id) VALUES ($1, 4, 'pending', $2) RETURNING id`, [po.id, storeA.id]);
  const num = `SRN${stamp}55`;
  const r = await request.post('/api/po/store-tracking', { headers: supTok, data: { boxId: Number(box4.id), trackingNumber: num } });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.boxes.find((b) => Number(b.id) === Number(box4.id)).tracking_number).toBe(num);
  expect(body.batches).toBeUndefined();              // the supplier strip-list applied
  expect((await q('SELECT tracking_source FROM po_boxes WHERE id = $1', [box4.id]))[0].tracking_source).toBe('store');
  // Our bought label is not theirs to overwrite.
  const over = await request.post('/api/po/store-tracking', { headers: supTok, data: { boxId: Number(labelA.id), trackingNumber: `SRZ${stamp}66` } });
  expect(over.status()).toBe(409);
  // One parcel, one label: a number already on another label is refused.
  const dup = await request.post('/api/po/store-tracking', { headers: supTok, data: { boxId: Number(box4.id), trackingNumber: T.b } });
  expect(dup.status()).toBe(409);
  // Another supplier is shut out.
  expect((await request.post('/api/po/store-tracking', { headers: otherTok, data: { boxId: Number(box4.id), trackingNumber: `SRY${stamp}77` } })).status()).toBe(403);
});

test('unlinking the batch drops its boxes\' label ties', async ({ request }) => {
  const r = await request.post('/api/po/unlink-batch', { headers: PH, data: { poId: po.id, batchId } });
  expect(r.status()).toBe(200);
  const [{ n }] = await q('SELECT count(*)::int AS n FROM batch_boxes WHERE batch_id = $1 AND po_box_id IS NOT NULL', [batchId]);
  expect(n).toBe(0);
  // Put it back for the screen test (the ties come back from link's box map only, so this
  // is a fresh order-state: re-link plainly).
  await q('UPDATE batches SET po_id = $1 WHERE id = $2', [po.id, batchId]);
});

test('Receiving shows which store each box is from, and warns on another box\'s label', async ({ page }) => {
  // A fresh store order with no receiving yet, so the screen starts at the box list.
  const [po2] = await q(
    `INSERT INTO purchase_orders (supplier_name, tag_code, status, by_store, manifest_scope, expected_boxes, created_by)
     VALUES ($1, $2, 'shipped', true, 'po', 2, 'e2e') RETURNING id, po_code`, [SUPPLIER, `SRU${stamp}`]);
  const [s1] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #7 Plano', 1) RETURNING id`, [po2.id]);
  const [s2] = await q(`INSERT INTO po_stores (po_id, name, position) VALUES ($1, 'AF #8 Waco', 2) RETURNING id`, [po2.id]);
  await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, po_store_id) VALUES
             ($1, 1, $2, 'shipped', $4), ($1, 2, $3, 'shipped', $5)`, [po2.id, `SRU${stamp}1A`, `SRU${stamp}2B`, s1.id, s2.id]);
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('label:has-text("Buyer") input').fill('e2e');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.locator('.po-picker input').fill(po2.po_code);
  await page.locator('.po-picker').getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('.po-receive-banner')).toContainText(po2.po_code);
  const rows = page.locator('.box-build-row');
  await expect(rows.first()).toBeVisible({ timeout: 15000 });
  await expect(rows.nth(0).locator('.rcv-store-chip')).toHaveText('Store: AF #7 Plano');
  await expect(rows.nth(1).locator('.rcv-store-chip')).toHaveText('Store: AF #8 Waco');
  // Box 1's field given box 2's label → the warning names the right box and store.
  await rows.nth(0).locator('.box-build-track input').fill(`SRU${stamp}2B`);
  await expect(rows.nth(0).locator('.dup-warn')).toContainText('box 2');
  await expect(rows.nth(0).locator('.dup-warn')).toContainText('AF #8 Waco');
});

test('the order screen shows a box received without its label, and ties it from the picker', async ({ page }) => {
  // A carton under a number this order doesn't know, received not tied to a store.
  const [ub] = await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, received_at)
                        VALUES ($1, 7, $2, 'received', now()) RETURNING id`, [batchId, `SRQ${stamp}88`]);
  await q(`INSERT INTO items (vin, batch_id, box_id, sku, size, name, status) VALUES ($1, $2, $3, $4, '9', 'E2E SR Shoe', 'in_stock')`,
    [`SBM-E2ESR${stamp}Q`, batchId, ub.id, SKU]);
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${po.id}`);
  // It was in the API from the start (PR C) but the screen dropped it — the picker never drew.
  const untied = page.locator('.store-untied');
  await expect(untied).toContainText('Not tied to a store:', { timeout: 15_000 });
  const row = untied.locator('.store-untied-row', { hasText: `SRQ${stamp}88` });
  await expect(row).toContainText('1 pair');
  await row.locator('select').selectOption(String(labelA.id));
  await expect(page.locator('.store-untied-row', { hasText: `SRQ${stamp}88` })).toHaveCount(0, { timeout: 15_000 });
  expect(Number((await q('SELECT po_box_id FROM batch_boxes WHERE id = $1', [ub.id]))[0].po_box_id)).toBe(Number(labelA.id));
});
