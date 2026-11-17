// A received parcel against the online order its tracking number belongs to
// (docs/context/online-orders.md → "Short parcels: found, told, documented").
//
// Receiving already compares a box with its online order AT THE BENCH — when the order's
// tracking number is known by then. Since the numbers fill themselves from the store's emails
// (online-order-shipments.js), a parcel is often received FIRST and gets its order later. This
// is that later meeting: fewer pairs came out of the delivery than the order says → a case for
// the PH team (Telegram, as every inbound issue), with a job for the warehouse — the photos a
// claim needs, uploaded on the case and sent to the team on WhatsApp.
import {
  getOnlineOrder, receivedForTracking, onlineOrdersToCompare, markOnlineOrderCompared, onlineOrderIssueOnBatch,
  insertIssues, openInboundIssues, setInboundWarehouseTask, dbConfigured,
} from './db.js';
import { alertInboundIssuesReported, alertInboundWarehouseTask } from './alerts.js';
import { onlineOrderCheck, onlineCheckText, isCancelled, orderCode, CLAIM_PHOTOS } from '../../src/lib/onlineOrders.js';

export const SYSTEM = 'System (online order check)';
export const PHOTO_TASK = `Short parcel, photos needed for the claim: ${CLAIM_PHOTOS.map((p) => p.label.toLowerCase()).join('; ')}. Add them to this case, send the same photos to the team on WhatsApp, then tap Done.`;

/**
 * One online order: has its parcel been received, and with every pair?
 * -> { state: 'no_tracking' | 'not_received' | 'ok' | 'already' | 'short', short?, caseId? }
 * Short is by COUNT (fewer pairs out of the box than on the order): a SKU typed differently
 * on the order must not read as a missing pair. `io` swaps the outside world for the tests.
 */
export async function compareOrderWithReceived(orderId, { io = {} } = {}) {
  const x = {
    order: getOnlineOrder, received: receivedForTracking, mark: markOnlineOrderCompared, flagged: onlineOrderIssueOnBatch,
    issue: insertIssues, open: openInboundIssues, task: setInboundWarehouseTask,
    alert: alertInboundIssuesReported, alertTask: alertInboundWarehouseTask, ...io,
  };
  const o = await x.order(orderId);
  if (!o || !String(o.tracking_number || '').trim()) return { state: 'no_tracking' };
  const got = await x.received(o.tracking_number);
  if (!got) return { state: 'not_received' };
  const lines = (o.lines || []).map((l) => ({ ...l, qty: Number(l.qty) }));
  const expected = lines.filter((l) => !isCancelled(l)).reduce((n, l) => n + l.qty, 0);
  const received = got.items.reduce((n, it) => n + Number(it.qty), 0);
  await x.mark(o.id);
  // Nothing still expected (all cancelled, or the warehouse already counted the order in and
  // split the missing pairs off): the refund side has it.
  if (o.received_at || expected === 0 || received >= expected) return { state: 'ok', expected, received };
  if (await x.flagged(got.batch_id)) return { state: 'already', expected, received };

  const short = expected - received;
  const summary = onlineOrderCheck({ ...o, lines }, got.items.map((it) => ({ sku: it.sku, sizes: [{ size: it.size, qty: Number(it.qty) }] })));
  const description = `Short by ${short}: ${received} of ${expected} pair${expected === 1 ? '' : 's'} came out of the parcel with tracking ${o.tracking_number}. `
    + `${onlineCheckText(o, summary)}. Found after receiving, when the tracking number reached ${orderCode(o.id)}.`;
  const [rec] = await x.issue(got.batch_id, [{ type: 'online_order', description: description.slice(0, 1000), expectedCount: expected, receivedCount: received, photos: [] }], SYSTEM);
  const rows = await x.open({
    batchId: got.batch_id, boxId: got.box_id, by: SYSTEM, byUid: null, source: 'online_order',
    shipment: [{ shipmentIssueId: rec.id, type: 'online_order', description: rec.description, expectedCount: expected, receivedCount: received, photos: [] }],
  });
  const row = rows[0] || null;
  if (row) {
    x.alert(rows, { id: null, name: 'The online order check' });
    const withTask = await x.task(row.id, { actor: SYSTEM, task: PHOTO_TASK });
    if (withTask) x.alertTask(withTask, { id: null, name: 'The online order check' });
  }
  return { state: 'short', short, expected, received, caseId: row ? Number(row.id) : null };
}

// One at a time: a save, the email reader and the worker can all point at the same order.
let chain = Promise.resolve();
const inLine = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

/** A tracking number just reached these orders. Never throws, never waited on. */
export function compareOrdersSoon(orderIds) {
  for (const id of [...new Set((orderIds || []).map(Number).filter((n) => n > 0))]) {
    inLine(() => compareOrderWithReceived(id)).catch((e) => console.warn('[online-order-received]', id, e.message));
  }
}

/** Every order whose parcel is in but was never compared. Called by the worker. */
export async function compareWaitingOrders(limit = 20) {
  if (!dbConfigured()) return 0;
  const due = await onlineOrdersToCompare(limit);
  for (const d of due) await inLine(() => compareOrderWithReceived(Number(d.id))).catch((e) => console.warn('[online-order-received]', d.id, e.message));
  return due.length;
}

// Production only by default (OO_RECEIVED_WATCH=on|off): every 10 minutes, the orders whose
// parcel was received but never compared — the ones that got their number from an email, and
// the ones typed after the parcel landed.
export function startOnlineOrderReceivedWorker() {
  const flag = String(process.env.OO_RECEIVED_WATCH || '').trim().toLowerCase();
  const on = flag === 'on' || (flag !== 'off' && String(process.env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production');
  if (!on) return;
  console.log('[online-order-received] worker on: received parcels compared with their online orders every 10 min');
  const run = () => compareWaitingOrders().catch((e) => console.error('[online-order-received] tick', e.message));
  setTimeout(() => { run(); setInterval(run, 10 * 60_000); }, 6 * 60_000);
}
