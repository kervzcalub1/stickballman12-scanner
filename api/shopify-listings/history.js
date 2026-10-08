// GET /api/shopify-listings/history -> { ok, rows } — the latest fields this page changed
// on Shopify (shopify_listing_edits). PH team (admin auto-allowed).
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, recentShopifyListingEdits } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  return send(res, 200, { ok: true, rows: await recentShopifyListingEdits(200) });
}
