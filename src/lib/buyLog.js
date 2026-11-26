// Buy Log — a supplier's own record of what they bought for us from a store that gives no
// receipt (docs/context/buy-log.md). Pure: the server shapes rows with these, the screen
// draws with them, and the Excel / CSV download is built from them.
//
// An order = lines (SKU, cost, pairs; a size when the supplier knows it), the payments made
// against it, and the purchase orders it ships on. From those:
//   · money     total = Σ pairs × cost; paid = Σ payments; unpaid · part · paid · over
//   · receiving ordered vs SHIPPED (the linked POs' manifests) vs RECEIVED (pairs scanned in
//               on those POs' batches), per SKU — and per size where a size was declared.
import { sizeNum } from './codes.js';

export const buyCode = (id) => `BL-${id}`;
const bare = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
// "10W" and "10" are one size here, like a PO line match; blank / "?" = not known.
export const sizeKey = (s) => {
  const t = String(s ?? '').trim();
  if (!t || /^(\?|n\/?a|any|random|mixed)$/i.test(t)) return '';
  const n = sizeNum(t);
  return Number.isNaN(n) ? t.toUpperCase() : String(n);
};

export const PAY_LABEL = { unpaid: 'Unpaid', part: 'Partly paid', paid: 'Paid', over: 'Overpaid' };
export function buyMoney(lines = [], payments = []) {
  const pairs = lines.reduce((n, l) => n + (Number(l.qty) || 0), 0);
  const total = r2(lines.reduce((n, l) => n + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0));
  const paid = r2(payments.reduce((n, p) => n + (Number(p.amount) || 0), 0));
  const balance = r2(total - paid);
  const state = paid <= 0 ? 'unpaid' : balance > 0.005 ? 'part' : balance < -0.005 ? 'over' : 'paid';
  return { pairs, total, paid, balance, state };
}

export const RECV_LABEL = {
  no_po: 'No PO linked', not_shipped: 'Not shipped', shipped: 'Shipped, not received',
  part: 'Partly received', received: 'Received', over: 'More received than ordered',
};
/**
 * ordered vs shipped vs received.
 *   lines     [{ sku, size?, qty, unit_cost, name? }]
 *   shipped   [{ sku, size, qty }]   the linked POs' manifest lines
 *   received  [{ sku, size, qty }]   pairs scanned in on the linked POs' batches
 * → { rows: [{ sku, name, ordered, shipped, received, short, sizes: [{ size, ordered, shipped, received }] | null, extra }], state }
 * A SKU is compared by size only when EVERY ordered line of it has a size; otherwise the
 * sizes are "whatever the store picked" and only the SKU's pair count is checked.
 * `extra` = shipped or received on these POs but not on the order (another order's shoes
 * on the same PO, or something nobody declared).
 */
export function buyCompare(lines = [], shipped = [], received = [], { linked = true } = {}) {
  const by = new Map();
  const row = (sku, name) => {
    const k = bare(sku);
    if (!by.has(k)) by.set(k, { sku, name: name || null, ordered: 0, shipped: 0, received: 0, sized: true, sizes: new Map(), extra: true });
    const g = by.get(k);
    if (!g.name && name) g.name = name;
    return g;
  };
  const cell = (g, size) => {
    const k = sizeKey(size);
    if (!g.sizes.has(k)) g.sizes.set(k, { size: k, ordered: 0, shipped: 0, received: 0 });
    return g.sizes.get(k);
  };
  for (const l of lines) {
    const g = row(l.sku, l.name); const q = Number(l.qty) || 0;
    g.extra = false; g.ordered += q;
    if (!sizeKey(l.size)) g.sized = false; else cell(g, l.size).ordered += q;
  }
  for (const [list, f] of [[shipped, 'shipped'], [received, 'received']]) {
    for (const x of list) { const g = row(x.sku, x.name); const q = Number(x.qty) || 0; g[f] += q; cell(g, x.size)[f] += q; }
  }
  const rows = [...by.values()].map((g) => ({
    sku: g.sku, name: g.name, ordered: g.ordered, shipped: g.shipped, received: g.received, extra: g.extra,
    short: Math.max(0, g.ordered - g.received),
    sizes: g.sized && !g.extra ? [...g.sizes.values()].filter((z) => z.size).sort((a, b) => (sizeNum(a.size) - sizeNum(b.size)) || a.size.localeCompare(b.size)) : null,
  })).sort((a, b) => Number(a.extra) - Number(b.extra) || bare(a.sku).localeCompare(bare(b.sku)));
  const mine = rows.filter((r) => !r.extra);
  const ordered = mine.reduce((n, r) => n + r.ordered, 0);
  const got = mine.reduce((n, r) => n + r.received, 0);
  const sent = mine.reduce((n, r) => n + r.shipped, 0);
  const sizeOff = mine.some((r) => r.sizes && r.sizes.some((z) => z.received !== z.ordered));
  const state = !linked ? 'no_po' : got === 0 ? (sent > 0 ? 'shipped' : 'not_shipped')
    : mine.some((r) => r.received > r.ordered) ? 'over'
      : got < ordered || mine.some((r) => r.received < r.ordered) || sizeOff ? 'part' : 'received';
  return { rows, state, ordered, shipped: sent, received: got };
}

/** DB row → what the screen reads: numbers as numbers, money and receiving worked out. */
export function shapeBuy(b) {
  if (!b) return null;
  const lines = (b.lines || []).map((l) => ({ ...l, id: Number(l.id), qty: Number(l.qty), unit_cost: Number(l.unit_cost), size: l.size || '' }));
  const payments = (b.payments || []).map((p) => ({ ...p, id: Number(p.id), amount: Number(p.amount), proof: p.proof || [] }));
  const pos = (b.pos || []).map((p) => ({ ...p, po_id: Number(p.po_id), tracking: p.tracking || [] }));
  const cmp = buyCompare(lines, b.shipped || [], b.received || [], { linked: pos.length > 0 });
  return {
    id: Number(b.id), code: buyCode(b.id), supplier_user_id: b.supplier_user_id == null ? null : Number(b.supplier_user_id),
    supplier_name: b.supplier_name, store: b.store || '', order_number: b.order_number || '', ordered_on: b.ordered_on || '',
    tracking_numbers: b.tracking_numbers || [], note: b.note || '',
    created_by: b.created_by, created_at: b.created_at, updated_by: b.updated_by, updated_at: b.updated_at,
    lines, payments, pos, money: buyMoney(lines, payments), compare: cmp.rows, receiving: cmp.state,
    counts: { ordered: cmp.ordered, shipped: cmp.shipped, received: cmp.received },
  };
}

// The download: one row per LINE, every column filled, so it sorts and pivots — the
// "spreadsheet of every order" (order date + number, SKU, sizes, pairs, cost, total,
// payment, tracking, receiving).
export const BUY_COLS = [
  ['code', 'Buy #'], ['ordered_on', 'Order date (EST)'], ['supplier', 'Bought by'], ['store', 'Store'], ['order_number', 'Order #'],
  ['sku', 'SKU'], ['name', 'Shoe'], ['size', 'Size'], ['qty', 'Pairs'], ['unit_cost', 'Cost per pair'], ['line_total', 'Line total'],
  ['order_total', 'Order total'], ['paid', 'Paid so far'], ['balance', 'Balance'], ['payment', 'Payment status'], ['proofs', 'Payment screenshots'],
  ['tracking', 'Tracking #'], ['pos', 'Purchase orders'], ['sku_shipped', 'SKU shipped'], ['sku_received', 'SKU received'], ['receiving', 'Receiving status'], ['note', 'Note'],
];
export function buyRows(buys = []) {
  const out = [];
  for (const b of buys) {
    const cmp = new Map((b.compare || []).map((r) => [bare(r.sku), r]));
    for (const l of b.lines.length ? b.lines : [{ sku: '', name: '', size: '', qty: 0, unit_cost: 0 }]) {
      const c = cmp.get(bare(l.sku));
      out.push({
        code: b.code, ordered_on: b.ordered_on, supplier: b.supplier_name, store: b.store, order_number: b.order_number,
        sku: l.sku, name: l.name || '', size: l.size || '', qty: l.qty, unit_cost: l.unit_cost, line_total: r2(l.qty * l.unit_cost),
        order_total: b.money.total, paid: b.money.paid, balance: b.money.balance, payment: PAY_LABEL[b.money.state], proofs: `${b.payments.filter((p) => (p.proof || []).length).length} of ${b.payments.length} payments`,
        tracking: [...new Set([...(b.pos || []).flatMap((p) => p.tracking || []), ...(b.tracking_numbers || [])])].join(' '), pos: (b.pos || []).map((p) => p.po_code).join(' '),
        sku_shipped: c ? c.shipped : 0, sku_received: c ? c.received : 0, receiving: RECV_LABEL[b.receiving], note: b.note || '',
      });
    }
  }
  return out;
}
