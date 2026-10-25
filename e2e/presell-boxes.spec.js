// Pre-sell BY BOX (docs/presell-box-tracking-plan.md, owner 2026-10-24). We give the supplier
// every tracking number; they pack, mixing sizes in a box. A size's boxes are DERIVED from what
// each box holds — the supplier's per-box list when there is one, else 📦 Box contents typed on
// the pre-sell side (a whole-order manifest). No marketplace is called here.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import { boxOrder, boxSummary, boxForPair, boxForSale, transitBoxes, shortTrack } from '../src/lib/presellBoxes.js';
import { assignWhere } from '../src/lib/presellFulfill.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SUPPLIER = `E2E PresellBoxes ${stamp}`;
const SKU = `E2E-PB-${stamp}`;      // on a per-box PO (the supplier scanned each box)
const SKU2 = `E2E-PB2-${stamp}`;    // on a whole-order PO (nobody declared the boxes)
const SKU3 = `E2E-PB3-${stamp}`;    // on no PO at all → "Make a PO for this buy"
const tok = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}` });
const PH = tok('ph_team');
const WH = tok('warehouse');

test.describe.configure({ mode: 'serial' });

let poA; let poB; let boxesA; let boxesB; const rowA = {}; const rowB = {}; const rowC = {}; let batchId;

test.beforeAll(async () => {
  // PO A: per-box manifest. Box 1 and 2 = 3 × 8, 3 × 9, 3 × 10; box 3 = 4 × 8, 4 × 9 — and box 3 is already received.
  [poA] = await q(`INSERT INTO purchase_orders (supplier_name, status, created_by) VALUES ($1, 'shipped', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  boxesA = [];
  for (const [n, st, eta] of [[1, 'in_transit', '2026-11-02'], [2, 'in_transit', '2026-10-30'], [3, 'delivered', null]]) {
    const [b] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status, eta_from) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [poA.id, n, `1ZPB${stamp}A${n}`, st, eta]);
    boxesA.push(Number(b.id));
  }
  for (const [box, size, n] of [[0, '8', 3], [0, '9', 3], [0, '10', 3], [1, '8', 3], [1, '9', 3], [1, '10', 3], [2, '8', 4], [2, '9', 4]]) {
    await q(`INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected) VALUES ($1, $2, $3, $4, 'E2E PB Shoe', $5)`,
      [poA.id, boxesA[box], SKU, size, n]);
  }
  [{ id: batchId }] = await q(`INSERT INTO batches (batch_code, po_id, created_by) VALUES ($1, $2, 'e2e') RETURNING id`, [`E2E-PB-${stamp}`, poA.id]);
  await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, received_at, po_box_id) VALUES ($1, 1, $2, 'received', now(), $3)`,
    [batchId, `1ZPB${stamp}A3`, boxesA[2]]);
  for (const size of ['8', '9', '10']) {
    // "10W" on our side: the supplier wrote 10 — notation must not split them.
    const [r] = await q(`INSERT INTO presell_stock (sku, size, name, qty, po_id, in_transit) VALUES ($1, $2, 'E2E PB Shoe', 10, $3, true) RETURNING id`,
      [SKU, size === '10' ? '10W' : size, poA.id]);
    rowA[size] = Number(r.id);
    await q('INSERT INTO presell_stock_po (stock_id, po_id, qty) VALUES ($1, $2, 10)', [r.id, poA.id]);
  }
  // PO B: a whole-order manifest (order-level lines, two labels nobody declared).
  [poB] = await q(`INSERT INTO purchase_orders (supplier_name, status, manifest_scope, created_by) VALUES ($1, 'shipped', 'po', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  await q(`INSERT INTO po_lines (po_id, sku, size, name, qty_expected) VALUES ($1, $2, '9', 'E2E PB2', 5), ($1, $2, '10', 'E2E PB2', 4)`, [poB.id, SKU2]);
  boxesB = [];
  for (const n of [1, 2]) {
    const [b] = await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, $2, $3, 'in_transit') RETURNING id`, [poB.id, n, `1ZPB${stamp}B${n}`]);
    boxesB.push(Number(b.id));
  }
  for (const [size, n] of [['9', 5], ['10', 4]]) {
    const [r] = await q(`INSERT INTO presell_stock (sku, size, name, qty, po_id, in_transit) VALUES ($1, $2, 'E2E PB2', $3, $4, true) RETURNING id`, [SKU2, size, n, poB.id]);
    rowB[size] = Number(r.id);
    await q('INSERT INTO presell_stock_po (stock_id, po_id, qty) VALUES ($1, $2, $3)', [r.id, poB.id, n]);
  }
  for (const size of ['7', '8']) {
    const [r] = await q(`INSERT INTO presell_stock (sku, size, name, qty, supplier) VALUES ($1, $2, 'E2E PB3', 6, $3) RETURNING id`, [SKU3, size, SUPPLIER]);
    rowC[size] = Number(r.id);
  }
});

test.afterAll(async () => {
  await q('DELETE FROM presell_stock WHERE sku = ANY($1)', [[SKU, SKU2, SKU3]]);
  if (batchId) { await q('DELETE FROM batch_boxes WHERE batch_id = $1', [batchId]); await q('DELETE FROM batches WHERE id = $1', [batchId]); }
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

const stockRows = async (request, sku) => {
  const r = await request.get(`/api/presell-listings/list?tab=stock&q=${sku}`, { headers: PH });
  expect(r.status()).toBe(200);
  return (await r.json()).rows.filter((x) => x.sku === sku);
};
const act = (request, data, headers = PH) => request.post('/api/presell-listings/action', { headers, data });

test('a size\'s boxes come from the supplier\'s per-box list — mixed sizes, received box first, notation matched', async ({ request }) => {
  const rows = await stockRows(request, SKU);
  const by = Object.fromEntries(rows.map((r) => [r.size, r]));
  // Size 8: 4 in the received box 3, then box 2 (exp 10/30) before box 1 (exp 11/02).
  const b8 = boxOrder(by['8'].boxes);
  expect(b8.map((b) => [b.tracking, b.qty, b.received])).toEqual([
    [`1ZPB${stamp}A3`, 4, true], [`1ZPB${stamp}A2`, 3, false], [`1ZPB${stamp}A1`, 3, false]]);
  expect(b8.every((b) => b.source === 'supplier')).toBe(true);
  expect(boxSummary(by['8'])).toMatchObject({ placed: 10, unplaced: 0, over: 0 });
  // Size 10W (supplier wrote 10): only boxes 1 and 2 → 4 not in a box yet.
  expect(boxSummary(by['10W'])).toMatchObject({ placed: 6, unplaced: 4, boxes: 2 });
  // The 11th pair of size 9 isn't in a counted box; the 5th is in box 2 (after box 3's 4).
  expect(boxForPair(by['9'].boxes, 5).tracking).toBe(`1ZPB${stamp}A2`);
  expect(boxForPair(by['9'].boxes, 11)).toBeNull();
});

test('📦 Box contents on a whole-order PO: typed per box, "?" = count unknown, too many refused', async ({ request }) => {
  const r = await act(request, { action: 'boxContents', poId: poB.id, boxId: boxesB[0], sku: SKU2, lines: [{ size: '9', qty: 3 }, { size: '10', qty: null }] });
  expect(r.status()).toBe(200);
  const grid = await r.json();
  expect(grid.boxes.find((b) => b.id === boxesB[0]).lines).toEqual(expect.arrayContaining([{ size: '9', qty: 3 }, { size: '10', qty: null }]));
  // The PO's own list is untouched — box contents never feed expected / reconciliation.
  expect((await q('SELECT count(*)::int AS n FROM po_lines WHERE po_id = $1 AND po_box_id IS NOT NULL', [poB.id]))[0].n).toBe(0);
  const by = Object.fromEntries((await stockRows(request, SKU2)).map((x) => [x.size, x]));
  expect(boxSummary(by['9'])).toMatchObject({ placed: 3, unplaced: 2 });
  expect(by['10'].boxes[0]).toMatchObject({ qty: null, source: 'presell' });
  expect(boxSummary(by['10'])).toMatchObject({ unknown: 1, unplaced: 4 });
  // 3 more of size 9 in box 2 = 6 in boxes; the ORDER lists 5.
  const over = await act(request, { action: 'boxContents', poId: poB.id, boxId: boxesB[1], sku: SKU2, lines: [{ size: '9', qty: 3 }] });
  expect(over.status()).toBe(409);
  expect((await over.json()).error).toContain(`size 9: 6 in boxes but ${poB.po_code} lists 5`);
  // A size not pre-listed against the order is refused, naming it.
  const stray = await act(request, { action: 'boxContents', poId: poB.id, boxId: boxesB[1], sku: SKU2, lines: [{ size: '11', qty: 1 }] });
  expect(stray.status()).toBe(400);
  // A box the supplier declared is theirs — read-only here.
  const declared = await act(request, { action: 'boxContents', poId: poA.id, boxId: boxesA[0], sku: SKU, lines: [{ size: '8', qty: 1 }] });
  expect(declared.status()).toBe(409);
  expect((await declared.json()).error).toMatch(/supplier already declared/);
});

test('split unknown: tick sizes → "somewhere in these boxes", never overwriting a count', async ({ request }) => {
  const r = await act(request, { action: 'boxUnknown', stockIds: [rowB['9'], rowB['10']], boxIds: [boxesB[0], boxesB[1]] });
  expect(r.status()).toBe(200);
  expect((await r.json()).added).toBe(2);   // box 1 already had both sizes — only box 2 is new
  const lines = await q('SELECT po_box_id, size, qty FROM presell_box_lines WHERE po_box_id = ANY($1) ORDER BY po_box_id, size', [boxesB]);
  expect(lines.map((l) => [Number(l.po_box_id), l.size, l.qty])).toEqual([
    [Number(boxesB[0]), '10', null], [Number(boxesB[0]), '9', 3], [Number(boxesB[1]), '10', null], [Number(boxesB[1]), '9', null]]);
  // A row on another order can't be put in this order's boxes.
  const off = await act(request, { action: 'boxUnknown', stockIds: [rowA['8']], boxIds: [boxesB[0]] });
  expect(off.status()).toBe(409);
});

test('Make a PO for this buy: our labels, rows linked; PH only; a tracking number can\'t open a second order', async ({ request }) => {
  const body = { action: 'makePo', stockIds: [rowC['7'], rowC['8']], supplierName: SUPPLIER, trackingNumbers: `1ZPB${stamp}C1\n1ZPB${stamp}C2` };
  expect((await act(request, body, WH)).status()).toBe(403);
  const r = await act(request, body);
  expect(r.status()).toBe(200);
  const out = await r.json();
  expect(out).toMatchObject({ linked: 2, labels: 2 });
  const labels = await q('SELECT tracking_number FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [out.poId]);
  expect(labels.map((l) => l.tracking_number)).toEqual([`1ZPB${stamp}C1`, `1ZPB${stamp}C2`]);
  expect((await q('SELECT count(*)::int AS n FROM po_lines WHERE po_id = $1', [out.poId]))[0].n).toBe(0);
  const links = await q('SELECT stock_id, qty FROM presell_stock_po WHERE po_id = $1 ORDER BY stock_id', [out.poId]);
  expect(links.map((l) => l.qty)).toEqual([6, 6]);
  // Already on an order now.
  expect((await act(request, body)).status()).toBe(409);
  // A fresh row, same tracking numbers → refused, pointing at the order that has them.
  const [extra] = await q(`INSERT INTO presell_stock (sku, size, name, qty) VALUES ($1, '9', 'E2E PB3', 1) RETURNING id`, [SKU3]);
  const dup = await act(request, { ...body, stockIds: [extra.id] });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).error).toContain(out.poCode);
  // The new order's boxes are open for 📦 Box contents straight away.
  const g = await request.get(`/api/presell-listings/list?tab=boxgrid&po=${out.poId}&sku=${SKU3}`, { headers: PH });
  expect((await g.json()).boxes).toHaveLength(2);
});

test('review: boxes hold PHYSICAL pairs — an order of 20 with 10 pre-sold is not "10 too many"; the cap is the order list', async ({ request }) => {
  const [po] = await q(`INSERT INTO purchase_orders (supplier_name, status, manifest_scope, created_by) VALUES ($1, 'shipped', 'po', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  await q(`INSERT INTO po_lines (po_id, sku, size, name, qty_expected) VALUES ($1, $2, '11', 'E2E PB2', 20)`, [po.id, SKU2]);
  const bx = [];
  for (const n of [1, 2]) bx.push(Number((await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, $2, $3, 'in_transit') RETURNING id`, [po.id, n, `1ZPB${stamp}D${n}`]))[0].id));
  const [r] = await q(`INSERT INTO presell_stock (sku, size, name, qty, po_id, in_transit) VALUES ($1, '11', 'E2E PB2', 10, $2, true) RETURNING id`, [SKU2, po.id]);
  await q('INSERT INTO presell_stock_po (stock_id, po_id, qty) VALUES ($1, $2, 10)', [r.id, po.id]);
  // 12 in box 1 is more than we pre-sold (10) but within the order (20) — accepted.
  expect((await act(request, { action: 'boxContents', poId: po.id, boxId: bx[0], sku: SKU2, lines: [{ size: '11', qty: 12 }] })).status()).toBe(200);
  const row = (await stockRows(request, SKU2)).find((x) => x.size === '11');
  expect(boxSummary(row)).toMatchObject({ placed: 12, unplaced: 0, over: 0 });
  // 9 more = 21 of an order of 20 — refused.
  const over = await act(request, { action: 'boxContents', poId: po.id, boxId: bx[1], sku: SKU2, lines: [{ size: '11', qty: 9 }] });
  expect(over.status()).toBe(409);
  expect((await over.json()).error).toContain(`size 11: 21 in boxes but ${po.po_code} lists 20`);
});

test('review: an order with ONE label nobody declared — everything is in it, nothing to type', async ({ request }) => {
  const [po] = await q(`INSERT INTO purchase_orders (supplier_name, status, created_by) VALUES ($1, 'shipped', 'e2e') RETURNING id, po_code`, [SUPPLIER]);
  await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'in_transit')`, [po.id, `1ZPB${stamp}E1`]);
  const [r] = await q(`INSERT INTO presell_stock (sku, size, name, qty, po_id) VALUES ($1, '12', 'E2E PB2', 4, $2) RETURNING id`, [SKU2, po.id]);
  await q('INSERT INTO presell_stock_po (stock_id, po_id, qty) VALUES ($1, $2, 4)', [r.id, po.id]);
  const row = (await stockRows(request, SKU2)).find((x) => x.size === '12');
  expect(row.boxes).toEqual([expect.objectContaining({ tracking: `1ZPB${stamp}E1`, qty: 4, source: 'only_box' })]);
  expect(boxSummary(row)).toMatchObject({ placed: 4, unplaced: 0 });
});

test('review: the supplier\'s scan replaces what PH typed, and the grid says so', async ({ request }) => {
  // PH typed size 8 into box 1 of PO A before the supplier's list existed (box 1 IS declared).
  await q(`INSERT INTO presell_box_lines (po_box_id, sku, size, qty) VALUES ($1, $2, '8', 5)`, [boxesA[0], SKU]);
  const g = await (await request.get(`/api/presell-listings/list?tab=boxgrid&po=${poA.id}&sku=${SKU}`, { headers: PH })).json();
  const b1 = g.boxes.find((b) => b.id === boxesA[0]);
  expect(b1).toMatchObject({ declared: true, replaced: 1 });
  expect(b1.lines.find((l) => l.size === '8').qty).toBe(3);   // the supplier's 3, not PH's 5 — never both
  const row = (await stockRows(request, SKU)).find((x) => x.size === '8');
  expect(boxSummary(row).placed).toBe(10);
});

test('review: Make a PO pressed twice at once opens ONE order', async ({ request }) => {
  const [a] = await q(`INSERT INTO presell_stock (sku, size, name, qty, supplier) VALUES ($1, '13', 'E2E PB3', 2, $2) RETURNING id`, [SKU3, SUPPLIER]);
  const body = { action: 'makePo', stockIds: [Number(a.id)], supplierName: SUPPLIER, trackingNumbers: `1ZPB${stamp}F1` };
  const res = await Promise.all([act(request, body), act(request, body)]);
  const codes = res.map((r) => r.status()).sort();
  expect(codes).toContain(409);
  expect((await q('SELECT count(DISTINCT po_id)::int AS n FROM po_boxes WHERE tracking_number = $1', [`1ZPB${stamp}F1`]))[0].n).toBeLessThanOrEqual(1);
});

test('arrival + fulfil name the box: the post says which box came in; an in-transit order gets its box', async () => {
  const { countArrival } = await import('../api/_lib/presell-arrival.js');
  const [row] = await q('SELECT * FROM presell_stock WHERE id = $1', [rowB['9']]);
  const posts = [];
  const r = await countArrival(row, 1, 'E2E-B', { notify: async (lines) => posts.push(lines), tracks: [`1ZPB${stamp}B1`] });
  expect(r).toBeTruthy();
  expect(posts[0]).toContainEqual({ b: 'Box:', t: ` 1ZPB${stamp}B1` });
  // Fulfil: 1 pair set aside covers the most urgent order; the next two wait on the boxes in landing order.
  const boxes = [
    { id: 1, tracking: 'LATE', qty: 2, status: 'in_transit', eta_from: '2026-11-05' },
    { id: 2, tracking: 'SOON', qty: 1, status: 'in_transit', eta_from: '2026-10-28' },
  ];
  const base = { stock_id: 9, in_transit: true, arrived_at: null, arrived_qty: 1, released_qty: 0, shipped_n: 0, boxes };
  const out = assignWhere([
    { ...base, id: 'a', ship_by: '2026-10-25T12:00:00Z' },
    { ...base, id: 'b', ship_by: '2026-10-26T12:00:00Z' },
    { ...base, id: 'c', ship_by: '2026-10-27T12:00:00Z' },
  ]);
  expect(out.map((x) => [x.id, x.where, x.box?.tracking ?? null])).toEqual([['a', 'ready', null], ['b', 'transit', 'SOON'], ['c', 'transit', 'LATE']]);
  expect([...transitBoxes([{}, {}, {}, {}], boxes).values()].map((b) => b?.tracking ?? null)).toEqual(['SOON', 'LATE', 'LATE', null]);
  // The sale post uses the same rule: 3 sold, 2 arrived of which 1 set aside → 2 still owed →
  // the 2nd pair among boxes NOT received (never a received box, which the warehouse already split).
  const mixed = [{ id: 0, tracking: 'HERE', qty: 4, received: true }, ...boxes];
  expect(boxForSale({ sold: 3, arrived_qty: 2, released_qty: 1 }, mixed).tracking).toBe('LATE');
  expect(boxForSale({ sold: 1, arrived_qty: 0, released_qty: 0 }, mixed).tracking).toBe('SOON');
  expect(boxForSale({ sold: 3, arrived_qty: 4, released_qty: 1, arrived_at: '2026-10-20' }, mixed)).toBeNull();
});

test('the page: the Stock tab shows each size by box; 📦 Boxes saves a box', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/presell-listings?tab=stock&q=${SKU2}`);
  const row9 = page.getByRole('row').filter({ hasText: SKU2 }).filter({ has: page.getByRole('cell', { name: '9', exact: true }) });
  await expect(row9).toContainText(`3 in ${shortTrack(`1ZPB${stamp}B1`)}`);
  await expect(row9).toContainText('2 not in a counted box');
  await row9.getByRole('button', { name: '📦 Boxes' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText(poB.po_code)).toBeVisible();
  await dlg.getByLabel('Box 2 size 10').fill('2');
  await dlg.getByRole('button', { name: /^Save 1 box$/ }).click();
  await expect(dlg.getByText('Saved 1 box.')).toBeVisible();
  expect((await q('SELECT qty FROM presell_box_lines WHERE po_box_id = $1 AND size = $2', [boxesB[1], '10']))[0].qty).toBe(2);
});
