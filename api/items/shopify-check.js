// GET /api/items/shopify-check?sku=<style>  ->  { ok, sku, checkedAt, products, error? }
// Inventory's "Check Shopify" button (docs/context/inventory.md): what Shopify holds for a
// style RIGHT NOW — every product carrying it, each size's quantity and price. Shopify is
// the bridge to every platform (Nikki → II → Shopify → the rest), so its live numbers are
// the answer to "is it listed", not our own SH tick. Read-only.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { shopifyLiveForStyle, shopifyAdminStore } from '../_lib/shopify.js';
import { shopifyHoldings } from '../../src/lib/shopifyCheck.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!requireRole(req, res, ['warehouse', 'ph_team'])) return;   // admin auto-allowed
  if (!rateLimit(req, { windowMs: 60_000, max: 40 }))
    return send(res, 429, { ok: false, error: 'Please wait a moment before checking again.' });

  const sku = (new URL(req.url, 'http://x').searchParams.get('sku') || '').trim();
  if (!sku) return send(res, 400, { ok: false, error: 'Provide a SKU.' });
  const codes = [...new Set(sku.split('/').map((c) => c.trim().toUpperCase()).filter(Boolean))].slice(0, 4);

  try {
    const shops = await Promise.all(codes.map((c) => shopifyLiveForStyle(c)));
    const checkedAt = new Date().toISOString();
    // Unreadable is never "Shopify has none" — say which it is.
    const failed = shops.find((s) => s.error);
    if (failed) return send(res, 200, { ok: true, sku, checkedAt, products: [], error: failed.error });
    const store = shopifyAdminStore();
    const variants = shops.flatMap((s) => s.variants || []).map((v) => {
      const id = String(v.productId || '').split('/').pop();
      return { ...v, url: store && /^\d+$/.test(id) ? `https://admin.shopify.com/store/${store}/products/${id}` : null };
    });
    return send(res, 200, { ok: true, sku, checkedAt, products: shopifyHoldings(variants) });
  } catch (e) {
    console.error('[items/shopify-check]', e.message);
    return send(res, 500, { ok: false, error: 'The Shopify check failed.' });
  }
}
