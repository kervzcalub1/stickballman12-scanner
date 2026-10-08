// GET /api/shopify-listings/variants -> { ok, variants:[…], adminStore, truncated? }
// PH team (admin auto-allowed). Every variant in the Shopify store, fresh — the page
// loads this on open. docs/context/shopify-listings.md
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { shopifyAllVariants, shopifyAdminStore } from '../_lib/shopify.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 10 })) return send(res, 429, { ok: false, error: 'Please wait a moment before reloading.' });
  try {
    const r = await shopifyAllVariants();
    if (r.error) return send(res, r.code === 'config' ? 500 : 502, { ok: false, error: r.error, code: r.code });
    return send(res, 200, { ok: true, variants: r.variants, adminStore: shopifyAdminStore(), truncated: !!r.truncated });
  } catch (e) {
    return send(res, 502, { ok: false, error: `Could not reach Shopify (${e.message}).` });
  }
}
