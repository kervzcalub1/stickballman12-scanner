// POST /api/batches/link-online-order  (warehouse / ph_team / admin)
//   { batchId, orderId }        tie the batch to that online order (or move it there)
//   { batchId, orderId: null }  remove the hand link
// The Batch page's "Link to an online order" (docs/context/online-orders.md "Linked to a
// batch"). Linking writes the join and then fills the cost of every pair in the batch that
// has NONE, from the order's actual cost for that SKU + size — the same number receiving
// would have used had the parcel's tracking number been on the order. A cost already on a
// pair is never changed, and unlinking leaves costs alone.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import {
  dbConfigured, PH_EXCLUDED_KINDS, getBatch, getOnlineOrder, linkBatchToOnlineOrder, unlinkBatchFromOnlineOrder,
  listBatchBlankCostItems, fillItemsCost,
} from '../_lib/db.js';
import { shapeOrder, actorOf, idOf } from '../online-orders/_shared.js';
import { onlineLineFor, orderCode } from '../../src/lib/onlineOrders.js';

const money = (n) => `$${Number(n).toFixed(2)}`;

// Blank-cost pairs → groups of the same cost, each written with its history note.
async function fillCostsFromOrder(batchId, order, by) {
  const shaped = shapeOrder(order);
  const blank = await listBatchBlankCostItems(batchId);
  const groups = new Map();
  for (const it of blank) {
    const hit = onlineLineFor([shaped], it.sku, it.size)
      // A GS pair received as a men's size: the order lists what the box said.
      || ((it.original_sku || it.original_size) ? onlineLineFor([shaped], it.original_sku || it.sku, it.original_size || it.size) : null);
    if (!hit || hit.each == null) continue;
    const k = `${hit.each}|${hit.price ?? ''}`;
    const g = groups.get(k) || { ids: [], each: hit.each, price: hit.price };
    g.ids.push(Number(it.id));
    groups.set(k, g);
  }
  let filled = 0;
  for (const g of groups.values()) {
    filled += await fillItemsCost(g.ids, g.each, g.price,
      `Cost filled from online order ${orderCode(order.id)} (${order.store}): ${money(g.each)} actual cost — batch linked to the order`, by);
  }
  return { filled, blank: blank.length };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const batchId = idOf(body.batchId);
  if (!batchId) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });
  const unlink = body.orderId == null;
  const orderId = unlink ? null : idOf(body.orderId);
  if (!unlink && !orderId) return send(res, 400, { ok: false, error: 'Which online order?' });
  const actor = actorOf(user);

  try {
    // PH never reaches an in-store / existing-stock batch, by id either.
    const found = await getBatch(batchId);
    if (!found || (user.role === 'ph_team' && PH_EXCLUDED_KINDS.includes(found.batch?.kind)))
      return send(res, 404, { ok: false, error: 'Batch not found.' });

    if (unlink) {
      const r = await unlinkBatchFromOnlineOrder({ batchId, actor });
      if (r.error) return send(res, r.status || 409, { ok: false, error: r.error });
      return send(res, 200, { ok: true, unlinked: true });
    }
    const r = await linkBatchToOnlineOrder({ batchId, orderId, actor });
    if (r.error) return send(res, r.status || 409, { ok: false, error: r.error });
    // The link is saved; a cost fill that fails must not report the link as failed.
    let costs = { filled: 0, blank: 0 };
    try { costs = await fillCostsFromOrder(batchId, await getOnlineOrder(orderId), actor); }
    catch (e) { console.warn('[batches/link-online-order] cost fill:', e.message); }
    return send(res, 200, {
      ok: true,
      order: { id: orderId, code: orderCode(orderId), store: r.order.store, order_number: r.order.order_number },
      costs,
    });
  } catch (e) {
    console.error('[batches/link-online-order]', e.message);
    return send(res, 500, { ok: false, error: 'Could not link the batch to that online order.' });
  }
}
