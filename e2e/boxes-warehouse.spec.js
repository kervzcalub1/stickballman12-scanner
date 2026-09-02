// The warehouse half of empty shoe boxes: receiving them, reconciling them, finding one,
// and putting one on a pair that arrived without a box.
//
// The four things that must hold, and why each is here:
//   1. A boxes PO is received as `kind='boxes'` — decided from the ORDER, never from what
//      the client claimed, because a boxes shipment landing as 'receiving' would put empty
//      cartons in front of the PH team as sellable stock.
//   2. Reconciliation works with no special case. That is the whole payoff of requiring a
//      SIZE on a box line: expected and received both group on (sku, size) already.
//   3. The PH team cannot see any of it — the rule that has been broken twice before by
//      guarding one query and forgetting the rest (docs/context/ph-excluded-batch-kinds.md).
//   4. A box goes onto exactly ONE pair, ever. `used` is terminal for the same reason
//      `sold` is.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const auth = (role, uid) => ({
  Authorization: `Bearer ${signToken({ uid: uid ?? `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}`,
});
const SUPPLIER = 'E2E BoxWh Supplier';
// A SKU PER TEST. `box-stock` and `use-box` answer "what do we hold for this shoe",
// which is a question about the whole database — so a shared SKU would make each test
// read stock the previous one left behind, and the counts would drift with run order.
let skuN = 0;
const nextSku = () => `E2E-BOXWH-${Date.now().toString(36)}-${++skuN}`;
let SUP_UID;

test.beforeAll(async () => {
  SUP_UID = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$2,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier' RETURNING id`,
    [SUPPLIER, 'e2e_boxwh_supplier'],
  ))[0].id);
});

test.afterAll(async () => {
  // Order matters both ways round: `batches.po_id` points at the order AND
  // `purchase_orders.received_batch_id` points back at the batch, so the link has to be
  // broken before either row can go.
  await q(`DELETE FROM items WHERE batch_id IN (SELECT id FROM batches WHERE supplier_name = $1)
             OR sku LIKE 'E2E-BOXWH-%'`, [SUPPLIER]);
  await q(`UPDATE purchase_orders SET received_batch_id = NULL WHERE supplier_name = $1`, [SUPPLIER]);
  await q(`DELETE FROM batches WHERE supplier_name = $1`, [SUPPLIER]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM users WHERE username = $1', ['e2e_boxwh_supplier']);
  await pool.end();
});

// A boxes PO whose single label has SHIPPED (only shipped labels count toward `expected`)
// carrying two sizes of one shoe in two different cartons.
async function shippedBoxesOrder(SKU) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, order_kind, tag_code, expected_boxes, status)
     VALUES ($1,$2,'boxes',$3,1,'shipped') RETURNING *`,
    [SUPPLIER, SUP_UID, `WH${Date.now() % 100000}`],
  ))[0];
  const box = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status)
     VALUES ($1, 1, $2, 'shipped') RETURNING *`,
    [po.id, `E2E-WH-${stamp}`],
  ))[0];
  await q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, name, size, dimensions, qty_expected, unit_cost)
     VALUES ($1,$2,$3,'Box Test Shoe','9','13 x 9 x 5 in',6,3.50),
            ($1,$2,$3,'Box Test Shoe','12','14 x 9 x 5 in',4,3.50)`,
    [po.id, box.id, SKU],
  );
  return { po, box };
}

// Receive `counts` [{ size, dimensions, n }] against that order, through the real
// endpoints the wizard uses.
async function receive(request, po, poBox, counts, SKU) {
  const open = await request.post('/api/batches/create-open', {
    headers: auth('warehouse'),
    data: { batch: { supplier: SUPPLIER, expectedBoxes: 1, poId: Number(po.id), noTracking: true } },
  });
  expect(open.ok(), await open.text()).toBeTruthy();
  const batch = await open.json();
  const added = await request.post('/api/batches/add-box', {
    headers: auth('warehouse'),
    data: { batchId: batch.id, boxNumber: 1, trackingNumber: poBox.tracking_number },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
  const { box } = await added.json();
  const items = counts.flatMap(({ size, dimensions, n }) =>
    Array.from({ length: n }, () => ({ name: 'Box Test Shoe', sku: SKU, size, dimensions, cost: 3.5 })));
  const res = await request.post('/api/batches/box-commit', {
    headers: auth('warehouse'), data: { batchId: batch.id, boxId: box.id, items, issues: [] },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return { batchId: batch.id, ...(await res.json()) };
}

test('a boxes PO is received as a boxes batch, and every unit keeps its size AND its carton', async ({ request }) => {
  const SKU = nextSku();
  const { po, box } = await shippedBoxesOrder(SKU);
  const r = await receive(request, po, box, [
    { size: '9', dimensions: '13 x 9 x 5 in', n: 6 },
    { size: '12', dimensions: '14 x 9 x 5 in', n: 4 },
  ], SKU);
  expect(r.count).toBe(10);

  const [batch] = await q('SELECT kind FROM batches WHERE id = $1', [r.batchId]);
  // Decided from the ORDER. The client never sent a kind.
  expect(batch.kind).toBe('boxes');

  const rows = await q('SELECT size, dimensions, status FROM items WHERE batch_id = $1', [r.batchId]);
  expect(rows).toHaveLength(10);
  expect(rows.every((x) => x.status === 'needs_shelf')).toBe(true);
  expect(rows.filter((x) => x.size === '9' && x.dimensions === '13 x 9 x 5 in')).toHaveLength(6);
  expect(rows.filter((x) => x.size === '12' && x.dimensions === '14 x 9 x 5 in')).toHaveLength(4);
});

test('a clean boxes shipment reconciles to no difference', async ({ request }) => {
  // The single most important assertion in this file: it is what requiring a size on a
  // box line bought, and it needed no special case in getPoReconciliation at all.
  const SKU = nextSku();
  const { po, box } = await shippedBoxesOrder(SKU);
  await receive(request, po, box, [
    { size: '9', dimensions: '13 x 9 x 5 in', n: 6 },
    { size: '12', dimensions: '14 x 9 x 5 in', n: 4 },
  ], SKU);
  const r = await request.get(`/api/po/reconciliation?poId=${po.id}`, { headers: auth('warehouse') });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { rows } = await r.json();
  expect(rows.every((x) => x.flag === 'match')).toBe(true);
  expect(rows.reduce((n, x) => n + x.delta, 0)).toBe(0);
});

test('a short boxes shipment reads short by exactly the missing cartons', async ({ request }) => {
  const SKU = nextSku();
  const { po, box } = await shippedBoxesOrder(SKU);
  await receive(request, po, box, [
    { size: '9', dimensions: '13 x 9 x 5 in', n: 6 },
    { size: '12', dimensions: '14 x 9 x 5 in', n: 3 },   // one short
  ], SKU);
  const { rows } = await (await request.get(`/api/po/reconciliation?poId=${po.id}`, { headers: auth('warehouse') })).json();
  const short = rows.find((x) => x.size === '12');
  expect(short.expected).toBe(4);
  expect(short.received).toBe(3);
  expect(short.delta).toBe(-1);
  expect(short.flag).toBe('shortage');
  expect(rows.find((x) => x.size === '9').flag).toBe('match');
});

test('the PH team cannot see empty boxes anywhere', async ({ request }) => {
  const SKU = nextSku();
  const { po, box } = await shippedBoxesOrder(SKU);
  await receive(request, po, box, [{ size: '9', dimensions: '13 x 9 x 5 in', n: 6 }], SKU);

  // The grid itself.
  const grid = await request.get('/api/ph/list?from=2020-01-01&to=2035-01-01', { headers: auth('ph_team') });
  expect(grid.ok()).toBeTruthy();
  const rows = (await grid.json()).rows || [];
  expect(rows.filter((r) => r.sku === SKU)).toHaveLength(0);

  // And the badge counts, which is the half that gets forgotten: a count is a query too.
  const counts = (await (await request.get('/api/items/pending-counts', { headers: auth('ph_team') })).json()).counts;
  expect(counts.boxes_needs_shelf).toBeGreaterThan(0);   // they ARE counted…
  const shoeShelf = (await q(
    `SELECT count(*)::int AS n FROM items i JOIN batches b ON b.id = i.batch_id
     WHERE i.status = 'needs_shelf' AND b.kind = 'boxes'`,
  ))[0].n;
  // …but never inside the warehouse's shoe backlog.
  expect(counts.needs_shelf).toBe(
    (await q(`SELECT count(*)::int AS n FROM items i LEFT JOIN batches b ON b.id = i.batch_id
              WHERE i.status = 'needs_shelf'`))[0].n - shoeShelf,
  );
});

test('a box on the shelf is findable by the size somebody asks for', async ({ request }) => {
  const SKU = nextSku();
  const { po, box } = await shippedBoxesOrder(SKU);
  await receive(request, po, box, [
    { size: '9', dimensions: '13 x 9 x 5 in', n: 6 },
    { size: '12', dimensions: '14 x 9 x 5 in', n: 4 },
  ], SKU);
  const r = await request.get(`/api/items/box-stock?sku=${SKU}`, { headers: auth('warehouse') });
  const { rows } = await r.json();
  expect(rows).toHaveLength(2);
  const nine = rows.find((x) => x.size === '9');
  expect(nine.qty).toBe(6);
  expect(nine.dimensions).toBe('13 x 9 x 5 in');
});

test('a box goes onto a pair, and can never be used twice', async ({ request }) => {
  const SKU = nextSku();
  const { po, box } = await shippedBoxesOrder(SKU);
  await receive(request, po, box, [{ size: '9', dimensions: '13 x 9 x 5 in', n: 2 }], SKU);

  // A pair that arrived with no box at all.
  const pairRes = await request.post('/api/batches/commit', {
    headers: auth('warehouse'),
    data: {
      kind: 'receiving',
      batch: { supplier: SUPPLIER, tracking: `E2E-PAIR-${Date.now()}` },
      items: [{ name: 'Box Test Shoe', sku: SKU, size: '9', withBox: false, cost: 90 }],
      issues: [],
    },
  });
  expect(pairRes.ok(), await pairRes.text()).toBeTruthy();
  const pairVin = (await pairRes.json()).vins[0];

  const fitting = await (await request.get(`/api/items/use-box?sku=${SKU}&size=9`, { headers: auth('warehouse') })).json();
  expect(fitting.boxes.length).toBe(2);
  const chosen = fitting.boxes[0];

  const used = await request.post('/api/items/use-box', {
    headers: auth('warehouse'), data: { vin: pairVin, boxId: chosen.id },
  });
  expect(used.ok(), await used.text()).toBeTruthy();

  // The pair is sellable and the box is spent — both, or neither.
  const [pair] = await q('SELECT status, with_box FROM items WHERE vin = $1', [pairVin]);
  expect(pair.status).toBe('needs_shelf');
  expect(pair.with_box).toBe(true);
  const [spent] = await q('SELECT status, used_on_item_id, used_at FROM items WHERE vin = $1', [chosen.vin]);
  expect(spent.status).toBe('used');
  expect(Number(spent.used_on_item_id)).toBeGreaterThan(0);
  expect(spent.used_at).not.toBeNull();

  // Both rows say what happened, so "where did the 40 boxes go" is answerable.
  const events = await q(
    `SELECT i.vin, e.details FROM item_events e JOIN items i ON i.id = e.item_id
     WHERE i.vin IN ($1,$2) AND e.type = 'status_change'`, [pairVin, chosen.vin]);
  expect(events.some((e) => /Boxed from stock/.test(JSON.stringify(e.details)))).toBe(true);
  expect(events.some((e) => /Used on/.test(JSON.stringify(e.details)))).toBe(true);

  // One carton, one shoe. Ever.
  const again = await request.post('/api/items/use-box', {
    headers: auth('warehouse'), data: { vin: pairVin, boxId: chosen.id },
  });
  expect(again.status()).toBe(409);
  expect(await again.text()).toContain('already been used');

  // And it has left the shelf count.
  const { rows: stock } = await (await request.get(`/api/items/box-stock?sku=${SKU}&size=9`, { headers: auth('warehouse') })).json();
  expect(stock[0].qty).toBe(1);
});

test('a used box cannot be dragged back into a sellable status', async ({ request }) => {
  // `used` is terminal for the same reason `sold` is — otherwise one physical carton
  // could be handed to two different shoes.
  const SKU = nextSku();
  const { po, box } = await shippedBoxesOrder(SKU);
  await receive(request, po, box, [{ size: '9', dimensions: '13 x 9 x 5 in', n: 1 }], SKU);
  const pairRes = await request.post('/api/batches/commit', {
    headers: auth('warehouse'),
    data: { kind: 'receiving', batch: { supplier: SUPPLIER, tracking: `E2E-PAIR2-${Date.now()}` },
      items: [{ name: 'Box Test Shoe', sku: SKU, size: '9', withBox: false, cost: 90 }], issues: [] },
  });
  const pairVin = (await pairRes.json()).vins[0];
  const fitting = await (await request.get(`/api/items/use-box?sku=${SKU}&size=9`, { headers: auth('warehouse') })).json();
  const chosen = fitting.boxes[0];
  await request.post('/api/items/use-box', { headers: auth('warehouse'), data: { vin: pairVin, boxId: chosen.id } });

  const back = await request.post('/api/items/event', {
    headers: auth('warehouse'),
    data: { vin: chosen.vin, type: 'status_change', details: { status: 'in_stock' } },
  });
  expect(back.ok()).toBeFalsy();
  const [still] = await q('SELECT status FROM items WHERE vin = $1', [chosen.vin]);
  expect(still.status).toBe('used');
});
