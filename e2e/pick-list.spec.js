// Pick lists for eBay + SHEIN orders (src/lib/pickList.js; docs/context/ebay-orders.md → "Pick list",
// docs/context/shein-live-fix.md → "Orders + pick list"). What this pins:
//   · the 4 x 6 in layout: 288 x 432 pt, at most 4 entries a page, a new page as soon as the next
//     entry wouldn't fit (never spills under the footer), long names cut at 2 lines with "...",
//     the order number never cut or wrapped, every stroke thick enough for a 203 dpi printer;
//   · entries from both platforms: one per PAIR (qty 2 = 2 entries; a refunded / swapped-out SHEIN
//     pair is not picked), SKU = the style code, size from Shopify's copy or SHEIN's own;
//   · SHEIN's own order state in plain words, grouped from shein_order_units;
//   · the real SQL (local DB): size_attr kept, the Shopify copy joined by seller SKU, PH yes / warehouse no;
//   · both Orders tabs: tick → Download → a real PDF with the right pages, size and words, named by
//     the EST day even when the browser's clock is in Manila.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import { loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import {
  PICK, CONTENT_W, ENTRIES_TOP, ENTRIES_BOTTOM, SEP_H, LINE_H, HEADER_H, FOOTER_H, HELV_BOLD, dots, ascii,
  layoutPickList, entryLines, boldMeasure, pickListPdf, pickListFileName, ebayPickEntries, sheinPickEntries,
  sheinOrdersFromUnits, sheinOrderStateOf, sheinUnitShoe, dayWords,
} from '../src/lib/pickList.js';
import { unitsFromOrders, sheinSizeAttr } from '../src/lib/sheinLive.js';
import { orderFromApi } from '../src/lib/ebayOrders.js';

const measure = boldMeasure(new jsPDF({ unit: 'pt' }));
const LONG = 'Nike Air Jordan 1 Retro High OG Chicago Lost and Found Varsity Red Black Sail Muslin Reimagined Limited Edition Mens Basketball Sneakers (DZ5485-612)';
// The longest real order numbers: eBay 12-34567-89012, SHEIN GSH + 12 (e.g. GSHNN960700HHA8).
const worst = (i) => ({ orderNo: `GSHNN96070${i}HHA8`, name: LONG, sku: 'DZ5485-612', size: '10.5W', pair: 1, pairs: 3 });
const texts = (page) => page.ops.filter((o) => o.t === 'text');
// How far a text op reaches below its baseline (Helvetica-Bold descender) and above it (cap height).
const bottomOf = (o) => o.y + (-HELV_BOLD.descender / 1000) * o.size;
const topOf = (o) => o.y - (HELV_BOLD.cap / 1000) * o.size;

test.describe('Pick list — the 4 x 6 layout (pure)', () => {
  test('the thermal numbers: 4 x 6 in, 0.2 in margins, every stroke at least 3 dots at 203 dpi, nothing grey or thin', () => {
    expect([PICK.W, PICK.H]).toEqual([4 * 72, 6 * 72]);
    expect(PICK.M).toBeGreaterThanOrEqual(0.15 * 72);
    // Helvetica-Bold's thinnest stroke (StdHW 118/1000 em) at each size we print
    expect(dots((HELV_BOLD.stdHW / 1000) * PICK.BODY)).toBeGreaterThanOrEqual(4.6);      // 14 pt body: 4.7 dots
    expect(dots((HELV_BOLD.stdHW / 1000) * PICK.ORDER_MIN)).toBeGreaterThanOrEqual(3.9); // 12 pt floor: 4.0 dots
    expect(dots((HELV_BOLD.stdHW / 1000) * PICK.SMALL)).toBeGreaterThanOrEqual(3);       // 10 pt header: 3.3 dots
    expect(dots((HELV_BOLD.cap / 1000) * PICK.BODY)).toBeGreaterThan(28);                 // cap height 28.3 dots
    expect(PICK.RULE).toBeGreaterThanOrEqual(1.5);
    expect(dots(PICK.RULE)).toBeGreaterThan(5);
    expect(LINE_H).toBeCloseTo(18.2, 5);                                                   // leading 1.3 x
  });

  test('four worst-case entries fit one page, with the numbers', () => {
    // 4 lines each (order, 2 name lines, SKU + size) = 72.8 pt; 4 of them + 3 separators = 339.2 pt
    // of the 357.2 pt between header and footer (432 − 2 × 14.4 − 27 − 19).
    expect(HEADER_H).toBe(27); expect(FOOTER_H).toBe(19);
    expect(ENTRIES_BOTTOM - ENTRIES_TOP).toBeCloseTo(357.2, 5);
    expect(4 * 4 * LINE_H + 3 * SEP_H).toBeCloseTo(339.2, 5);
    const L = layoutPickList([1, 2, 3, 4].map(worst), { widthOf: measure, platform: 'shein', day: '2026-11-12' });
    expect(L.pages).toHaveLength(1);
    const [p] = L.pages;
    expect(p.entries.map((e) => e.lines)).toEqual([4, 4, 4, 4]);
    const last = p.entries[3];
    expect(last.top + last.height).toBeCloseTo(ENTRIES_TOP + 339.2, 5);
    expect(last.top + last.height).toBeLessThanOrEqual(ENTRIES_BOTTOM);
    // every body glyph sits between the header rule and the footer
    for (const o of texts(p).filter((x) => !/header|footer/.test(x.kind))) {
      expect(topOf(o)).toBeGreaterThan(ENTRIES_TOP);
      expect(bottomOf(o)).toBeLessThan(ENTRIES_BOTTOM);
    }
    // header + footer inside the margins
    for (const o of texts(p)) { expect(topOf(o)).toBeGreaterThanOrEqual(PICK.M); expect(bottomOf(o)).toBeLessThanOrEqual(PICK.H - PICK.M); }
  });

  test('9 pairs → pages of 4, 4, 1; a long name is cut at 2 lines with "..."; nothing is wider than the label', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({ orderNo: `12-34567-8901${i}`, name: i === 0 ? LONG : 'Nike Dunk Low Retro White Black Panda (DD1391-100)', sku: 'DD1391-100', size: '9', pair: 1, pairs: 1 }));
    const L = layoutPickList(entries, { widthOf: measure, platform: 'ebay', day: '2026-11-12', madeAt: 'made 3:05 PM EST' });
    expect(L.pages.map((p) => p.entries.length)).toEqual([4, 4, 1]);
    expect(L).toMatchObject({ pairs: 9, orders: 9 });
    const names = texts(L.pages[0]).filter((o) => o.kind === 'name').slice(0, 3).map((o) => o.text);
    expect(names[0]).toBe('Nike Air Jordan 1 Retro High OG');
    expect(names[1]).toMatch(/\.\.\.$/);
    expect(names[2]).not.toMatch(/\.\.\.$/);                     // next entry's first name line
    for (const p of L.pages) {
      for (const o of texts(p)) {
        const w = measure(o.text, o.size);
        const left = o.align === 'right' ? o.x - w : o.x;
        expect(left).toBeGreaterThanOrEqual(PICK.M - 0.01);
        expect(left + w).toBeLessThanOrEqual(PICK.W - PICK.M + 0.01);
        expect(o.size).toBeGreaterThanOrEqual(PICK.SMALL);        // nothing under 10 pt
      }
      for (const r of p.ops.filter((x) => x.t === 'rule')) expect(r.w).toBeGreaterThanOrEqual(1.5);
    }
    expect(texts(L.pages[2]).find((o) => o.kind === 'header-right').text).toBe('page 3/3');
    expect(texts(L.pages[0]).find((o) => o.kind === 'header').text).toBe('eBay pick list | 12 Nov 2026 EST');
    expect(texts(L.pages[1]).find((o) => o.kind === 'footer').text).toBe('9 pairs | 9 orders');
  });

  test('a SKU too long to share its line with the size: the size gets its own line and the page breaks early', () => {
    const e = { orderNo: '12-34567-89012', name: LONG, sku: 'DD1391-100 / DD1503-101', size: '10.5', pair: 1, pairs: 1 };
    const lines = entryLines(e, measure);
    expect(lines.map((l) => l.kind)).toEqual(['order', 'name', 'name', 'sku', 'size']);
    const L = layoutPickList([e, e, e, e], { widthOf: measure, platform: 'ebay', day: '2026-11-12' });
    expect(L.pages.map((p) => p.entries.length)).toEqual([3, 1]);   // 3 × 91 + 2 × 16 = 305; a 4th (+107) would end at 453 > 398.6
    for (const p of L.pages) expect(Math.max(...p.entries.map((x) => x.top + x.height))).toBeLessThanOrEqual(ENTRIES_BOTTOM);
    // a SKU that needs two lines of its own: 6 lines = 109.2 pt, still never under the footer
    const huge = { ...e, sku: 'DD1391-100 / DD1503-101 / CW1590-100' };
    expect(entryLines(huge, measure).map((l) => l.kind)).toEqual(['order', 'name', 'name', 'sku', 'sku', 'size']);
    const H = layoutPickList([huge, huge, huge, huge], { widthOf: measure, platform: 'ebay', day: '2026-11-12' });
    expect(H.pages.map((p) => p.entries.length)).toEqual([2, 2]);   // 3 × 109.2 + 2 × 16 = 359.6 > 357.2: a third would spill
    for (const p of H.pages) expect(Math.max(...p.entries.map((x) => x.top + x.height))).toBeLessThanOrEqual(ENTRIES_BOTTOM);
  });

  test('the order number is never cut or wrapped: 14 pt when it fits, shrinks only to 12 pt', () => {
    for (const no of ['12-34567-89012', 'GSHNN960700HHA8']) {
      const [first] = entryLines({ orderNo: no, name: 'x', sku: 'y', size: '9', pair: 1, pairs: 1 }, measure);
      expect(first).toMatchObject({ kind: 'order', text: `#${no}`, size: 14 });
    }
    const long = 'GSHNN960700HHA8GSHNN960700HHA';  // 29 characters: 269 pt at 14 pt > 259.2 → smaller
    const [first] = entryLines({ orderNo: long, name: 'x', sku: 'y', size: '9', pair: 2, pairs: 2 }, measure);
    expect(first.text).toContain(long);
    expect(first.size).toBeGreaterThanOrEqual(12);
    expect(first.size).toBeLessThan(14);
    expect(measure(first.text, first.size)).toBeLessThanOrEqual(CONTENT_W);
  });

  test('plain ASCII only (the PDF font drops anything else) and the EST day in the file name', () => {
    expect(ascii('Nike’s “Air” — Café · 1…')).toBe('Nike\'s "Air" - Cafe | 1...');
    expect(dayWords('2026-11-02')).toBe('2 Nov 2026');
    // 22:30 EST on Nov 12 is already Nov 13 in Manila and in UTC: the file is Nov 12
    expect(pickListFileName('ebay', new Date('2026-11-13T03:30:00Z'))).toBe('pick-list-ebay-2026-11-12.pdf');
    expect(pickListFileName('shein', new Date('2026-11-13T05:30:00Z'))).toBe('pick-list-shein-2026-11-13.pdf');
  });

  test('the PDF itself: 288 x 432 pt pages, one per 4 pairs', async () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({ orderNo: `12-34567-8901${i}`, name: LONG, sku: 'DZ5485-612', size: '10', pair: 1, pairs: 1 }));
    const doc = await pickListPdf(entries, { platform: 'ebay', now: new Date('2026-11-12T20:05:00Z'), JsPDF: jsPDF });
    const pdf = await PDFDocument.load(doc.output('arraybuffer'));
    expect(pdf.getPageCount()).toBe(3);
    for (const p of pdf.getPages()) expect(p.getSize()).toEqual({ width: 288, height: 432 });
    expect(pdf.getTitle()).toBe('eBay pick list 2026-11-12');
  });
});

/* ------------------------------ entries + states ------------------------------ */
const API_ORDER = {
  orderId: '12-34567-89012', creationDate: '2026-11-10T15:00:00.000Z', lastModifiedDate: '2026-11-10T16:00:00.000Z', buyer: { username: 'sneakerfan99' },
  orderFulfillmentStatus: 'NOT_STARTED', cancelStatus: { cancelState: 'NONE_REQUESTED' }, pricingSummary: { total: { value: '300.00', currency: 'USD' } }, paymentSummary: {},
  lineItems: [
    { lineItemId: 'L1', legacyItemId: '1', title: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', sku: '10077481', quantity: 2, variationAspects: [{ name: 'US Shoe Size', value: '10' }] },
    { lineItemId: 'L2', legacyItemId: '2', title: 'ASICS Gel-1130 White Clay Canyon', sku: '10012345', quantity: 1, variationAspects: [{ name: 'US Shoe Size', value: '9.5' }] },
  ],
};
const unit = (over) => ({ goods_id: 'g', order_no: 'GSH1', unit_status: 2, exchange_tag: 1, stock_mode: 3, seller_sku: '100', title: 'SHEIN title', order_time: '2026-11-10T15:00:00Z', ...over });

test.describe('Pick list — entries from both platforms (pure)', () => {
  test('eBay: one entry per pair, the style code as SKU (Shopify copy, else the title, else the listing SKU)', () => {
    const o = orderFromApi(API_ORDER);
    o.lines[1].style = null;
    const e = ebayPickEntries([o]);
    expect(e).toEqual([
      { orderNo: '12-34567-89012', name: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', sku: 'DD1391-100', size: '10', pair: 1, pairs: 3 },
      { orderNo: '12-34567-89012', name: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', sku: 'DD1391-100', size: '10', pair: 2, pairs: 3 },
      { orderNo: '12-34567-89012', name: 'ASICS Gel-1130 White Clay Canyon', sku: '10012345', size: '9.5', pair: 3, pairs: 3 },
    ]);
    o.lines[1].style = '1201A256-110';
    expect(ebayPickEntries([o])[2].sku).toBe('1201A256-110');
  });

  test('SHEIN: what we store from an order line includes the size SHEIN printed', () => {
    expect(sheinSizeAttr({ skuAttribute: [{ attrName: '9码', language: 'CN' }, { attrName: 'US9', language: 'US' }] })).toBe('US9');
    expect(sheinSizeAttr({ skuAttribute: [{ attrName: '10', language: 'en' }] })).toBe('10');
    expect(sheinSizeAttr({})).toBe(null);
    const [u] = unitsFromOrders([{ orderNo: 'GSH9', orderStatus: 2, stockMode: 3, orderGoodsInfoList: [{ goodsId: '7', sellerSku: '100', newGoodsStatus: 2, skuAttribute: [{ attrName: 'US10.5', language: 'US' }] }] }]);
    expect(u).toMatchObject({ goods_id: '7', order_no: 'GSH9', size_attr: 'US10.5' });
  });

  test('SHEIN: the order’s state in plain words, from SHEIN’s own state per pair', () => {
    expect(sheinOrderStateOf([unit({ unit_status: 1 })])).toBe('new');
    expect(sheinOrderStateOf([unit({ unit_status: 2 }), unit({ unit_status: 4 })])).toBe('to_ship');
    expect(sheinOrderStateOf([unit({ unit_status: 7 })])).toBe('pickup');
    expect(sheinOrderStateOf([unit({ unit_status: 4 }), unit({ unit_status: 5 })])).toBe('shipped');
    expect(sheinOrderStateOf([unit({ unit_status: 5 })])).toBe('delivered');
    expect(sheinOrderStateOf([unit({ unit_status: 6 })])).toBe('cancelled');
    expect(sheinOrderStateOf([unit({ unit_status: 2, exchange_tag: 2 })])).toBe('cancelled');   // swapped out
    expect(sheinOrderStateOf([unit({ unit_status: 9 })])).toBe('rejected');
    expect(sheinOrderStateOf([unit({ stock_mode: 1 })])).toBe('shein_ships');
  });

  test('SHEIN: grouped into orders, still-to-go first; one entry per live pair; Shopify’s name + size, else SHEIN’s', () => {
    const units = [
      unit({ goods_id: 'a1', order_no: 'GSHA', unit_status: 4, order_time: '2026-11-11T10:00:00Z' }),
      unit({ goods_id: 'b1', order_no: 'GSHB', unit_status: 2, order_time: '2026-11-09T10:00:00Z', shopify_title: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', style: 'DD1391-100', shopify_size: '9' }),
      unit({ goods_id: 'b2', order_no: 'GSHB', unit_status: 6, order_time: '2026-11-09T10:00:00Z' }),                       // refunded pair
      unit({ goods_id: 'b3', order_no: 'GSHB', unit_status: 2, order_time: '2026-11-09T10:00:00Z', seller_sku: '200', title: 'Mens Running Shoe Lightweight', size_attr: 'US10' }),
    ];
    const orders = sheinOrdersFromUnits(units);
    expect(orders.map((o) => [o.order_no, o.state, o.units.length])).toEqual([['GSHB', 'to_ship', 3], ['GSHA', 'shipped', 1]]);
    const e = sheinPickEntries([orders[0]]);
    expect(e).toEqual([
      { orderNo: 'GSHB', name: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', sku: 'DD1391-100', size: '9', pair: 1, pairs: 2 },
      { orderNo: 'GSHB', name: 'Mens Running Shoe Lightweight', sku: '200', size: 'US10', pair: 2, pairs: 2 },
    ]);
    expect(sheinUnitShoe(unit({ title: 'Air Max 90 (CN8490-100)' }))).toEqual({ name: 'Air Max 90 (CN8490-100)', sku: 'CN8490-100', size: '' });
  });
});

/* ------------------------------ the real SQL ------------------------------ */
test.describe.serial('Pick list — SHEIN orders from the local database', () => {
  test.skip(!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || ''), 'needs the local database');
  const ph = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };
  const wh = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E WH', role: 'warehouse' })}` };
  let pool;
  test.beforeAll(async () => {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(`DELETE FROM shein_order_units WHERE order_no LIKE 'E2EPICK%'`);
    await pool.query(`DELETE FROM shopify_listing_variants WHERE variant_id LIKE 'e2e-pick-%'`);
    await pool.query(`INSERT INTO shopify_listing_variants (variant_id, product_id, product_title, status, sku, size, style)
      VALUES ('e2e-pick-1', 'e2e-pick-p', 'Nike Dunk Low Retro White Black Panda (DD1391-100)', 'ACTIVE', 'E2EPICK-SKU-1', '9.5', 'DD1391-100')`);
  });
  test.afterAll(async () => {
    await pool.query(`DELETE FROM shein_order_units WHERE order_no LIKE 'E2EPICK%'`);
    await pool.query(`DELETE FROM shopify_listing_variants WHERE variant_id LIKE 'e2e-pick-%'`);
    await pool.end();
  });

  test('the sync keeps SHEIN’s size; the endpoint joins Shopify’s copy; PH reads it, the warehouse can’t', async ({ request }) => {
    const { upsertSheinUnits } = await import('../api/_lib/db.js');
    const sold = new Date(Date.now() - 2 * 3600_000).toISOString();
    const units = unitsFromOrders([
      { orderNo: 'E2EPICK1', orderStatus: 2, stockMode: 3, orderAllocateTime: null, orderGoodsInfoList: [
        { goodsId: 'e2epick-g1', sellerSku: 'E2EPICK-SKU-1', newGoodsStatus: 2, goodsTitle: 'SHEIN long title', skuAttribute: [{ attrName: 'US9.5', language: 'US' }] },
        { goodsId: 'e2epick-g2', sellerSku: 'E2EPICK-GONE', newGoodsStatus: 1, goodsTitle: 'Mens Trail Shoe', skuAttribute: [{ attrName: 'US11', language: 'US' }] }] },
    // due: false — never a pair any Shopify step would take off, whatever else runs on this database
    ]).map((u) => ({ ...u, order_time: sold, due: false }));
    await upsertSheinUnits(units);
    // a later read without the attribute must not wipe the size we kept
    await upsertSheinUnits(units.map((u) => ({ ...u, size_attr: null, unit_status: 2 })));
    expect((await request.get('/api/shein/orders', { headers: wh })).status()).toBe(403);
    const r = await request.get('/api/shein/orders', { headers: ph });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const mine = body.units.filter((u) => u.order_no === 'E2EPICK1').sort((a, b) => a.goods_id.localeCompare(b.goods_id));
    expect(mine).toEqual([
      expect.objectContaining({ goods_id: 'e2epick-g1', size_attr: 'US9.5', shopify_title: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', style: 'DD1391-100', shopify_size: '9.5', unit_status: 2 }),
      expect.objectContaining({ goods_id: 'e2epick-g2', size_attr: 'US11', shopify_title: null, style: null, unit_status: 2 }),
    ]);
    const [o] = sheinOrdersFromUnits(mine);
    expect(sheinPickEntries([o]).map((e) => [e.name, e.sku, e.size])).toEqual([
      ['Nike Dunk Low Retro White Black Panda (DD1391-100)', 'DD1391-100', '9.5'], ['Mens Trail Shoe', 'E2EPICK-GONE', 'US11']]);
  });
});

/* ------------------------------ the two Orders tabs ------------------------------ */
// 22:30 EST on Nov 12 = 11:30 on Nov 13 in Manila, where the PH team works: the file must say Nov 12.
const NOW = new Date('2026-11-13T03:30:00Z');
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();
const STATUS = { ok: true, configured: true, missing: [], secrets: true, connected: true, canMarket: true, canOrders: true, canFinances: true, user: 'stickballman12', pull: { state: 'done', listings: 0, rows: 0 } };

function ebayFixture() {
  const base = orderFromApi(API_ORDER);
  const line = (over) => ({ ...base.lines[0], qty: 1, image_url: null, ...over });
  return [
    { ...base, order_id: '11-11111-11111', ship_by: iso(-86400_000), fulfillments: [], lines: [line({ title: LONG, sku: '10077481', style: 'DZ5485-612', size: '10.5' })] },
    { ...base, order_id: '22-22222-22222', ship_by: iso(3 * 86400_000), fulfillments: [], lines: [line({ title: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', size: '9', qty: 2 })] },
    { ...base, order_id: '33-33333-33333', status: 'FULFILLED', ship_by: iso(-3 * 86400_000), deliver_by: iso(3 * 86400_000),
      fulfillments: [{ id: 'F1', number: '1Z999AA10123456784', carrier: 'UPS', shipped_at: iso(-4 * 86400_000) }], lines: [line({ title: 'Jordan 4 Military Blue (FV5029-141)', size: '12' })] },
    { ...base, order_id: '44-44444-44444', cancel_state: 'CANCELED', fulfillments: [], lines: [line({ title: 'Cancelled shoe (AA0000-000)', size: '8' })] },
  ];
}
const sheinFixture = () => [
  unit({ goods_id: 's1', order_no: 'GSHNN960700HHA8', unit_status: 1, order_time: iso(-3600_000), shopify_title: 'Nike Dunk Low Retro White Black Panda (DD1391-100)', style: 'DD1391-100', shopify_size: '9' }),
  unit({ goods_id: 's2', order_no: 'GSHNN960700HHB9', unit_status: 2, order_time: iso(-7200_000), shopify_title: LONG, style: 'DZ5485-612', shopify_size: '10.5' }),
  unit({ goods_id: 's3', order_no: 'GSHNN960700HHB9', unit_status: 2, order_time: iso(-7200_000), title: 'Mens Trail Running Shoe', size_attr: 'US11' }),
  unit({ goods_id: 's4', order_no: 'GSHNN960700HHC1', unit_status: 4, order_time: iso(-86400_000), shopify_title: 'Jordan 4 Military Blue (FV5029-141)', shopify_size: '12' }),
  unit({ goods_id: 's5', order_no: 'GSHNN960700HHD2', unit_status: 6, order_time: iso(-86400_000), title: 'Refunded shoe' }),
];

// The downloaded file → its pages, sizes and words (pdf.js reads the words back).
async function readPdf(dl) {
  const bytes = fs.readFileSync(await dl.path());
  const doc = await PDFDocument.load(bytes);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) pages.push((await (await pdf.getPage(i)).getTextContent()).items.map((x) => x.str).join('\n'));
  return { count: doc.getPageCount(), sizes: doc.getPages().map((p) => p.getSize()), pages };
}

test.describe('Pick list — the Orders tabs', () => {
  test.use({ timezoneId: 'Asia/Manila' });

  test('eBay: tick, select awaiting shipment, Download → a 4 x 6 PDF named by the EST day', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await page.route('**/api/ebay/status', (r) => r.fulfill({ json: STATUS }));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
    await page.route('**/api/ebay/orders**', (r) => r.fulfill({ json: { ok: true, orders: ebayFixture(), canOrders: true, connected: true,
      sync: { state: 'done', lastOrdersAt: NOW.toISOString(), finishedAt: NOW.toISOString(), by: 'auto' } } }));
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=orders');
    const rows = page.locator('.ebo-table tbody tr');
    await expect(rows).toHaveCount(4);
    const bar = page.locator('[data-pick-bar="ebay"]');
    const download = bar.getByRole('button', { name: /Download pick list/ });
    await expect(download).toBeDisabled();
    await expect(page.getByLabel('Pick order 44-44444-44444')).toBeDisabled();          // cancelled: nothing to pick
    await bar.getByRole('button', { name: 'Select awaiting shipment (2)' }).click();
    await expect(bar.locator('[data-pick-count]')).toHaveText('2 orders · 3 pairs');
    await expect(page.getByLabel('Pick order 11-11111-11111')).toBeChecked();
    await expect(page.getByLabel('Pick order 33-33333-33333')).not.toBeChecked();
    await page.getByLabel('Pick order 33-33333-33333').check();
    await expect(download).toHaveText('Download pick list (3)');
    const [dl] = await Promise.all([page.waitForEvent('download'), download.click()]);
    expect(dl.suggestedFilename()).toBe('pick-list-ebay-2026-11-12.pdf');
    const pdf = await readPdf(dl);
    expect(pdf.count).toBe(1);                                         // 4 pairs: one label
    expect(pdf.sizes).toEqual([{ width: 288, height: 432 }]);
    expect(pdf.pages[0]).toContain('eBay pick list | 12 Nov 2026 EST');
    for (const w of ['#11-11111-11111', '#22-22222-22222', '1 of 2', '2 of 2', '#33-33333-33333', 'SKU DZ5485-612', 'Size 10.5', 'SKU DD1391-100', 'Size 9', 'SKU FV5029-141', '4 pairs | 3 orders']) expect(pdf.pages[0]).toContain(w);
    expect(pdf.pages[0]).not.toContain('44-44444-44444');
    // clear, then "every order shown" ticks all but the cancelled one
    await bar.getByRole('button', { name: 'Clear' }).click();
    await expect(download).toBeDisabled();
    await page.getByLabel('Select every order shown').check();
    await expect(bar.locator('[data-pick-count]')).toHaveText('3 orders · 4 pairs');
    await expect(page.getByLabel('Pick order 44-44444-44444')).not.toBeChecked();
  });

  test('eBay on a phone: the tick and the bar fit, nothing scrolls sideways', async ({ page }) => {
    await page.route('**/api/ebay/status', (r) => r.fulfill({ json: STATUS }));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
    await page.route('**/api/ebay/orders**', (r) => r.fulfill({ json: { ok: true, orders: ebayFixture(), canOrders: true, connected: true, sync: { state: 'done', lastOrdersAt: NOW.toISOString() } } }));
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/ebay-listings?tab=orders');
    await expect(page.locator('.ebo-table tbody tr')).toHaveCount(4);
    const box = await page.locator('.ebo-table tbody tr').first().locator('td.pk-cell').boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await page.locator('.ebo-table tbody tr').first().locator('td.pk-cell').click();
    await expect(page.getByLabel('Pick order 11-11111-11111')).toBeChecked();
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className}`));
    expect(wide).toEqual([]);
  });

  test('SHEIN: the Orders section — SHEIN’s state in words, tick, Download → pages of 4', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    const big = [...sheinFixture(), ...Array.from({ length: 4 }, (_, i) => unit({ goods_id: `t${i}`, order_no: `GSHNN96070${i}XXX`, unit_status: 2, order_time: iso(-10_000_000 - i), title: `Extra shoe ${i}`, size_attr: 'US8' }))];
    await page.route('**/api/shein/**', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('/shein/orders')) return r.fulfill({ json: { ok: true, units: big, sync: { orders: 'on', polledAt: NOW.toISOString() } } });
      return r.fulfill({ json: { ok: true } });
    });
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein?section=orders');
    await expect(page.getByRole('tab', { name: 'Orders' })).toHaveAttribute('aria-selected', 'true');
    const rows = page.locator('[data-section="orders"] .ebo-table tbody tr');
    await expect(rows).toHaveCount(8);
    await expect(rows.first()).toContainText('GSHNN960700HHA8');
    await expect(rows.first()).toContainText('New order');
    await expect(page.locator('tr[data-order="GSHNN960700HHC1"]')).toContainText('Shipped');
    await expect(page.locator('tr[data-order="GSHNN960700HHD2"]')).toContainText('Cancelled / refunded');
    await expect(page.getByLabel('Pick order GSHNN960700HHD2')).toBeDisabled();
    await page.getByRole('button', { name: /^To ship/ }).click();
    await expect(rows).toHaveCount(5);
    await page.getByRole('button', { name: /^All/ }).click();
    const bar = page.locator('[data-pick-bar="shein"]');
    await bar.getByRole('button', { name: 'Select awaiting shipment (6)' }).click();
    await expect(bar.locator('[data-pick-count]')).toHaveText('6 orders · 7 pairs');
    const [dl] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: 'Download pick list (6)' }).click()]);
    expect(dl.suggestedFilename()).toBe('pick-list-shein-2026-11-12.pdf');
    const pdf = await readPdf(dl);
    expect(pdf.count).toBe(2);                                           // 7 pairs: 4 + 3
    expect(pdf.sizes.every((s) => s.width === 288 && s.height === 432)).toBe(true);
    expect(pdf.pages[0]).toContain('SHEIN pick list | 12 Nov 2026 EST');
    expect(pdf.pages[0]).toContain('page 1/2');
    expect(pdf.pages.join('\n')).toContain('#GSHNN960700HHA8');
    expect(pdf.pages.join('\n')).toContain('Size US11');
    expect(pdf.pages.join('\n')).not.toContain('GSHNN960700HHC1');      // shipped: not ticked
    expect(pdf.pages.join('\n')).not.toContain('Refunded shoe');
  });
});
