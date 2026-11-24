// Batch page → "Link to an online order" (2026-11-25).
//
// The situation: a parcel from an online store (Shoe Palace, JD Sports…) is scanned in.
// It is not a supplier's purchase order, yet "Link to a purchase order" was the only
// button on its batch — and the batch only knew its online order when the tracking number
// happened to be typed on it. Now the batch can be tied to the order by hand, the link
// reads both ways, and the pairs with no cost take the order's actual cost.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';
import { estToday } from '../src/lib/format.js';

const hdr = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-bol-${role}`, username: `e2e_bol_${role}`, name: `E2E BOL ${role}`, role })}` });
const PH = hdr('ph_team');
const WH = hdr('warehouse');
const STORE = 'E2E-BOL Store';
const SUPPLIER = 'E2E-BOL Shoe Shop';
const SKU = 'E2EBOL-100';
let db;
const q = (text, values) => db.query(text, values).then((r) => r.rows);

async function cleanup() {
  const rows = await q('SELECT id, batch_id FROM items WHERE sku LIKE $1', ['E2EBOL-%']);
  for (const r of rows) await q('DELETE FROM item_events WHERE item_id = $1', [r.id]);
  await q('DELETE FROM items WHERE sku LIKE $1', ['E2EBOL-%']);
  await q('UPDATE batches SET po_id = NULL WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  const ids = (await q('SELECT id FROM batches WHERE supplier_name = $1', [SUPPLIER])).map((r) => r.id);
  for (const id of ids) {
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM shipment_issues WHERE batch_id = $1', [id]).catch(() => {});
    await q('DELETE FROM inbound_issues WHERE batch_id = $1', [id]).catch(() => {});
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await q(`DELETE FROM online_orders WHERE store LIKE 'E2E-BOL%'`);
}

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await cleanup();
});
test.afterAll(async () => { await cleanup(); await db.end(); });

const uniq = () => `${Date.now()}${Math.floor(performance.now() % 1000)}`;

// A parcel scanned in with no order picked: two size 9s (one cost typed, one blank) and a 10.
async function receive(request, { tracking = null } = {}) {
  const r = await request.post('/api/batches/commit', {
    headers: WH,
    data: {
      batch: { buyer: 'stickballman12', supplier: SUPPLIER, ...(tracking ? { tracking } : { noTracking: true }), dateReceived: estToday() },
      items: [
        { name: 'E2E BOL Runner', sku: SKU, size: '9', cost: 50, withBox: true },
        { name: 'E2E BOL Runner', sku: SKU, size: '9', withBox: true },
        { name: 'E2E BOL Runner', sku: SKU, size: '10', withBox: true },
      ],
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { batchCode } = await r.json();
  const [row] = await q('SELECT id FROM batches WHERE batch_code = $1', [batchCode]);
  return { batchId: Number(row.id), batchCode };
}

async function order(request, { tracking = null, orderNumber = `BOL-${uniq()}`, lines } = {}) {
  const r = await request.post('/api/online-orders/save', {
    headers: PH,
    data: { store: STORE, order_number: orderNumber, ...(tracking ? { tracking_number: tracking } : {}), tax: 30, shipping: 0, coupon: 0, gc_pct: 0,
      lines: lines || [{ sku: 'E2EBOL/100', size: '9', qty: 2, unit_price: 100 }, { sku: 'E2EBOL/100', size: '10', qty: 1, unit_price: 100 }] },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return { id: (await r.json()).id, orderNumber };
}

const full = async (request, id, headers = WH) => (await request.get(`/api/batches/full?id=${id}`, { headers })).json();
const link = (request, batchId, orderId, headers = WH) => request.post('/api/batches/link-online-order', { headers, data: { batchId, orderId } });
const costs = (batchId) => q('SELECT size, cost::float AS cost FROM items WHERE batch_id = $1 ORDER BY id', [batchId]);

test('linking: the order is offered with how many of the batch’s pairs it holds, blank costs fill, a typed cost is kept', async ({ request }) => {
  const b = await receive(request);
  const o = await order(request);
  // An order for a different shoe — offered (recent), but below the one that fits.
  const other = await order(request, { lines: [{ sku: 'E2EBOL-999', size: '9', qty: 1, unit_price: 80 }] });

  expect((await full(request, b.batchId)).onlineOrder).toBeNull();

  const c = await (await request.get(`/api/batches/online-candidates?batchId=${b.batchId}&q=E2E-BOL`, { headers: WH })).json();
  expect(c.batch.pairs).toBe(3);
  const mine = c.orders.filter((x) => [o.id, other.id].includes(x.id));
  // "E2EBOL/100" on the order is "E2EBOL-100" on the box: one code. All 3 pairs are on it.
  expect(mine.map((x) => [x.id, x.on_order, x.tracking_match])).toEqual([[o.id, 3, false], [other.id, 0, false]]);

  const r = await link(request, b.batchId, o.id);
  expect(r.ok(), await r.text()).toBeTruthy();
  // $300 of shoes + $30 tax by price = $110 a pair. Two blanks filled; the typed $50 stays.
  expect((await r.json()).costs).toEqual({ filled: 2, blank: 2 });
  expect(await costs(b.batchId)).toEqual([{ size: '9', cost: 50 }, { size: '9', cost: 110 }, { size: '10', cost: 110 }]);

  const f = await full(request, b.batchId);
  expect(f.onlineOrder).toMatchObject({ id: o.id, source: 'linked', store: STORE, order_number: o.orderNumber, linked_by: 'E2E BOL warehouse' });

  // The order says which batch it became, and its history has the link.
  const got = await (await request.get(`/api/online-orders/get?id=${o.id}`, { headers: PH })).json();
  expect(got.batches.map((x) => [x.batch_code, x.pairs])).toEqual([[b.batchCode, 3]]);
  expect(got.events.map((e) => e.action)).toContain('batch_linked');

  // Searching batches by the store's order number finds a batch linked by hand.
  const s = await (await request.get(`/api/batches/list?q=${encodeURIComponent(o.orderNumber)}`, { headers: WH })).json();
  expect((s.batches || []).map((x) => x.batch_code)).toContain(b.batchCode);

  // Linking the same order twice is a no-op, not a second history line.
  expect((await link(request, b.batchId, o.id)).ok()).toBeTruthy();
  const again = await (await request.get(`/api/online-orders/get?id=${o.id}`, { headers: PH })).json();
  expect(again.events.filter((e) => e.action === 'batch_linked')).toHaveLength(1);

  // Moved to the other order: the first one's history says so.
  expect((await link(request, b.batchId, other.id, PH)).ok()).toBeTruthy();
  expect((await full(request, b.batchId)).onlineOrder.id).toBe(other.id);
  const left = await (await request.get(`/api/online-orders/get?id=${o.id}`, { headers: PH })).json();
  expect(left.batches).toEqual([]);
  expect(left.events.map((e) => e.action)).toContain('batch_unlinked');

  // Unlinked: nothing tied, and the costs stay where they are.
  expect((await link(request, b.batchId, null)).ok()).toBeTruthy();
  expect((await full(request, b.batchId)).onlineOrder).toBeNull();
  expect((await costs(b.batchId)).map((x) => x.cost)).toEqual([50, 110, 110]);
});

test('a tracking match is shown without a link, the hand link wins over it, and a deleted order lets go', async ({ request }) => {
  const tracking = `1ZE2EBOL${uniq()}`;
  const b = await receive(request, { tracking });
  const byTracking = await order(request, { tracking, lines: [{ sku: 'E2EBOL-777', size: '7', qty: 10, unit_price: 60 }] });
  const right = await order(request);

  expect((await full(request, b.batchId)).onlineOrder).toMatchObject({ id: byTracking.id, source: 'tracking' });
  const c = await (await request.get(`/api/batches/online-candidates?batchId=${b.batchId}`, { headers: WH })).json();
  // No search: the tracking match leads, the order that holds the pairs is right behind it.
  expect(c.orders[0]).toMatchObject({ id: byTracking.id, tracking_match: true, on_order: 0 });
  expect(c.orders.find((x) => x.id === right.id)).toMatchObject({ on_order: 3, tracking_match: false });

  expect((await link(request, b.batchId, right.id)).ok()).toBeTruthy();
  expect((await full(request, b.batchId)).onlineOrder).toMatchObject({ id: right.id, source: 'linked' });

  // The order is deleted (recorded by mistake): the batch falls back to its tracking number.
  expect((await request.post('/api/online-orders/delete', { headers: PH, data: { id: right.id } })).ok()).toBeTruthy();
  expect((await full(request, b.batchId)).onlineOrder).toMatchObject({ id: byTracking.id, source: 'tracking' });
});

test('refused: a batch on a purchase order, an order that is not there, a supplier account', async ({ request }) => {
  const b = await receive(request);
  const o = await order(request);
  const po = await request.post('/api/po/create', { headers: PH, data: { supplierName: SUPPLIER, tagCode: `BOL${Date.now() % 100000}`, labels: [{ trackingNumber: `E2EBOLPO${uniq()}` }] } });
  expect(po.ok(), await po.text()).toBeTruthy();
  const poId = (await po.json()).po.id;
  expect((await request.post('/api/po/link-batch', { headers: PH, data: { poId, batchId: b.batchId } })).ok()).toBeTruthy();

  const r = await link(request, b.batchId, o.id);
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toMatch(/purchase order/);
  expect((await full(request, b.batchId)).onlineOrder).toBeNull();

  await request.post('/api/po/unlink-batch', { headers: PH, data: { poId, batchId: b.batchId } });
  expect((await link(request, b.batchId, 987654321)).status()).toBe(404);
  expect((await link(request, 987654321, o.id)).status()).toBe(404);
  expect((await link(request, b.batchId, 'abc')).status()).toBe(400);
  expect((await link(request, b.batchId, o.id, hdr('supplier'))).status()).toBe(403);
  expect((await request.get(`/api/batches/online-candidates?batchId=${b.batchId}`, { headers: hdr('supplier') })).status()).toBe(403);
});

for (const [role, path, orders] of [['warehouse', '/batches', '/online-orders'], ['ph_team', '/ph/batches', '/ph/online-orders']]) {
  test(`${role}: links the batch from the Batch page, then removes the link`, async ({ page, request }) => {
    const b = await receive(request);
    const o = await order(request);
    const code = `OO-${String(o.id).padStart(4, '0')}`;

    await loginAs(page, role);
    await page.goto(`${path}?b=${b.batchId}`);
    await expect(page.getByText('Not received against a purchase order or an online order')).toBeVisible();
    await page.getByRole('button', { name: 'Link to an online order' }).click();

    const dialog = page.getByRole('dialog', { name: 'Link to an online order' });
    await dialog.getByLabel('Search online orders').fill(o.orderNumber);
    const row = dialog.getByRole('button', { name: new RegExp(`${code} · ${STORE}`) });
    await expect(row).toContainText('3 of this batch’s 3 pairs on it');
    await row.click();
    await dialog.getByRole('button', { name: `Link to ${code}` }).click();

    await expect(page.getByRole('status').filter({ hasText: `linked to online order ${code}` })).toContainText('Cost filled on 2 pairs');
    const head = page.locator('.batch-po');
    await expect(head).toContainText(`Online order ${code} · ${STORE} #${o.orderNumber}`);
    await expect(head.getByRole('link', { name: code })).toHaveAttribute('href', `${orders}?o=${o.id}`);
    // Tied to an online order: the purchase-order button is not the one to press any more.
    await expect(page.getByRole('button', { name: 'Link to a purchase order' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Remove the link' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove the link' }).click();
    await expect(page.getByText('Not received against a purchase order or an online order')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link to a purchase order' })).toBeVisible();
  });
}
