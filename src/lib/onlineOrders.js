// Online orders — what each pair ACTUALLY cost (docs/context/online-orders.md).
//
// An online order is priced per shoe, then the order-level money lands on top of it:
//   coupon    — split evenly per UNIT ordered (owner's rule: "divided per units ordered")
//   tax       — split by PRICE: a $200 pair carries twice a $100 pair's share
//   shipping  — split by PRICE, the same way
//   gift card — a PERCENTAGE off everything paid (the cards were bought at a discount
//               and the order was paid with them)
//   = actual cost each = (price − coupon each + tax share + shipping share) × (1 − gc%)
//
// Cancelled lines are left out of the split: the pairs that are actually coming carry
// the order's coupon, tax and shipping. Pure — the screen and the server use the same
// function, so the number PH saw while typing is the number that was saved.

import { poLineMoney } from './costs.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const cents = (v) => Math.round(v * 100) / 100;

export const isCancelled = (line) => !!(line && (line.cancelled_at || line.cancelled));

// `order`: { coupon, tax, shipping, gc_pct }; `lines`: [{ qty, unit_price, cancelled_at? }]
// → { lines: [{ ...line, each, lineTotal, parts: { price, coupon, tax, shipping, gc } }],
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
    return {
      ...l,
      each: cents(before - g),
      // Rounded from the EXACT per-pair figure, not from the rounded `each` — 3 × $36.663
      // is $109.99, while 3 × $36.66 would be a cent short of the order total (QA).
      lineTotal: cents((before - g) * num(l.qty)),
      parts: { price, coupon: cents(couponEach), tax: cents(t), shipping: cents(s), gc: cents(g) },
    };
  });
  const paid = subtotal - coupon + tax + shipping;
  return {
    lines: out,
    units,
    subtotal: cents(subtotal),
    paid: cents(paid),                          // what the store charged
    total: cents(paid * (1 - gc / 100)),        // what it cost us, after the card discount
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
