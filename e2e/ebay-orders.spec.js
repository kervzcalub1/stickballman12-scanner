// eBay Orders + Sales report (docs/context/ebay-orders.md), and the admin's way in (/ebay).
// What this pins:
//   · eBay's order JSON → our row (buyer, shoe, SKU, size, ship-by, money in cents);
//   · where an order stands: late / ship today / to ship / shipped / delivery late /
//     delivered / cancelled, judged by eBay's own dates in EST;
//   · the report: sales vs fees vs refunds vs other, payouts left out, CSVs line up;
//   · the Orders table and the Sales report page (eBay mocked), and an ADMIN reaching the
//     eBay page at /ebay and connecting from there (eBay returns to /ebay).
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { orderFromApi, shipState, summarize, salesCsv, transactionsCsv, transactionFromApi } from '../src/lib/ebayOrders.js';

const API_ORDER = {
  orderId: '12-34567-89012', creationDate: '2026-10-10T15:00:00.000Z', lastModifiedDate: '2026-10-10T16:00:00.000Z',
  buyer: { username: 'sneakerfan99' }, orderFulfillmentStatus: 'NOT_STARTED', orderPaymentStatus: 'PAID', cancelStatus: { cancelState: 'NONE_REQUESTED' },
  pricingSummary: { priceSubtotal: { value: '150.00', currency: 'USD' }, deliveryCost: { value: '12.00' }, total: { value: '172.50', currency: 'USD' } },
  totalMarketplaceFee: { value: '21.40' }, paymentSummary: { totalDueSeller: { value: '140.60' }, refunds: [] },
  fulfillmentHrefs: [],
  lineItems: [{ lineItemId: 'L1', legacyItemId: '327090839752', title: 'Nike Dunk Low Panda', sku: '10077481', quantity: 1,
    lineItemCost: { value: '150.00' }, deliveryCost: { shippingCost: { value: '12.00' } }, total: { value: '172.50' },
    ebayCollectAndRemitTaxes: [{ amount: { value: '10.50' } }], variationAspects: [{ name: 'Color', value: 'White' }, { name: 'US Shoe Size', value: '10' }],
    lineItemFulfillmentInstructions: { shipByDate: '2026-10-13T03:59:59.000Z', maxEstimatedDeliveryDate: '2026-10-18T03:59:59.000Z' } }],
};

test.describe('eBay order rules', () => {
  test('an eBay order becomes one row: buyer, shoe, SKU, size, ship-by, money in cents', () => {
    const o = orderFromApi(API_ORDER);
    expect(o).toMatchObject({ order_id: '12-34567-89012', buyer: 'sneakerfan99', status: 'NOT_STARTED', ship_by: '2026-10-13T03:59:59.000Z',
      subtotal_cents: 15000, shipping_cents: 1200, tax_cents: 1050, total_cents: 17250, fee_cents: 2140, due_seller_cents: 14060, fulfillment_count: 0 });
    expect(o.lines).toEqual([expect.objectContaining({ line_item_id: 'L1', item_id: '327090839752', sku: '10077481', size: '10', qty: 1, subtotal_cents: 15000 })]);
  });

  test('where an order stands, by eBay’s own dates in EST', () => {
    const o = orderFromApi(API_ORDER);
    // ship-by = Oct 12 23:59:59 EDT
    expect(shipState(o, {}, new Date('2026-10-12T14:00:00Z'))).toBe('due_today');
    expect(shipState(o, {}, new Date('2026-10-11T14:00:00Z'))).toBe('to_ship');
    expect(shipState(o, {}, new Date('2026-10-13T12:00:00Z'))).toBe('late');
    const shipped = { ...o, status: 'FULFILLED', fulfillments: [{ number: '1Z999', shipped_at: '2026-10-12T20:00:00Z' }] };
    expect(shipState(shipped, {}, new Date('2026-10-14T12:00:00Z'))).toBe('shipped');
    expect(shipState(shipped, { '1Z999': { status: 'Delivered' } }, new Date('2026-10-20T12:00:00Z'))).toBe('delivered');
    expect(shipState(shipped, { '1Z999': { status: 'InTransit' } }, new Date('2026-10-20T12:00:00Z'))).toBe('late_delivery');
    expect(shipState({ ...o, cancel_state: 'CANCELED' }, {}, new Date('2026-10-20T12:00:00Z'))).toBe('cancelled');
  });

  test('the statement: sales, fees, refunds, labels; payouts are not income', () => {
    const tx = [
      { transactionId: 'T1', transactionType: 'SALE', transactionDate: '2026-01-15T15:00:00Z', bookingEntry: 'CREDIT', amount: { value: '140.60' },
        totalFeeAmount: { value: '21.40' }, totalFeeBasisAmount: { value: '162.00' }, orderId: '12-34567-89012', buyer: { username: 'sneakerfan99' },
        orderLineItems: [{ lineItemId: 'L1', marketplaceFees: [{ amount: { value: '21.40' } }] }] },
      { transactionId: 'T2', transactionType: 'REFUND', transactionDate: '2026-02-02T15:00:00Z', bookingEntry: 'DEBIT', amount: { value: '50.00' }, orderId: 'X' },
      { transactionId: 'T3', transactionType: 'SHIPPING_LABEL', transactionDate: '2026-02-03T15:00:00Z', bookingEntry: 'DEBIT', amount: { value: '9.25' } },
      { transactionId: 'T4', transactionType: 'WITHDRAWAL', transactionDate: '2026-02-04T15:00:00Z', bookingEntry: 'DEBIT', amount: { value: '500.00' } },
      // Jan 1 00:30 EST is still January in EST (05:30 UTC)
      { transactionId: 'T5', transactionType: 'NON_SALE_CHARGE', transactionDate: '2026-01-01T05:30:00Z', bookingEntry: 'DEBIT', amount: { value: '3.00' } },
    ].map(transactionFromApi);
    const s = summarize(tx);
    expect(s).toMatchObject({ sales: 1, gross: 16200, fees: 2140, salesNet: 14060, net: 14060 - 5000 - 925 - 300 });
    expect(Object.keys(s.months).sort()).toEqual(['2026-01', '2026-02']);
    expect(s.months['2026-02']).toMatchObject({ refunds: -5000, other: -925 });
    expect(s.byType.WITHDRAWAL).toEqual({ count: 1, cents: -50000 });   // listed, not in the net

    const sales = salesCsv([orderFromApi(API_ORDER)], { '12-34567-89012': tx[0] }).replace(/^﻿/, '').split('\r\n');
    expect(sales[0]).toContain('Order #,Buyer,Item title,SKU,Size');
    expect(sales[1]).toBe('2026-10-10,12-34567-89012,sneakerfan99,Nike Dunk Low Panda,10077481,10,327090839752,1,150.00,12.00,0.00,10.50,172.50,21.40,140.60,0.00,NOT_STARTED');
    const st = transactionsCsv(tx).split('\r\n');
    expect(st).toHaveLength(7);   // header + 5 + trailing
    expect(st[2]).toContain('Refunds,DEBIT,50.00,-50.00');
  });
});

const STATUS = { ok: true, configured: true, missing: [], secrets: true, connected: true, canMarket: true, canOrders: true, canFinances: true, user: 'stickballman12',
  pull: { state: 'done', listings: 0, rows: 0 } };

function ordersFixture() {
  const base = orderFromApi(API_ORDER);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  return [
    { ...base, order_id: 'LATE-1', ship_by: iso(now - 86400_000), fulfillments: [], lines: [{ ...base.lines[0], image_url: null }] },
    { ...base, order_id: 'SHIP-2', buyer: 'jordanhead', status: 'FULFILLED', ship_by: iso(now - 3 * 86400_000), deliver_by: iso(now + 3 * 86400_000),
      fulfillments: [{ id: 'F1', number: '1Z999AA10123456784', carrier: 'UPS', shipped_at: iso(now - 4 * 86400_000), status: 'InTransit', detail: 'Arrived at facility' }],
      lines: [{ ...base.lines[0], title: 'Jordan 4 Military Blue', sku: '20000001', size: '9.5', image_url: null }] },
  ];
}

test.describe('eBay Orders + Sales report pages', () => {
  test('Orders: one row per order — order #, buyer, shoe + SKU + size, tracking; late first and counted', async ({ page }) => {
    await page.route('**/api/ebay/status', (r) => r.fulfill({ json: STATUS }));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
    await page.route('**/api/ebay/orders**', (r) => r.fulfill({ json: { ok: true, orders: ordersFixture(), canOrders: true, connected: true,
      sync: { state: 'done', lastOrdersAt: '2026-10-13T12:00:00Z', finishedAt: '2026-10-13T12:00:00Z', by: 'auto' } } }));
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/ebay-listings?tab=orders');
    const rows = page.locator('.ebo-table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('LATE-1');
    await expect(rows.first()).toContainText('Late — not shipped');
    await expect(rows.nth(1)).toContainText('jordanhead');
    await expect(rows.nth(1)).toContainText('20000001');
    await expect(rows.nth(1)).toContainText('9.5');
    await expect(rows.nth(1).getByRole('link', { name: '1Z999AA10123456784' })).toHaveAttribute('href', /ups\.com\/track\?tracknum=1Z999AA10123456784/);
    await expect(rows.nth(1)).toContainText('InTransit — Arrived at facility');
    await page.getByRole('button', { name: /Late — not shipped 1/ }).click();
    await expect(rows).toHaveCount(1);
    await page.getByRole('button', { name: 'All 2' }).click();
    await page.getByLabel('Search eBay orders').fill('20000001');
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Sales report' })).toHaveCount(0);   // PH: no money report
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().right)}`));
    expect(wide).toEqual([]);
  });

  test('Sales report (admin at /ebay): year to date by default, totals, three CSVs', async ({ page }) => {
    const asked = [];
    await page.route('**/api/ebay/status', (r) => r.fulfill({ json: STATUS }));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
    await page.route('**/api/ebay/sales-report**', (r) => {
      asked.push(new URL(r.request().url()).searchParams.toString());
      return r.fulfill({ json: { ok: true, canFinances: true, orders: [orderFromApi(API_ORDER)],
        transactions: [
          { transaction_id: 'T1', transaction_type: 'SALE', transaction_date: '2026-01-15T15:00:00Z', booking_entry: 'CREDIT', amount_cents: 14060, fee_cents: 2140, fee_basis_cents: 16200, order_id: '12-34567-89012', line_fees: [] },
          { transaction_id: 'T2', transaction_type: 'REFUND', transaction_date: '2026-02-02T15:00:00Z', booking_entry: 'DEBIT', amount_cents: 5000, fee_cents: 0, fee_basis_cents: 0 },
        ],
        coverage: { from: '2026-01-01T05:00:00.000Z', lastSync: '2026-10-13T12:00:00Z' },
        ebaySummary: { creditAmount: { value: '140.60' }, creditBookingEntry: 'CREDIT', refundAmount: { value: '50.00' }, refundBookingEntry: 'DEBIT' } } });
    });
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sales');
    await expect(page.locator('.er-stat').filter({ hasText: 'net to you' })).toContainText('$90.60');
    await expect(page.locator('.er-stat').filter({ hasText: 'gross sales' })).toContainText('$162.00');
    expect(asked[0]).toMatch(/^from=\d{4}-01-01&to=\d{4}-\d{2}-\d{2}$/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Statement — every transaction/ }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^eBay \d{4}-01-01 to .* - statement\.csv$/);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Sales by order/ }).click()]);
    expect(dl2.suggestedFilename()).toMatch(/sales by order\.csv$/);
    await page.getByLabel('Period').selectOption('last_month');
    // Wait for the NEW period's request, not a count: the dev build mounts the tab twice, so
    // year to date can be asked twice and a count raced the last-month request (2026-10-27).
    await expect.poll(() => asked.filter((a) => a !== asked[0]).length).toBe(1);
    expect(asked.find((a) => a !== asked[0])).toMatch(/^from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
  });

  test('an admin reaches eBay at /ebay and connects from there; eBay comes back to /ebay', async ({ page }) => {
    let body = null;
    await page.route('**/api/ebay/status', (r) => r.fulfill({ json: { ...STATUS, connected: false, user: null, pull: null } }));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
    await page.route('**/api/ebay/connect', (r) => { body = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, url: '/ebay?ebay=connected&ebay_user=stickballman12' } }); });
    await loginAs(page, 'admin');
    await page.goto('/');
    await page.getByRole('button', { name: /^eBay Orders & late shipments/ }).click();
    await expect(page).toHaveURL(/\/ebay$/);
    await page.getByRole('button', { name: 'Connect eBay' }).click();
    await expect.poll(() => body).toEqual({ back: '/ebay' });
    await expect(page.getByText('eBay connected as stickballman12')).toBeVisible();
  });
});
