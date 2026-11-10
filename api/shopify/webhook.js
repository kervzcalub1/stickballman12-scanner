// POST /api/shopify/webhook   Shopify's pushes, by topic (x-shopify-topic):
//   inventory_levels/update ({ inventory_item_id, location_id, available }) — a stock level changed.
//     The fast half of "SHEIN always shows Shopify's latest number" (docs/context/shein-live-fix.md →
//     "Shopify → SHEIN"): the SKU is queued and its SHEIN sizes get the live per-product step (stock only).
//   products/create · products/update — SHEIN Listings (docs/context/shein-listings.md): coalesced,
//     hashed WITHOUT stock, and only a real listing change (price, SKU, size, title…) recomputes
//     that product's SHEIN status, from stored SHEIN rows (no SHEIN call). A stock-only update does nothing.
//   products/delete — the product is off on SHEIN Listings at once.
//   Every one of these also refreshes Shopify Listings' stored copy of that product
//   (api/_lib/listings-watch.js — the page no longer reads Shopify live on open).
// No app login: Shopify's HMAC over the raw body is the proof. Answers 200 at once and works after.
import { applySecurity, rateLimit, send } from '../_lib/util.js';
import { shopifyWebhookValid, shopifySkuForInventoryItem } from '../_lib/shopify.js';
import { queuePush } from '../_lib/shein-live.js';
import { listingProductChanged, listingProductDeleted } from '../_lib/shein-listing.js';
import { ebaySyncEnqueue } from '../_lib/db.js';
import { queueShopifyListingProduct, shopifyListingStockChanged, shopifyListingProductDeleted } from '../_lib/listings-watch.js';

// What each topic calls — swappable in tests (e2e/shein-listings.spec.js proves the inventory path
// is exactly what it was: the SKU of the inventory item → queuePush, nothing else).
export const HOOK = {
  shopifySkuForInventoryItem, queuePush, listingProductChanged, listingProductDeleted, ebaySyncQueue: ebaySyncEnqueue,
  // Shopify Listings' stored copy (api/_lib/listings-watch.js): the changed product is re-read and saved.
  shopifyListing: { product: queueShopifyListingProduct, stock: shopifyListingStockChanged, deleted: shopifyListingProductDeleted },
};

// eBay Sync (docs/context/ebay-sync.md) hears the same topics, BESIDE SHEIN's path: it only inserts into
// ebay_sync_queue, and an error here never reaches SHEIN's handling.
const toEbayQueue = (hook, items) => {
  try { Promise.resolve(hook.ebaySyncQueue?.(items)).catch((e) => console.error('[ebay-sync] queue', e.message)); } catch (e) { console.error('[ebay-sync] queue', e.message); }
};

// Shopify Listings' copy hears the same topics, also BESIDE SHEIN's path: an error here is logged, never thrown.
const toListingCopy = (hook, fn, arg) => {
  try { Promise.resolve(hook.shopifyListing?.[fn]?.(arg)).catch((e) => console.error('[listings-watch] webhook', e.message)); } catch (e) { console.error('[listings-watch] webhook', e.message); }
};

export async function routeShopifyWebhook(topic, body, hook = HOOK) {
  if (topic === 'inventory_levels/update' && body?.inventory_item_id) toListingCopy(hook, 'stock', body.inventory_item_id);
  if ((topic === 'products/create' || topic === 'products/update') && body?.id) toListingCopy(hook, 'product', body.id);
  if (topic === 'products/delete' && body?.id) toListingCopy(hook, 'deleted', body.id);
  if (topic === 'inventory_levels/update') {
    const itemId = body?.inventory_item_id;
    if (!itemId) return { ignored: true };
    const sku = await hook.shopifySkuForInventoryItem(itemId);
    if (sku) { hook.queuePush([sku]); toEbayQueue(hook, [{ kind: 'sku', key: sku }]); }
    return { pushed: sku || null };
  }
  if (topic === 'products/create' || topic === 'products/update') {
    if (body?.id) toEbayQueue(hook, [{ kind: 'product', key: `gid://shopify/Product/${body.id}` }]);
    hook.listingProductChanged(body); return { listing: 'queued' };
  }
  if (topic === 'products/delete') {
    if (body?.id) toEbayQueue(hook, [{ kind: 'product_delete', key: `gid://shopify/Product/${body.id}` }]);
    await hook.listingProductDeleted(body); return { listing: 'deleted' };
  }
  return { ignored: true };
}

// A refused call leaves one line saying WHO sent it, because a status code can't: a 401 from our own
// subscription means our secret is wrong, a 401 from another store or app means nothing of ours failed.
// Headers are attacker-controlled before the signature passes, so they are cut to safe characters,
// and the lines are capped per hour. The signature itself is never logged.
const safeHeader = (v) => String(v ?? '').replace(/[^\w./:@-]/g, '').slice(0, 80) || '-';
const REJECT_LOGS_PER_HOUR = 200;
let rejectHour = 0;
let rejectLogged = 0;
export function logRejectedWebhook(req, now = Date.now()) {
  const hour = Math.floor(now / 3_600_000);
  if (hour !== rejectHour) { rejectHour = hour; rejectLogged = 0; }
  if (++rejectLogged > REJECT_LOGS_PER_HOUR) return false;
  const h = req.headers || {};
  console.warn(`[shopify/webhook] refused bad signature: topic=${safeHeader(h['x-shopify-topic'])} shop=${safeHeader(h['x-shopify-shop-domain'])} api=${safeHeader(h['x-shopify-api-version'])} sub=${safeHeader(h['x-shopify-name'])} id=${safeHeader(h['x-shopify-webhook-id'])} signed=${h['x-shopify-hmac-sha256'] ? 'yes' : 'no'} bytes=${req.rawBody?.length ?? 0}`);
  return true;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  if (!rateLimit(req, { windowMs: 60_000, max: 2000 })) return send(res, 429, { ok: false });
  if (!shopifyWebhookValid(req.rawBody, req.headers['x-shopify-hmac-sha256'])) {
    logRejectedWebhook(req);
    return send(res, 401, { ok: false });
  }
  send(res, 200, { ok: true });
  const topic = String(req.headers['x-shopify-topic'] || '');
  try {
    await routeShopifyWebhook(topic, req.body);
  } catch (e) { console.error('[shopify/webhook]', e.message); }
}
