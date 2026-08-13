// When can a label's manifest still be edited?
//
// Reported live: an order part-received (status 'receiving') with a NEW label added for
// the rest of the shipment — the supplier could see the label and its Add button, but
// every save came back "This order is already shipped". The gate was keyed on the ORDER
// being a draft, while a multi-label order flips to 'receiving' the moment the first box
// lands. Labels still sitting at the supplier were locked out of their own manifest.
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
const SUPPLIER = 'E2E Window Supplier';
const SKU = 'E2E-WINDOW-1';
// purchase_orders.supplier_user_id is a real FK, so the portal's own scoping check needs
// a real account behind it.
let SUPPLIER_UID;
let OTHER_UID;

test.beforeAll(async () => {
  const mk = async (username) => (await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1, $2, 'x', 'supplier', 'approved')
     ON CONFLICT (username) DO UPDATE SET role = 'supplier' RETURNING id`,
    [`E2E ${username}`, username],
  ))[0].id;
  SUPPLIER_UID = Number(await mk('e2e_window_supplier'));
  OTHER_UID = Number(await mk('e2e_window_other'));
});

test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM users WHERE username IN ($1, $2)', ['e2e_window_supplier', 'e2e_window_other']);
  await pool.end();
});

// A part-received order: label 1 delivered, label 2 still pending at the supplier.
async function partReceivedOrder(request) {
  const r = await request.post('/api/po/create', {
    headers: auth('ph_team'),
    data: {
      supplierName: SUPPLIER, tagCode: `WIN${Date.now() % 100000}`,
      labels: [{ trackingNumber: `E2E-WIN-A-${Date.now()}` }, { trackingNumber: `E2E-WIN-B-${Date.now()}` }],
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const po = (await r.json()).po;
  await q('UPDATE purchase_orders SET status = $1, supplier_user_id = $2 WHERE id = $3', ['receiving', SUPPLIER_UID, po.id]);
  const boxes = await q('SELECT id, box_number FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [po.id]);
  await q("UPDATE po_boxes SET status = 'delivered' WHERE id = $1", [boxes[0].id]);
  return { po, delivered: boxes[0], pending: boxes[1] };
}

test('a label still pending can be filled while the order is being received', async ({ request }) => {
  const { po, pending } = await partReceivedOrder(request);
  const res = await request.post('/api/po/scan', {
    headers: auth('supplier', SUPPLIER_UID),
    data: { poId: po.id, poBoxId: pending.id, sku: SKU, size: '10', qty: 2, name: 'E2E Window Runner' },
  });
  expect(res.status(), await res.text()).toBe(200);
  const lines = await q('SELECT qty_expected FROM po_lines WHERE po_box_id = $1', [pending.id]);
  expect(lines[0].qty_expected).toBe(2);
});

test('a label added AFTER the order started arriving can be filled too', async ({ request }) => {
  const { po } = await partReceivedOrder(request);
  // The new label the supplier was given for the rest of the shipment.
  const [fresh] = await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 3, $2, 'pending') RETURNING id`,
    [po.id, `E2E-WIN-NEW-${Date.now()}`],
  );
  const res = await request.post('/api/po/scan', {
    headers: auth('supplier', SUPPLIER_UID),
    data: { poId: po.id, poBoxId: fresh.id, sku: SKU, size: '9', qty: 1, name: 'E2E Window Runner' },
  });
  expect(res.status(), await res.text()).toBe(200);
});

test('a pre_transit label is still the supplier\'s to fill, close and ship', async ({ request }) => {
  const { po, pending } = await partReceivedOrder(request);
  // What 17TRACK reports minutes after the label is made: "Label Created, UPS has not
  // received the package yet". The parcel is still on the supplier's floor.
  await q("UPDATE po_boxes SET status = 'pre_transit' WHERE id = $1", [pending.id]);

  const add = await request.post('/api/po/scan', {
    headers: auth('supplier', SUPPLIER_UID),
    data: { poId: po.id, poBoxId: pending.id, sku: SKU, size: '11', qty: 3, name: 'E2E Window Runner' },
  });
  expect(add.status(), await add.text()).toBe(200);

  // …and they can still get it out of the door: close it, then ship it.
  const close = await request.post('/api/po/close-box', { headers: auth('supplier', SUPPLIER_UID), data: { poBoxId: pending.id } });
  expect(close.status(), await close.text()).toBe(200);
  expect((await q('SELECT status FROM po_boxes WHERE id = $1', [pending.id]))[0].status).toBe('packed');
  const ship = await request.post('/api/po/ship', { headers: auth('supplier', SUPPLIER_UID), data: { poBoxId: pending.id } });
  expect(ship.status(), await ship.text()).toBe(200);
});

test('a label that already shipped stays closed — its manifest is the evidence', async ({ request }) => {
  const { po, delivered } = await partReceivedOrder(request);
  const res = await request.post('/api/po/scan', {
    headers: auth('supplier', SUPPLIER_UID),
    data: { poId: po.id, poBoxId: delivered.id, sku: SKU, size: '9', qty: 1 },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toMatch(/on its way/i);
});

test('a packed label asks to be reopened rather than silently accepting', async ({ request }) => {
  const { po, pending } = await partReceivedOrder(request);
  await q("UPDATE po_boxes SET status = 'packed' WHERE id = $1", [pending.id]);
  const res = await request.post('/api/po/scan', {
    headers: auth('supplier', SUPPLIER_UID),
    data: { poId: po.id, poBoxId: pending.id, sku: SKU, size: '9', qty: 1 },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toMatch(/reopen/i);
});

test('once the order is reconciled the manifest is frozen', async ({ request }) => {
  const { po, pending } = await partReceivedOrder(request);
  await q("UPDATE purchase_orders SET status = 'reconciled' WHERE id = $1", [po.id]);
  const res = await request.post('/api/po/scan', {
    headers: auth('supplier', SUPPLIER_UID),
    data: { poId: po.id, poBoxId: pending.id, sku: SKU, size: '9', qty: 1 },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toMatch(/reconciled/i);
});

test.describe('PH entering the manifest on the supplier’s behalf', () => {
  test('can write a label that has already shipped or landed', async ({ request }) => {
    const { po, delivered } = await partReceivedOrder(request);
    // The case this exists for: the supplier doesn't use the portal and sends their list
    // by message, often after the box has already been received.
    const res = await request.post('/api/po/scan', {
      headers: auth('ph_team'),
      data: { poId: po.id, poBoxId: delivered.id, sku: SKU, size: '9', qty: 4, name: 'E2E Window Runner' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const [line] = await q('SELECT qty_expected, entered_on_behalf FROM po_lines WHERE po_box_id = $1', [delivered.id]);
    expect(line.qty_expected).toBe(4);
    // Stamped, so the record says who wrote it — that's what makes a late manifest honest.
    expect(line.entered_on_behalf).toBe(true);
  });

  test('can fix a line it just entered on a shipped label', async ({ request }) => {
    const { po, delivered } = await partReceivedOrder(request);
    await request.post('/api/po/scan', {
      headers: auth('ph_team'),
      data: { poId: po.id, poBoxId: delivered.id, sku: SKU, size: '9', qty: 4, name: 'E2E Window Runner' },
    });
    const [line] = await q('SELECT id FROM po_lines WHERE po_box_id = $1', [delivered.id]);
    const res = await request.post('/api/po/line', {
      headers: auth('ph_team'), data: { lineId: Number(line.id), qty: 6 },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await q('SELECT qty_expected FROM po_lines WHERE id = $1', [line.id]))[0].qty_expected).toBe(6);
  });

  test('but the SUPPLIER still cannot rewrite a label the carrier has taken', async ({ request }) => {
    const { po, delivered } = await partReceivedOrder(request);
    const res = await request.post('/api/po/scan', {
      headers: auth('supplier', SUPPLIER_UID),
      data: { poId: po.id, poBoxId: delivered.id, sku: SKU, size: '9', qty: 4 },
    });
    expect(res.status()).toBe(409);
  });

  test('and a reconciled order is frozen even on their behalf', async ({ request }) => {
    const { po, delivered } = await partReceivedOrder(request);
    await q("UPDATE purchase_orders SET status = 'reconciled' WHERE id = $1", [po.id]);
    const res = await request.post('/api/po/scan', {
      headers: auth('ph_team'),
      data: { poId: po.id, poBoxId: delivered.id, sku: SKU, size: '9', qty: 1 },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/reconciled/i);
  });
});

test('another supplier still cannot touch this order', async ({ request }) => {
  const { po, pending } = await partReceivedOrder(request);
  const res = await request.post('/api/po/scan', {
    headers: auth('supplier', OTHER_UID),
    data: { poId: po.id, poBoxId: pending.id, sku: SKU, size: '9', qty: 1 },
  });
  expect(res.status()).toBe(403);
});
