// Which online order does a parcel from the store's shipping email belong to?
// (docs/context/online-orders.md → "Tracking numbers fill themselves".) Pure: the server
// applies one step at a time and asks again, so every step is planned from what is in the
// database right then.
//
// The team's own convention is the model: an order the store ships in several parcels is
// several online orders with the same order number, one per parcel, each with its own tracking
// number and pairs. So a parcel either
//   · already is on an order (its tracking number is there)            -> nothing to do
//   · is exactly an order that has no tracking number yet (same sizes) -> FILL the number in
//   · is part of the one order that has no tracking number yet         -> CARVE those pairs
//     into their own order with the number, the order's money split with them
// and anything else is left for a person, listed as not placed. It never touches an order
// the warehouse counted in, an order that already has a tracking number, or a cancelled pair.
import { sizeNum } from './codes.js';
import { trackKey, isCancelled } from './onlineOrders.js';

const r2 = (n) => Math.round(n * 100) / 100;
const sizeKey = (s) => { const n = sizeNum(s); return Number.isNaN(n) ? String(s ?? '').trim().toUpperCase() : String(n); };
const active = (o) => (o.lines || []).filter((l) => !isCancelled(l) && Number(l.qty) > 0);
const pairs = (ls) => ls.reduce((n, l) => n + Number(l.qty), 0);
// "7.5:4|9:2" — what a parcel holds by size, whatever the shoe is called.
const sig = (ls) => {
  const m = new Map();
  for (const l of ls) m.set(sizeKey(l.size), (m.get(sizeKey(l.size)) || 0) + Number(l.qty));
  return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, q]) => `${k}:${q}`).join('|');
};
const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
const overlap = (a, b) => { let n = 0; for (const w of a) if (b.has(w)) n += 1; return n; };

// The order's lines this parcel's items are, or null when that can't be said for sure: a size
// the order doesn't have enough of, or two different shoes in that size and a name that
// doesn't pick one.
function take(order, items) {
  const left = active(order).map((l) => ({ ...l, left: Number(l.qty) }));
  const out = [];
  for (const it of items) {
    const cands = left.filter((l) => l.left > 0 && sizeKey(l.size) === sizeKey(it.size));
    const skus = [...new Set(cands.map((l) => String(l.sku).toUpperCase()))];
    let sku = skus[0];
    if (skus.length > 1) {
      const want = words(it.name);
      const scored = skus.map((s) => [s, Math.max(...cands.filter((l) => String(l.sku).toUpperCase() === s).map((l) => overlap(want, words(`${l.name || ''} ${l.sku}`))))])
        .sort((a, b) => b[1] - a[1]);
      if (!scored[0][1] || scored[0][1] === scored[1][1]) return null;
      sku = scored[0][0];
    }
    let need = Number(it.qty);
    for (const l of cands.filter((c) => String(c.sku).toUpperCase() === sku)) {
      const q = Math.min(need, l.left);
      if (!q) continue;
      l.left -= q; need -= q;
      out.push({ sku: l.sku, name: l.name || null, size: l.size, qty: q, unit_price: Number(l.unit_price) });
    }
    if (need > 0) return null;
  }
  const rest = left.filter((l) => l.left > 0).map((l) => ({ sku: l.sku, name: l.name || null, size: l.size, qty: l.left, unit_price: Number(l.unit_price) }));
  return { lines: out, rest };
}

/**
 * orders: every online order with this order number ({ id, tracking_number, received_at,
 *   coupon, tax, shipping, lines }). shipments: [{ tracking, carrier, items:[{ name, size, qty }] }],
 *   oldest first. `skip`: tracking keys not to place (already on some other order).
 * -> { action, unplaced }. action is the NEXT step only, or null:
 *   { kind:'fill',  orderId, tracking }
 *   { kind:'carve', orderId, lineIds, lineQtys, tracking, lines, rest, money:{ parcel, rest } }
 */
export function planParcels(orders, shipments, skip = new Set()) {
  const on = new Set(orders.map((o) => trackKey(o.tracking_number)).filter(Boolean));
  const todo = (shipments || []).filter((s) => trackKey(s.tracking) && !on.has(trackKey(s.tracking)) && !skip.has(trackKey(s.tracking)));
  const open = orders.filter((o) => !trackKey(o.tracking_number) && !o.received_at && pairs(active(o)) > 0)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const placeable = todo.filter((s) => (s.items || []).length && pairs(s.items) > 0);

  for (const s of placeable) {
    const hit = open.find((o) => sig(active(o)) === sig(s.items));
    if (hit) return { action: { kind: 'fill', orderId: Number(hit.id), tracking: s.tracking, pairs: pairs(s.items) }, unplaced: [] };
  }
  if (open.length === 1) {
    const o = open[0];
    for (const s of placeable) {
      const t = take(o, s.items);
      if (!t || !t.rest.length) continue;
      const all = active(o);
      const unitShare = pairs(t.lines) / pairs(all);
      const sub = (ls) => ls.reduce((n, l) => n + Number(l.unit_price) * Number(l.qty), 0);
      const priceShare = sub(all) > 0 ? sub(t.lines) / sub(all) : unitShare;
      // Split the way orderCosts spreads them, so no pair's actual cost moves: the coupon per
      // pair, tax and shipping by price. The order keeps whatever the rounding leaves.
      const parcel = { coupon: r2(Number(o.coupon || 0) * unitShare), tax: r2(Number(o.tax || 0) * priceShare), shipping: r2(Number(o.shipping || 0) * priceShare) };
      const rest = { coupon: r2(Number(o.coupon || 0) - parcel.coupon), tax: r2(Number(o.tax || 0) - parcel.tax), shipping: r2(Number(o.shipping || 0) - parcel.shipping) };
      return {
        action: { kind: 'carve', orderId: Number(o.id), lineIds: [...all].sort((a, b) => Number(a.id) - Number(b.id)).map((l) => Number(l.id)), lineQtys: [...all].sort((a, b) => Number(a.id) - Number(b.id)).map((l) => Number(l.qty)), tracking: s.tracking, pairs: pairs(t.lines), lines: t.lines, rest: t.rest, money: { parcel, rest } },
        unplaced: [],
      };
    }
  }
  return { action: null, unplaced: todo.map((s) => trackKey(s.tracking)) };
}
