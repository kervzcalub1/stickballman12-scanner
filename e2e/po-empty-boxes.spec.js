// Ordering EMPTY SHOE BOXES on the same paperwork as shoes.
//
// A pair turns up with a crushed box, or with no box at all, so the same suppliers ship
// us replacement boxes. It's the same order, the same labels and the same reconciliation
// — but a bigger manifest line: a real empty shoe box is SIZE-SPECIFIC (its label prints
// the SKU, the size and the UPC) and it also has a carton size of its own. So a box line
// carries BOTH, and both are required; the dimensions are the extra fact, not a
// replacement for the size.
//
// The rules that have to hold, and are what this file guards:
//   1. The kind decides what is required — checked against the ORDER, not against
//      whichever field the client sent. A boxes order demands size AND dimensions.
//   2. Dedupe is on SKU + size + dimensions: re-declaring the same box increments it,
//      while a different size, or the same size in a different carton, is its own line.
//      That's `po_lines_box_sku_dim_idx`, and the shoe-side index gained a
//      `WHERE dimensions IS NULL` predicate so the two stop overlapping.
//   3. The kind is EDITABLE after the fact. A boxes order is routinely raised on the
//      shoes form before anyone says which it is, and the supplier can't declare a thing
//      until the order says what it's for.
//   4. Bulk apply is the same write as a single edit — including the merge — because a
//      box order is normally a run of SKUs in one size of carton.
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
const SUPPLIER = 'E2E Boxes Supplier';
const SKU_A = 'E2E-BOX-A';
const SKU_B = 'E2E-BOX-B';
let SUPPLIER_UID;

test.beforeAll(async () => {
  SUPPLIER_UID = Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1, $2, 'x', 'supplier', 'approved')
     ON CONFLICT (username) DO UPDATE SET role = 'supplier' RETURNING id`,
    ['E2E Boxes Supplier', 'e2e_boxes_supplier'],
  ))[0].id);
});

test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM users WHERE username = $1', ['e2e_boxes_supplier']);
  await pool.end();
});

// A fresh order of the given kind, with one label, assigned to the supplier account so
// the portal's own scoping check has something real behind it.
//
// Seeded straight into the DB rather than through `po/create`. Every test here owns its
// own order (a spec that shares mutable state isn't a guard), which is a dozen orders a
// run — and `po/create` is rate-limited to 30/min, so going through the endpoint made
// THIS file push the whole PO suite over the limit and fail four tests in a neighbouring
// spec. `po/create` itself is covered by `createdOrder` below and by po-edit.spec.js.
async function order(request, orderKind = 'boxes') {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, order_kind, tag_code, expected_boxes, status)
     VALUES ($1, $2, $3, $4, 1, 'draft') RETURNING *`,
    [SUPPLIER, SUPPLIER_UID, orderKind, `BOX${Date.now() % 100000}`],
  ))[0];
  const box = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'pending') RETURNING *`,
    [po.id, `E2E-BOX-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`],
  ))[0];
  return { po, box };
}

// The one place the CREATE endpoint itself is exercised, so `orderKind` is proved to
// survive the form rather than only the column.
async function createdOrder(request, orderKind) {
  const r = await request.post('/api/po/create', {
    headers: auth('ph_team'),
    data: {
      supplierName: SUPPLIER, supplierUserId: SUPPLIER_UID, orderKind,
      tagCode: `BOX${Date.now() % 100000}`,
      labels: [{ trackingNumber: `E2E-BOX-C-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }],
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).po;
}
const scan = (request, data, role = 'supplier') =>
  request.post('/api/po/scan', { headers: auth(role, role === 'supplier' ? SUPPLIER_UID : undefined), data });
const lines = (poId) => q('SELECT * FROM po_lines WHERE po_id = $1 ORDER BY id', [poId]);

test('the create form carries the kind through, and defaults to shoes', async ({ request }) => {
  expect((await createdOrder(request, 'boxes')).order_kind).toBe('boxes');
  // Sending nothing, not sending 'shoes' — the default is the case that matters, and it
  // is what every order raised before empty-box orders existed relies on.
  expect((await createdOrder(request, undefined)).order_kind).toBe('shoes');
});

test('a boxes order demands BOTH the shoe size and the carton', async ({ request }) => {
  const { po, box } = await order(request);
  // Half a declaration is a line the warehouse can't match to anything, either way round.
  const noDims = await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 1 });
  expect(noDims.status()).toBe(400);
  expect(await noDims.text()).toContain('empty shoe boxes');
  const noSize = await scan(request, { poBoxId: box.id, sku: SKU_A, dimensions: '13 x 9 x 5 in', qty: 1 });
  expect(noSize.status()).toBe(400);
  expect(await noSize.text()).toContain('which shoe size');

  const ok = await scan(request, {
    poBoxId: box.id, sku: SKU_A, name: 'Panda', size: '9', qty: 4, unitCost: 3.5,
    dimensions: { l: 13, w: 9, h: 5, unit: 'in' },
  });
  expect(ok.ok(), await ok.text()).toBeTruthy();
  const line = (await ok.json()).line;
  expect(line.size).toBe('9');
  expect(line.dimensions).toBe('13 x 9 x 5 in');   // stored canonically
  expect(await lines(po.id)).toHaveLength(1);
});

test('two sizes of one shoe are two lines, whatever the carton measures', async ({ request }) => {
  // The reason size had to be on the line at all: these are two different things to
  // order, and a size-blind key would have merged them into one.
  const { po, box } = await order(request);
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 2, dimensions: '13 x 9 x 5 in' });
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '10', qty: 3, dimensions: '13 x 9 x 5 in' });
  const all = await lines(po.id);
  expect(all).toHaveLength(2);
  expect(all.map((l) => l.size).sort()).toEqual(['10', '9']);
});

test('the same box increments, a different carton is its own line', async ({ request }) => {
  const { po, box } = await order(request);
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 4, unitCost: 3.5, dimensions: '13 x 9 x 5 in' });
  // Typed loosely the second time — normalising on the server is what makes this the
  // same carton rather than a second declaration of it.
  const again = await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 2, dimensions: '13X9X5' });
  const merged = (await again.json()).line;
  expect(merged.qty_expected).toBe(6);
  // A re-declaration that carries no money must never wipe money already declared.
  expect(Number(merged.unit_cost)).toBe(3.5);

  // Same shoe, same size, a different carton — still its own line.
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 1, dimensions: { l: 15, w: 10, h: 6, unit: 'in' } });
  const all = await lines(po.id);
  expect(all).toHaveLength(2);
  expect(all.map((l) => l.dimensions).sort()).toEqual(['13 x 9 x 5 in', '15 x 10 x 6 in']);
});

test('a shoes order is untouched: sizes still key its lines, dimensions are refused', async ({ request }) => {
  const { po, box } = await order(request, 'shoes');
  const a = await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 2 });
  expect(a.ok()).toBeTruthy();
  const again = await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 3 });
  expect((await again.json()).line.qty_expected).toBe(5);

  const bad = await scan(request, { poBoxId: box.id, sku: SKU_B, size: '9', dimensions: '13 x 9 x 5 in', qty: 1 });
  expect(bad.status()).toBe(400);
  const line = (await lines(po.id))[0];
  const badEdit = await request.post('/api/po/line', {
    headers: auth('ph_team'), data: { lineId: line.id, dimensions: '13 x 9 x 5 in' },
  });
  expect(badEdit.status()).toBe(400);
  expect(await badEdit.text()).toContain('for shoes');
});

test('one line’s size or dimensions can be corrected, and a collision merges', async ({ request }) => {
  const { po, box } = await order(request);
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 2, dimensions: '13 x 9 x 5 in' });
  const second = (await (await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 3, dimensions: '15 x 10 x 6 in' })).json()).line;

  // Loose text in, canonical text out.
  const fixed = await request.post('/api/po/line', {
    headers: auth('supplier', SUPPLIER_UID), data: { lineId: second.id, dimensions: '15 X 10 X 6 IN' },
  });
  expect(fixed.ok(), await fixed.text()).toBeTruthy();
  expect((await fixed.json()).line.dimensions).toBe('15 x 10 x 6 in');

  // Corrected onto the OTHER carton of the same SKU: one line, quantities summed —
  // the same rule a size change follows on a shoes order.
  const collide = await request.post('/api/po/line', {
    headers: auth('supplier', SUPPLIER_UID), data: { lineId: second.id, dimensions: '13 x 9 x 5 in' },
  });
  const j = await collide.json();
  expect(j.merged).toBe(true);
  expect(j.line.qty_expected).toBe(5);
  expect(await lines(po.id)).toHaveLength(1);
});

test('one carton size can be set across a whole manifest at once', async ({ request }) => {
  const { po, box } = await order(request);
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 2, dimensions: '13 x 9 x 5 in' });
  await scan(request, { poBoxId: box.id, sku: SKU_B, size: '9', qty: 3, dimensions: '15 x 10 x 6 in' });
  const before = await lines(po.id);

  const r = await request.post('/api/po/lines-dimensions', {
    headers: auth('supplier', SUPPLIER_UID),
    data: { lineIds: before.map((l) => l.id), dimensions: { l: 13, w: 9, h: 5, unit: 'in' } },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const j = await r.json();
  expect(j.dimensions).toBe('13 x 9 x 5 in');
  // One line already carried it (skipped, so it isn't restamped with today's editor);
  // the other was rewritten.
  expect(j.skipped).toBe(1);
  expect(j.updated).toBe(1);
  const after = await lines(po.id);
  expect(after.every((l) => l.dimensions === '13 x 9 x 5 in')).toBe(true);
  expect(after.reduce((n, l) => n + l.qty_expected, 0)).toBe(5);
});

test('a bulk apply merges only lines that become the SAME shoe, size and carton', async ({ request }) => {
  const { po, box } = await order(request);
  // Two cartons of one size (these should merge) and a third size that must not.
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 2, dimensions: '13 x 9 x 5 in' });
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 3, dimensions: '15 x 10 x 6 in' });
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '12', qty: 4, dimensions: '15 x 10 x 6 in' });
  const before = await lines(po.id);
  expect(before).toHaveLength(3);

  const r = await request.post('/api/po/lines-dimensions', {
    headers: auth('ph_team'), data: { lineIds: before.map((l) => l.id), dimensions: '13 x 9 x 5 in' },
  });
  expect((await r.json()).merged).toBe(1);
  const after = await lines(po.id);
  // Size 9 collapsed to one line of 5; size 12 kept its own line, re-carton'd.
  expect(after).toHaveLength(2);
  expect(after.find((l) => l.size === '9').qty_expected).toBe(5);
  expect(after.find((l) => l.size === '12').qty_expected).toBe(4);
  expect(after.every((l) => l.dimensions === '13 x 9 x 5 in')).toBe(true);
});

test('a bulk apply is refused on a shoes order rather than filling it with dimensions', async ({ request }) => {
  const { po, box } = await order(request, 'shoes');
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 1 });
  const line = (await lines(po.id))[0];
  const r = await request.post('/api/po/lines-dimensions', {
    headers: auth('ph_team'), data: { lineIds: [line.id], dimensions: '13 x 9 x 5 in' },
  });
  expect(r.status()).toBe(400);
  expect(await r.text()).toContain('for shoes');
});

test('PH can switch an order that was already raised on the shoes form', async ({ request }) => {
  // The case this shipped for: the order existed before anyone said it was for boxes,
  // and the supplier is waiting to declare against it.
  const { po, box } = await order(request, 'shoes');
  const r = await request.post('/api/po/update', { headers: auth('ph_team'), data: { poId: po.id, orderKind: 'boxes' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await r.json()).po.order_kind).toBe('boxes');
  // The change is on the order's thread — that thread is its only audit trail.
  const notes = await q("SELECT body FROM po_comments WHERE po_id = $1 AND kind = 'system'", [po.id]);
  expect(notes.some((n) => /empty shoe boxes/.test(n.body))).toBe(true);
  // And the supplier can now declare against it.
  const ok = await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 1, dimensions: '13 x 9 x 5 in' });
  expect(ok.ok(), await ok.text()).toBeTruthy();
});

test('a settled order will not change kind — its count was agreed as what it was', async ({ request }) => {
  const { po } = await order(request);
  await q("UPDATE purchase_orders SET status = 'reconciled' WHERE id = $1", [po.id]);
  const r = await request.post('/api/po/update', { headers: auth('ph_team'), data: { poId: po.id, orderKind: 'shoes' } });
  expect(r.status()).toBe(409);
});

test('a supplier cannot bulk-apply onto somebody else’s order', async ({ request }) => {
  const { po, box } = await order(request);
  await scan(request, { poBoxId: box.id, sku: SKU_A, size: '9', qty: 1, dimensions: '13 x 9 x 5 in' });
  const line = (await lines(po.id))[0];
  const r = await request.post('/api/po/lines-dimensions', {
    headers: auth('supplier', SUPPLIER_UID + 99999),
    data: { lineIds: [line.id], dimensions: '15 x 10 x 6 in' },
  });
  expect(r.status()).toBe(403);
});
