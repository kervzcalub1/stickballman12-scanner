// GET /api/shopify-reprice/variants -> { ok, variants:[{ variantId, productId, productTitle,
//   status, sku, size, price, qty, style }], truncated? }
// PH team (admin auto-allowed). Every variant in the Shopify store, fresh — prices move,
// so nothing here is cached. docs/context/shopify-reprice.md
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { shopifyAllVariants } from '../_lib/shopify.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 6 })) return send(res, 429, { ok: false, error: 'Please wait a moment before pulling again.' });
  try {
    const r = await shopifyAllVariants();
    if (r.error) return send(res, r.code === 'config' ? 500 : 502, { ok: false, error: r.error, code: r.code });
    return send(res, 200, { ok: true, variants: r.variants, truncated: !!r.truncated });
  } catch (e) {
    return send(res, 502, { ok: false, error: `Could not reach Shopify (${e.message}).` });
  }
}
