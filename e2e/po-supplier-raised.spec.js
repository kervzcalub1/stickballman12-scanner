// The workflow inverted: we want the supplier's manifest BEFORE we buy labels.
//
// Was: PH buys courier labels, raises the order around their tracking numbers, and the
// supplier fills each one.
// Now (also): the supplier raises the order, declares the boxes they packed and what is
// in them, asks for labels, and PH assigns the tracking numbers onto boxes that already
// exist. Both directions stay supported.
//
// The rules that have to hold:
//   1. A supplier raises an order for THEMSELVES only, and its boxes start numberless.
//   2. They can add and remove boxes until one has gone — but never set a tracking
//      number, which is ours to buy.
//   3. Asking for labels against nothing is refused; that is the whole point of the change.
//   4. Assigning is a decision PH confirms, and a tracking number stays unique globally.
//   5. Every one of those moves is on the order's audit thread.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const SKU = 'E2E-SUPRAISE-1';
let SUP, OTHER;
const asSupplier = (uid) => ({ Authorization: `Bearer ${signToken({ uid, username: `e2e_sup_${uid}`, name: 'E2E Raise Supplier', role: 'supplier' })}` });
const asPh = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` });
const tn = () => `1Z999RAISE${Date.now()}${Math.floor(Math.random() * 900 + 100)}`;

test.beforeAll(async () => {
  const mk = async (u, n) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($2,$1,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier' RETURNING id`, [u, n]))[0].id);
  SUP = await mk('e2e_raise_sup', 'E2E Raise Supplier');
  OTHER = await mk('e2e_raise_other', 'E2E Other Supplier');
});
test.afterAll(async () => {
  await q(`DELETE FROM purchase_orders WHERE supplier_user_id = ANY($1)`, [[SUP, OTHER]]);
  await q(`DELETE FROM users WHERE username IN ('e2e_raise_sup','e2e_raise_other')`);
  await pool.end();
});

// A supplier-raised order with N numberless boxes and a declared manifest.
//
// Seeded straight into the DB. Almost every test here needs its own order, and
// `po/create` is rate limited to 30/min per IP — going through it made this one file tip
// the whole suite over and fail a neighbouring spec. The CREATE endpoint itself is
// covered by the two tests below that are actually about it.
async function packed(request, boxes = 3) {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, tag_code, expected_boxes, status)
     VALUES ('E2E Raise Supplier', $1, 'supplier', 'E2E-RAISE', $2, 'draft') RETURNING *`,
    [SUP, boxes],
  ))[0];
  const rows = await q(
    `INSERT INTO po_boxes (po_id, box_number, status)
     SELECT $1, g, 'pending' FROM generate_series(1, $2) g RETURNING *`,
    [po.id, boxes],
  );
  rows.sort((a, b) => a.box_number - b.box_number);
  for (const b of rows) {
    await request.post('/api/po/scan', {
      headers: asSupplier(SUP),
      data: { poBoxId: b.id, sku: SKU, name: 'E2E Raise Runner', size: '9', qty: 4, unitCost: 80 },
    });
  }
  return { po, boxes: rows };
}

test('a supplier raises their own order, and its boxes start with no tracking number', async ({ request }) => {
  const { po, boxes } = await packed(request, 3);
  expect(po.raised_by).toBe('supplier');
  expect(Number(po.supplier_user_id)).toBe(SUP);
  expect(boxes).toHaveLength(3);
  expect(boxes.every((b) => !b.tracking_number)).toBe(true);
  expect(boxes.map((b) => b.box_number)).toEqual([1, 2, 3]);
});

test('a supplier says whether the shipment is shoes or empty boxes', async ({ request }) => {
  // The two features compose: a supplier-raised order can be an empty-box order, and then
  // it demands a carton size on every line exactly as a PH-raised one does.
  const r = await request.post('/api/po/create', {
    headers: asSupplier(SUP), data: { boxes: 1, orderKind: 'boxes' },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { po, boxes } = await r.json();
  expect(po.order_kind).toBe('boxes');
  expect(po.raised_by).toBe('supplier');

  const sizeOnly = await request.post('/api/po/scan', {
    headers: asSupplier(SUP), data: { poBoxId: boxes[0].id, sku: SKU, size: '9', qty: 1 },
  });
  expect(sizeOnly.status()).toBe(400);
  const ok = await request.post('/api/po/scan', {
    headers: asSupplier(SUP),
    data: { poBoxId: boxes[0].id, sku: SKU, name: 'E2E', size: '9', qty: 6, dimensions: { l: 330, w: 230, h: 130, unit: 'mm' } },
  });
  expect(ok.ok(), await ok.text()).toBeTruthy();
  expect((await ok.json()).line.dimensions).toBe('330 x 230 x 130 mm');
});

test('a supplier cannot raise an order against somebody else', async ({ request }) => {
  // The account comes off the token, never the body — otherwise one supplier could open
  // orders against another.
  const r = await request.post('/api/po/create', {
    headers: asSupplier(SUP),
    data: { boxes: 1, supplierUserId: OTHER, supplierName: 'E2E Other Supplier' },
  });
  expect(r.ok()).toBeTruthy();
  expect(Number((await r.json()).po.supplier_user_id)).toBe(SUP);
});

test('boxes can be added and removed until one has gone, but never given a tracking number', async ({ request }) => {
  const { po, boxes } = await packed(request, 2);

  const added = await request.post('/api/po/label-add', { headers: asSupplier(SUP), data: { poId: po.id, boxes: 1 } });
  expect(added.ok(), await added.text()).toBeTruthy();
  const extra = (await added.json()).boxes[0];
  expect(extra.box_number).toBe(3);
  expect(extra.tracking_number).toBeNull();

  // Courier numbers are ours to buy.
  const sneaky = await request.post('/api/po/label-add', {
    headers: asSupplier(SUP), data: { poId: po.id, labels: [{ trackingNumber: tn() }] },
  });
  expect(sneaky.status()).toBe(403);

  const gone = await request.post('/api/po/label-remove', {
    headers: asSupplier(SUP), data: { boxId: extra.id, confirm: String(extra.box_number) },
  });
  expect(gone.ok(), await gone.text()).toBeTruthy();

  // Once a box has actually left, it is a record of something physical.
  await q(`UPDATE po_boxes SET status = 'shipped' WHERE id = $1`, [boxes[0].id]);
  const late = await request.post('/api/po/label-remove', {
    headers: asSupplier(SUP), data: { boxId: boxes[0].id, confirm: String(boxes[0].box_number) },
  });
  expect(late.status()).toBe(409);
  expect(await late.text()).toContain('already on its way');
});

test('asking for labels against nothing is refused — that is the point of the change', async ({ request }) => {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, expected_boxes, status)
     VALUES ('E2E Raise Supplier', $1, 'supplier', 2, 'draft') RETURNING *`, [SUP]))[0];
  await q(`INSERT INTO po_boxes (po_id, box_number, status) SELECT $1, g, 'pending' FROM generate_series(1,2) g`, [po.id]);
  const early = await request.post('/api/po/request-labels', { headers: asSupplier(SUP), data: { poId: po.id } });
  expect(early.status()).toBe(400);
  expect(await early.text()).toContain('Nothing is declared');
});

test('the request reaches PH, and assigning answers it', async ({ request }) => {
  const { po, boxes } = await packed(request, 3);
  const asked = await request.post('/api/po/request-labels', { headers: asSupplier(SUP), data: { poId: po.id } });
  expect(asked.ok(), await asked.text()).toBeTruthy();
  expect((await asked.json()).po.labels_requested_at).not.toBeNull();

  const counts = (await (await request.get('/api/items/pending-counts', { headers: asPh() })).json()).counts;
  expect(counts.po_labels_requested).toBeGreaterThan(0);

  // Page order onto box order — the default the client confirms on screen.
  const assignments = boxes.map((b) => ({ boxId: Number(b.id), trackingNumber: tn(), carrierKey: 100002 }));
  const done = await request.post('/api/po/assign-labels', { headers: asPh(), data: { poId: po.id, assignments } });
  expect(done.ok(), await done.text()).toBeTruthy();
  const res = await done.json();
  expect(res.assigned).toBe(3);
  expect(res.allLabelled).toBe(true);
  // Answered, so it drops out of the queue.
  expect(res.po.labels_requested_at).toBeNull();
  const rows = await q('SELECT tracking_number FROM po_boxes WHERE po_id = $1', [po.id]);
  expect(rows.every((r) => r.tracking_number)).toBe(true);
});

test('a partly-assigned order keeps asking', async ({ request }) => {
  // Clearing the flag on the first label would drop it out of the queue with boxes still
  // waiting, and nobody would go back for them.
  const { po, boxes } = await packed(request, 3);
  await request.post('/api/po/request-labels', { headers: asSupplier(SUP), data: { poId: po.id } });
  const done = await request.post('/api/po/assign-labels', {
    headers: asPh(), data: { poId: po.id, assignments: [{ boxId: Number(boxes[0].id), trackingNumber: tn() }] },
  });
  const res = await done.json();
  expect(res.allLabelled).toBe(false);
  expect(res.po.labels_requested_at).not.toBeNull();
});

test('a tracking number can still only ever be on one box', async ({ request }) => {
  const a = await packed(request, 2);
  const shared = tn();
  await request.post('/api/po/assign-labels', {
    headers: asPh(), data: { poId: a.po.id, assignments: [{ boxId: Number(a.boxes[0].id), trackingNumber: shared }] },
  });
  const b = await packed(request, 1);
  const clash = await request.post('/api/po/assign-labels', {
    headers: asPh(), data: { poId: b.po.id, assignments: [{ boxId: Number(b.boxes[0].id), trackingNumber: shared }] },
  });
  expect(clash.status()).toBe(409);
  expect(await clash.text()).toContain('already on box');

  // And not twice within one sheet either.
  const dup = await request.post('/api/po/assign-labels', {
    headers: asPh(),
    data: { poId: a.po.id, assignments: [
      { boxId: Number(a.boxes[0].id), trackingNumber: 'SAME-1' },
      { boxId: Number(a.boxes[1].id), trackingNumber: 'SAME-1' },
    ] },
  });
  expect(dup.status()).toBe(409);
});

test('every move is on the order’s audit thread', async ({ request }) => {
  const { po, boxes } = await packed(request, 2);
  const added = await request.post('/api/po/label-add', { headers: asSupplier(SUP), data: { poId: po.id, boxes: 1 } });
  const extra = (await added.json()).boxes[0];
  await request.post('/api/po/label-remove', { headers: asSupplier(SUP), data: { boxId: extra.id, confirm: String(extra.box_number) } });
  await request.post('/api/po/request-labels', { headers: asSupplier(SUP), data: { poId: po.id } });
  await request.post('/api/po/assign-labels', {
    headers: asPh(), data: { poId: po.id, assignments: boxes.map((b) => ({ boxId: Number(b.id), trackingNumber: tn() })) },
  });

  const log = (await q(`SELECT body FROM po_comments WHERE po_id = $1 AND kind = 'system' ORDER BY id`, [po.id]))
    .map((x) => x.body).join('\n');
  expect(log).toMatch(/box\(es\) added/i);
  expect(log).toMatch(/removed/i);
  expect(log).toMatch(/Labels requested by/i);
  expect(log).toMatch(/tracking number\(s\) assigned/i);
  expect(log).toMatch(/Every box now has a label/i);
});
