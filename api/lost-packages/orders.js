// Lost Package Tracker Tool — one run's orders (docs/context/lost-packages.md).
//   GET  /api/lost-packages/orders?run=ID  -> { ok, run, orders }
//   POST /api/lost-packages/orders  { runId, orders: [...] }  -> { ok, uploaded, orderCount }
// The browser sends a run's orders in chunks (the body cap is 256 KB; a month can be
// thousands of orders). Re-sending a chunk is harmless. Opening a run whose Phase 2 is
// running also nudges the worker, so a dev server restart picks the job back up.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getLostRun, listLostOrders, addLostOrders, requeueStuckLostOrders, dbConfigured } from '../_lib/db.js';
import { kickLostPackages } from '../_lib/lostpkg-worker.js';

const MAX_CHUNK = 500;
const CLASSES = new Set(['Lost', 'Delivered', 'Cancelled', 'Refunded']);
const cap = (v, n = 300) => String(v ?? '').slice(0, n);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['ph_team'])) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 600 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      const id = Number(new URL(req.url, 'http://x').searchParams.get('run'));
      if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'Which run?' });
      const run = await getLostRun(id);
      if (!run) return send(res, 404, { ok: false, error: 'That run is gone.' });
      if (run.p2_status === 'running') {
        requeueStuckLostOrders(10).catch(() => {}).finally(kickLostPackages);
      }
      return send(res, 200, { ok: true, run, orders: await listLostOrders(id) });
    }
    const b = await getJsonBody(req);
    const runId = Number(b.runId);
    if (!Number.isInteger(runId)) return send(res, 400, { ok: false, error: 'Which run?' });
    const list = Array.isArray(b.orders) ? b.orders : [];
    if (!list.length || list.length > MAX_CHUNK) return send(res, 400, { ok: false, error: `Send between 1 and ${MAX_CHUNK} orders at a time.` });
    const orders = [];
    for (const o of list) {
      if (!o || !String(o.key || '').trim() || !CLASSES.has(o.p1_class)) return send(res, 400, { ok: false, error: 'An order in that chunk is malformed.' });
      orders.push({
        key: cap(o.key, 200), tracking: cap(o.tracking, 80), order_number: cap(o.order_number, 120), tracking_fallback: cap(o.tracking_fallback, 80),
        store: cap(o.store, 120), product: cap(o.product), sku: cap(o.sku, 80), qty: cap(o.qty, 20), courier: cap(o.courier, 60),
        order_date: cap(o.order_date, 40), eta: cap(o.eta, 40), status_written: cap(o.status_written), first_sheet: cap(o.first_sheet, 80),
        evidence: cap(o.evidence, 500), p1_class: o.p1_class,
      });
    }
    const run = await getLostRun(runId);
    if (!run) return send(res, 404, { ok: false, error: 'That run is gone.' });
    return send(res, 200, { ok: true, ...(await addLostOrders(runId, orders)) });
  } catch (e) {
    console.error('[lost-packages/orders]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save those orders.' });
  }
}
