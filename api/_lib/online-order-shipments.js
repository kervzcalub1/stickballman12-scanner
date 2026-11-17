// Tracking numbers fill themselves on online orders (docs/context/online-orders.md).
//
// A store that ships one order in several parcels sends one "a shipment is on the way" email
// per parcel: its tracking number and the pairs inside. The mailbox is asked for EVERY email
// carrying the order number (Make scenario 7082222, MAKE_ORDER_EMAILS_URL: POST { order } ->
// the emails' plain text, oldest first), the shipping emails are read into parcels
// (`online_order_shipments`), and each parcel is put on its online order — one step at a
// time, planned by the pure `planParcels` (src/lib/onlineOrderParcels.js).
//
// Only Shopify stores' shipping emails are read (Shoe Palace). A store whose emails are in
// another shape is noticed on the first answer and not asked about again by the worker.
import {
  orderKey, dbConfigured, onlineOrdersByKey, upsertOrderShipments, listOrderShipments, markShipCheck, shipChecksDue,
  fillOnlineOrderTracking, carveOnlineOrder, onlineOrderByTracking, claimForTracking,
} from './db.js';
import { registerWarehouseTracking, normalizeTrackingNumber } from './tracking.js';
import { mentionsOrder } from './online-order-receipts.js';
import { planParcels } from '../../src/lib/onlineOrderParcels.js';
import { trackKey } from '../../src/lib/onlineOrders.js';

const TIMEOUT_MS = 45_000;
const SEP = '\n@@SBM-EMAIL-END@@\n';
export const ACTOR = 'Store email';

const hookUrl = () => String(process.env.MAKE_ORDER_EMAILS_URL || '').trim();
export const orderEmailsConfigured = () => { try { return new URL(hookUrl()).protocol === 'https:'; } catch { return false; } };
// OO_SHIP_APPLY=off: parcels are still read and shown, but no order is changed.
const applyOn = () => String(process.env.OO_SHIP_APPLY || '').trim().toLowerCase() !== 'off';

/** The scenario's answer -> [{ subject, from, date, text }]. */
export function splitOrderEmails(raw) {
  return String(raw || '').split(SEP).map((p) => {
    const f = (k) => (p.match(new RegExp(`^@@${k}@@ ?(.*)$`, 'm')) || [])[1]?.trim() || '';
    const at = p.indexOf('@@TEXT@@\n');
    return { subject: f('SUBJECT'), from: f('FROM'), date: f('DATE'), text: at < 0 ? '' : p.slice(at + 9) };
  }).filter((e) => e.subject || e.text.trim());
}

const STATUS = [[/has been delivered|have been delivered/i, 'delivered'], [/out for delivery/i, 'out_for_delivery'], [/on the way|has shipped|shipping update/i, 'on_the_way']];
export const STATUS_RANK = { on_the_way: 1, out_for_delivery: 2, delivered: 3 };

/**
 * One Shopify shipping email (plain text, lines wrapped by the mailer):
 *
 *   UPS tracking number: 1Z16G2050307953950
 *   ( https://www.ups.com/WebTracking?… )
 *   Items in this shipment
 *   ----------------------
 *   Speedcat Ballet Lace Womens Lifestyle Shoes (Ruby
 *   Shimmer/Frosted Ivory) ×
 *   4 of 10
 *   7.5
 *   If you have any questions, …
 *
 * -> { tracking, carrier, status, items:[{ name, size, qty }] } or null when it is not one.
 */
export function parseShopifyShipmentEmail({ subject = '', text = '' } = {}) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tl = lines.map((l) => l.match(/^(?:(.{1,30}?)\s+)?tracking number:\s*([A-Z0-9]{8,40})\b/i)).find(Boolean);
  if (!tl) return null;
  const status = (STATUS.find(([re]) => re.test(subject) || re.test(lines.slice(0, 3).join(' '))) || [])[1] || 'on_the_way';
  const start = lines.findIndex((l) => /^items in this shipment$/i.test(l));
  const items = [];
  if (start >= 0) {
    let name = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const l = lines[i];
      if (/^-{3,}$/.test(l)) continue;
      if (/^(if you have any questions|customer information|shipping address)/i.test(l)) break;
      if (!/×$/.test(l)) { name.push(l); continue; }
      name.push(l.replace(/\s*×$/, ''));
      const q = (lines[i + 1] || '').match(/^(\d{1,3})(?:\s+of\s+\d{1,3})?$/i);
      if (!q) { name = []; continue; }
      i += 1;
      let size = null;
      // The variant line, when the shoe has one: short, and not the start of the next shoe.
      const v = lines[i + 1] || '';
      if (v && v.length <= 30 && !/×$/.test(v) && !/^(if you have any questions|customer information)/i.test(v)) {
        const parts = v.split('/').map((p) => p.trim());
        size = parts.find((p) => /^\d{1,2}(?:\.5)?[A-Z]{0,2}$/i.test(p)) || v;
        i += 1;
      }
      items.push({ name: name.filter(Boolean).join(' ').slice(0, 200), size, qty: Number(q[1]) });
      name = [];
    }
  }
  return { tracking: tl[2].toUpperCase(), carrier: (tl[1] || '').trim().slice(0, 30) || null, status, items };
}

/** Every email for the number -> the parcels in them, one per tracking number, oldest first. */
export function parcelsFromEmails(key, emails) {
  const by = new Map();
  let shopify = false;
  for (const e of emails) {
    if (!mentionsOrder(key, e.subject, e.text)) continue;
    if (/shopifyemail\.com/i.test(e.from) || /^order summary$|^items in this shipment$/im.test(e.text)) shopify = true;
    const p = parseShopifyShipmentEmail(e);
    if (!p) continue;
    const k = trackKey(p.tracking);
    const cur = by.get(k);
    const at = e.date && !Number.isNaN(Date.parse(e.date)) ? new Date(e.date).toISOString() : null;
    if (!cur) by.set(k, { ...p, emailed_at: at });
    else {
      if ((STATUS_RANK[p.status] || 0) > (STATUS_RANK[cur.status] || 0)) cur.status = p.status;
      if (!cur.items.length && p.items.length) cur.items = p.items;
    }
  }
  return { parcels: [...by.values()], shopify };
}

async function askMake(key) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(hookUrl(), { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: key }) });
    const text = await r.text();
    if (!r.ok || !text.includes('@@SUBJECT@@')) throw new Error(`the mailbox search answered ${r.status}`);
    return text;
  } finally { clearTimeout(timer); }
}

/** Put the parcels already read for this number on their orders. -> the steps taken. */
export async function placeParcels(key, { io = {} } = {}) {
  const x = { orders: onlineOrdersByKey, shipments: listOrderShipments, elsewhere: onlineOrderByTracking, fill: fillOnlineOrderTracking, carve: carveOnlineOrder, ...io };
  const done = [];
  const skip = new Set();
  const ships = (await x.shipments(key)).map((s) => ({ tracking: s.tracking_number, carrier: s.carrier, items: s.items || [] }));
  for (let i = 0; i < 20; i += 1) {
    const orders = await x.orders(key);
    const { action } = planParcels(orders, ships, skip);
    if (!action) break;
    // A number already on an order with ANOTHER order number is somebody's, not ours to move.
    const other = await x.elsewhere(action.tracking, null);
    if (other && !orders.some((o) => Number(o.id) === Number(other.id))) { skip.add(trackKey(action.tracking)); continue; }
    const ok = action.kind === 'fill'
      ? await x.fill(action.orderId, action.tracking, ACTOR, `tracking ${action.tracking} added from the store's shipping email — shipped`)
      : await x.carve(action, ACTOR);
    // Refused = the order changed under the plan (someone is editing it). Leave it for the next run.
    if (!ok) break;
    done.push({ kind: action.kind, orderId: action.orderId, tracking: action.tracking, pairs: action.pairs, newId: action.kind === 'carve' ? Number(ok) : null });
  }
  return done;
}

/**
 * One order number: read its emails, keep the parcels, place them.
 * -> { state: 'ok' | 'unconfigured' | 'error' | 'skipped', parcels, placed }
 */
export async function syncOrderParcels(orderNumber, { io = {} } = {}) {
  const key = orderKey(orderNumber);
  if (key.length < 4) return { state: 'skipped' };
  const x = { ask: askMake, configured: orderEmailsConfigured, save: upsertOrderShipments, mark: markShipCheck, place: placeParcels, ...io };
  if (!x.configured()) return { state: 'unconfigured' };
  try {
    const emails = splitOrderEmails(await x.ask(key));
    const { parcels, shopify } = parcelsFromEmails(key, emails);
    if (parcels.length) await x.save(key, parcels);
    const placed = applyOn() ? await x.place(key) : [];
    // Emails, but none in a shape we read: the worker stops asking about this number.
    await x.mark(key, { emails: emails.length, parcels: parcels.length, skip: emails.length > 0 && !shopify, note: null });
    const fresh = placed.map((p) => normalizeTrackingNumber(p.tracking)).filter(Boolean);
    if (fresh.length) registerWarehouseTracking(fresh, { claim: claimForTracking, label: 'online-order-shipments' }).catch((e) => console.warn('[online-order-shipments] register:', e.message));
    return { state: 'ok', parcels: parcels.length, placed };
  } catch (e) {
    console.error('[online-order-shipments]', key, e.message);
    await x.mark(key, { emails: null, parcels: null, skip: false, note: String(e.message || 'failed').slice(0, 200) }).catch(() => {});
    return { state: 'error' };
  }
}

// One at a time: two runs for one number would both carve the same pairs.
let chain = Promise.resolve();
const inLine = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
export const syncOrderParcelsNow = (orderNumber) => inLine(() => syncOrderParcels(orderNumber));

/** An order number was typed: look for its shipping emails too. Never throws, never waited on. */
export function orderNumberSetForParcels(orderNumber) {
  if (!orderEmailsConfigured() || orderKey(orderNumber).length < 4) return;
  syncOrderParcelsNow(orderNumber).catch((e) => console.warn('[online-order-shipments]', e.message));
}

// ---- Worker ---------------------------------------------------------------------------------
// Shipping emails arrive hours or days after the order, a parcel at a time. So every order
// number that still has an entry with no tracking number (not counted in, not older than 30
// days, not marked "another shape") is asked about again every OO_SHIP_HOURS (default 4), a
// few numbers per tick. Production only by default; OO_SHIP_WATCH=on|off overrides.
export function shipWatchEnabled(env = process.env) {
  const flag = String(env.OO_SHIP_WATCH || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
}

export function startOnlineOrderShipmentWorker() {
  if (!shipWatchEnabled()) return;
  const hours = Math.max(1, Number(process.env.OO_SHIP_HOURS) || 4);
  console.log(`[online-order-shipments] worker on: open orders re-checked every ${hours} h`);
  const run = async () => {
    try {
      if (!dbConfigured() || !orderEmailsConfigured()) return;
      for (const d of await shipChecksDue(4, hours)) await syncOrderParcelsNow(d.order_key);
    } catch (e) { console.error('[online-order-shipments] tick', e.message); }
  };
  setTimeout(() => { run(); setInterval(run, 5 * 60_000); }, 5 * 60_000);
}
