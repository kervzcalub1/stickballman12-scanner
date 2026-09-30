// Shared by the api/online-orders/* handlers (docs/context/online-orders.md). A file
// starting with "_" is not mounted as a route.
import { orderCosts, orderStage } from '../../src/lib/onlineOrders.js';

export const actorOf = (user) => user?.name || user?.username || null;

// DB row → what the screen reads: numbers as numbers, each line's actual cost worked out
// by the SAME function the form used while typing, and the derived stage.
export function shapeOrder(o) {
  if (!o) return null;
  const lines = (o.lines || []).map((l) => ({
    ...l,
    id: Number(l.id), qty: Number(l.qty), unit_price: Number(l.unit_price),
    refund_amount: l.refund_amount == null ? null : Number(l.refund_amount),
  }));
  const money = { coupon: Number(o.coupon), tax: Number(o.tax), shipping: Number(o.shipping), gc_pct: Number(o.gc_pct) };
  const costs = orderCosts(money, lines);
  return {
    ...o, ...money, id: Number(o.id),
    lines: costs.lines,
    totals: { units: costs.units, subtotal: costs.subtotal, paid: costs.paid, total: costs.total },
    stage: orderStage({ ...o, lines }),
  };
}
