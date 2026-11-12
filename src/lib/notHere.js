// "Is more of this shoe already coming?" for the approver's card: pairs approved, bought or
// shipped that have not reached the warehouse yet. On hand can't show them, so without this the
// same sizes get approved again the next day at another store (approvers' feedback, 2026-11-06).
//
// Each pair is counted once, at the furthest point it has reached. A request's approved lines
// count until it has a receipt, its receipt until it has a purchase order, and the order until
// the pairs are received.
import { compareSizes } from './codes.js';
import { sizeKey } from './buyPaste.js';

// Anything older is stuck or forgotten rather than coming, and would talk an approver out of a
// buy for pairs nobody expects any more.
export const NOT_HERE_DAYS = 30;

export const NOT_HERE_STAGES = [
  { key: 'approved', label: 'Approved, not bought yet' },
  { key: 'bought', label: 'Bought, not shipped yet' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'online', label: 'Online orders' },
];

const SHIPPED = new Set(['shipped', 'in_transit', 'delivered']);
const n = (v) => Number(v) || 0;
// Within one order a size matches by its number, as reconciliation does: the warehouse's "7.5W"
// is the order's "7.5".
const orderSize = (size) => {
  const k = sizeKey(size);
  const num = parseFloat(k);
  return Number.isFinite(num) ? String(num) : k;
};

/** What is still to arrive on purchase orders, per order and size, split by whether it has left. */
function fromOrders({ poLines = [], received = [], receivedBoxIds = [] }) {
  const landed = new Set(receivedBoxIds.map(Number));
  const orders = new Map();
  const rowFor = (po, size) => {
    const k = `${po}|${orderSize(size)}`;
    if (!orders.has(k)) orders.set(k, { po, size, listed: 0, boxed: 0, out: 0, inLandedBoxes: 0, counted: 0 });
    return orders.get(k);
  };
  for (const l of poLines) {
    const row = rowFor(l.po_id, l.size);
    if (l.po_box_id == null) { row.listed += n(l.qty); continue; }
    // A replacement label re-sends pairs the original already expected.
    if (l.box_kind === 'replacement') continue;
    row.boxed += n(l.qty);
    if (landed.has(Number(l.po_box_id))) row.inLandedBoxes += n(l.qty);
    else if (SHIPPED.has(l.box_status)) row.out += n(l.qty);
  }
  for (const r of received) {
    const k = `${r.po_id}|${orderSize(r.size)}`;
    if (orders.has(k)) orders.get(k).counted += n(r.qty);
  }
  const rows = [];
  for (const o of orders.values()) {
    // The order's own list is what was paid for; its boxes only say how much has been packed.
    const expected = o.listed > 0 ? o.listed : o.boxed;
    // Two records of the same arrival, so the larger one, never the sum of them.
    const left = Math.max(0, expected - Math.max(o.counted, o.inLandedBoxes));
    const shipped = Math.min(left, o.out);
    if (shipped > 0) rows.push({ stage: 'shipped', size: o.size, qty: shipped, po: o.po });
    if (left > shipped) rows.push({ stage: 'bought', size: o.size, qty: left - shipped, po: o.po });
  }
  return rows;
}

// The buying request a pair is on, as everyone already calls it ("BC-13"). Only the approved and
// receipt stages come from a request; an order or an online buy has its own number elsewhere.
const fromCart = (r) => {
  const id = Number(r.cart_id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return { id, code: String(r.cart_code || '').trim() || `BC-${id}` };
};

/** The distinct requests behind a stage's pairs, oldest first. */
function requestsOf(list) {
  const m = new Map();
  for (const r of list) if (r.cart && !m.has(r.cart.id)) m.set(r.cart.id, r.cart);
  return [...m.values()].sort((a, b) => a.id - b.id).map((c) => c.code);
}

// How many purchase orders also hold pairs of a stage that names requests. "Bought, not shipped
// yet" mixes receipts with orders not yet packed, and "(From BC-13)" alone would claim the
// order's pairs for the request too.
const ordersOf = (list) => new Set(list.filter((r) => !r.cart && r.po != null).map((r) => String(r.po))).size;

/** @returns {{ total:number, sizes:Array<{size,qty}>, stages:Array<{key,label,sizes,qty,requests:string[],orders:number}> }} */
export function notHereSummary({ approved = [], receipts = [], poLines = [], received = [], receivedBoxIds = [], online = [] } = {}) {
  const rows = [
    ...approved.map((r) => ({ stage: 'approved', size: r.size, qty: n(r.qty), cart: fromCart(r) })),
    ...receipts.map((r) => ({ stage: 'bought', size: r.size, qty: n(r.qty), cart: fromCart(r) })),
    ...fromOrders({ poLines, received, receivedBoxIds }),
    ...online.map((r) => ({ stage: 'online', size: r.size, qty: n(r.qty) })),
  ].filter((r) => r.qty > 0);
  const tally = (list) => {
    const m = new Map();
    for (const r of list) {
      const k = sizeKey(r.size) || '?';
      const cur = m.get(k) || { size: r.size || '?', qty: 0 };
      cur.qty += r.qty;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => compareSizes(a.size, b.size));
  };
  return {
    total: rows.reduce((t, r) => t + r.qty, 0),
    sizes: tally(rows),
    stages: NOT_HERE_STAGES.flatMap(({ key, label }) => {
      const list = rows.filter((r) => r.stage === key);
      return list.length
        ? [{ key, label, qty: list.reduce((t, r) => t + r.qty, 0), sizes: tally(list), requests: requestsOf(list), orders: ordersOf(list) }]
        : [];
    }),
  };
}

const sizesText = (sizes) => sizes.map((s) => `${s.size} ×${s.qty}`).join(', ');
// "(From BC-13, BC-14)": which requests those pairs are on, so the approver can open them. Only
// a stage that names a request says where it came from; an order's pairs are counted beside it.
const fromText = ({ requests = [], orders = 0 }) => {
  if (!requests.length) return '';
  const also = orders ? ` + ${orders === 1 ? 'a purchase order' : `${orders} purchase orders`}` : '';
  return ` (From ${requests.join(', ')}${also})`;
};

/** The card's lines. A count that couldn't be read says so: it is not the same as none. */
export function notHereLines(summary) {
  if (!summary) return ['Not in warehouse yet: could not be read.'];
  if (!summary.total) return ['Not in warehouse yet: none.'];
  return [
    `Not in warehouse yet: ${sizesText(summary.sizes)}`,
    ...summary.stages.map((s) => `${s.label}: ${sizesText(s.sizes)}${fromText(s)}`),
  ];
}
