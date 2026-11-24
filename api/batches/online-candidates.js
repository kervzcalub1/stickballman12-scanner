// GET /api/batches/online-candidates?batchId=&q=  (warehouse / ph_team / admin)
// Which ONLINE orders this already-received batch could belong to — the Batch page's
// "Link to an online order". A parcel bought from an online store is not a purchase
// order, so its batch could never be tied to anything unless the tracking number happened
// to be typed on the order (docs/context/online-orders.md "Linked to a batch").
// Orders carrying the batch's tracking number come first, then the ones that hold the
// most of the batch's pairs (same SKU + size matching as receiving), then the newest.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { listBatchOnlineCandidates, dbConfigured, PH_EXCLUDED_KINDS } from '../_lib/db.js';
import { lineKey, orderCode } from '../../src/lib/onlineOrders.js';

// How many of the batch's pairs this order's (non-cancelled) lines cover.
function pairsOnOrder(lines, items) {
  const left = new Map();
  for (const l of lines || []) {
    const k = lineKey(l.sku, l.size);
    left.set(k, (left.get(k) || 0) + Math.max(0, Number(l.qty) || 0));
  }
  let n = 0;
  for (const it of items || []) {
    // A GS pair received as a men's size is on the order under what the box said.
    const keys = [lineKey(it.sku, it.size)];
    if (it.original_sku || it.original_size) keys.push(lineKey(it.original_sku || it.sku, it.original_size || it.size));
    const k = keys.find((x) => (left.get(x) || 0) > 0);
    if (!k) continue;
    left.set(k, left.get(k) - 1);
    n += 1;
  }
  return n;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const url = new URL(req.url, 'http://x');
  const batchId = Number(url.searchParams.get('batchId'));
  if (!Number.isSafeInteger(batchId) || batchId <= 0) return send(res, 400, { ok: false, error: 'A valid batchId is required.' });
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);

  try {
    const r = await listBatchOnlineCandidates(batchId, q);
    // PH never sees an in-store / existing-stock batch, by id either (batches/full does the same).
    if (!r || (user.role === 'ph_team' && PH_EXCLUDED_KINDS.includes(r.batch.kind)))
      return send(res, 404, { ok: false, error: 'Batch not found.' });
    const orders = r.orders.map((o) => ({
      id: Number(o.id), code: orderCode(o.id), store: o.store, order_number: o.order_number,
      tracking_number: o.tracking_number, ordered_on: o.ordered_on, created_at: o.created_at,
      received_at: o.received_at, lines: o.lines || [],
      pairs: (o.lines || []).reduce((n, l) => n + (Number(l.qty) || 0), 0),
      tracking_match: o.tracking_match === true,
      on_order: pairsOnOrder(o.lines, r.items),
      linked_batches: o.linked_batches || [],
    })).sort((a, b) => (Number(b.tracking_match) - Number(a.tracking_match)) || (b.on_order - a.on_order) || (b.id - a.id))
      .slice(0, 40);
    return send(res, 200, {
      ok: true,
      batch: {
        id: Number(r.batch.id), pairs: r.items.length,
        online_order_id: r.batch.online_order_id == null ? null : Number(r.batch.online_order_id),
        po_id: r.batch.po_id == null ? null : Number(r.batch.po_id),
      },
      orders,
    });
  } catch (e) {
    console.error('[batches/online-candidates]', e.message);
    return send(res, 500, { ok: false, error: 'Could not load the online orders.' });
  }
}
