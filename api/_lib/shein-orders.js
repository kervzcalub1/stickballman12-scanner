// SHEIN sales → Shopify, at once (docs/context/shein-live-fix.md → "Sales"). Shopify is
// the one stock count every other channel sells from, so a pair SHEIN sold must leave
// Shopify within seconds or eBay / StockX / Alias can sell it again.
//
//   SHEIN webhook (order changed) ─┐
//   poll every minute (backstop) ──┴→ processOrders(orderNos) → order-detail → units
//                                      → for each unit: Shopify −1 (or +1 if SHEIN cancelled
//                                        it before it shipped)
//
// One unit = one goodsId = one pair. The Shopify write is compare-and-set (changeFromQuantity
// = what we just read) with an idempotency key built from the goodsId and that quantity, so a
// retry never takes a pair twice, and a sale elsewhere in between makes Shopify refuse and us
// re-read. Everything that happened is in shein_order_units.
// Idempotency: the key carries the goodsId + how many DEFINITE refusals came before, so a
// request whose answer got lost is resent with the same key and can't take a pair twice.
import { sheinCall, listOf } from './shein.js';
import { shopifyStockForSku, shopifyAdjustAvailable, shopifyConfigured, sheinOrdersConfigured, shopifyFindSheinOrder, shopifyCreateSheinOrder } from './shopify.js';
import { getSetting, setSetting, upsertSheinUnits, sheinUnitsKnown, sheinUnitsToAct, markSheinUnit, sheinLinkedSku, claimSheinShopifyOrder, markSheinShopifyOrder, getSheinShopifyOrder, sheinOrdersDueForShopify } from './db.js';
import { unitsFromOrders, unitAction, pickLocation, toSheinTime, sheinOrderState, shopifyOrderInput } from '../../src/lib/sheinLive.js';

export const SYNC_KEY = 'shein_sync';
// What the Shopify step touches — swappable in tests.
export const IO = { shopifyStockForSku, shopifyAdjustAvailable, markSheinUnit, sheinUnitsToAct, shopifyConfigured, sheinLinkedSku };
// After this many failed tries a unit waits for a person (Retry). Matches sheinUnitsToAct's cap.
export const MAX_AUTO_ATTEMPTS = 8;
export async function readSync() {
  try { const v = await getSetting(SYNC_KEY); return v ? JSON.parse(v) : {}; } catch { return {}; }
}
export async function writeSync(patch, by) {
  const cur = await readSync();
  const next = { ...cur, ...patch };
  await setSetting(SYNC_KEY, JSON.stringify(next), by || 'shein-sync');
  return next;
}

// Order numbers SHEIN changed in [from, to] (SHEIN allows 48 h per query, 30 a page).
export async function changedOrderNos(from, to) {
  const nos = new Set();
  const step = 47 * 3600_000;
  for (let a = new Date(from).getTime(); a < new Date(to).getTime(); a += step) {
    const b = Math.min(a + step, new Date(to).getTime());
    for (let page = 1; page <= 400; page++) {
      const info = await sheinCall('/open-api/order/order-list', { queryType: 2, startTime: toSheinTime(a), endTime: toSheinTime(b), page, pageSize: 30 });
      const list = listOf(info, 'orderList');
      for (const o of list) if (o?.orderNo) nos.add(String(o.orderNo));
      if (list.length < 30) break;
    }
  }
  return [...nos];
}

async function orderDetails(orderNos) {
  const out = [];
  for (let i = 0; i < orderNos.length; i += 30) {
    const info = await sheinCall('/open-api/order/order-detail', { orderNoList: orderNos.slice(i, i + 30) });
    out.push(...(Array.isArray(info) ? info : []));
  }
  return out;
}

// Record these orders' units, then take every due one off Shopify.
export async function processOrders(orderNos, { openAtStart = false } = {}) {
  const nos = [...new Set((orderNos || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!nos.length) return { units: 0, ...(await actOnUnits()) };
  const sync = await readSync();
  const details = await orderDetails(nos);
  const ids = details.flatMap((o) => (o.orderGoodsInfoList || []).map((g) => String(g.goodsId ?? ''))).filter(Boolean);
  const known = await sheinUnitsKnown(ids);
  const units = unitsFromOrders(details, { since: sync.since || null, known, openAtStart });
  await upsertSheinUnits(units);
  return { units: units.length, ...(await actOnUnits()) };
}

// One pass at a time — the webhook and the poll can arrive together.
let acting = null;
// `manual` = a person pressed Retry: units the poll gave up on are tried again too.
export function actOnUnits(io = IO, { manual = false } = {}) {
  if (acting) return acting.then(() => actOnUnits(io, { manual }));
  acting = (async () => {
    let deducted = 0; let restocked = 0; let failed = 0;
    if (!io.shopifyConfigured()) return { deducted, restocked, failed };
    for (const u of await io.sheinUnitsToAct({ manual })) {
      const action = unitAction(u);
      if (!action) continue;
      const r = await applyToShopify(u, action, io).catch((e) => ({ error: e.message }));
      if (r.ok && action === 'deduct') deducted += 1;
      else if (r.ok) restocked += 1;
      else failed += 1;
    }
    return { deducted, restocked, failed };
  })().finally(() => { acting = null; });
  return acting;
}

export async function applyToShopify(u, action, io = IO) {
  const delta = action === 'deduct' ? -1 : 1;
  if (!u.seller_sku) { await io.markSheinUnit(u.goods_id, { error: 'SHEIN order line has no seller SKU', failed: true }); return { error: 'no sku' }; }
  for (let attempt = 0; attempt < 4; attempt++) {
    let st = await io.shopifyStockForSku(u.seller_sku);
    let via = '';
    // The order carries the size's OLD seller SKU and Shopify no longer has it (the product was
    // re-made with new SKUs): take it off the SKU that SHEIN size was relinked to. Not for a
    // unit that already gave up (a person may have taken it off by hand) — Retry stays as it was.
    if (st.code === 'missing' && u.shein_sku && io.sheinLinkedSku && (u.attempts || 0) < MAX_AUTO_ATTEMPTS) {
      const linked = await io.sheinLinkedSku(u.shein_sku);
      if (linked && linked !== u.seller_sku) { st = await io.shopifyStockForSku(linked); via = ` (via relinked SKU ${linked}; the order says ${u.seller_sku})`; }
    }
    if (st.error) { await io.markSheinUnit(u.goods_id, { error: st.error, failed: st.code !== 'unauthorized' }); return st; }
    const loc = st.levels.find((l) => l.locationId === u.shopify_location) || pickLocation(st.levels, process.env.SHOPIFY_SHEIN_LOCATION);
    if (!loc) { await io.markSheinUnit(u.goods_id, { error: `Shopify stocks ${u.seller_sku} at ${st.levels.length} locations and none is clearly the warehouse — set SHOPIFY_SHEIN_LOCATION`, failed: true }); return { error: 'location' }; }
    const r = await io.shopifyAdjustAvailable({
      inventoryItemId: st.inventoryItemId, locationId: loc.locationId, delta, from: loc.available,
      // Same key on a resend after a network failure (Shopify answers it as the original — never
      // twice); a new key only after Shopify definitely refused (nothing changed then).
      key: `shein-${u.goods_id}-${action}-${u.attempts || 0}-${attempt}`, ref: `stickballman12://shein/order/${u.order_no}/${u.goods_id}`,
    });
    if (r.ok) {
      const note = action === 'deduct'
        ? `Shopify ${loc.available} → ${r.after} at ${loc.location}${loc.available <= 0 ? ' — Shopify had none left: OVERSOLD' : ''}${via}`
        : `SHEIN cancelled before shipping — put back: Shopify ${loc.available} → ${r.after}${via}`;
      await io.markSheinUnit(u.goods_id, { deducted: action === 'deduct', restocked: action === 'restock', variant: st.variantId, location: loc.locationId, before: action === 'deduct' ? loc.available : null, note, error: null });
      return { ok: true };
    }
    if (r.code !== 'stale') { await io.markSheinUnit(u.goods_id, { error: r.error, failed: r.code !== 'unauthorized' }); return r; }
    // A sale somewhere else changed the number between our read and our write: read again.
  }
  await io.markSheinUnit(u.goods_id, { error: 'Shopify kept changing under us — will retry', failed: true });
  return { error: 'stale' };
}

// The backstop poll: every order SHEIN changed since the last poll (with a 10-minute overlap).
export async function pollOrders() {
  const sync = await readSync();
  if (sync.orders !== 'on') return null;
  const now = new Date();
  const from = new Date(Math.max(new Date(sync.polledTo || sync.since || now).getTime() - 10 * 60_000, now.getTime() - 7 * 86400_000));
  const nos = await changedOrderNos(from, now);
  const r = await processOrders(nos);
  await writeSync({ polledTo: now.toISOString(), polledAt: now.toISOString(), lastPoll: { orders: nos.length, ...r } });
  return r;
}

// Switch on: from now every SHEIN sale comes off Shopify. The last 14 days are recorded
// first (so their units are KNOWN and never deducted by surprise) — and, if the person said
// so, the ones still open (sold, not shipped) are taken off too.
export async function switchOn({ by, openAtStart }) {
  const now = new Date();
  await writeSync({ orders: 'on', since: now.toISOString(), polledTo: now.toISOString(), onBy: by, onAt: now.toISOString(), openAtStart: !!openAtStart }, by);
  const nos = await changedOrderNos(new Date(now.getTime() - 14 * 86400_000), now);
  return processOrders(nos, { openAtStart: !!openAtStart });
}
export const switchOff = (by) => writeSync({ orders: 'off', offBy: by, offAt: new Date().toISOString() }, by);

/* ---------------------- the order itself, in Shopify ---------------------- */
// CedCommerce wrote SHEIN orders into Shopify until the owner removed it (2026-11-06). Our own
// app does it now, so the Channel column reads "SHEIN via Stickballman12.com". Stock is NOT
// part of this: the −1 above already happened at the sale, and the order is written with
// inventory bypassed. One SHEIN order = one Shopify order, written when it has shipped.
export const ORDER_IO = {
  orderDetails, shopifyStockForSku, sheinLinkedSku, sheinOrdersConfigured, shopifyFindSheinOrder, shopifyCreateSheinOrder,
  claim: claimSheinShopifyOrder, mark: markSheinShopifyOrder, get: getSheinShopifyOrder,
};

export async function addOrderToShopify(orderNo, { by = null, io = ORDER_IO } = {}) {
  const no = String(orderNo || '').trim();
  if (!no) return { state: 'failed', error: 'Which SHEIN order?' };
  if (!io.sheinOrdersConfigured()) return { state: 'failed', error: 'The SHEIN orders app isn’t set up on this server (SHEIN_ORDERS_CLIENT_ID / SECRET).' };
  const row = await io.claim(no, by);
  if (!row) {
    const cur = await io.get(no);
    return { state: cur?.state || 'creating', name: cur?.shopify_name || null, error: cur?.error || null, busy: cur?.state === 'creating' };
  }
  const fail = async (error, definite = true) => {
    // Not definite = the order may exist. It stays 'creating', so nothing writes again for 5
    // minutes, and the next try looks in Shopify first.
    await io.mark(no, { state: definite ? 'failed' : 'creating', error });
    return { state: definite ? 'failed' : 'creating', error };
  };
  try {
    // Already there? (An earlier answer got lost, or a retry after a crash.) Never a second order.
    const found = await io.shopifyFindSheinOrder(no);
    if (found.error) return fail(`Couldn’t check Shopify first: ${found.error}`);
    if (found.order) {
      await io.mark(no, { state: 'created', id: found.order.id, name: found.order.name, source: found.order.sourceName, note: 'Found already in Shopify.' });
      return { state: 'created', name: found.order.name, id: found.order.id, already: true };
    }
    const [detail] = await io.orderDetails([no]);
    if (!detail) return fail('SHEIN didn’t return this order.');
    const ready = sheinOrderState(detail);
    if (ready.state === 'skip') { await io.mark(no, { state: 'skipped', note: ready.reason }); return { state: 'skipped', note: ready.reason }; }
    if (ready.state === 'wait') { await io.mark(no, { state: 'waiting', note: ready.reason }); return { state: 'waiting', note: ready.reason }; }

    const variants = new Map();
    let location = null;
    for (const g of detail.orderGoodsInfoList || []) {
      const sku = String(g.sellerSku ?? '').trim();
      if (!sku || variants.has(sku)) continue;
      let st = await io.shopifyStockForSku(sku);
      if (st.code === 'missing' && g.skuCode && io.sheinLinkedSku) {
        const linked = await io.sheinLinkedSku(String(g.skuCode));
        if (linked && linked !== sku) st = await io.shopifyStockForSku(linked);
      }
      if (st.code === 'missing') continue;   // goes in by SKU and title; the sale stays on record
      if (st.error) return fail(st.error);
      variants.set(sku, st.variantId);
      location = location || pickLocation(st.levels, process.env.SHOPIFY_SHEIN_LOCATION)?.locationId || null;
    }
    const { order, total } = shopifyOrderInput(detail, { variants, locationId: location || sheinLocationGid() });
    const made = await io.shopifyCreateSheinOrder(order);
    if (!made.ok) return fail(made.error, made.definite !== false);
    await io.mark(no, { state: 'created', id: made.id, name: made.name, source: made.source, total });
    return { state: 'created', name: made.name, id: made.id, source: made.source, total };
  } catch (e) {
    // Thrown before the write (a bad price, no location) or by the write's network call.
    return fail(e.message, !/fetch|network|timeout|aborted/i.test(e.message));
  }
}
const sheinLocationGid = () => {
  const v = String(process.env.SHOPIFY_SHEIN_LOCATION || '').trim();
  return /^\d+$/.test(v) ? `gid://shopify/Location/${v}` : (v.startsWith('gid://') ? v : null);
};

// The worker's step: every order that has shipped since the switch was turned on.
export async function syncShopifyOrders(io = ORDER_IO, due = sheinOrdersDueForShopify) {
  const sync = await readSync();
  if (sync.shopifyOrders !== 'on' || !sync.shopifyOrdersSince || !io.sheinOrdersConfigured()) return null;
  let created = 0; let failed = 0;
  for (const no of await due(sync.shopifyOrdersSince)) {
    const r = await addOrderToShopify(no, { by: 'auto', io });
    if (r.state === 'created') created += 1;
    else if (r.state === 'failed') failed += 1;
  }
  return { created, failed };
}
