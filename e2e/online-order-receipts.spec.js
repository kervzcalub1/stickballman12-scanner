// An online order finds its own receipt (docs/context/online-orders.md → "The receipt links
// itself"). The store's confirmation email is found by the ORDER NUMBER and filed as a
// receipt; the order shows it, and an order shipped in several parcels (one online order per
// parcel, same number) is checked against the receipt as a whole.
//
// The real mailbox search is never called from here (MAKE_RECEIPT_PARSER_URL is blanked for
// the suite); the lookup's outside world is swapped through `io`.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';
import { parseShopifyOrderEmail, mentionsOrder, receiptBodyFromLookup, checkOrderReceipt, RETRY_MIN } from '../api/_lib/online-order-receipts.js';
import { receiptLink } from '../src/lib/onlineOrders.js';
import { parseShopifyShipmentEmail, splitOrderEmails, parcelsFromEmails, syncOrderParcels } from '../api/_lib/online-order-shipments.js';
import { planParcels } from '../src/lib/onlineOrderParcels.js';
import { onlineOrdersByKey, carveOnlineOrder } from '../api/_lib/db.js';

const PH = { Authorization: `Bearer ${signToken({ uid: 'oor-ph', username: 'oor_ph', name: 'OOR PH', role: 'ph_team' })}` };
const WH = { Authorization: `Bearer ${signToken({ uid: 'oor-wh', username: 'oor_wh', name: 'OOR Warehouse', role: 'warehouse' })}` };
const KEY = process.env.RECEIPT_INGEST_KEY;
const STORE = 'E2E-OOR Shoe Shop';
const stamp = Date.now().toString(36).toUpperCase();
const NO = `E2EOOR${stamp}`;
let db;

// A Shopify store's order confirmation as the mailbox hands it over (plain text).
const EMAIL = `
Thank you for your order!

Order #${NO}

We're getting your order ready to be shipped. We will notify you when it has been sent.

Order summary

Speedcat Ballet Lace Womens Lifestyle Shoes (Ruby Shimmer/Frosted Ivory) × 10

7.5

$1,000.00

Court Runner Mens (Black/White) × 2

Black / 10

$240.00

$199.98

Subtotal

$1,199.98

Shipping

$0.00

Taxes

$71.40

Total

$1,271.38 USD

Customer information

If you have any questions, reply to this email or contact us at CustomerService@ShoeShop.com.
`;
const lookup = (over = {}) => ({
  ok: true, transaction_id: NO, store: null, mailbox: 'gmail', folder: '[Gmail]/All Mail',
  email: { subject: `Order #${NO} confirmed`, from: 'store@t.shopifyemail.com', date_iso: '2026-10-24T04:02:56.000Z', folder: '[Gmail]/All Mail', text: EMAIL },
  totals: { subtotal: 1199.98, tax: 71.4, shipping: 0, total: null }, items: [], warnings: ['store_not_detected', 'no_items_parsed'], ...over,
});

const clean = async () => {
  await db.query(`DELETE FROM online_orders WHERE store LIKE 'E2E-OOR%'`);
  await db.query(`DELETE FROM email_receipts WHERE order_number LIKE 'E2EOOR%'`);
  await db.query(`DELETE FROM online_order_receipt_checks WHERE order_key LIKE 'E2EOOR%'`);
  await db.query(`DELETE FROM online_order_shipments WHERE order_key LIKE 'E2EOOR%'`);
  await db.query(`DELETE FROM online_order_ship_checks WHERE order_key LIKE 'E2EOOR%'`);
};
test.beforeAll(async () => { db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); await clean(); });
test.afterAll(async () => { await clean(); await db.end(); });

const save = (request, data) => request.post('/api/online-orders/save', { headers: PH, data });
const get = async (request, id) => (await (await request.get(`/api/online-orders/get?id=${id}`, { headers: PH })).json()).order;
const parcel = async (request, qty, over = {}) => {
  const r = await save(request, { store: STORE, order_number: NO, lines: [{ sku: 'OOR-SPEEDCAT', size: '7.5', qty, unit_price: 100 }], ...over });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).id;
};

test('a Shopify order confirmation reads into items, sizes and totals', () => {
  const p = parseShopifyOrderEmail(EMAIL);
  expect(p.items).toEqual([
    { name: 'Speedcat Ballet Lace Womens Lifestyle Shoes (Ruby Shimmer/Frosted Ivory)', size: '7.5', qty: 10, final_price: 1000 },
    // a struck-through price then the discounted one: the last is what was paid; "Black / 10" → 10
    { name: 'Court Runner Mens (Black/White)', size: '10', qty: 2, final_price: 199.98 },
  ]);
  expect(p.totals).toEqual({ subtotal: 1199.98, shipping: 0, tax: 71.4, total: 1271.38 });
  expect(p.store).toBe('shoeshop');
  // An email in another shape is not guessed at.
  expect(parseShopifyOrderEmail('Your package is on the way\nTracking 1Z999').items).toEqual([]);
});

test('the email has to carry the number as a whole word', () => {
  expect(mentionsOrder('SP2515272', 'Order #SP2515272 confirmed', '')).toBe(true);
  expect(mentionsOrder('SP2515272', '', 'order sp2515272.')).toBe(true);
  expect(mentionsOrder('2515272', 'Order #SP2515272 confirmed', '')).toBe(false);   // inside a longer number
  expect(mentionsOrder('SP25152', 'Order #SP2515272 confirmed', '')).toBe(false);
  expect(receiptBodyFromLookup('OTHER-99', lookup(), STORE)).toBe(null);
  const body = receiptBodyFromLookup(NO, lookup(), 'Shoe Palace');
  expect(body).toMatchObject({ order_number: NO, store: 'shoeshop', store_location: { name: 'Shoe Palace (online)' }, warnings: [] });
  expect(body.totals.total).toBe(1271.38);
  expect(body.items).toHaveLength(2);
});

test('the lookup: already filed costs no search; not found is asked again later; found is filed once', async () => {
  const io = (over) => {
    const log = { asked: 0, filed: [], marks: [] };
    return { log, io: {
      existing: async () => null, storeOf: async () => 'Shoe Palace', configured: () => true,
      ask: async () => { log.asked += 1; return { found: false }; },
      file: async (row) => { log.filed.push(row); return { id: 77 }; },
      mark: async (key, m) => { log.marks.push({ key, ...m }); }, ...over(log),
    } };
  };
  // Already in email_receipts (a mailbox check filed it): linked, and the mailbox is not asked.
  let t = io(() => ({ existing: async () => ({ id: 5 }) }));
  expect(await checkOrderReceipt(` #${NO.toLowerCase()} `, { io: t.io })).toEqual({ state: 'found', receiptId: 5 });
  expect(t.log.asked).toBe(0);

  // Not in the mailbox yet: asked again in 15 min, then 2 h, then a day, then it stops.
  for (const [tries, next] of [[0, RETRY_MIN[0]], [1, RETRY_MIN[1]], [2, RETRY_MIN[2]], [3, null]]) {
    t = io(() => ({}));
    expect((await checkOrderReceipt(NO, { tries, io: t.io })).state).toBe('not_found');
    expect(t.log.marks[0]).toMatchObject({ key: NO, state: 'not_found', nextInMin: next });
  }

  // Found: filed under the order's own number, with the items read here.
  t = io((log) => ({ ask: async () => { log.asked += 1; return { found: true, payload: lookup() }; } }));
  expect(await checkOrderReceipt(NO, { io: t.io })).toEqual({ state: 'found', receiptId: 77 });
  expect(t.log.filed[0]).toMatchObject({ order_number: NO, store: 'shoeshop', total: 1271.38, store_name: 'Shoe Palace (online)' });
  expect(t.log.filed[0].items.map((i) => i.qty)).toEqual([10, 2]);
  expect(t.log.marks.at(-1)).toMatchObject({ state: 'found' });

  // The search matched an email about something else: not this order's receipt.
  t = io((log) => ({ ask: async () => ({ found: true, payload: lookup({ email: { subject: 'Your parcel', text: 'tracking 99' } }) }) }));
  expect((await checkOrderReceipt(NO, { io: t.io })).state).toBe('not_found');
  expect(t.log.filed).toHaveLength(0);

  // The search itself failing is an error with a retry, never "no receipt".
  t = io(() => ({ ask: async () => { throw new Error('boom'); } }));
  expect((await checkOrderReceipt(NO, { io: t.io })).state).toBe('error');
  expect(t.log.marks[0]).toMatchObject({ state: 'error', nextInMin: RETRY_MIN[0] });

  // No mailbox search on this server: nothing is asked.
  t = io(() => ({ configured: () => false }));
  expect((await checkOrderReceipt(NO, { io: t.io })).state).toBe('unconfigured');
  expect(t.log.asked).toBe(0);
  // Too short to be an order number.
  expect((await checkOrderReceipt('12', { io: t.io })).state).toBe('skipped');
});

test('receiptLink: pairs are compared across every parcel of the order number', () => {
  const same = [{ id: 1, pairs: 3 }, { id: 2, pairs: 3 }, { id: 3, pairs: 2 }, { id: 4, pairs: 2 }];
  expect(receiptLink({ order_number: 'X-1000', receipt: { pairs: 10 }, same_order: same })).toMatchObject({ state: 'linked', parcels: 4, entered: 10, agrees: true });
  expect(receiptLink({ order_number: 'X-1000', receipt: { pairs: 12 }, same_order: same })).toMatchObject({ state: 'linked', agrees: false, receiptPairs: 12 });
  expect(receiptLink({ order_number: 'X-1000', receipt: { pairs: 0 }, same_order: same }).agrees).toBe(null);
  expect(receiptLink({ order_number: '', same_order: null }).state).toBe('no_number');
  expect(receiptLink({ order_number: 'X-1000', receipt_check: { state: 'pending' } }).state).toBe('looking');
  expect(receiptLink({ order_number: 'X-1000', receipt_check: { state: 'not_found', next_at: '2026-11-18T10:00:00Z' } })).toMatchObject({ state: 'not_found', retrying: true });
  expect(receiptLink({ order_number: 'X-1000', receipt_check: { state: 'unconfigured' } }).state).toBe('none');
  expect(receiptLink({ order_number: 'X-1000' }).state).toBe('none');
});

test('four parcels, one order number: the receipt links to all four and the pairs add up', async ({ request, page }) => {
  const ids = [];
  for (const q of [3, 3, 2, 2]) ids.push(await parcel(request, q, { tracking_number: `1ZE2EOOR${stamp}${ids.length}` }));
  // Saving the number queued a look; this server has no mailbox search, so it says "not looked for".
  let o = await get(request, ids[0]);
  expect(o.receipt).toBe(null);
  expect(o.receipt_link).toMatchObject({ parcels: 4, entered: 10 });
  expect(['none', 'looking']).toContain(o.receipt_link.state);

  // The confirmation is filed (here through the mailbox check's own door).
  const body = receiptBodyFromLookup(NO, lookup({ email: { ...lookup().email, text: EMAIL.replace(/\nCourt Runner[\s\S]*?\$199\.98\n/, '\n') } }), STORE);
  const r = await request.post('/api/receipts/ingest', { headers: { 'x-api-key': KEY }, data: body });
  expect(r.ok(), await r.text()).toBeTruthy();

  for (const id of ids) {
    o = await get(request, id);
    expect(o.receipt).toMatchObject({ subject: `Order #${NO} confirmed`, pairs: 10 });
    expect(o.receipt_link).toMatchObject({ state: 'linked', parcels: 4, entered: 10, receiptPairs: 10, agrees: true });
  }
  // The list carries it too, and the warehouse reads the same.
  const list = await (await request.get(`/api/online-orders/list?q=${NO}`, { headers: WH })).json();
  expect(list.orders).toHaveLength(4);
  expect(list.orders.every((x) => x.receipt_link.state === 'linked')).toBe(true);
  // The Receipts list points back at the four orders.
  const rc = await (await request.get(`/api/receipts/list?q=${NO}`, { headers: PH })).json();
  expect(rc.rows[0].online_order_ids.map(Number)).toEqual(ids);

  // A parcel entered short: every parcel of the number says the receipt differs.
  const one = await get(request, ids[3]);
  const edit = await save(request, { id: ids[3], store: STORE, order_number: NO, tracking_number: one.tracking_number,
    lines: [{ sku: 'OOR-SPEEDCAT', size: '7.5', qty: 1, unit_price: 100 }], baseLineIds: one.lines.map((l) => l.id) });
  expect(edit.ok(), await edit.text()).toBeTruthy();
  expect((await get(request, ids[0])).receipt_link).toMatchObject({ entered: 9, receiptPairs: 10, agrees: false });

  // On the page: the receipt panel, the parcels, and the email itself.
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/online-orders?o=${ids[0]}`);
  const panel = page.locator('.oo-receipt');
  await expect(panel).toHaveAttribute('data-receipt-state', 'linked');
  await expect(panel).toContainText(`Order #${NO} confirmed`);
  await expect(panel).toContainText('4 parcels');
  await expect(panel).toContainText('= 9 pairs');
  await expect(panel).toContainText('the receipt says 10');
  await panel.locator('.oo-receipt-open').click();
  const modal = page.getByRole('dialog', { name: 'Receipt' });
  await expect(modal).toContainText('Speedcat Ballet Lace');
  await expect(modal).toContainText('$1,000.00');
  await modal.getByRole('button', { name: 'Close' }).click();
  // A sibling parcel is one click away.
  await panel.getByRole('button', { name: new RegExp(`OO-0*${ids[1]} \\(3\\)`) }).click();
  await expect(page).toHaveURL(new RegExp(`o=${ids[1]}`));
  await expect(page.locator('.oo-receipt')).toContainText('4 parcels');
});

test('no number, no search: who may ask, and what an unconfigured server answers', async ({ request }) => {
  const r = await save(request, { store: STORE, lines: [{ sku: 'OOR-NONUM', size: '9', qty: 1, unit_price: 50 }] });
  const { id } = await r.json();
  expect((await get(request, id)).receipt_link.state).toBe('no_number');
  expect((await request.post('/api/online-orders/receipt', { headers: PH, data: { id } })).status()).toBe(400);
  expect((await request.post('/api/online-orders/receipt', { headers: WH, data: { id } })).status()).toBe(403);
  expect((await request.post('/api/online-orders/receipt', { data: { id } })).status()).toBe(401);

  // With a number, on a server with no mailbox search: told so, and the order is not left "looking".
  const n = `${NO}B`;
  const id2 = (await (await save(request, { store: STORE, order_number: n, lines: [{ sku: 'OOR-NUM', size: '9', qty: 1, unit_price: 50 }] })).json()).id;
  expect((await request.post('/api/online-orders/receipt', { headers: PH, data: { id: id2 } })).status()).toBe(503);
  expect((await get(request, id2)).receipt_link.state).toBe('none');
});

// ---- Tracking numbers fill themselves: the store's shipping emails ---------------------------
const shipEmail = (track, qty, of, subject = `A shipment from order #${NO} is on the way`, over = '') => ({
  subject, from: 'store+1@t.shopifyemail.com', date: '2026-10-24T05:02:19.000Z',
  text: `Some items in your order are on the way
Shoe Shop
Order #${NO}
---------------------------------------
Some items in your order are on the way. Track your
shipment to see the delivery status.
View your order
( https://www.shoeshop.com/1/orders/abc/authenticate?key=xyz )
UPS tracking number: ${track}
( https://www.ups.com/WebTracking?loc=en_US&requester=ST&trackNums=${track} )
Items in this shipment
----------------------
Speedcat Ballet Lace Womens Lifestyle Shoes (Ruby
Shimmer/Frosted Ivory) ×
${qty} of ${of}
7.5
${over}If you have any questions, reply to this email or
contact us at CustomerService@ShoeShop.com.`,
});

test('a Shopify shipping email reads into a parcel: tracking number, carrier, pairs', () => {
  const p = parseShopifyShipmentEmail(shipEmail('1Z16G2050307953950', 4, 10, undefined, 'Court Runner Mens ×\n1\nBlack / 10\n'));
  expect(p).toEqual({ tracking: '1Z16G2050307953950', carrier: 'UPS', status: 'on_the_way', items: [
    { name: 'Speedcat Ballet Lace Womens Lifestyle Shoes (Ruby Shimmer/Frosted Ivory)', size: '7.5', qty: 4 },
    { name: 'Court Runner Mens', size: '10', qty: 1 },
  ] });
  // The confirmation has no tracking number: not a parcel.
  expect(parseShopifyShipmentEmail({ subject: `Order #${NO} confirmed`, text: EMAIL })).toBe(null);

  // On the way, out for delivery, delivered: three emails, ONE parcel, the furthest status.
  const raw = [
    { subject: `Order #${NO} confirmed`, from: 'store+1@t.shopifyemail.com', date: '2026-10-24T04:00:00Z', text: EMAIL },
    shipEmail('1ZAAA0000000000001', 4, 10), shipEmail('1ZAAA0000000000002', 6, 10),
    shipEmail('1ZAAA0000000000001', 4, 10, `A shipment from order #${NO} has been delivered`),
    { ...shipEmail('1ZBBB0000000000009', 1, 1), subject: 'A shipment from order #OTHER is on the way', text: shipEmail('1ZBBB0000000000009', 1, 1).text.replace(NO, 'OTHER77') },
  ].map((e) => `@@SUBJECT@@ ${e.subject}\n@@FROM@@ ${e.from}\n@@DATE@@ ${e.date}\n@@TEXT@@\n${e.text}`).join('\n@@SBM-EMAIL-END@@\n');
  const emails = splitOrderEmails(raw);
  expect(emails).toHaveLength(5);
  const { parcels, shopify } = parcelsFromEmails(NO, emails);
  expect(shopify).toBe(true);
  expect(parcels.map((x) => [x.tracking, x.status, x.items[0].qty])).toEqual([['1ZAAA0000000000001', 'delivered', 4], ['1ZAAA0000000000002', 'on_the_way', 6]]);
  expect(splitOrderEmails('@@SUBJECT@@ \n@@FROM@@ \n@@DATE@@ \n@@TEXT@@\n')).toEqual([]);   // nothing found
});

test('planParcels: fill the entry that IS the parcel, carve the one that holds it, leave the rest to a person', () => {
  const line = (id, qty, over = {}) => ({ id, sku: 'AAA-1', name: 'Speedcat Ballet', size: '7.5', qty, unit_price: 100, ...over });
  const ship = (tracking, qty, size = '7.5', name = 'Speedcat Ballet Lace') => ({ tracking, items: [{ name, size, qty }] });
  const one = { id: 1, tracking_number: null, received_at: null, coupon: 30, tax: 20, shipping: 10, lines: [line(11, 10)] };

  // One entry of 10, parcels of 4 + 2 + 4: carve 4 (the money goes with the pairs), …
  let p = planParcels([one], [ship('T1', 4), ship('T2', 2), ship('T3', 4)]).action;
  expect(p).toMatchObject({ kind: 'carve', orderId: 1, lineIds: [11], tracking: 'T1', pairs: 4,
    lines: [{ sku: 'AAA-1', size: '7.5', qty: 4, unit_price: 100 }], rest: [{ sku: 'AAA-1', qty: 6 }],
    money: { parcel: { coupon: 12, tax: 8, shipping: 4 }, rest: { coupon: 18, tax: 12, shipping: 6 } } });
  // …and when what is left IS the last parcel, its number is simply filled in.
  const after = [{ ...one, lines: [line(12, 4)] }, { id: 2, tracking_number: 'T1', lines: [line(13, 4)] }, { id: 3, tracking_number: 't 2', lines: [line(14, 2)] }];
  expect(planParcels(after, [ship('T1', 4), ship('T2', 2), ship('T3', 4)]).action).toEqual({ kind: 'fill', orderId: 1, tracking: 'T3', pairs: 4 });
  // Everything placed: nothing to do.
  expect(planParcels([{ ...after[0], tracking_number: 'T3' }, after[1], after[2]], [ship('T1', 4), ship('T2', 2), ship('T3', 4)])).toEqual({ action: null, unplaced: [] });

  // Entries typed per parcel by hand: each parcel fills the entry with the same pairs.
  const typed = [{ id: 5, lines: [line(1, 4)] }, { id: 6, lines: [line(2, 2)] }];
  expect(planParcels(typed, [ship('T2', 2)]).action).toMatchObject({ kind: 'fill', orderId: 6 });
  // Two open entries and a parcel that is neither: not guessed.
  expect(planParcels(typed, [ship('T9', 3)])).toEqual({ action: null, unplaced: ['T9'] });
  // More pairs than the entry has, a size it doesn't have, an entry already counted in, a parcel with no items.
  expect(planParcels([one], [ship('T1', 11)]).action).toBe(null);
  expect(planParcels([one], [ship('T1', 2, '9')]).action).toBe(null);
  expect(planParcels([{ ...one, received_at: '2026-11-01' }], [ship('T1', 4)]).action).toBe(null);
  expect(planParcels([one], [{ tracking: 'T1', items: [] }])).toEqual({ action: null, unplaced: ['T1'] });
  // A cancelled pair is never moved; only the active ones are counted.
  expect(planParcels([{ ...one, lines: [line(11, 4), line(12, 6, { cancelled_at: '2026-11-01' })] }], [ship('T1', 4)]).action).toMatchObject({ kind: 'fill' });

  // Two shoes in the same size: the email's name picks the line, or nothing is done.
  const two = { ...one, lines: [line(21, 3, { sku: 'AAA-1', name: 'Speedcat Ballet' }), line(22, 3, { sku: 'BBB-2', name: 'Court Runner' })] };
  expect(planParcels([two], [ship('T1', 2, '7.5', 'Court Runner Mens (Black)')]).action).toMatchObject({ kind: 'carve', lines: [{ sku: 'BBB-2', qty: 2 }], rest: [{ sku: 'AAA-1', qty: 3 }, { sku: 'BBB-2', qty: 1 }] });
  expect(planParcels([two], [ship('T1', 2, '7.5', 'Some Other Shoe')]).action).toBe(null);
  // A number told to skip (it is on another order number's entry) is left alone.
  expect(planParcels([one], [ship('T1', 4)], new Set(['T1'])).action).toBe(null);
});

test('one entry of 10, three parcels in the emails: it becomes three entries with their tracking numbers', async ({ request, page }) => {
  const n = `${NO}S`;
  const r = await save(request, { store: STORE, order_number: n, ordered_on: '2026-10-24', coupon: 30, tax: 20, shipping: 10, gc_pct: 5,
    lines: [{ sku: 'OOR-SPEEDCAT', name: 'Speedcat Ballet', size: '7.5', qty: 10, unit_price: 100 }] });
  const { id } = await r.json();
  const before = await get(request, id);
  const T = [`1ZE2E${stamp}A1`, `1ZE2E${stamp}B2`, `1ZE2E${stamp}C3`];
  const fake = [[T[0], 4], [T[1], 2], [T[2], 4]].map(([t, q]) => shipEmail(t, q, 10)).map((e) => ({ ...e, text: e.text.replaceAll(NO, n) }));
  const raw = fake.map((e) => `@@SUBJECT@@ ${e.subject.replace(NO, n)}\n@@FROM@@ ${e.from}\n@@DATE@@ ${e.date}\n@@TEXT@@\n${e.text}`).join('\n@@SBM-EMAIL-END@@\n');

  const out = await syncOrderParcels(n, { io: { configured: () => true, ask: async () => raw } });
  expect(out.state).toBe('ok');
  expect(out.placed.map((p) => [p.kind, p.pairs])).toEqual([['carve', 4], ['carve', 2], ['fill', 4]]);

  const list = (await (await request.get(`/api/online-orders/list?q=${n}`, { headers: PH })).json()).orders.sort((a, b) => a.id - b.id);
  expect(list.map((o) => [o.tracking_number, o.totals.units, o.coupon, o.tax, o.shipping, o.stage])).toEqual([
    [T[2], 4, 12, 8, 4, 'shipped'], [T[0], 4, 12, 8, 4, 'shipped'], [T[1], 2, 6, 4, 2, 'shipped'],
  ]);
  // No pair's actual cost moved, and the order's money still adds up to what was typed.
  expect(new Set(list.flatMap((o) => o.lines.map((l) => l.each)))).toEqual(new Set(before.lines.map((l) => l.each)));
  expect(list.reduce((s, o) => s + o.totals.total, 0)).toBeCloseTo(before.totals.total, 2);
  // Each new entry says where it came from, and the original says what left.
  const hist = await (await request.get(`/api/online-orders/get?id=${list[1].id}`, { headers: PH })).json();
  expect(hist.events[0]).toMatchObject({ action: 'created', actor: 'Store email' });
  expect(hist.events[0].detail).toContain(`split from OO-${String(id).padStart(4, '0')}`);
  expect(hist.parcels.map((p) => [p.tracking_number, p.pairs, p.order_id])).toEqual([[T[0], 4, list[1].id], [T[1], 2, list[2].id], [T[2], 4, id]]);
  // Asked again: nothing more to do.
  expect((await syncOrderParcels(n, { io: { configured: () => true, ask: async () => raw } })).placed).toEqual([]);
  expect((await (await request.get(`/api/online-orders/list?q=${n}`, { headers: PH })).json()).orders).toHaveLength(3);

  // On the page: the three parcels, each pointing at its entry.
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/online-orders?o=${id}`);
  const box = page.locator('.oo-parcels');
  await expect(box).toHaveAttribute('data-parcels', '3');
  await expect(box.locator('li')).toHaveCount(3);
  await expect(box.locator('li').nth(2)).toContainText('this entry');
  await expect(box.locator('li').first()).toContainText('4 pairs');
  await box.getByRole('button', { name: `OO-${String(list[1].id).padStart(4, '0')}` }).click();
  await expect(page).toHaveURL(new RegExp(`o=${list[1].id}`));
});

test('an entry someone changed in between is left alone, and a store in another shape is not asked again', async ({ request }) => {
  const n = `${NO}G`;
  const { id } = await (await save(request, { store: STORE, order_number: n, lines: [{ sku: 'OOR-G', size: '9', qty: 5, unit_price: 80 }] })).json();
  const o = (await onlineOrdersByKey(n))[0];
  const plan = planParcels([o], [{ tracking: `1ZE2E${stamp}G1`, items: [{ name: 'x', size: '9', qty: 2 }] }]).action;
  // The plan was made from these line ids; a cancel in between changes them.
  const line = (await get(request, id)).lines[0];
  await request.post('/api/online-orders/line', { headers: PH, data: { lineId: line.id, action: 'cancel', qty: 1, reason: 'oot', refund: 'needs_request' } });
  expect(await carveOnlineOrder(plan, 'Store email')).toBe(null);
  expect((await onlineOrdersByKey(n))).toHaveLength(1);

  // Emails came back, none of them a Shopify store's: marked so the worker skips the number.
  const marks = [];
  const nike = '@@SUBJECT@@ Your Nike order\n@@FROM@@ nike@official.nike.com\n@@DATE@@ 2026-11-01T00:00:00Z\n@@TEXT@@\nOrder ' + n + ' has shipped. Tracking 1Z999';
  await syncOrderParcels(n, { io: { configured: () => true, ask: async () => nike, place: async () => [], mark: async (k, m) => marks.push(m) } });
  expect(marks[0]).toMatchObject({ emails: 1, parcels: 0, skip: true });
  // Not configured: nothing is asked.
  expect((await syncOrderParcels(n, { io: { configured: () => false } })).state).toBe('unconfigured');
});
