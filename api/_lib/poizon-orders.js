// POIZON orders, read from Shopify (docs/context/poizon-orders.md). POIZON sales land in Shopify
// as orders made by the "POIZON" app; Shopify can't search by app, so this reads every order
// CHANGED since the last run (a light page of 250: id + app), keeps POIZON's, reads those in full
// and stores them in poizon_orders. Read-only on Shopify: nothing is ever written there.
//   first run  = the last 30 days (about 25 light pages for this store)
//   afterwards = only what changed since the cursor (normally one page)
// State lives in app_settings.poizon_orders_sync, so the page shows when it last ran and why not.
import { getSetting, setSetting, upsertPoizonOrders } from './db.js';
import { shopifyConfigured, shopifyOrdersChangedPage, shopifyOrdersByIds } from './shopify.js';

const SYNC_KEY = 'poizon_orders_sync';
const STALE_MS = 10 * 60 * 1000;
const FIRST_DAYS = 30;
const OVERLAP_MS = 2 * 60 * 1000;   // re-read a little before the cursor: Shopify's search index lags a moment
const MAX_PAGES = 60;               // one run reads at most 15,000 orders; the cursor carries on next run

export const isPoizonOrder = (node) => /poizon/i.test(`${node?.app?.name || ''} ${node?.channelInformation?.channelDefinition?.channelName || ''}`);

// A Shopify order (ORDERS_FULL) → our row. A line keeps how many pairs are still to ship.
export function poizonOrderRow(node) {
  const lines = (node.lineItems?.edges || []).map(({ node: l }) => {
    const qty = Number(l.quantity) || 0;
    const current = l.currentQuantity == null ? qty : Number(l.currentQuantity) || 0;
    const unfulfilled = l.unfulfilledQuantity == null ? current : Number(l.unfulfilledQuantity) || 0;
    return { title: l.title || '', size: l.variantTitle || '', sku: l.sku || '', qty, current, unfulfilled };
  });
  const tracking = (node.fulfillments || []).flatMap((f) => (f.trackingInfo || []).map((t) => ({
    number: t.number || '', company: t.company || '', url: t.url || '', status: f.status || '', at: f.createdAt || null,
  }))).filter((t) => t.number);
  return {
    shopify_order_id: String(node.id || '').split('/').pop(),
    order_no: String(node.name || '').replace(/^#/, ''),
    ordered_at: node.createdAt || null, cancelled_at: node.cancelledAt || null, closed_at: node.closedAt || null,
    fulfillment_status: node.displayFulfillmentStatus || null, financial_status: node.displayFinancialStatus || null,
    lines, tracking, shopify_updated_at: node.updatedAt || null,
  };
}

export async function readSync(key = SYNC_KEY) {
  try { return JSON.parse((await getSetting(key)) || 'null'); } catch { return null; }
}
export const syncRunning = (s) => s?.state === 'running' && Date.now() - Date.parse(s.startedAt) < STALE_MS;

let inFlight = null;
// `io` lets a test stand in for Shopify and the table (and keep its state under its own key).
export function runPoizonOrdersSync({ by = 'auto', io = null } = {}) {
  if (inFlight) return inFlight;
  inFlight = sync({ by, io: io || { page: shopifyOrdersChangedPage, full: shopifyOrdersByIds, save: upsertPoizonOrders, configured: shopifyConfigured } })
    .finally(() => { inFlight = null; });
  return inFlight;
}

async function sync({ by, io }) {
  const key = io.key || SYNC_KEY;
  const prev = (await readSync(key)) || {};
  const startedAt = new Date().toISOString();
  const keep = { cursor: prev.cursor || null, lastAt: prev.lastAt || null, firstDone: !!prev.firstDone };
  const put = (o) => setSetting(key, JSON.stringify({ ...keep, by, startedAt, ...o }), by).catch(() => {});
  if (!io.configured()) { await put({ state: 'error', error: 'Shopify isn’t set up on this server.' }); return { error: 'not configured' }; }
  await put({ state: 'running', read: 0, found: 0 });
  const since = keep.cursor ? new Date(Date.parse(keep.cursor) - OVERLAP_MS).toISOString() : new Date(Date.now() - FIRST_DAYS * 86_400_000).toISOString();
  let after = null; let read = 0; let found = 0; let changed = 0; let cursor = keep.cursor; let more = false;
  try {
    for (let p = 0; p < MAX_PAGES; p += 1) {
      const r = await io.page(since, after);
      if (r.error) throw Object.assign(new Error(r.code === 'denied' ? 'Shopify refused: the app needs the read_orders scope.' : r.error), { code: r.code });
      read += r.orders.length;
      const ids = r.orders.filter(isPoizonOrder).map((o) => o.id);
      if (ids.length) {
        const f = await io.full(ids);
        if (f.error) throw Object.assign(new Error(f.error), { code: f.code });
        const rows = f.orders.filter(isPoizonOrder).map(poizonOrderRow).filter((x) => x.shopify_order_id && x.order_no);
        found += rows.length;
        changed += await io.save(rows);
      }
      // Pages come oldest change first, so everything up to this page's last order is safely stored.
      const last = r.orders[r.orders.length - 1]?.updatedAt;
      if (last && (!cursor || last > cursor)) cursor = last;
      keep.cursor = cursor;
      after = r.next;
      more = !!after;
      if (!after) break;
      if (p % 5 === 4) await put({ state: 'running', read, found });
    }
    keep.lastAt = new Date().toISOString();
    keep.firstDone = keep.firstDone || !more;
    await put({ state: 'done', read, found, changed, more });
    return { ok: true, read, found, changed, more };
  } catch (e) {
    await put({ state: 'error', error: e.message, read, found });
    return { error: e.message };
  }
}
