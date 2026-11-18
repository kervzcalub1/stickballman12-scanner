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
  insertIssues, openInboundIssues, setInboundWarehouseTask, dbConfigured, receiveOnlineOrder, resetOnlineOrderCompareOnce,
} from './db.js';
import { alertInboundIssuesReported, alertInboundWarehouseTask, alertOnlineOrderArrived } from './alerts.js';
import { onlineOrderCheck, onlineCheckText, isCancelled, orderCode, CLAIM_PHOTOS, lineKey, nearCode, splitTracking } from '../../src/lib/onlineOrders.js';

export const SYSTEM = 'System (online order check)';
// Who counted an order in when nobody pressed "Count it in": the delivery itself.
export const autoBy = (batchCode) => `Auto · batch ${batchCode}`;

// The delivery's pairs under the ORDER's spelling, where the two say the same shoe differently:
// a code one character off at the same size ("Q0400-100" typed for "IQ0400-100"), or the box in
// women's sizing ("11.5W") for the men's size ordered (10). A typing slip or a size chart must
// not read as five wrong pairs. Only when exactly one order line fits.
export function underOrderCodes(lines, items) {
  const active = (lines || []).filter((x) => !isCancelled(x));
  const keys = new Set(active.map((l) => lineKey(l.sku, l.size)));
  const num = (z) => { const m = String(z ?? '').match(/[\d.]+/); return m ? parseFloat(m[0]) : NaN; };
  // The same size said two ways: equal, or the box in WOMEN's ("11.5W") for a men's 10 on the
  // order — the same shoe, a size and a half apart.
  const sameSize = (ordered, box) => lineKey('X', ordered) === lineKey('X', box)
    || (/\d\s*W$/i.test(String(box || '').trim()) && !/W$/i.test(String(ordered || '').trim()) && num(box) - 1.5 === num(ordered));
  return (items || []).map((it) => {
    if (keys.has(lineKey(it.sku, it.size))) return it;
    const fits = active.filter((l) => sameSize(l.size, it.size) && nearCode(l.sku, it.sku));
    const one = [...new Set(fits.map((l) => lineKey(l.sku, l.size)))];
    return one.length === 1 ? { ...it, sku: fits[0].sku, size: fits[0].size } : it;
  });
}

// How many pairs of each ACTIVE order line came out of the delivery: Map(lineId → got). The
// delivery's pairs are handed to the lines by code + size (the bench's rule), first line first.
export function countsFromReceived(lines, items) {
  const left = new Map();
  for (const it of items || []) left.set(lineKey(it.sku, it.size), (left.get(lineKey(it.sku, it.size)) || 0) + Number(it.qty));
  const counts = new Map();
  for (const l of (lines || []).filter((x) => !isCancelled(x))) {
    const k = lineKey(l.sku, l.size);
    const got = Math.min(Number(l.qty), left.get(k) || 0);
    left.set(k, (left.get(k) || 0) - got);
    counts.set(Number(l.id), got);
  }
  return counts;
}
export const PHOTO_TASK = `This parcel doesn’t match its online order, photos needed for the claim: ${CLAIM_PHOTOS.map((p) => p.label.toLowerCase()).join('; ')}. Add them to this case, send the same photos to the team on WhatsApp, then tap Done.`;

/**
 * One online order: has its parcel been received, and with every pair?
 * -> { state: 'no_tracking' | 'not_received' | 'ok' | 'already' | 'short' | 'wrong', counted?, short?, wrong?, caseId? }
 *
 * It also COUNTS THE ORDER IN (2026-11-18): the warehouse scanning the parcel is the count.
 * Every pair there → Delivered, by itself. Pairs missing, and nothing wrong in the parcel →
 * counted in with what arrived, the missing pairs split off as not delivered with their refund
 * to chase (what the "Count it in…" button does). Wrong pairs in the parcel → left for a person:
 * which ordered pair a wrong one stands for is a judgement. `io` swaps the outside world for the tests.
 */
export async function compareOrderWithReceived(orderId, { io = {} } = {}) {
  const x = {
    order: getOnlineOrder, received: receivedForTracking, mark: markOnlineOrderCompared, flagged: onlineOrderIssueOnBatch,
    issue: insertIssues, open: openInboundIssues, task: setInboundWarehouseTask, count: receiveOnlineOrder,
    alert: alertInboundIssuesReported, alertTask: alertInboundWarehouseTask, arrived: alertOnlineOrderArrived, ...io,
  };
  const o = await x.order(orderId);
  if (!o || !String(o.tracking_number || '').trim()) return { state: 'no_tracking' };
  // Several numbers = several parcels: one of them landing is not the whole order, and
  // calling the rest "not delivered" would be wrong. Left for a person to count in.
  if (splitTracking(o.tracking_number).length > 1) return { state: 'several_parcels' };
  const raw = await x.received(o.tracking_number);
  if (!raw) return { state: 'not_received' };
  const lines = (o.lines || []).map((l) => ({ ...l, qty: Number(l.qty) }));
  const got = { ...raw, items: underOrderCodes(lines, raw.items) };
  const expected = lines.filter((l) => !isCancelled(l)).reduce((n, l) => n + l.qty, 0);
  const received = got.items.reduce((n, it) => n + Number(it.qty), 0);
  await x.mark(o.id);
  // Nothing still expected (all cancelled, or the warehouse already counted the order in and
  // split the missing pairs off): the refund side has it.
  if (o.received_at || expected === 0) return { state: 'ok', expected, received };
  const summary = onlineOrderCheck({ ...o, lines }, got.items.map((it) => ({ sku: it.sku, sizes: [{ size: it.size, qty: Number(it.qty) }] })));
  // SHORT is by count (fewer pairs out of the box than on the order). WRONG is by shoe: the
  // count is there, but a pair is not the code + size that was ordered — the same rule the
  // bench uses (code with dashes and spaces dropped, numeric size).
  const short = Math.max(0, expected - received);
  const wrong = summary.totals.extra;
  // Count it in, unless a wrong pair makes that a judgement. Refused (already counted by a
  // person in the same minute) is fine: theirs stands.
  const countIn = async () => {
    if (wrong) return false;
    const counts = countsFromReceived(lines, got.items);
    const arrived = [...counts.values()].reduce((n, v) => n + v, 0);
    const detail = arrived === expected
      ? `all ${expected} pair(s) arrived — matched to batch ${got.batch_code} by its tracking number, counted in automatically`
      : `${arrived} of ${expected} pair(s) arrived in batch ${got.batch_code} — ${expected - arrived} not delivered, refund to follow up (counted in automatically)`;
    try { await x.count({ ...o, lines }, counts, autoBy(got.batch_code), detail); return true; } catch (e) {
      if (e.status === 409) return false;
      throw e;
    }
  };
  // The team hears about every parcel on Telegram (once per order): what came, and the finding.
  // A parcel that matched and landed more than 3 days ago is counted in quietly — the catch-up
  // over old orders must not be a hundred "all arrived" messages.
  const tell = (extra) => {
    const old = got.received_at && Date.now() - new Date(got.received_at).getTime() > 3 * 86_400_000;
    if (!short && !wrong && old) return;
    x.arrived({ order: o, batchCode: got.batch_code, items: got.items, expected, received, short, wrong, text: short || wrong ? onlineCheckText(o, summary).split(': ').slice(1).join(': ') : '', ...extra });
  };
  if (!short && !wrong) { const counted = await countIn(); tell({ counted }); return { state: 'ok', expected, received, counted }; }
  if (await x.flagged(got.batch_id)) {
    // Flagged at the bench: the case exists; still count it in and say what was found.
    const counted = await countIn(); tell({ counted });
    return { state: 'already', expected, received, counted };
  }

  const lead = short
    ? `Short by ${short}: ${received} of ${expected} pair${expected === 1 ? '' : 's'} came out of the parcel with tracking ${o.tracking_number}.`
    : `Wrong pairs: ${wrong} of the ${received} in the parcel with tracking ${o.tracking_number} ${wrong === 1 ? 'is' : 'are'} not what was ordered.`;
  const description = `${lead} ${onlineCheckText(o, summary)}. Found after receiving, when the tracking number reached ${orderCode(o.id)}.`;
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
  const counted = await countIn();
  tell({ counted, caseId: row ? Number(row.id) : null });
  return { state: short ? 'short' : 'wrong', short, wrong, expected, received, caseId: row ? Number(row.id) : null, counted };
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
  let reset = false;
  const run = async () => {
    try {
      if (!reset && dbConfigured()) { reset = true; const n = await resetOnlineOrderCompareOnce(); if (n) console.log(`[online-order-received] ${n} orders to look at again (counting in)`); }
      await compareWaitingOrders();
    } catch (e) { console.error('[online-order-received] tick', e.message); }
  };
  setTimeout(() => { run(); setInterval(run, 10 * 60_000); }, 6 * 60_000);
}
