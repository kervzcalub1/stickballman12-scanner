// POST /api/ebay/connect -> { ok, url }   the eBay page the seller account owner approves on
// POST /api/ebay/connect { disconnect: true } -> { ok }   forget the stored token
// Admin only: this links the COMPANY eBay account. (docs/context/ebay-listings.md)
import { send, applySecurity, rateLimit, requireAdmin, getJsonBody } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { ebayConfigured, ebayMissing, consentUrl, disconnect } from '../_lib/ebay.js';
import { secretsConfigured } from '../_lib/secrets.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 10 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const by = user.name || user.username || '';
  const body = await getJsonBody(req);
  if (body.disconnect) { await disconnect(by); return send(res, 200, { ok: true }); }
  if (!ebayConfigured()) return send(res, 503, { ok: false, error: `eBay isn't set up on this server — missing ${ebayMissing().join(', ')}.` });
  // The token is stored encrypted or not at all (secrets.js fails closed).
  if (!secretsConfigured()) return send(res, 503, { ok: false, error: 'BUY_GC_KEY is not set — the eBay token has to be stored encrypted.' });
  return send(res, 200, { ok: true, url: await consentUrl(by) });
}
