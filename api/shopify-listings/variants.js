// GET  /api/shopify-listings/variants -> { ok, variants:[…], adminStore, truncated?, source, check, market, marketPass }
// POST /api/shopify-listings/variants -> { ok, started }   "Check now": a full re-read + market prices, on the server
// PH team (admin auto-allowed). docs/context/shopify-listings.md "Kept fresh by the server".
//
// The page used to read every Shopify variant LIVE on open, and price the market in the browser.
// Now it reads the server's copy (api/_lib/listings-watch.js: a full re-read every 30 min + each
// Shopify webhook), with the market prices the server already looked up. Until the first full
// re-read has finished, it reads Shopify live (as before) and starts one.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { shopifyAllVariants, shopifyAdminStore, shopifyConfigured } from '../_lib/shopify.js';
import { dbConfigured, listShopifyListingVariants, listMarketPrices } from '../_lib/db.js';
import { shopifyFullCheck, marketPass, lastShopifyCheck, lastMarketPass } from '../_lib/listings-watch.js';

const everDone = (c) => !!(c && (c.state === 'done' || c.lastGood || c.prev));
const fullThenMarket = (by) => shopifyFullCheck(by)
  .then((r) => (r.error || r.skipped ? r : marketPass({ by })))
  .catch((e) => console.error('[shopify-listings] check', e.message));

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 10 })) return send(res, 429, { ok: false, error: 'Please wait a moment before reloading.' });
  const by = user.name || user.username || 'someone';

  if (req.method === 'POST') {
    if (!shopifyConfigured()) return send(res, 500, { ok: false, error: 'Shopify is not configured on the server.' });
    if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
    const c = await lastShopifyCheck();
    if (c?.state === 'running' && Date.now() - Date.parse(c.startedAt) < 20 * 60_000) return send(res, 409, { ok: false, error: 'The server is re-reading Shopify right now.' });
    fullThenMarket(by);
    return send(res, 200, { ok: true, started: true });
  }
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });

  try {
    const check = dbConfigured() ? await lastShopifyCheck() : null;
    if (dbConfigured() && everDone(check)) {
      const [variants, market, mpass] = await Promise.all([listShopifyListingVariants(), listMarketPrices(), lastMarketPass()]);
      return send(res, 200, {
        ok: true, source: 'stored', variants, adminStore: shopifyAdminStore(), truncated: !!check.truncated, check, marketPass: mpass,
        market: market.map((m) => ({ sku: m.sku, size: m.size, status: m.status, valueCents: m.value_cents, label: m.label, name: m.name, checkedAt: m.checked_at })),
      });
    }
    // No copy yet: Shopify live, as before — and start the first full re-read so the next open is instant.
    const r = await shopifyAllVariants();
    if (r.error) return send(res, r.code === 'config' ? 500 : 502, { ok: false, error: r.error, code: r.code });
    if (dbConfigured() && check?.state !== 'running') fullThenMarket(`${by} (first open)`);
    return send(res, 200, { ok: true, source: 'live', variants: r.variants, adminStore: shopifyAdminStore(), truncated: !!r.truncated, check, market: [] });
  } catch (e) {
    return send(res, 502, { ok: false, error: `Could not reach Shopify (${e.message}).` });
  }
}
