// Online Orders — the owner's scenarios (2026-10-01), end to end:
//   ordered → shipped → tracking → delivered            (the good path)
//   ordered → cancelled                                 (never got a tracking number)
//   ordered → shipped → tracking → cancelled            (refund traced to the end)
//   ordered 5 → shipped → tracking → delivered 3 only   (2 not delivered, refund to chase)
// plus: what each pair ACTUALLY cost, who may do what, and the duplicate-tracking guard.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';

const PH = { Authorization: `Bearer ${signToken({ uid: 'oo-ph', username: 'oo_ph', name: 'OO PH', role: 'ph_team' })}` };
const WH = { Authorization: `Bearer ${signToken({ uid: 'oo-wh', username: 'oo_wh', name: 'OO Warehouse', role: 'warehouse' })}` };
const STORE = 'E2E-OO Store';
let db;

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query(`DELETE FROM online_orders WHERE store LIKE 'E2E-OO%'`);
});
test.afterAll(async () => {
  await db.query(`DELETE FROM online_orders WHERE store LIKE 'E2E-OO%'`);
  await db.end();
});

const save = (request, data, headers = PH) => request.post('/api/online-orders/save', { headers, data });
const get = async (request, id) => (await (await request.get(`/api/online-orders/get?id=${id}`, { headers: PH })).json());
const list = async (request, view, q = 'E2E-OO') => (await (await request.get(`/api/online-orders/list?view=${view}&q=${encodeURIComponent(q)}`, { headers: WH })).json());

test('ordered → shipped → delivered: no tracking is "Ordered", tracking makes it expected, the count delivers it', async ({ request }) => {
  const r = await save(request, { store: STORE, order_number: 'A-1', coupon: 30, tax: 21, shipping: 9, gc_pct: 10,
    lines: [{ sku: 'oo-aaa-1', size: '9', qty: 2, unit_price: 100 }, { sku: 'OO-BBB-1', size: '10', qty: 1, unit_price: 200 }] });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { id } = await r.json();

  let { order } = await get(request, id);
  expect(order.stage).toBe('ordered');
  // $30 coupon over 3 pairs, $21 tax + $9 shipping by price, then 10% off for the cards.
  expect(order.lines.map((l) => [l.sku, l.each])).toEqual([['OO-AAA-1', 87.75], ['OO-BBB-1', 184.5]]);
  expect(order.totals.total).toBe(360);
  expect((await list(request, 'ordered')).orders.some((o) => o.id === id)).toBe(true);
  expect((await list(request, 'expected')).orders.some((o) => o.id === id)).toBe(false);

  // Ships: the tracking number puts it on the warehouse's list.
  const edit = await save(request, { id, store: STORE, order_number: 'A-1', tracking_number: `1ZE2EOO${Date.now()}`, coupon: 30, tax: 21, shipping: 9, gc_pct: 10,
    lines: order.lines.map((l) => ({ sku: l.sku, size: l.size, qty: l.qty, unit_price: l.unit_price })) });
  expect(edit.ok(), await edit.text()).toBeTruthy();
  expect((await list(request, 'expected')).orders.some((o) => o.id === id)).toBe(true);

  // The warehouse counts it in — everything arrived.
  ({ order } = await get(request, id));
  const rec = await request.post('/api/online-orders/receive', { headers: WH, data: { id, counts: order.lines.map((l) => ({ lineId: l.id, got: l.qty })) } });
  expect(rec.ok(), await rec.text()).toBeTruthy();
  const after = await get(request, id);
  expect(after.order.stage).toBe('delivered');
  expect(after.events.map((e) => e.action)).toEqual(['created', 'edited', 'received']);
  // Counted once. A second bench on the same parcel is refused, not doubled.
  const again = await request.post('/api/online-orders/receive', { headers: WH, data: { id, counts: [] } });
  expect(again.status()).toBe(409);
});

test('ordered → cancelled: no tracking ever, the refund is still traced', async ({ request }) => {
  const { id } = await (await save(request, { store: STORE, lines: [{ sku: 'OO-CCC-1', size: '8', qty: 1, unit_price: 150 }] })).json();
  let { order } = await get(request, id);
  const cancel = await request.post('/api/online-orders/line', { headers: PH,
    data: { lineId: order.lines[0].id, action: 'cancel', reason: 'oot', refund: 'refunded', amount: 150 } });
  expect(cancel.ok(), await cancel.text()).toBeTruthy();
  ({ order } = await get(request, id));
  expect(order.stage).toBe('cancelled');
  expect(order.lines[0]).toMatchObject({ cancel_reason: 'oot', refund: 'refunded', refund_amount: 150 });
  // Refunded with the cancellation → nothing to chase.
  expect((await list(request, 'followup')).orders.some((o) => o.id === id)).toBe(false);
});

test('shipped → one pair cancelled: the refund is chased to the end, every step in the history', async ({ request }) => {
  const { id } = await (await save(request, { store: STORE, tracking_number: `1ZE2EOOC${Date.now()}`,
    lines: [{ sku: 'OO-DDD-1', size: '11', qty: 2, unit_price: 120 }] })).json();
  let { order } = await get(request, id);
  // Cancel ONE of the two: the line splits, the other pair is still coming.
  const c = await request.post('/api/online-orders/line', { headers: PH,
    data: { lineId: order.lines[0].id, action: 'cancel', qty: 1, reason: 'other', note: 'store email', refund: 'needs_request' } });
  expect(c.ok(), await c.text()).toBeTruthy();
  ({ order } = await get(request, id));
  const active = order.lines.filter((l) => !l.cancelled_at);
  const gone = order.lines.find((l) => l.cancelled_at);
  expect(active).toHaveLength(1); expect(active[0].qty).toBe(1);
  expect(gone).toMatchObject({ qty: 1, refund: 'needs_request' });
  expect(order.stage).toBe('shipped');
  expect((await list(request, 'followup')).orders.some((o) => o.id === id)).toBe(true);

  // Asked the store → waiting → money back. "Refunded" without an amount is refused.
  expect((await request.post('/api/online-orders/line', { headers: PH, data: { lineId: gone.id, action: 'refund', to: 'requested', note: 'ticket 481' } })).ok()).toBeTruthy();
  expect((await request.post('/api/online-orders/line', { headers: PH, data: { lineId: gone.id, action: 'refund', to: 'refunded' } })).status()).toBe(400);
  expect((await request.post('/api/online-orders/line', { headers: PH, data: { lineId: gone.id, action: 'refund', to: 'refunded', amount: 120 } })).ok()).toBeTruthy();
  const after = await get(request, id);
  expect(after.order.lines.find((l) => l.id === gone.id)).toMatchObject({ refund: 'refunded', refund_amount: 120 });
  expect(after.events.map((e) => e.action)).toEqual(['created', 'cancelled', 'refund_requested', 'refund_refunded']);
  expect((await list(request, 'followup')).orders.some((o) => o.id === id)).toBe(false);
});

test('ordered 5 → delivered 3: the 2 missing split off as not delivered, refund to chase', async ({ request }) => {
  const { id } = await (await save(request, { store: STORE, tracking_number: `1ZE2EOOS${Date.now()}`,
    lines: [{ sku: 'OO-EEE-1', size: '9.5', qty: 5, unit_price: 90 }] })).json();
  let { order } = await get(request, id);
  const rec = await request.post('/api/online-orders/receive', { headers: WH, data: { id, counts: [{ lineId: order.lines[0].id, got: 3 }] } });
  expect(rec.ok(), await rec.text()).toBeTruthy();
  ({ order } = await get(request, id));
  expect(order.stage).toBe('delivered');
  expect(order.lines.filter((l) => !l.cancelled_at).map((l) => l.qty)).toEqual([3]);
  expect(order.lines.find((l) => l.cancelled_at)).toMatchObject({ qty: 2, cancel_reason: 'not_delivered', refund: 'needs_request' });
  expect((await list(request, 'followup')).orders.some((o) => o.id === id)).toBe(true);
  // The warehouse's count isn't a cancellation to undo from the PH side.
  const undo = await request.post('/api/online-orders/line', { headers: PH, data: { lineId: order.lines.find((l) => l.cancelled_at).id, action: 'restore' } });
  expect(undo.status()).toBe(409);
  // …and the 3 that arrived are on the shelf — there is nothing left to cancel.
  const late = await request.post('/api/online-orders/line', { headers: PH,
    data: { lineId: order.lines.find((l) => !l.cancelled_at).id, action: 'cancel', reason: 'oot', refund: 'needs_request' } });
  expect(late.status()).toBe(409);
});

test('who may do what, and one tracking number on two orders is caught', async ({ request }) => {
  expect((await save(request, { store: STORE, lines: [{ sku: 'X', size: '9', qty: 1, unit_price: 1 }] }, WH)).status()).toBe(403);
  const track = `1ZE2EOOD${Date.now()}`;
  expect((await save(request, { store: STORE, tracking_number: track, lines: [{ sku: 'OO-FFF-1', size: '9', qty: 1, unit_price: 50 }] })).ok()).toBeTruthy();
  const dup = await save(request, { store: STORE, tracking_number: ` ${track.toLowerCase()} `, lines: [{ sku: 'OO-FFF-2', size: '9', qty: 1, unit_price: 50 }] });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).duplicate).toBeTruthy();
  expect((await save(request, { store: STORE, tracking_number: track, allowDuplicateTracking: true, lines: [{ sku: 'OO-FFF-2', size: '9', qty: 1, unit_price: 50 }] })).ok()).toBeTruthy();
  // A line with no size is refused, not saved half-filled.
  expect((await save(request, { store: STORE, lines: [{ sku: 'OO-GGG-1', qty: 1, unit_price: 50 }] })).status()).toBe(400);
});

test('the page: PH records an order and sees each pair’s actual cost as it types', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/online-orders');
  await page.getByRole('button', { name: '+ New order' }).click();
  await page.getByPlaceholder('Nike.com, Foot Locker…').fill(`${STORE} UI`);
  await page.getByLabel('Line 1 SKU').fill('oo-ui-1');
  await page.getByLabel('Line 1 size').fill('10');
  await page.getByLabel('Line 1 quantity').fill('2');
  await page.getByLabel('Line 1 price').fill('100');
  await page.locator('.pc-field', { hasText: 'Coupon' }).locator('input').fill('20');
  await page.locator('.pc-field', { hasText: 'Tax' }).locator('input').fill('16');
  // $100 − $10 coupon + $8 tax = $98 a pair.
  await expect(page.locator('.oo-each').first()).toHaveText('$98.00');
  // 5% cashback on the $90 after coupon (not on the tax) = $4.50 back → $93.50 a pair.
  await page.locator('.pc-field', { hasText: 'Cashback' }).locator('input').fill('5');
  await expect(page.locator('.oo-each').first()).toHaveText('$93.50');
  await page.getByRole('button', { name: 'Save order' }).click();
  await expect(page.locator('.oo-title')).toContainText('E2E-OO Store UI');
  await expect(page.locator('.oo-stage')).toHaveText('Ordered');
  await expect(page.locator('.oo-lines td b', { hasText: '$93.50' })).toBeVisible();
});

// ---- QA findings, 2026-10-01 — each one pinned so it can't come back -----------------
test('QA: a refused action writes no history, and a counted-in order can’t be un-cancelled', async ({ request }) => {
  const { id } = await (await save(request, { store: STORE, tracking_number: `1ZE2EOOQ${Date.now()}`,
    lines: [{ sku: 'OO-QA-X', size: '9', qty: 1, unit_price: 100 }, { sku: 'OO-QA-Y', size: '10', qty: 1, unit_price: 100 }] })).json();
  let { order } = await get(request, id);
  const y = order.lines.find((l) => l.sku === 'OO-QA-Y');
  const x = order.lines.find((l) => l.sku === 'OO-QA-X');
  const cancelY = () => request.post('/api/online-orders/line', { headers: PH, data: { lineId: y.id, action: 'cancel', reason: 'oot', refund: 'needs_request' } });
  const [a, b] = await Promise.all([cancelY(), cancelY()]);
  expect([a.status(), b.status()].sort()).toEqual([200, 409]);
  expect((await get(request, id)).events.filter((e) => e.action === 'cancelled')).toHaveLength(1);

  expect((await request.post('/api/online-orders/receive', { headers: WH, data: { id, counts: [{ lineId: x.id, got: 1 }] } })).ok()).toBeTruthy();
  const restore = await request.post('/api/online-orders/line', { headers: PH, data: { lineId: y.id, action: 'restore' } });
  expect(restore.status()).toBe(409);
  ({ order } = await get(request, id));
  expect(order.lines.find((l) => l.id === y.id).cancelled_at).toBeTruthy();
});

test('QA: the refund only moves the ways that mean something', async ({ request }) => {
  const { id } = await (await save(request, { store: STORE, lines: [{ sku: 'OO-QA-R', size: '9', qty: 1, unit_price: 80 }] })).json();
  const { order } = await get(request, id);
  const lineId = order.lines[0].id;
  const line = (data) => request.post('/api/online-orders/line', { headers: PH, data: { lineId, ...data } });
  expect((await line({ action: 'cancel', reason: 'other', refund: 'refunded', amount: 80 })).ok()).toBeTruthy();
  expect((await line({ action: 'refund', to: 'requested' })).status()).toBe(409);        // already back
  expect((await line({ action: 'refund', to: 'needs_request' })).ok()).toBeTruthy();     // "not actually back"
  const after = (await get(request, id)).order.lines[0];
  expect(after).toMatchObject({ refund: 'needs_request', refund_amount: null });
  expect((await line({ action: 'refund', to: 'refunded', amount: 0 })).status()).toBe(400);
});

test('cashback is a % of each price after the coupon, pre-tax, after the gift card', async ({ request }) => {
  // $100 + $200, $30 coupon ($15 each), $20 tax, 10% card, 5% cashback:
  //   pair 1: (100 − 15 + 6.67) × 0.9 − 85 × 5% = 82.50 − 4.25 = 78.25
  //   pair 2: (200 − 15 + 13.33) × 0.9 − 185 × 5% = 178.50 − 9.25 = 169.25
  const r = await save(request, { store: STORE, coupon: 30, tax: 20, gc_pct: 10, cashback_pct: 5,
    lines: [{ sku: 'OO-CB-1', size: '9', qty: 1, unit_price: 100 }, { sku: 'OO-CB-2', size: '10', qty: 1, unit_price: 200 }] });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { order } = await get(request, (await r.json()).id);
  expect(order.cashback_pct).toBe(5);
  expect(order.lines.map((l) => l.each)).toEqual([78.25, 169.25]);
  expect(order.totals.cashback).toBe(13.5);
  expect(order.totals.total).toBe(247.5);
  // It's a percentage — over 100 is refused, and so is one that takes a pair below $0.
  const one = [{ sku: 'OO-CB-3', size: '9', qty: 1, unit_price: 100 }];
  expect((await save(request, { store: STORE, cashback_pct: 101, lines: one })).status()).toBe(400);
  expect((await save(request, { store: STORE, gc_pct: 90, cashback_pct: 50, lines: one })).status()).toBe(400);
});

test('QA: bad input is a 400 with a reason, never a 500', async ({ request }) => {
  const one = [{ sku: 'OO-QA-V', size: '9', qty: 1, unit_price: 100 }];
  expect((await save(request, { store: STORE, coupon: 1e20, lines: one })).status()).toBe(400);
  expect((await save(request, { store: STORE, lines: [{ ...one[0], unit_price: 1e15 }] })).status()).toBe(400);
  expect((await save(request, { store: STORE, ordered_on: '2026-13-45', lines: one })).status()).toBe(400);
  expect((await save(request, { store: STORE, coupon: 150, lines: one })).status()).toBe(400);   // coupon > shoes
  expect((await request.get('/api/online-orders/get?id=99999999999999999999', { headers: PH })).status()).toBe(400);
  const { id } = await (await save(request, { store: STORE, lines: one })).json();
  const { order } = await get(request, id);
  const blank = await request.post('/api/online-orders/receive', { headers: WH, data: { id, counts: [{ lineId: order.lines[0].id, got: null }] } });
  expect(blank.status()).toBe(400);
});

test('QA: a form opened before a cancel can’t put the cancelled line back', async ({ request }) => {
  const { id } = await (await save(request, { store: STORE, lines: [{ sku: 'OO-QA-S1', size: '9', qty: 1, unit_price: 50 }, { sku: 'OO-QA-S2', size: '9', qty: 1, unit_price: 50 }] })).json();
  const { order } = await get(request, id);
  const baseLineIds = order.lines.map((l) => l.id);
  await request.post('/api/online-orders/line', { headers: PH, data: { lineId: order.lines[1].id, action: 'cancel', reason: 'oot', refund: 'refunded', amount: 50 } });
  const stale = await save(request, { id, store: STORE, baseLineIds, lines: order.lines.map((l) => ({ sku: l.sku, size: l.size, qty: l.qty, unit_price: l.unit_price })) });
  expect(stale.status()).toBe(409);
});

test('QA: a phone gets no sideways scroll, Back leaves the form, and an untracked order can be counted in', async ({ page, request }) => {
  page.on('pageerror', (err) => { throw err; });
  const { id } = await (await save(request, { store: `${STORE} Phone`, lines: [{ sku: 'OO-QA-P', size: '9', qty: 1, unit_price: 50 }] })).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'ph_team');
  await page.goto('/ph/online-orders');
  await page.waitForSelector('.oo-row');
  const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noSideScroll()).toBe(true);
  await page.getByRole('button', { name: '+ New order' }).click();
  await expect(page.locator('.oo-form')).toBeVisible();
  expect(await noSideScroll()).toBe(true);
  await page.goBack();
  await expect(page.locator('.oo-form')).toHaveCount(0);
  await expect(page.locator('.oo-row').first()).toBeVisible();
  await page.goto(`/ph/online-orders?o=${id}`);
  await expect(page.locator('.oo-stage')).toHaveText('Ordered');
  await expect(page.getByRole('button', { name: 'Count it in…' })).toBeVisible();
});
