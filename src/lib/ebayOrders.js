// eBay orders + the sales report — the pure half (docs/context/ebay-orders.md). Shared by
// the sync (api/_lib/ebay-orders-sync.js: eBay's JSON → our rows) and the page (where an
// order stands, the report's sums, the CSVs). Money is kept in CENTS (integers).
import { estDate, estCivil, ymd } from './format.js';

export const cents = (a) => {
  const v = a && typeof a === 'object' ? a.value : a;
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const sumAmounts = (list) => (list || []).reduce((n, x) => n + cents(x?.amount ?? x), 0);

// One eBay order (Fulfillment API) → our row. `lines` keep what the table shows per shoe;
// the order-level money is what the buyer paid and what eBay keeps.
export function orderFromApi(o) {
  const ps = o.pricingSummary || {};
  const lines = (o.lineItems || []).map((li) => {
    const aspects = li.variationAspects || [];
    const size = (aspects.find((a) => /size/i.test(a.name || '')) || {}).value || null;
    return {
      line_item_id: li.lineItemId, item_id: li.legacyItemId || null, variation_id: li.legacyVariationId || null,
      title: li.title || '', sku: li.sku || null, size, qty: Number(li.quantity || 1),
      subtotal_cents: cents(li.lineItemCost), shipping_cents: cents(li.deliveryCost?.shippingCost),
      discount_cents: (li.appliedPromotions || []).reduce((n, p) => n + cents(p.discountAmount), 0),
      tax_cents: sumAmounts(li.ebayCollectAndRemitTaxes), total_cents: cents(li.total),
      refund_cents: sumAmounts(li.refunds), status: li.lineItemFulfillmentStatus || null,
      ship_by: li.lineItemFulfillmentInstructions?.shipByDate || null,
      deliver_by: li.lineItemFulfillmentInstructions?.maxEstimatedDeliveryDate || null,
      aspects: aspects.map((a) => `${a.name}: ${a.value}`).join(' · ') || null,
    };
  });
  const earliest = (k) => lines.map((l) => l[k]).filter(Boolean).sort()[0] || null;
  return {
    order_id: o.orderId, created_at: o.creationDate, modified_at: o.lastModifiedDate || o.creationDate,
    buyer: o.buyer?.username || null, status: o.orderFulfillmentStatus || null, payment_status: o.orderPaymentStatus || null,
    cancel_state: o.cancelStatus?.cancelState || null,
    ship_by: earliest('ship_by'), deliver_by: lines.map((l) => l.deliver_by).filter(Boolean).sort().pop() || null,
    subtotal_cents: cents(ps.priceSubtotal), shipping_cents: cents(ps.deliveryCost), discount_cents: Math.abs(cents(ps.priceDiscount)),
    tax_cents: lines.reduce((n, l) => n + l.tax_cents, 0), total_cents: cents(ps.total),
    fee_cents: cents(o.totalMarketplaceFee), due_seller_cents: cents(o.paymentSummary?.totalDueSeller),
    refund_cents: sumAmounts(o.paymentSummary?.refunds), currency: ps.total?.currency || 'USD',
    lines, fulfillment_count: (o.fulfillmentHrefs || []).length,
  };
}

export const fulfillmentsFromApi = (list) => (list || []).map((f) => ({
  id: f.fulfillmentId, number: f.shipmentTrackingNumber || null, carrier: f.shippingCarrierCode || null,
  shipped_at: f.shippedDate || null, line_ids: (f.lineItems || []).map((x) => x.lineItemId),
}));

// Where an order stands, judged against eBay's own ship-by / deliver-by dates.
//   late         not shipped and the ship-by date has passed            (bad)
//   due_today    not shipped, ship-by is today (EST)                     (warn)
//   to_ship      not shipped, still time
//   late_delivery shipped, the latest delivery estimate has passed and the carrier hasn't said delivered (bad)
//   shipped      shipped (in transit / no carrier word yet)
//   delivered    every tracking number delivered
//   cancelled
// `tracking` = { [number]: { status } } from shipment_tracking (17TRACK).
export const SHIP_STATES = {
  late: ['Late — not shipped', 'bad'], due_today: ['Ship today', 'warn'], to_ship: ['To ship', 'info'],
  late_delivery: ['Delivery late', 'bad'], shipped: ['Shipped', 'ok'], delivered: ['Delivered', 'ok'], cancelled: ['Cancelled', 'muted'],
};
export function shipState(o, tracking = {}, now = new Date()) {
  if (o.cancel_state === 'CANCELED') return 'cancelled';
  const fs = o.fulfillments || [];
  const shipped = o.status === 'FULFILLED' || fs.length > 0;
  if (!shipped) {
    if (!o.ship_by) return 'to_ship';
    const due = new Date(o.ship_by);
    if (due < now) return 'late';
    return ymd(estCivil(due)) === ymd(estCivil(now)) ? 'due_today' : 'to_ship';
  }
  const nums = fs.map((f) => f.number).filter(Boolean);
  const delivered = nums.length > 0 && nums.every((n) => /delivered/i.test(tracking[n]?.status || ''));
  if (delivered) return 'delivered';
  if (o.deliver_by && new Date(o.deliver_by) < now) return 'late_delivery';
  return 'shipped';
}
// Shipped after the ship-by date (still worth seeing once it's delivered).
export function shippedLate(o) {
  const first = (o.fulfillments || []).map((f) => f.shipped_at).filter(Boolean).sort()[0];
  return !!(first && o.ship_by && new Date(first) > new Date(o.ship_by));
}

/* ------------------------------- the report ------------------------------- */

// Finances transaction types that are money IN or OUT of the business for the period.
// WITHDRAWAL (a payout the seller pulled), LOAN_REPAYMENT and PURCHASE (buying on eBay
// with the balance) move money but aren't sales activity, so the net leaves them out.
export const NOT_SALES = new Set(['WITHDRAWAL', 'LOAN_REPAYMENT', 'PURCHASE']);
export const TYPE_LABEL = {
  SALE: 'Sales', REFUND: 'Refunds', SHIPPING_LABEL: 'Shipping labels', NON_SALE_CHARGE: 'Other eBay fees (ads, subscriptions…)',
  DISPUTE: 'Disputes', CREDIT: 'Credits from eBay', ADJUSTMENT: 'Adjustments', TRANSFER: 'Refund transfers',
  WITHDRAWAL: 'Withdrawals (payouts)', LOAN_REPAYMENT: 'Loan repayments', PURCHASE: 'Purchases on eBay',
};
export const signed = (t) => (t.booking_entry === 'DEBIT' ? -1 : 1) * Number(t.amount_cents || 0);

// The statement for a period: per type (count, signed total), the sale side split into
// gross / fees / net, and per EST month.
export function summarize(transactions) {
  const byType = {};
  const months = {};
  const out = { gross: 0, fees: 0, salesNet: 0, sales: 0, net: 0, byType, months };
  for (const t of transactions) {
    const type = t.transaction_type || 'OTHER';
    const s = signed(t);
    const ty = byType[type] || (byType[type] = { count: 0, cents: 0 });
    ty.count++; ty.cents += s;
    if (NOT_SALES.has(type)) continue;
    const m = estDate(t.transaction_date).slice(0, 7);
    const mo = months[m] || (months[m] = { sales: 0, gross: 0, fees: 0, refunds: 0, other: 0, net: 0 });
    if (type === 'SALE') {
      out.sales++; out.gross += Number(t.fee_basis_cents || 0); out.fees += Number(t.fee_cents || 0); out.salesNet += s;
      mo.sales++; mo.gross += Number(t.fee_basis_cents || 0); mo.fees += Number(t.fee_cents || 0);
    } else if (type === 'REFUND' || type === 'TRANSFER') mo.refunds += s;
    else mo.other += s;
    mo.net += s;
    out.net += s;
  }
  return out;
}

const BOM = '﻿';
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (head, rows) => BOM + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const money = (c) => (c == null ? '' : (c / 100).toFixed(2));

// Sales by order line: one row per shoe sold, EST dates. Fees per line come from the
// finances SALE record (per line item) when we have it, else the order's fee on its first
// line. Net = item + shipping − discount − fees (tax is eBay's, never ours).
export function salesCsv(orders, saleByOrder = {}) {
  const head = ['Date (EST)', 'Order #', 'Buyer', 'Item title', 'SKU', 'Size', 'eBay item #', 'Qty', 'Item price', 'Shipping charged',
    'Discount', 'Sales tax (eBay collected)', 'Buyer paid', 'eBay fees', 'Net (before refunds)', 'Refunded', 'Status'];
  const rows = [];
  for (const o of orders) {
    const tx = saleByOrder[o.order_id];
    const lineFees = new Map((tx?.line_fees || []).map((x) => [x.line_item_id, x.fee_cents]));
    o.lines.forEach((l, i) => {
      const fee = lineFees.has(l.line_item_id) ? lineFees.get(l.line_item_id) : (i === 0 ? (tx?.fee_cents ?? o.fee_cents) : 0);
      const net = l.subtotal_cents + l.shipping_cents - l.discount_cents - fee;
      rows.push([estDate(o.created_at), o.order_id, o.buyer || '', l.title, l.sku || '', l.size || '', l.item_id || '', l.qty,
        money(l.subtotal_cents), money(l.shipping_cents), money(l.discount_cents), money(l.tax_cents), money(l.total_cents),
        money(fee), money(net), money(l.refund_cents), o.cancel_state === 'CANCELED' ? 'Cancelled' : (o.status || '')]);
    });
  }
  return toCsv(head, rows);
}

// The statement: every money movement in the period, as eBay booked it.
export function transactionsCsv(transactions) {
  const head = ['Date (EST)', 'Type', 'Credit/Debit', 'Amount', 'Signed amount', 'Gross (before fees)', 'eBay fees', 'Order #', 'Buyer',
    'Status', 'Memo', 'Payout ID', 'Transaction ID'];
  return toCsv(head, transactions.map((t) => [estDate(t.transaction_date), TYPE_LABEL[t.transaction_type] || t.transaction_type,
    t.booking_entry || '', money(t.amount_cents), money(signed(t)), t.transaction_type === 'SALE' ? money(t.fee_basis_cents) : '',
    t.transaction_type === 'SALE' ? money(t.fee_cents) : '', t.order_id || '', t.buyer || '', t.status || '', t.memo || '',
    t.payout_id || '', t.transaction_id]));
}

// The monthly summary as a CSV too (what a YTD statement usually needs on one page).
export function summaryCsv(sum) {
  const head = ['Month', 'Sales (orders)', 'Gross sales', 'eBay fees', 'Refunds', 'Other (labels, ads, credits…)', 'Net'];
  const rows = Object.keys(sum.months).sort().map((m) => {
    const x = sum.months[m];
    return [m, x.sales, money(x.gross), money(-x.fees), money(x.refunds), money(x.other), money(x.net)];
  });
  rows.push(['Total', sum.sales, money(sum.gross), money(-sum.fees),
    money(Object.values(sum.months).reduce((n, x) => n + x.refunds, 0)), money(Object.values(sum.months).reduce((n, x) => n + x.other, 0)), money(sum.net)]);
  return toCsv(head, rows);
}

// A Finances transaction → our row.
export function transactionFromApi(t) {
  return {
    transaction_id: t.transactionId, transaction_type: t.transactionType || 'OTHER', transaction_date: t.transactionDate,
    booking_entry: t.bookingEntry || null, amount_cents: cents(t.amount), fee_cents: cents(t.totalFeeAmount),
    fee_basis_cents: cents(t.totalFeeBasisAmount), order_id: t.orderId || null, buyer: t.buyer?.username || null,
    status: t.transactionStatus || null, memo: t.transactionMemo || null, payout_id: t.payoutId || null,
    line_fees: (t.orderLineItems || []).map((li) => ({ line_item_id: li.lineItemId, fee_cents: sumAmounts(li.marketplaceFees) })),
  };
}
