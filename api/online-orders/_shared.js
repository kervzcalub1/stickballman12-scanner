// Shared by the api/online-orders/* handlers (docs/context/online-orders.md). A file
// starting with "_" is not mounted as a route.
import { orderCosts, orderStage } from '../../src/lib/onlineOrders.js';

export const actorOf = (user) => user?.name || user?.username || null;

// Input guards shared by the handlers (QA 2026-10-01: an id past bigint range, a
// 1e20 coupon or a "2026-13-45" date reached Postgres and came back as a 500).
export const MAX_MONEY = 1_000_000;
export const idOf = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
// A real calendar date, not just the right shape — Feb 30 is refused, not a 500.
export const realDate = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
};

// DB row → what the screen reads: numbers as numbers, each line's actual cost worked out
// by the SAME function the form used while typing, and the derived stage.
export function shapeOrder(o) {
  if (!o) return null;
  const lines = (o.lines || []).map((l) => ({
    ...l,
    id: Number(l.id), qty: Number(l.qty), unit_price: Number(l.unit_price),
    refund_amount: l.refund_amount == null ? null : Number(l.refund_amount),
  }));
  const money = { coupon: Number(o.coupon), tax: Number(o.tax), shipping: Number(o.shipping), gc_pct: Number(o.gc_pct), cashback: Number(o.cashback || 0) };
  const costs = orderCosts(money, lines);
  return {
    ...o, ...money, id: Number(o.id),
    lines: costs.lines,
    totals: { units: costs.units, subtotal: costs.subtotal, paid: costs.paid, cashback: costs.cashback, total: costs.total },
    stage: orderStage({ ...o, lines }),
  };
}
