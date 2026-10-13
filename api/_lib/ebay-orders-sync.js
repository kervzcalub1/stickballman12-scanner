// eBay orders + money sync (docs/context/ebay-orders.md). One job, run in the background
// (the page presses Sync, the worker runs it every 30 min in production):
//   1. orders — the first time (or a "load from" date) by creation date, from Jan 1 EST of
//      this year; afterwards only orders eBay changed since the last run;
//   2. tracking — each order's shipping fulfillments, re-read only when eBay's count
//      differs from what we hold;
//   3. photos — sold shoes whose listing has left our pull (GetItem, once per item);
//   4. tracking numbers shipped in the last 30 days go to 17TRACK (claim-then-register,
//      so a number is only ever registered once) for delivered / in-transit;
//   5. money — Finances transactions for the same window (needs `sell.finances`; a refusal
//      is kept on the run, it doesn't fail the orders).
// Progress + coverage live in app_settings 'ebay_orders_sync'.
import { getSetting, setSetting, saveEbayOrders, ebayOrderFulfillmentCounts, setEbayOrderFulfillments,
  saveEbayTransactions, ebayItemsWithoutImage, saveEbayItemImage, claimForTracking } from './db.js';
import { fetchEbayOrders, fetchShippingFulfillments, fetchEbayTransactions, ebayItemPicture, ebayStatus } from './ebay.js';
import { registerWarehouseTracking } from './tracking.js';
import { orderFromApi, fulfillmentsFromApi, transactionFromApi } from '../../src/lib/ebayOrders.js';
import { estDayStart } from '../../src/lib/ebayCoupons.js';
import { estToday } from '../../src/lib/format.js';

export const SYNC_KEY = 'ebay_orders_sync';
const STALE_MS = 30 * 60 * 1000;
const TWO_YEARS_MS = (2 * 365 - 2) * 86400_000;

export async function readSync() {
  try { return JSON.parse((await getSetting(SYNC_KEY)) || 'null'); } catch { return null; }
}
export const syncRunning = (s) => s?.state === 'running' && Date.now() - Date.parse(s.startedAt) < STALE_MS;

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const x = list[i++]; await fn(x); } }));
}

// `fromYmd` = load orders created since this EST day (a backfill); without it, incremental.
export async function runEbayOrdersSync({ by = 'auto', fromYmd = null } = {}) {
  const prev = (await readSync()) || {};
  const startedAt = new Date().toISOString();
  const keep = { coveredFrom: prev.coveredFrom || null, lastOrdersAt: prev.lastOrdersAt || null, lastTxTo: prev.lastTxTo || null };
  const put = (o) => setSetting(SYNC_KEY, JSON.stringify({ ...keep, by, startedAt, ...o }), by).catch(() => {});
  try {
    const st = await ebayStatus();
    if (!st.connected) throw new Error('eBay is not connected.');
    if (!st.canOrders) throw Object.assign(new Error('eBay needs re-approving for orders — an admin presses Connect eBay again.'), { auth: true });
    const backfill = !!fromYmd || !keep.lastOrdersAt;
    const startYmd = fromYmd || `${estToday().slice(0, 4)}-01-01`;
    let from = estDayStart(startYmd);
    if (Date.now() - from.getTime() > TWO_YEARS_MS) from = new Date(Date.now() - TWO_YEARS_MS);   // eBay's limit
    const since = backfill ? null : new Date(Date.parse(keep.lastOrdersAt) - 15 * 60_000);

    await put({ state: 'running', step: 'orders', done: 0, total: null });
    const raw = await fetchEbayOrders(backfill ? { from } : { modifiedSince: since },
      (done, total) => put({ state: 'running', step: 'orders', done, total }));
    const orders = raw.map(orderFromApi);
    await saveEbayOrders(orders);

    // Tracking: only where eBay's fulfillment count moved.
    const held = await ebayOrderFulfillmentCounts(orders.map((o) => o.order_id));
    const need = orders.filter((o) => o.fulfillment_count > 0 && held.get(o.order_id) !== o.fulfillment_count);
    let done = 0;
    const numbers = [];
    await put({ state: 'running', step: 'tracking', done, total: need.length });
    await pool(need, 6, async (o) => {
      try {
        const fs = fulfillmentsFromApi(await fetchShippingFulfillments(o.order_id));
        await setEbayOrderFulfillments(o.order_id, fs);
        for (const f of fs) if (f.number && f.shipped_at && Date.now() - Date.parse(f.shipped_at) < 30 * 86400_000) numbers.push(f.number);
      } catch (e) { console.warn('[ebay-orders] fulfillments', o.order_id, e.message); }
      if (++done % 20 === 0) await put({ state: 'running', step: 'tracking', done, total: need.length });
    });

    // Photos for sold shoes no longer in the listings pull.
    const missing = (await ebayItemsWithoutImage(orders.flatMap((o) => o.lines.map((l) => l.item_id)))).slice(0, 400);
    done = 0;
    await put({ state: 'running', step: 'photos', done, total: missing.length });
    await pool(missing, 4, async (id) => { await saveEbayItemImage(id, await ebayItemPicture(id)); done++; });

    // Delivered / in transit, from the carriers (17TRACK; once per number).
    if (numbers.length) await registerWarehouseTracking(numbers, { claim: claimForTracking, label: 'ebay-orders' });

    // Money.
    let txCount = null; let financeError = null;
    if (st.canFinances) {
      await put({ state: 'running', step: 'money', done: 0, total: null });
      const txFrom = backfill ? from : new Date(Math.min(Date.parse(keep.lastTxTo || startedAt), Date.parse(startedAt)) - 3 * 86400_000);
      try {
        const tx = await fetchEbayTransactions({ from: txFrom, to: new Date() }, (n, total) => put({ state: 'running', step: 'money', done: n, total }));
        await saveEbayTransactions(tx.map(transactionFromApi));
        txCount = tx.length;
        keep.lastTxTo = startedAt;
      } catch (e) { financeError = e.message; }
    } else financeError = 'Not approved for eBay finances yet — an admin presses Connect eBay again.';

    keep.lastOrdersAt = startedAt;
    if (backfill && (!keep.coveredFrom || from.toISOString() < keep.coveredFrom)) keep.coveredFrom = from.toISOString();
    await put({ state: 'done', finishedAt: new Date().toISOString(), orders: orders.length, tracking: need.length, photos: missing.length,
      registered: numbers.length, transactions: txCount, financeError, backfill });
    return { ok: true };
  } catch (e) {
    console.error('[ebay-orders] sync', e.message);
    await put({ state: 'failed', finishedAt: new Date().toISOString(), error: e.message, needsReconnect: !!e.auth });
    return { ok: false, error: e.message };
  }
}
