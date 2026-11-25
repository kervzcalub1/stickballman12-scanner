// Costs → "From emails" (2026-11-25): what a pair was PAID, read out of the store's emails.
// tracking number → the shipping email (which order, which pairs) → the order's confirmation
// (the price after the store's discount) → the pairs scanned under that tracking number.
// The emails below are the real shapes (Shoe Palace / Shopify, Foot Locker, JD Sports, DTLR),
// cut down. The mailbox itself is never called: the run is handed its answers.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';
import { estToday } from '../src/lib/format.js';
import { readParcel, readOrder, priceParcel, learnNames, orderNumberOf, readSkuLines, priceBySku, priceFromOrder } from '../src/lib/costEmails.js';
import { runCostEmails, applyCostEmailRun, runIsStale, READERS } from '../api/_lib/cost-emails.js';
import { createCostEmailRun, getCostEmailRun } from '../api/_lib/db.js';

const WH = { Authorization: `Bearer ${signToken({ uid: 'e2e-cfe', username: 'e2e_cfe', name: 'E2E CFE', role: 'warehouse' })}` };
const SUPPLIER = 'E2E-CFE Palace';
let db;
const q = (text, values) => db.query(text, values).then((r) => r.rows);

const shipment = (order, trk, items) => ({
  subject: `A shipment from order #${order} is on the way`, from: 'store+8523376@t.shopifyemail.com', date: '2026-10-28T20:53:24.000Z',
  text: `Some items in your order are on the way\n\nShoe Palace\n\nOrder #${order}\n\nView your order \n( https://www.shoepalace.com/x/orders/abc )\n\n`
    + `UPS tracking number: ${trk} \n( https://www.ups.com/WebTracking?trackNums=${trk} )\n\nItems in this shipment\n----------------------\n\n`
    + items.map(([name, n, of, size]) => `${name} ×\n${n} of ${of}\n\n${size}\n\n25OFF\n(-$19.99)\n`).join('\n')
    + '\nIf you have any questions, reply to this email or\ncontact us at CustomerService@ShoePalace.com.',
});
const confirmation = (order) => ({
  subject: `Order #${order} confirmed`, from: 'store+8523376@t.shopifyemail.com', date: '2026-10-28T19:39:25.000Z',
  text: `Thank you for your order!\n\nShoe Palace\n\nOrder #${order}\n\nOrder summary\n-------------\n\n`
    + 'Air Force 1 \'07 Mens Basketball Shoes\n(White/White/Black) × 3\n\n12\n\n25OFF\n(-$59.97)\n\n$239.94\n\n$179.97\n\n'
    + 'Book 1 Mens Basketball Shoes (Sail/Clay\nOrange/Purple) × 10\n\n9\n\n25OFF\n(-$174.90)\n\n$699.80\n\n$524.90\n\n'
    + 'Dunk Low Mens Lifestyle Shoes (Black/White) × 2\n\n9\n\n$200.00\n\n'
    + 'Subtotal\n\n$904.87\n\nShipping\n\n$362.95\n\nTaxes\n\n$0.00\n\nTotal\n\n$1,267.82 USD\n\nYou saved $234.87\n\nCustomer information\n',
});
const footLocker = (trk) => ({
  subject: 'Your order is ready to go', from: 'accountservices_at_em_footlocker_com_x@icloud.com', date: '2026-10-05T14:24:36.000Z',
  text: `Foot Locker Logo\nOrder: 03078660010000004687\nPurchase date: October 04, 2026\nShipping Carrier\nFEDH tracking: ${trk}\nIN THIS PACKAGE\nPackage status Shipped\n`
    + 'NIKE M CAITLIN 1-YL/BL/PK NIKE M CAITLIN 1-YL/BL/PK\nSize 08.0\nQty 1\n$140.00\n5-6 Business Days\nNIKE M CAITLIN 1-YL/BL/PK NIKE M CAITLIN 1-YL/BL/PK\nSize 10.5\nQty 1\n$140.00\nORDER SUMMARY\nSUBTOTAL\n',
});
const jd = (trk) => ({
  subject: 'Your order. We\'ve got the scoop on it.', from: 'jdsports@notifications.jdsports.com', date: '2026-09-23T18:14:19.000Z',
  text: `ORDER UPDATE\nOrder Number: 60033625400\nShipping\nTracking: 1Z12C923YW20008216\nproduct_img\nAIR JORDAN 1 LOW SE\n$80.00\nSize: 12.0 REG\nQuantity: 1\n`
    + `Shipping\nTracking: ${trk}\nproduct_img\nAIR JORDAN 1 LOW SE\n$80.00\nSize: 12.0 REG\nQuantity: 1\nORDER SUMMARY\nSubtotal ( item/s):\n$160.00\nShipping:\n0.00\nTax:\n$0.00\nTotal:\n$145.00\nPayment\n`,
});
const dtlr = (trk) => ({
  subject: 'Order 5864970 Has Been Fulfilled', from: 'custserv@dtlr.com', date: '2026-10-11T20:15:45.000Z',
  text: `Order Fulfillment Confirmation Order #5864970\nOrder Details Description Ord Qty Fulfilled Qty Tracking\nIU3638-100Color=WHITE;Size=10 1 1 UPS Surepost - 1Z16G364YW37491452\n[https://x.y] IU3638-100Color=WHITE;Size=10 1 1 UPS Surepost - ${trk}\n`,
});

test('the readers: each store’s email gives the order, the pairs and the price paid', () => {
  const trk = '1Z16G1890323798719';
  const p = readParcel([shipment('SP2520297', trk, [['Air Force 1 \'07 Mens Basketball Shoes\n(White/White/Black)', 1, 3, '12'], ['Book 1 Mens Basketball Shoes (Sail/Clay\nOrange/Purple)', 1, 10, '9']])], trk);
  expect(p).toMatchObject({ state: 'ok', store: 'Shoe Palace', order: 'SP2520297', priced: false });
  expect(p.items.map((i) => [i.size, i.qty])).toEqual([['12', 1], ['9', 1]]);
  const o = readOrder([confirmation('SP2520297')]);
  // Paid = the line after the discount ÷ pairs; a line with no discount has one amount.
  expect(o.lines.map((l) => [l.size, l.qty, l.full, l.each])).toEqual([['12', 3, 79.98, 59.99], ['9', 10, 69.98, 52.49], ['9', 2, 100, 100]]);
  expect(o.totals).toMatchObject({ subtotal: 904.87, shipping: 362.95 });

  const fl = readParcel([footLocker('878180486028')], '878180486028');
  expect(fl).toMatchObject({ state: 'ok', store: 'Foot Locker', order: '03078660010000004687', priced: true });
  expect(fl.items.map((i) => [i.name, i.size, i.each])).toEqual([['NIKE M CAITLIN 1-YL/BL/PK', '08.0', 140], ['NIKE M CAITLIN 1-YL/BL/PK', '10.5', 140]]);
  // The box in women's sizing (9.5W) is the men's 8 the store sold.
  expect(priceParcel([{ id: 1, sku: 'IH7423-700', size: '9.5W' }, { id: 2, sku: 'IH7423-700', size: '12W' }], fl)).toMatchObject([{ id: 1, each: 140 }, { id: 2, each: 140 }]);

  // JD: only THIS parcel's pair, and the order's $15 off spread by price.
  const j = readParcel([jd('1ZA19Y39YW20215205')], '1ZA19Y39YW20215205');
  expect(j).toMatchObject({ state: 'ok', store: 'JD Sports', order: '60033625400', priced: true });
  expect(j.items).toHaveLength(1);
  expect(j.items[0]).toMatchObject({ full: 80, each: 72.5 });

  // DTLR's fulfilment email has the SKU and the parcel, not the price — the order has that.
  const d = readParcel([dtlr('1Z16G36BYW27622170')], '1Z16G36BYW27622170');
  expect(d).toMatchObject({ state: 'ok', store: 'DTLR', order: '5864970', priced: false });
  expect(d.items).toEqual([{ sku: 'IU3638-100', name: null, size: '10', qty: 1 }]);

  // Nothing to read is said, never guessed.
  expect(readParcel([], 'X')).toEqual({ state: 'no_email' });
  expect(readParcel([{ subject: 'Your Nike gear has shipped', from: 'nike@ship.notifications.nike.com', text: '\n' }], 'X')).toMatchObject({ state: 'no_text', store: 'Nike' });
  expect(orderNumberOf({ subject: 'Order 5864970 Has Been Fulfilled' })).toBe('5864970');
  expect(orderNumberOf({ subject: 'Your order is out for delivery', text: 'Thanks for your order today' })).toBeNull();
});

// 2026-11-26, from the real emails: 94 pairs were saved at a whole LINE's amount (3 pairs at
// $420 each) and the store's discount was never read. These are those emails, cut down.
test('Foot Locker / Champs and JD: the amount is the line’s, the discount is in the summary', () => {
  const FL = 'accountservices_at_em_footlocker_com_x@icloud.com';
  const pkg = (trk, body) => ({ subject: 'Your order is ready to go', from: FL, text: `Order: P7506601398859993088\nFedex tracking: ${trk}\nIn this package\nSHIPPING TO:\nA B\n${body}` });
  // Qty 3 / $420.00 = $140 a pair, and $105 after its share of DISCOUNTS.
  const a = readParcel([pkg('384058607372', 'JRDN AJ1 MID SE-BK/PU/WH\nSize 12.0\nQty 3\n$420.00\n5-6 Business Days\nOrder summary\nSUBTOTAL\n(3 items)\n$420.00\nSHIPPING\nFREE\nDISCOUNTS\n-$105.00\nFLX CASH APPLIED\n$0.00\nTAX\n$0.00\nTOTAL\n$315.00\nPAYMENT\n')], '384058607372');
  expect(a).toMatchObject({ state: 'ok', priced: true, note: 'store discount $105.00 spread by price' });
  expect(a.unsure).toBeUndefined();
  expect(a.items).toEqual([{ name: 'JRDN AJ1 MID SE-BK/PU/WH', size: '12.0', qty: 3, full: 140, each: 105 }]);
  expect(priceParcel([{ id: 1, sku: 'DV1308-004', size: '12' }], a)).toMatchObject([{ id: 1, each: 105, full: 140 }]);
  // On sale: "was now" for the line, on one line or two; then 20% off in the summary.
  for (const amounts of ['$250.00 $179.98', '$250.00\n$179.98']) {
    const r = readParcel([pkg('384058607373', `NIKE M AF1 LO BCA-BK/PK/BK\nSize 13.0\nQty 2\n${amounts}\nOrder summary\nSUBTOTAL\n(2 items)\n$179.98\nDISCOUNTS\n-$36.00\nTOTAL\nNone None None $143.98\n`)], '384058607373');
    expect(r.items).toEqual([{ name: 'NIKE M AF1 LO BCA-BK/PK/BK', size: '13.0', qty: 2, full: 125, each: 71.99 }]);
  }
  // A blank summary ("$", TOTAL $0.00): nothing says whether a discount came off → unsure.
  const blank = readParcel([pkg('384097823588', 'JRDN M AJ1 RET HI OG FC-BK/RD\nSize 09.0\nQty 2\n$370.00\nOrder summary\nSUBTOTAL\n(2 items)\n$\nSHIPPING\nFREE\nTAX\n$\nTOTAL\n$0.00\nPAYMENT\n')], '384097823588');
  expect(blank).toMatchObject({ state: 'ok', priced: true, unsure: true });
  expect(blank.items[0]).toMatchObject({ qty: 2, full: 185, each: 185 });
  // …alone, the price stays and is marked to check; with the order's confirmation, the order wins.
  expect(priceParcel([{ id: 1, sku: 'X', size: '9' }], blank)).toMatchObject([{ id: 1, each: 185, check: true }]);
  const conf = readOrder([{ subject: 'Thank you for your order, Kevin', from: FL,
    text: 'Order: P7506601398859993088\nWe’re working on your order now\nThank you for shopping with us\nSHIPPING TO:\nA B\nJRDN M AJ1 RET HI OG FC-BK/RD\nSize 09.0\nQty 2\n$370.00\nEstimated arrival by Fri, Oct 9.\nOrder summary\nSUBTOTAL\n(2 items)\n$370.00\nSHIPPING\nFREE\nDISCOUNTS\n-$210.02\nTAX\n$0.00\nTOTAL\nNone None None $159.98\nPAYMENT\nGift Card\n' }]);
  expect(conf).toMatchObject({ state: 'ok', store: 'Foot Locker' });
  expect(conf.lines).toEqual([{ name: 'JRDN M AJ1 RET HI OG FC-BK/RD', size: '09.0', qty: 2, full: 185, each: 79.99 }]);
  const viaOrder = priceParcel([{ id: 1, sku: 'X', size: '9' }], blank, conf);
  expect(viaOrder).toMatchObject([{ id: 1, each: 79.99, full: 185 }]);
  expect(viaOrder[0].check).toBeUndefined();

  // JD: "Shipping Tracking:" on one line, a summary of zeros → unsure; the confirmation has the coupon.
  const JD = 'jdsports@notifications.jdsports.com';
  const upd = readParcel([{ subject: 'Your order. We\'ve got the scoop on it.', from: JD,
    text: 'ORDER UPDATE\nOrder Number: 60036952789\nShipping Tracking: 1Z036H8DYW00011845\nWomen\'s Nike V5 RNR\n$105.00\nSize: 9.0\nQuantity: 1\nORDER SUMMARY\nSubtotal ( item/s): $0.00\nShipping: 0.00\nTax: $0.00\nTotal: $0.00\nPayment\n' }], '1Z036H8DYW00011845');
  expect(upd).toMatchObject({ state: 'ok', store: 'JD Sports', order: '60036952789', unsure: true });
  expect(upd.items[0]).toMatchObject({ size: '9.0', qty: 1, each: 105 });
  const jdConf = readOrder([{ subject: 'You\'ve got great taste, alexander', from: JD,
    text: 'Order Number: 60036952789\nWomen\'s Nike V5 RNR\n$105.00\nSize: 9.0\nQuantity: 8\nWomen\'s Nike V5 RNR\n$105.00\nSize: 9.5\nQuantity: 6\nORDER SUMMARY\nSubtotal:\n$1470.00\nCoupon:\nSAVEMORE\n-$294.00\nShipping:\n$0.00\nTax:\n$0.00\nTotal:\n$1176.00\nBILLING ADDRESS\n' }]);
  expect(jdConf.lines.map((l) => [l.size, l.qty, l.full, l.each])).toEqual([['9.0', 8, 105, 84], ['9.5', 6, 105, 84]]);
  expect(priceParcel([{ id: 2, sku: 'IZ2563-133', size: '9W' }], upd, jdConf)).toMatchObject([{ id: 2, each: 84, full: 105 }]);

  // An email we cannot read keeps what it looked like, for whoever writes its reader.
  const un = readParcel([{ subject: 'Your order has shipped', from: FL, text: 'Order: P7506601398859993088\nTracking 384058829670 is on its way to you, nothing else is printed here at all.' }], '384058829670');
  expect(un).toMatchObject({ state: 'unreadable', store: 'Foot Locker', sample: { subject: 'Your order has shipped' } });

  // A preview from the old readers that priced one of these stores cannot be applied.
  expect(runIsStale({ summary: { stores: { 'Foot Locker': { pairs: 3, priced: 2 } } } })).toBe(true);
  expect(runIsStale({ summary: { stores: { 'Shoe Palace': { pairs: 3, priced: 3 } } } })).toBe(false);
  expect(runIsStale({ summary: { v: READERS, stores: { 'Foot Locker': { pairs: 3, priced: 2 } } } })).toBe(false);
});

test('two shoes of one size at two prices: left alone, until the store’s name for the SKU is known', () => {
  const trk = '1ZTWOSHOES000000001';
  const parcel = readParcel([shipment('SP1', trk, [['Book 1 Mens Basketball Shoes (Sail/Clay\nOrange/Purple)', 1, 10, '9'], ['Dunk Low Mens Lifestyle Shoes (Black/White)', 1, 2, '9']])], trk);
  const order = readOrder([confirmation('SP1')]);
  const pairs = [{ id: 1, sku: 'FJ4249-106', size: '9' }, { id: 2, sku: 'DD1391-100', size: '9' }];
  expect(priceParcel(pairs, parcel, order).map((r) => r.reason)).toEqual(Array(2).fill('Two shoes of this size at different prices in the parcel'));
  // Another parcel held only Book 1s under FJ4249-106: that names the shoe.
  const names = new Map();
  const solo = readParcel([shipment('SP1', '1ZSOLO0000000000001', [['Book 1 Mens Basketball Shoes (Sail/Clay\nOrange/Purple)', 2, 10, '9']])], '1ZSOLO0000000000001');
  learnNames(names, [{ sku: 'FJ4249-106', size: '9' }, { sku: 'FJ4249-106', size: '9' }], solo);
  const res = priceParcel(pairs, parcel, order, names);
  expect(res[0]).toMatchObject({ id: 1, each: 52.49, full: 69.98, how: 'parcel' });
  expect(res[1].reason).toBeTruthy();   // the Dunk's name was never learned
});

// adidas' receipt is its HTML with the tags half-stripped; "9-" is a 9.5; Selling Price is
// already after the discounts listed under it.
const adidasReceipt = (rows) => ({
  subject: 'Your adidas receipt', from: 'adidas@us-info.adidas.com', date: '2026-09-05T18:30:14.000Z',
  text: 'adidas<br> &zwnj; &zwnj;<br>' + rows.map(([name, size, sku, price, off]) => `<br><br>${name} &zwnj; ,${size}<br><br> Article No: ${sku}<br><br> &zwnj;Selling Price: $${price} <br><br> &zwnj;60% OFF RED TAG &zwnj; &zwnj; - ${off}<br>`).join(''),
});
const adidasUpdate = {
  subject: 'Your adidas order update', from: 'adidas@us-info.adidas.com', date: '2026-10-02T10:00:00.000Z',
  text: 'UPDATE TO YOUR ORDER ORDER NUMBER: AD9AA055496\nITEMS STILL TO BE SHIPPED\nCart Image\nSAMBA OG SHOES\n$180.00 $45.00 x 4 $120.00\nColor: Aurora Coffee / Off White / Gum\nSize: 8\nQuantity: 4\nArticle No: KI6956\nNEED HELP?',
};

test('by SKU: only emails that PRINT the code count, one price fills, two prices are shown and left', () => {
  const emails = [
    { subject: 'alias Account Management Check in', from: 'someone@goat.com', date: '2026-03-03', text: 'KI6956 is selling well this week, list more pairs.' },
    adidasReceipt([['SAMBA OG W AUCO/OW', '9-', 'KI6956', '59.50', '60.50'], ['SAMBA OG W AUCO/OW', '8', 'KI6956', '59.50', '60.50'], ['CAMPUS 00s STBARK', '8', 'GY6433', '18.69', '36.28']]),
    adidasUpdate,
  ];
  const lines = readSkuLines(emails, 'ki 6956');
  expect(lines.map((l) => [l.size, l.each, l.full, l.store])).toEqual([['9.5', 59.5, 120, 'adidas'], ['8', 59.5, 120, 'adidas'], ['8', 30, 45, 'adidas']]);
  expect(priceBySku({ sku: 'KI6956', size: '9.5W', supplier: 'Adidas' }, lines)).toMatchObject({ each: 59.5, full: 120, how: 'sku', store: 'adidas' });
  expect(priceBySku({ sku: 'KI6956', size: '8', supplier: 'Adidas' }, lines).reason).toBe('Bought at 2 prices ($30.00, $59.50) — pick one by hand');
  expect(priceBySku({ sku: 'KI6956', size: '13', supplier: 'Adidas' }, lines).reason).toMatch(/no line in this size/);
  // Another supplier's pair is not priced off adidas' receipt.
  expect(priceBySku({ sku: 'KI6956', size: '9.5', supplier: 'Foot Locker' }, lines).each).toBeUndefined();
  expect(priceBySku({ sku: 'KI6956', size: '9.5', supplier: 'Adidas' }, []).reason).toBe('No store email prints this SKU');

  // An order number someone gives: its lines print the SKU (adidas), or the size decides when the SKU was named too.
  const ad = readOrder([adidasUpdate]);
  expect(ad).toMatchObject({ state: 'ok', store: 'adidas' });
  expect(priceFromOrder({ sku: 'KI6956', size: '8' }, ad)).toMatchObject({ each: 30, full: 45, how: 'order' });
  const sp = readOrder([confirmation('SP99000222')]);
  expect(priceFromOrder({ sku: 'FQ4296-101', size: '12' }, sp).reason).toMatch(/give the SKU too/);
  expect(priceFromOrder({ sku: 'FQ4296-101', size: '12' }, sp, { trustSize: true })).toMatchObject({ each: 59.99 });
  expect(priceFromOrder({ sku: 'FQ4296-101', size: '9' }, sp, { trustSize: true }).reason).toBeTruthy();   // two shoes in a 9, two prices
});

test.describe('a run, end to end', () => {
  const TRK = `1ZE2ECFE${String(Date.now()).slice(-10)}`;
  let batchId;
  test.beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  });
  test.afterAll(async () => {
    const rows = await q('SELECT id FROM items WHERE sku LIKE $1', ['E2ECFE-%']);
    for (const r of rows) await q('DELETE FROM item_events WHERE item_id = $1', [r.id]);
    await q('DELETE FROM items WHERE sku LIKE $1', ['E2ECFE-%']);
    await q('DELETE FROM batches WHERE supplier_name = $1', [SUPPLIER]);
    await q('DELETE FROM cost_email_runs WHERE supplier = $1', [SUPPLIER]);
    await q('DELETE FROM cost_email_lookups WHERE key IN ($1, $2, $3, $4)', [`T:${TRK}`, 'O:SP99000111', 'O:SP99000333', 'S:E2ECFESTRAY']);
    await db.end();
  });

  test('the run prices the pairs, the preview writes nothing, Apply fills only the blanks', async ({ request }) => {
    const r = await request.post('/api/batches/commit', {
      headers: WH,
      data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, tracking: TRK, dateReceived: estToday() },
        items: [
          { name: 'E2E CFE AF1', sku: 'E2ECFE-AF1', size: '12', withBox: true },
          { name: 'E2E CFE Book', sku: 'E2ECFE-BOOK', size: '9', withBox: true },
          { name: 'E2E CFE Book', sku: 'E2ECFE-BOOK', size: '9', cost: 40, withBox: true },   // already costed: not in the run
          { name: 'E2E CFE Stray', sku: 'E2ECFE-STRAY', size: '14', withBox: true },          // not in the parcel's email
        ] },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    [{ id: batchId }] = await q('SELECT id FROM batches WHERE batch_code = $1', [(await r.json()).batchCode]);

    const asked = [];
    const io = { ask: async (term) => {
      asked.push(term);
      if (term === TRK) return [shipment('SP99000111', TRK, [['Air Force 1 \'07 Mens Basketball Shoes\n(White/White/Black)', 1, 3, '12'], ['Book 1 Mens Basketball Shoes (Sail/Clay\nOrange/Purple)', 2, 10, '9']])];
      if (term === 'SP99000111') return [confirmation('SP99000111')];
      return [];
    } };
    const id = await createCostEmailRun({ supplier: SUPPLIER, from: null, to: null, by: 'E2E' });
    await runCostEmails(id, { io });
    // The parcel, its order, then the one pair still unpriced by its SKU (newsletters left out).
    expect(asked).toEqual([TRK, 'SP99000111', 'E2ECFESTRAY" -from:goat.com "E2ECFESTRAY']);

    const run = await getCostEmailRun(id, { rows: true });
    expect(run.status).toBe('done');
    expect(run.summary).toMatchObject({ pairs: 3, priced: 2, parcels: 1, stores: { 'Shoe Palace': { pairs: 3, priced: 2 } } });
    expect(run.rows.map((x) => [x.sku, x.each, x.full, x.order, x.reason])).toEqual([
      ['E2ECFE-AF1', 59.99, 79.98, 'SP99000111', null],
      ['E2ECFE-BOOK', 52.49, 69.98, 'SP99000111', null],
      ['E2ECFE-STRAY', null, null, 'SP99000111', 'This size is not in the parcel’s email'],
    ]);
    // A preview: nothing on the pairs yet.
    expect((await q('SELECT count(*)::int AS n FROM items WHERE batch_id = $1 AND cost IS NOT NULL', [batchId]))[0].n).toBe(1);

    // The page shows it (the endpoint reads the same run).
    const got = await (await request.get(`/api/items/cost-emails?id=${id}&rows=1`, { headers: WH })).json();
    expect(got.run.rows).toHaveLength(3);

    // Someone types a cost on the AF1 between the preview and the click: theirs wins.
    await q(`UPDATE items SET cost = 61 WHERE batch_id = $1 AND sku = 'E2ECFE-AF1'`, [batchId]);
    const ap = await request.post('/api/items/cost-emails', { headers: WH, data: { action: 'apply', id } });
    expect(ap.ok(), await ap.text()).toBeTruthy();
    expect((await ap.json()).filled).toBe(1);
    expect(await q('SELECT sku, cost::float AS cost, shelf_price::float AS shelf FROM items WHERE batch_id = $1 ORDER BY id', [batchId])).toEqual([
      { sku: 'E2ECFE-AF1', cost: 61, shelf: null }, { sku: 'E2ECFE-BOOK', cost: 52.49, shelf: 52.49 },
      { sku: 'E2ECFE-BOOK', cost: 40, shelf: null }, { sku: 'E2ECFE-STRAY', cost: null, shelf: null },
    ]);
    const [note] = await q(`SELECT e.details->>'text' AS t FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.batch_id = $1 AND e.details->>'text' LIKE 'Cost $52.49%'`, [batchId]);
    expect(note.t).toContain('Shoe Palace email, order SP99000111');
    expect(note.t).toContain('listed $69.98');
    // Applied once.
    expect((await request.post('/api/items/cost-emails', { headers: WH, data: { action: 'apply', id } })).status()).toBe(409);
    expect(await applyCostEmailRun(987654321, 'x')).toMatchObject({ status: 404 });

    // What it read is remembered (a miss for a day): the next run asks the mailbox nothing.
    asked.length = 0;
    const id2 = await createCostEmailRun({ supplier: SUPPLIER, from: null, to: null, by: 'E2E' });
    await runCostEmails(id2, { io });
    expect(asked).toEqual([]);
    expect((await getCostEmailRun(id2)).summary).toMatchObject({ pairs: 1, priced: 0, skus: 1 });

    // Narrowed to the SKU and told the order: the size decides, the pair is priced from it.
    asked.length = 0;
    const conf = confirmation('SP99000333');
    const io3 = { ask: async (term) => { asked.push(term); return term === 'SP99000333' ? [{ ...conf, text: conf.text.replace('× 3\n\n12\n', '× 3\n\n14\n') }] : []; } };
    const id3 = await createCostEmailRun({ supplier: SUPPLIER, from: null, to: null, by: 'E2E', sku: 'E2ECFE-STRAY', order: 'SP99000333' });
    await runCostEmails(id3, { io: io3 });
    expect(asked).toEqual(['SP99000333']);
    const r3 = await getCostEmailRun(id3, { rows: true });
    expect(r3).toMatchObject({ sku: 'E2ECFE-STRAY', order_number: 'SP99000333' });
    expect(r3.rows.map((x) => [x.sku, x.each, x.how, x.order])).toEqual([['E2ECFE-STRAY', 59.99, 'order', 'SP99000333']]);
  });

  test('who may, and a server without the mailbox search says so', async ({ request, page }) => {
    const sup = { Authorization: `Bearer ${signToken({ uid: 'e2e-cfe-s', username: 'e2e_cfe_s', name: 'S', role: 'supplier' })}` };
    expect((await request.get('/api/items/cost-emails', { headers: sup })).status()).toBe(403);
    // The suite runs with MAKE_ORDER_EMAILS_URL unset: a run cannot start, and says why.
    const start = await request.post('/api/items/cost-emails', { headers: WH, data: { action: 'start', supplier: SUPPLIER } });
    expect(start.status()).toBe(503);
    expect((await request.post('/api/items/cost-emails', { headers: WH, data: { action: 'apply' } })).status()).toBe(400);

    await loginAs(page, 'warehouse');
    await page.goto('/costs?tab=emails');
    await expect(page.getByRole('tab', { name: 'From emails' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('The mailbox search is not set up on this server')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read the emails' })).toBeDisabled();
    await expect(page.getByLabel('Only this SKU')).toBeVisible();
    await expect(page.getByLabel('Order number')).toBeVisible();
  });

  test('the tab has its own filters, and says what they match before anything is read', async ({ request, page }) => {
    const TRK2 = '1ZE2ECFE0000000002';
    const r = await request.post('/api/batches/commit', {
      headers: WH,
      data: { batch: { buyer: 'stickballman12', supplier: SUPPLIER, tracking: TRK2, dateReceived: estToday() },
        items: [
          { name: 'E2E CFE Scope', sku: 'E2ECFE-SCOPE', size: '10', withBox: true },
          { name: 'E2E CFE Scope', sku: 'E2ECFE-SCOPE', size: '11', withBox: true },
          { name: 'E2E CFE Scope', sku: 'E2ECFE-SCOPE', size: '12', cost: 50, withBox: true },   // costed: not counted
        ] },
    });
    expect(r.ok()).toBeTruthy();
    // The server's count: this supplier's blank pairs for the SKU, one parcel; a past range has none.
    const scope = async (qs) => (await (await request.get(`/api/items/cost-emails?scope=1&${qs}`, { headers: WH })).json()).scope;
    const s1 = await scope(`supplier=${encodeURIComponent(SUPPLIER)}&sku=E2ECFE-SCOPE`);
    expect(s1).toMatchObject({ pairs: 2, parcels: 1, noTracking: 0 });
    expect(s1.suppliers).toEqual([{ value: SUPPLIER, pairs: 2 }]);
    expect((await scope(`supplier=${encodeURIComponent(SUPPLIER)}&from=2020-01-01&to=2020-01-31`)).pairs).toBe(0);
    // The supplier list is counted without the supplier filter: picking one keeps the others.
    expect((await scope('supplier=Nobody%20At%20All&sku=E2ECFE-SCOPE')).suppliers).toEqual([{ value: SUPPLIER, pairs: 2 }]);

    await loginAs(page, 'warehouse');
    await page.goto(`/costs?tab=emails&esup=${encodeURIComponent(SUPPLIER)}`);
    await expect(page.getByLabel('Supplier to read')).toHaveValue(SUPPLIER);
    await page.getByLabel('Only this SKU').fill('E2ECFE-SCOPE');
    await expect(page.getByText('2 pairs with no cost · 1 parcel to look up')).toBeVisible();
    // A typed range is this tab's own (?ef= ?et=), kept on a refresh.
    await page.getByLabel('Received from').fill('2020-01-01');
    await page.getByLabel('Received to').fill('2020-01-31');
    await expect(page.getByText('No pairs without a cost match these filters.')).toBeVisible();
    await expect(page).toHaveURL(/ef=2020-01-01/);
    await page.reload();
    await expect(page.getByLabel('Received from')).toHaveValue('2020-01-01');
    await expect(page.getByLabel('Received to')).toHaveValue('2020-01-31');
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByLabel('Supplier to read')).toHaveValue('');
    await expect(page.getByLabel('Received from')).toHaveValue('');
  });
});
