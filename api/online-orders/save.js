// POST /api/online-orders/save
//   { id?, store, order_number?, tracking_number?, ordered_on?, coupon, tax, shipping,
//     gc_pct, note?, lines:[{ sku, name?, size, qty, unit_price }], allowDuplicateTracking? }
//   -> { ok, id }   ·   409 { duplicate:{ id, store } } when another order has the tracking #
// Create or edit an online order. `lines` are the ACTIVE lines — cancelled ones are
// history and are changed only through line.js. PH records orders (admin auto-allowed).
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { dbConfigured, createOnlineOrder, updateOnlineOrder, getOnlineOrder, onlineOrderByTracking } from '../_lib/db.js';
import { actorOf } from './_shared.js';
import { orderCode } from '../../src/lib/onlineOrders.js';

const text = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };
// Money: blank is 0 here — a coupon or shipping nobody typed is genuinely none. Negative
// or non-numeric is refused rather than quietly zeroed.
const money = (v) => {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const b = await getJsonBody(req);
  const id = b.id != null ? Number(b.id) : null;
  if (id != null && (!Number.isInteger(id) || id <= 0)) return send(res, 400, { ok: false, error: 'Which order?' });

  const o = {
    store: text(b.store, 120),
    order_number: text(b.order_number, 80),
    tracking_number: text(b.tracking_number, 60),
    ordered_on: /^\d{4}-\d{2}-\d{2}$/.test(String(b.ordered_on || '')) ? b.ordered_on : null,
    coupon: money(b.coupon), tax: money(b.tax), shipping: money(b.shipping),
    gc_pct: money(b.gc_pct),
    note: text(b.note, 1000),
  };
  if (!o.store) return send(res, 400, { ok: false, error: 'Which store was it bought from?' });
  for (const k of ['coupon', 'tax', 'shipping', 'gc_pct']) {
    if (Number.isNaN(o[k])) return send(res, 400, { ok: false, error: `The ${k === 'gc_pct' ? 'gift card discount' : k} has to be a number, 0 or more.` });
  }
  if (o.gc_pct > 100) return send(res, 400, { ok: false, error: 'The gift card discount is a percentage — 100 at most.' });

  const raw = Array.isArray(b.lines) ? b.lines.slice(0, 200) : [];
  const lines = [];
  for (const [i, l] of raw.entries()) {
    const sku = text(l?.sku, 60);
    const size = text(l?.size, 20);
    const qty = Number(l?.qty);
    const price = money(l?.unit_price);
    if (!sku && !size && !l?.unit_price) continue;   // an empty row left on the form
    if (!sku || !size) return send(res, 400, { ok: false, error: `Line ${i + 1} needs a SKU and a size.` });
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) return send(res, 400, { ok: false, error: `Line ${i + 1}: the quantity has to be a whole number, 1 or more.` });
    if (Number.isNaN(price) || l?.unit_price === '' || l?.unit_price == null) return send(res, 400, { ok: false, error: `Line ${i + 1} needs the price paid per shoe.` });
    lines.push({ sku: sku.toUpperCase(), name: text(l?.name, 200), size, qty, unit_price: price });
  }

  try {
    const before = id ? await getOnlineOrder(id) : null;
    if (id && !before) return send(res, 404, { ok: false, error: 'That order no longer exists.' });
    // A new order needs something on it; an edited one may be left with only cancelled lines.
    const cancelledCount = (before?.lines || []).filter((l) => l.cancelled_at).length;
    if (!lines.length && !cancelledCount) return send(res, 400, { ok: false, error: 'Add at least one shoe to the order.' });
    if (before?.received_at && lines.reduce((n, l) => n + l.qty, 0) !== (before.lines || []).filter((l) => !l.cancelled_at).reduce((n, l) => n + Number(l.qty), 0)) {
      return send(res, 409, { ok: false, error: 'The warehouse already counted this order in — the number of pairs can’t change now. Cancel a line instead.' });
    }
    if (o.tracking_number && !b.allowDuplicateTracking) {
      const dup = await onlineOrderByTracking(o.tracking_number, id);
      if (dup) {
        return send(res, 409, {
          ok: false, duplicate: { id: Number(dup.id), store: dup.store, order_number: dup.order_number },
          error: `${orderCode(dup.id)} (${dup.store}) already has this tracking number.`,
        });
      }
    }
    const actor = actorOf(user);
    if (!id) {
      const newId = await createOnlineOrder(o, lines, actor);
      return send(res, 200, { ok: true, id: Number(newId) });
    }
    const changes = [];
    if (!before.tracking_number && o.tracking_number) changes.push(`tracking ${o.tracking_number} added — shipped`);
    else if (before.tracking_number !== o.tracking_number) changes.push(`tracking ${before.tracking_number || '—'} → ${o.tracking_number || '—'}`);
    for (const k of ['coupon', 'tax', 'shipping', 'gc_pct']) {
      if (Number(before[k]) !== o[k]) changes.push(`${k === 'gc_pct' ? 'gift card %' : k} ${Number(before[k])} → ${o[k]}`);
    }
    const beforeUnits = (before.lines || []).filter((l) => !l.cancelled_at).reduce((n, l) => n + Number(l.qty), 0);
    const afterUnits = lines.reduce((n, l) => n + l.qty, 0);
    if (beforeUnits !== afterUnits) changes.push(`${beforeUnits} → ${afterUnits} pair(s)`);
    await updateOnlineOrder(id, o, lines, actor, changes.join(' · ') || 'details edited');
    return send(res, 200, { ok: true, id });
  } catch (e) {
    console.error('[online-orders/save]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the order.' });
  }
}
