// GET  /api/ebay-sync/duplicates?productId=gid://shopify/Product/N -> { ok, title, dupSkus, listings:[{ item_id, title, view_url, start_time, watch_count, sizes }] }
// POST /api/ebay-sync/duplicates { productId, endItemId, keepItemId, acceptLoss? } -> { ok, ended?, error?, lost? }
// The same SKU on two of OUR eBay listings (docs/context/ebay-sync.md): a person picks which one to end. Nothing is
// ended automatically. Reading needs the PH team; ending needs an admin or "Connect integrations"; the kill switch,
// a server that may not write, and End listings switched Off still stop it.
import { send, applySecurity, rateLimit, requireRole, getJsonBody } from '../_lib/util.js';
import { requirePrivilege } from '../_lib/buycart.js';
import { dbConfigured } from '../_lib/db.js';
import { duplicateListings, endExtraListing } from '../_lib/ebay-sync.js';

const PID = /^gid:\/\/shopify\/Product\/\d+$/;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method === 'GET') {
    const user = requireRole(req, res, ['ph_team']);
    if (!user) return;
    if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
    if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
    const productId = String(new URL(req.url, 'http://x').searchParams.get('productId') || '');
    if (!PID.test(productId)) return send(res, 400, { ok: false, error: 'Which product?' });
    try { return send(res, 200, await duplicateListings(productId)); } catch (e) {
      console.error('[ebay-sync/duplicates]', e.message);
      return send(res, 500, { ok: false, error: 'Could not read the listings.' });
    }
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = await requirePrivilege(req, res, 'connect_integrations', 'Ending an eBay listing needs an admin, or the “Connect integrations” privilege.');
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 10 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  const body = await getJsonBody(req);
  const productId = String(body.productId || '');
  if (!PID.test(productId)) return send(res, 400, { ok: false, error: 'Which product?' });
  try {
    const out = await endExtraListing(productId, { endItemId: body.endItemId, keepItemId: body.keepItemId, acceptLoss: body.acceptLoss === true }, { by: user.name || user.username || '' });
    return send(res, 200, out);
  } catch (e) {
    console.error('[ebay-sync/duplicates]', e.message);
    return send(res, 500, { ok: false, error: 'That did not go through.' });
  }
}
