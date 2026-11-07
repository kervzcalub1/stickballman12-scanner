// GET /api/ebay-sync/listings?filter=all|qty_drift|price_kept|price_drift|no_shopify&q=&offset= -> { ok, rows, total, tabs }
// price_rule is one of kept_lock | kept_repriced | kept_manual | follows_shopify.
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, ebaySyncListings, ebaySyncListingTabs } from '../_lib/db.js';
import { pageOffset } from '../../src/lib/ebaySync.js';

const RULE = { follows_shopify: 'follows_shopify', kept_lock: 'kept_lock', kept_repriced: 'kept_repriced', kept_manual: 'kept_manual' };
export default async function handler(req, res) {
  applySecurity(req, res);
  const qs = new URL(req.url, 'http://x').searchParams;
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const filter = ['all', 'qty_drift', 'price_kept', 'price_drift', 'no_shopify'].includes(qs.get('filter')) ? qs.get('filter') : 'all';
  const offset = pageOffset(qs.get('offset'));
  if (offset == null) return send(res, 400, { ok: false, error: 'The offset must be a whole number, 0 or more.' });
  const { rows, total } = await ebaySyncListings({ filter, q: String(qs.get('q') || '').slice(0, 80), offset });
  return send(res, 200, { ok: true, rows: rows.map((r) => ({ ...r, price_rule: RULE[r.price_rule] || null })), total, tabs: await ebaySyncListingTabs() });
}
