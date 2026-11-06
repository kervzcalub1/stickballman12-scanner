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
import { shopifyStockForSku, shopifyAdjustAvailable, shopifyConfigured, sheinOrdersConfigured, shopifyFindSheinOrder, shopifyCreateSheinOrder, shopifyFulfilSheinOrder, shopifyCancelSheinOrder } from './shopify.js';
import { getSetting, setSetting, upsertSheinUnits, sheinUnitsKnown, sheinUnitsToAct, markSheinUnit, sheinLinkedSku, claimSheinShopifyOrder, markSheinShopifyOrder, getSheinShopifyOrder, sheinOrdersDueForShopify, sheinShopifyOrdersFor, sheinUnitsOfOrder, sheinOrdersToFulfil, markSheinOrderFulfilled } from './db.js';
import { unitsFromOrders, unitAction, pickLocation, toSheinTime, sheinOrderState, shopifyOrderInput, sheinOrderTracking } from '../../src/lib/sheinLive.js';

export const SYNC_KEY = 'shein_sync';
// What the Shopify step touches — swappable in tests.
export const IO = { shopifyStockForSku, shopifyAdjustAvailable, markSheinUnit, sheinUnitsToAct, shopifyConfigured, sheinLinkedSku, ordersAtSale: (...a) => ordersAtSaleStep(...a), orderRowsFor: sheinShopifyOrdersFor, releaseClaimed: (...a) => releaseClaimedOrder(...a) };
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
    // At the sale: write the order first and let IT take the pair off, as DPL's eBay orders do.
    // Whatever that didn't cover is still due below, so a failed order never leaves a pair on sale.
    if (io.ordersAtSale) await io.ordersAtSale().catch((e) => console.error('[shein-orders] at sale', e.message));
    const units = await io.sheinUnitsToAct({ manual });
    const rows = io.orderRowsFor ? new Map((await io.orderRowsFor([...new Set(units.map((u) => u.order_no))])).map((r) => [r.order_no, r])) : new Map();
    for (const u of units) {
      const action = unitAction(u);
      if (!action) continue;
      const row = rows.get(u.order_no);
      // The order may already hold this pair (its answer got lost): wait for that to settle, or
      // the pair comes off twice. It settles within 5 minutes.
      if (action === 'deduct' && row?.state === 'creating') continue;
      if (action === 'restock' && row?.stock_claimed) {
        const done = await io.releaseClaimed(u, row).catch((e) => ({ error: e.message }));
        if (done.ok) restocked += 1; else failed += 1;
        continue;
      }
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
  units: sheinUnitsOfOrder, markUnit: markSheinUnit, toFulfil: sheinOrdersToFulfil, markFulfilled: markSheinOrderFulfilled,
  fulfil: shopifyFulfilSheinOrder, cancel: shopifyCancelSheinOrder,
};

// atSale: write the order now, open, and let it take the pair off Shopify, unless a pair of it
// is already off, or a SKU has no variant to claim: then stock stays with the sync's own −1.
export async function addOrderToShopify(orderNo, { by = null, io = ORDER_IO, atSale = false } = {}) {
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
      // That lost write claimed the stock: its pairs are off, and the sync must not take them again.
      if (row.stock_claimed) await markClaimedUnits(no, found.order.name, new Map(), new Map(), io);
      return { state: 'created', name: found.order.name, id: found.order.id, already: true };
    }
    const [detail] = await io.orderDetails([no]);
    if (!detail) return fail('SHEIN didn’t return this order.');
    const ready = sheinOrderState(detail);
    if (ready.state === 'skip') { await io.mark(no, { state: 'skipped', note: ready.reason }); return { state: 'skipped', note: ready.reason }; }
    if (ready.state === 'wait' && !atSale) { await io.mark(no, { state: 'waiting', note: ready.reason }); return { state: 'waiting', note: ready.reason }; }
    const shipped = ready.state === 'ready';

    const variants = new Map();
    const before = new Map();
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
      const level = pickLocation(st.levels, process.env.SHOPIFY_SHEIN_LOCATION);
      if (level) before.set(sku, level);
      location = location || level?.locationId || null;
    }
    const { order, total } = shopifyOrderInput(detail, { variants, locationId: location || sheinLocationGid(), shipped });
    // Claim only when the order can account for every pair: nothing off yet, and every SKU known.
    const units = atSale ? await io.units(no) : [];
    const live = units.filter((u) => [1, 3].includes(Number(u.exchange_tag)) && Number(u.unit_status) !== 6);
    const claim = atSale && live.length > 0 && live.every((u) => u.deducted_at == null && variants.has(String(u.seller_sku || '').trim()));
    // Recorded BEFORE the write: if the answer is lost, the retry must know this order took the stock.
    if (claim) await io.mark(no, { state: 'creating', claimed: true, open: !shipped });
    const made = await io.shopifyCreateSheinOrder(order, { claim });
    if (!made.ok) return fail(made.error, made.definite !== false);
    await io.mark(no, { state: 'created', id: made.id, name: made.name, source: made.source, total, claimed: claim, open: !shipped });
    if (claim) await markClaimedUnits(no, made.name, variants, before, io);
    return { state: 'created', name: made.name, id: made.id, source: made.source, total, claimed: claim };
  } catch (e) {
    // Thrown before the write (a bad price, no location) or by the write's network call.
    return fail(e.message, !/fetch|network|timeout|aborted/i.test(e.message));
  }
}
async function markClaimedUnits(no, name, variants, before, io) {
  for (const u of await io.units(no)) {
    if (u.deducted_at || ![1, 3].includes(Number(u.exchange_tag)) || Number(u.unit_status) === 6) continue;
    const sku = String(u.seller_sku || '').trim();
    const lv = before.get(sku);
    const note = `${lv ? `Shopify ${lv.available} → ${lv.available - 1} at ${lv.location}, ` : ''}by order ${name}${lv && lv.available <= 0 ? ' — Shopify had none left: OVERSOLD' : ''}`;
    await io.markUnit(u.goods_id, { deducted: true, variant: variants.get(sku) || null, location: lv?.locationId || null, before: lv?.available ?? null, note, error: null });
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

// Before the sync's own −1: the orders of units due to come off, sold since the switch. Only those
// sold since "at the sale" was turned on, so a pair already handled the old way is never touched.
export async function ordersAtSaleStep(io = ORDER_IO, list = sheinUnitsToAct) {
  const sync = await readSync();
  if (sync.shopifyOrders !== 'on' || sync.shopifyOrdersAtSale !== 'on' || !sync.shopifyOrdersAtSaleSince || !io.sheinOrdersConfigured()) return;
  const since = new Date(sync.shopifyOrdersAtSaleSince);
  const due = (await list({})).filter((u) => unitAction(u) === 'deduct' && u.order_time && new Date(u.order_time) >= since);
  for (const no of new Set(due.map((u) => u.order_no))) await addOrderToShopify(no, { by: 'auto', io, atSale: true });
}

// SHEIN cancelled a pair the ORDER took off. All of them: cancel the order, which puts them back.
// One of several: Shopify's order still holds it, and a +1 from us would count it twice, so it
// goes red for a person rather than guess.
export async function releaseClaimedOrder(u, row, io = ORDER_IO) {
  const units = await io.units(u.order_no);
  const live = units.filter((x) => [1, 3].includes(Number(x.exchange_tag)) && Number(x.unit_status) !== 6);
  if (live.length) {
    const error = `SHEIN cancelled or swapped one pair on ${row.shopify_name}. Fix that line in Shopify by hand.`;
    await io.markUnit(u.goods_id, { error, failed: true });
    return { error };
  }
  const r = await io.cancel(row.shopify_order_id, `SHEIN cancelled ${u.order_no} before it shipped.`);
  if (r.error) { await io.markUnit(u.goods_id, { error: `Couldn’t cancel ${row.shopify_name}: ${r.error}`, failed: true }); return r; }
  for (const x of units) if (x.deducted_at && !x.restocked_at) await io.markUnit(x.goods_id, { restocked: true, note: `SHEIN cancelled before shipping — ${row.shopify_name} cancelled, pair back`, error: null });
  return { ok: true };
}

// The worker's step: orders written open at the sale that SHEIN has now shipped.
export async function fulfilShippedOrders(io = ORDER_IO) {
  if (!io.sheinOrdersConfigured()) return null;
  let fulfilled = 0; let failed = 0;
  for (const row of await io.toFulfil()) {
    const [detail] = await io.orderDetails([row.order_no]);
    const r = await io.fulfil(row.shopify_order_id, sheinOrderTracking(detail));
    await io.markFulfilled(row.order_no, { error: r.error ? `Couldn’t fulfil ${row.shopify_name}: ${r.error}` : null });
    if (r.error) failed += 1; else fulfilled += 1;
  }
  return { fulfilled, failed };
}
