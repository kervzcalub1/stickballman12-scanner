// Online orders — what each pair ACTUALLY cost (docs/context/online-orders.md).
//
// An online order is priced per shoe, then the order-level money lands on top of it:
//   coupon    — split evenly per UNIT ordered (owner's rule: "divided per units ordered")
//   tax       — split by PRICE: a $200 pair carries twice a $100 pair's share
//   shipping  — split by PRICE, the same way
//   gift card — a PERCENTAGE off everything paid (the cards were bought at a discount
//               and the order was paid with them)
//   cashback  — a PERCENTAGE paid back (Rakuten / card portal), on each pair's price
//               after the coupon, PRE-tax and pre-shipping (what portals pay on; same
//               base as the Payout Calculator's cashback)
//   = actual cost each = (price − coupon each + tax share + shipping share) × (1 − gc%)
//                        − (price − coupon each) × cashback%
//
// Cancelled lines are left out of the split: the pairs that are actually coming carry
// the order's coupon, tax and shipping. Pure — the screen and the server use the same
// function, so the number PH saw while typing is the number that was saved.

import { poLineMoney } from './costs.js';
import { sizeNum } from './codes.js';
import { manifestSummary } from './manifestScan.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const cents = (v) => Math.round(v * 100) / 100;

export const isCancelled = (line) => !!(line && (line.cancelled_at || line.cancelled));

// `order`: { coupon, tax, shipping, gc_pct, cashback_pct }; `lines`: [{ qty, unit_price, cancelled_at? }]
// → { lines: [{ ...line, each, lineTotal, parts: { price, coupon, tax, shipping, gc, cashback } }],
//     units, subtotal, total, paid }   (cancelled lines come back with each = null)
export function orderCosts(order, lines) {
  const o = order || {};
  const active = (lines || []).filter((l) => !isCancelled(l) && num(l.qty) > 0);
  const units = active.reduce((n, l) => n + num(l.qty), 0);
  const subtotal = active.reduce((n, l) => n + num(l.unit_price) * num(l.qty), 0);
  const coupon = num(o.coupon);
  const tax = num(o.tax);
  const shipping = num(o.shipping);
  const gc = Math.min(100, Math.max(0, num(o.gc_pct)));
  const cbPct = Math.min(100, Math.max(0, num(o.cashback_pct)));
  const couponEach = units ? coupon / units : 0;
  // By price. An order of all-$0 lines (a freebie) has no price to weigh by, so the
  // shares fall back to per unit rather than dividing by zero.
  const share = (price) => (subtotal > 0 ? price / subtotal : units ? 1 / units : 0);

  const out = (lines || []).map((l) => {
    if (isCancelled(l) || num(l.qty) <= 0) return { ...l, each: null, parts: null };
    const price = num(l.unit_price);
    const t = tax * share(price);
    const s = shipping * share(price);
    const before = price - couponEach + t + s;
    const g = before * (gc / 100);
    // Cashback is a % of the pair's price after the coupon — pre-tax, pre-shipping.
    const cb = Math.max(0, price - couponEach) * (cbPct / 100);
    const net = before - g - cb;
    return {
      ...l,
      each: cents(net),
      // Rounded from the EXACT per-pair figure, not from the rounded `each` — 3 × $36.663
      // is $109.99, while 3 × $36.66 would be a cent short of the order total (QA).
      lineTotal: cents(net * num(l.qty)),
      parts: { price, coupon: cents(couponEach), tax: cents(t), shipping: cents(s), gc: cents(g), cashback: cents(cb) },
    };
  });
  const paid = subtotal - coupon + tax + shipping;
  const cashback = active.reduce((n, l) => n + Math.max(0, num(l.unit_price) - couponEach) * (cbPct / 100) * num(l.qty), 0);
  return {
    lines: out,
    units,
    subtotal: cents(subtotal),
    paid: cents(paid),                          // what the store charged
    cashback: cents(cashback),
    total: cents(paid * (1 - gc / 100) - cashback),   // what it cost us, after the card discount + cashback
  };
}

// "1Z 999 AA1…" pasted from an email and "1Z999AA1…" off a scanner are one parcel.
export const trackKey = (t) => String(t || '').replace(/\s+/g, '').toUpperCase();

// What PH picks when cancelling. 'not_delivered' is never picked — it is written by the
// warehouse's count ("ordered 5, delivered 3"), so it is labelled but not offered.
export const CANCEL_REASONS = [['oot', 'Out of stock (OOT)'], ['other', 'Other']];
export const REASON_LABEL = { oot: 'Out of stock', other: 'Cancelled', not_delivered: 'Not delivered' };

// Where the order stands — derived, never stored, so it can't disagree with its lines.
//   ordered   · no tracking number yet (or it never shipped)
//   shipped   · has tracking, not counted in yet — on the warehouse's "expect" list
//   delivered · the warehouse counted what arrived
//   cancelled · every line was cancelled
export function orderStage(o) {
  const lines = o?.lines || [];
  if (lines.length && lines.every(isCancelled) && !o.received_at) return 'cancelled';
  if (o?.received_at) return 'delivered';
  return String(o?.tracking_number || '').trim() ? 'shipped' : 'ordered';
}
export const STAGE_LABEL = { ordered: 'Ordered', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled' };
// A cancelled line's refund, traced: at cancellation it either came straight back
// ('refunded') or somebody has to chase it ('needs_request' → 'requested' → 'refunded').
export const REFUND_STATES = { refunded: 'Refunded', needs_request: 'Needs follow-up', requested: 'Requested — waiting' };
export const needsFollowUp = (l) => isCancelled(l) && (l.refund === 'needs_request' || l.refund === 'requested');
export const orderCode = (id) => `OO-${String(id).padStart(4, '0')}`;

// The order against its emailed receipt (found by the order number, api/_lib/online-order-receipts.js).
// One order number can be on several online orders, one per parcel the store shipped: the
// receipt is for ALL of them, so the pairs compared are everyone's together. Cancelled pairs
// count too: the receipt is what was ordered.
//   state: 'linked' | 'no_number' | 'looking' | 'not_found' | 'error' | 'none'
//   agrees: true / false, or null when the receipt has no item lines to count.
export function receiptLink(o) {
  const same = Array.isArray(o?.same_order) ? o.same_order : [];
  const entered = same.reduce((n, s) => n + (Number(s.pairs) || 0), 0);
  const base = { parcels: same.length, entered };
  if (!String(o?.order_number || '').trim()) return { ...base, state: 'no_number' };
  if (o.receipt) {
    const pairs = Number(o.receipt.pairs) || 0;
    return { ...base, state: 'linked', receiptPairs: pairs, agrees: pairs > 0 ? pairs === entered : null };
  }
  const c = o.receipt_check;
  if (!c || c.state === 'unconfigured') return { ...base, state: 'none' };
  if (c.state === 'pending') return { ...base, state: 'looking' };
  // Still on its own retries, or given up until someone presses the button.
  return { ...base, state: c.state === 'error' ? 'error' : 'not_found', retrying: !!c.next_at, checkedAt: c.checked_at || null, note: c.note || null };
}

// The photos a claim against the store needs when a parcel arrives short (owner, 2026-11-18):
// required at the bench before the box can be saved, and asked for on the case when the
// shortage is found later. `key` rides in the photo's file name, so each can be told apart.
export const CLAIM_PHOTOS = [
  { key: 'label', label: 'The shipping label with the tracking number', hint: 'Still on the parcel, the whole label readable.' },
  { key: 'pairs', label: 'Every shoe box that arrived, in one picture', hint: 'So the count can be seen: all the boxes side by side.' },
  { key: 'slip', label: 'The packing slip / manifest that came inside', hint: 'The paper the store packed with it.' },
];

// Receive New: the online-order line for this pair, across the orders its parcel(s) match.
// Same matching as a PO line (poLineMoney: code with dashes/spaces stripped, NUMERIC
// size), so an online order and a PO can't disagree about which line a pair is.
// → { each, price, code } — each = the actual cost; price = what was paid per shoe.
export function onlineLineFor(orders, sku, size) {
  for (const o of orders || []) {
    const active = (o.lines || []).filter((l) => !isCancelled(l) && l.each != null);
    const each = poLineMoney(active.map((l) => ({ sku: l.sku, size: l.size, unit_cost: l.each })), sku, size);
    if (!each) continue;
    const price = poLineMoney(active.map((l) => ({ sku: l.sku, size: l.size, unit_cost: l.unit_price })), sku, size);
    return { each: each.shelf, price: price?.shelf ?? null, code: orderCode(o.id) };
  }
  return null;
}

// Receive New: the box against the online order it is (Brent, 2026-10-21) — the same
// expected / received / missing / extra the warehouse sees when receiving against a PO,
// so a pair the store never sent is caught at the bench, not when the refund is chased.
// Expected = the order's lines still coming (cancelled ones are already settled); matched
// to the cart on the code with dashes/spaces stripped and the NUMERIC size, the rule
// onlineLineFor and poLineMoney use. Returns manifestSummary's { rows, totals } shape.
const bareCode = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');
const lineKey = (sku, size) => {
  const n = sizeNum(size);
  return `${bareCode(sku)}|${Number.isNaN(n) ? String(size || '').trim().toUpperCase() : n}`;
};
export function onlineOrderCheck(order, items) {
  const rows = new Map();
  for (const l of (order?.lines || []).filter((x) => !isCancelled(x))) {
    const k = lineKey(l.sku, l.size);
    const r = rows.get(k) || { key: k, sku: l.sku, name: l.name || '', expected: true, sizes: [{ key: 's', size: String(l.size ?? ''), expectedQty: 0, qty: 0 }] };
    r.sizes[0].expectedQty += Math.max(0, Number(l.qty) || 0);
    rows.set(k, r);
  }
  for (const it of items || []) {
    if (!it || it.pending) continue;
    for (const s of it.sizes || []) {
      const q = Math.max(0, Number(s.qty) || 0);
      if (!q) continue;
      const k = lineKey(it.sku || it.code, s.size);
      const r = rows.get(k) || { key: k, sku: it.sku || it.code || '', name: it.name || '', expected: false, sizes: [{ key: 's', size: String(s.size ?? ''), qty: 0 }] };
      if (!r.name && it.name) r.name = it.name;
      r.sizes[0].qty += q;
      rows.set(k, r);
    }
  }
  return manifestSummary([...rows.values()]);
}

// One line for the batch's issue list — what an auditor reads months later.
export function onlineCheckText(order, summary) {
  const off = (summary?.rows || []).filter((r) => r.state !== 'ok');
  const what = off.map((r) => {
    const n = r.state === 'unexpected' || r.state === 'over' ? `+${r.state === 'over' ? r.delta : r.received}` : `${r.received}/${r.expected}`;
    const label = { missing: 'missing', short: 'short', over: 'extra', unexpected: 'not on the order' }[r.state];
    return `${r.sku || '?'} US ${r.size} ${label} (${n})`;
  });
  return `${orderCode(order.id)} · ${order.store}${order.order_number ? ` #${order.order_number}` : ''}: ${what.join('; ')}`;
}
