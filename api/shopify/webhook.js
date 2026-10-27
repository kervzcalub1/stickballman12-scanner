// POST /api/shopify/webhook   Shopify's pushes, by topic (x-shopify-topic):
//   inventory_levels/update ({ inventory_item_id, location_id, available }) — a stock level changed.
//     The fast half of "SHEIN always shows Shopify's latest number" (docs/context/shein-live-fix.md →
//     "Shopify → SHEIN"): the SKU is queued and its SHEIN sizes get the live per-product step (stock only).
//   products/create · products/update — SHEIN Listings (docs/context/shein-listings.md): coalesced,
//     hashed WITHOUT stock, and only a real listing change (price, SKU, size, title…) recomputes
//     that product's SHEIN status, from stored SHEIN rows (no SHEIN call). A stock-only update does nothing.
//   products/delete — the product is off on SHEIN Listings at once.
// No app login: Shopify's HMAC over the raw body is the proof. Answers 200 at once and works after.
import { applySecurity, rateLimit, send } from '../_lib/util.js';
import { shopifyWebhookValid, shopifySkuForInventoryItem } from '../_lib/shopify.js';
import { queuePush } from '../_lib/shein-live.js';
import { listingProductChanged, listingProductDeleted } from '../_lib/shein-listing.js';

// What each topic calls — swappable in tests (e2e/shein-listings.spec.js proves the inventory path
// is exactly what it was: the SKU of the inventory item → queuePush, nothing else).
export const HOOK = { shopifySkuForInventoryItem, queuePush, listingProductChanged, listingProductDeleted };

export async function routeShopifyWebhook(topic, body, hook = HOOK) {
  if (topic === 'inventory_levels/update') {
    const itemId = body?.inventory_item_id;
    if (!itemId) return { ignored: true };
    const sku = await hook.shopifySkuForInventoryItem(itemId);
    if (sku) hook.queuePush([sku]);
    return { pushed: sku || null };
  }
  if (topic === 'products/create' || topic === 'products/update') { hook.listingProductChanged(body); return { listing: 'queued' }; }
  if (topic === 'products/delete') { await hook.listingProductDeleted(body); return { listing: 'deleted' }; }
  return { ignored: true };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  if (!rateLimit(req, { windowMs: 60_000, max: 2000 })) return send(res, 429, { ok: false });
  if (!shopifyWebhookValid(req.rawBody, req.headers['x-shopify-hmac-sha256'])) return send(res, 401, { ok: false });
  send(res, 200, { ok: true });
  const topic = String(req.headers['x-shopify-topic'] || '');
  try {
    await routeShopifyWebhook(topic, req.body);
  } catch (e) { console.error('[shopify/webhook]', e.message); }
}
