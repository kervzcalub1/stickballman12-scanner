// POST /api/shopify/webhook   Shopify's push when a stock level changes (topic
// inventory_levels/update: { inventory_item_id, location_id, available }). The fast half of
// "SHEIN always shows Shopify's latest number" (docs/context/shein-live-fix.md → "Shopify →
// SHEIN"). No app login: Shopify's HMAC over the raw body is the proof. Answers 200 at once;
// the SKU is queued and its SHEIN sizes get the live per-product step (stock only).
import { applySecurity, rateLimit, send } from '../_lib/util.js';
import { shopifyWebhookValid, shopifySkuForInventoryItem } from '../_lib/shopify.js';
import { queuePush } from '../_lib/shein-live.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  if (!rateLimit(req, { windowMs: 60_000, max: 2000 })) return send(res, 429, { ok: false });
  if (!shopifyWebhookValid(req.rawBody, req.headers['x-shopify-hmac-sha256'])) return send(res, 401, { ok: false });
  send(res, 200, { ok: true });
  const topic = String(req.headers['x-shopify-topic'] || '');
  const itemId = req.body?.inventory_item_id;
  if (topic !== 'inventory_levels/update' || !itemId) return;
  try {
    const sku = await shopifySkuForInventoryItem(itemId);
    if (sku) queuePush([sku]);
  } catch (e) { console.error('[shopify/webhook]', e.message); }
}
