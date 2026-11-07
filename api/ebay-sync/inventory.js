// GET /api/ebay-sync/inventory?q=&offset= -> { ok, rows:[{ sku, title, stock, listing_count, duplicate }], total }
import { send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, ebaySyncInventory } from '../_lib/db.js';
import { pageOffset } from '../../src/lib/ebaySync.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const qs = new URL(req.url, 'http://x').searchParams;
  if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 120 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const offset = pageOffset(qs.get('offset'));
  if (offset == null) return send(res, 400, { ok: false, error: 'The offset must be a whole number, 0 or more.' });
  const { rows, total } = await ebaySyncInventory({ q: String(qs.get('q') || '').slice(0, 80), offset });
  return send(res, 200, { ok: true, rows, total });
}
