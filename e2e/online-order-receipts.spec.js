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
