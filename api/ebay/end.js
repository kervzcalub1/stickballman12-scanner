// POST /api/ebay/end { itemIds:[…] (≤ 10) } -> { ok, results:[{ itemId, ok, skipped?, error? }], needsReconnect? }
// GET  /api/ebay/end                       -> { ok, ends }   the log of what was ended here
// End eBay listings that are no longer in Shopify (docs/context/ebay-listings.md → "Not in
// Shopify"). PH + admin. For EACH listing, right before ending it:
//   1. every size of it must be marked not-in-Shopify by the last pull (ending a listing
//      ends ALL its sizes — a listing with even one size still in Shopify is refused);
//   2. its Custom labels are searched in Shopify LIVE, one by one — if any is back (re-linked
//      since the pull), it is skipped, not ended.
// Then eBay EndItem, a row in ebay_listing_ends, and it drops off our copy. One at a time.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured, ebayListingRows, logEbayEnd, dropEbayListing, recentEbayEnds } from '../_lib/db.js';
import { ebayConfigured, endEbayItem } from '../_lib/ebay.js';
import { shopifySkusPresent } from '../_lib/shopify.js';
import { VERDICT_LABEL } from '../_lib/ebay-orphans.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  const user = requireRole(req, res, ['ph_team']);   // admin/superadmin auto-allowed
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 30 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });
  if (req.method === 'GET') return send(res, 200, { ok: true, ends: await recentEbayEnds() });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!ebayConfigured()) return send(res, 503, { ok: false, error: 'eBay isn’t set up on this server.' });

  const b = await getJsonBody(req);
  const ids = [...new Set((Array.isArray(b.itemIds) ? b.itemIds : []).map((x) => String(x).replace(/[^0-9]/g, '')).filter(Boolean))];
  if (!ids.length) return send(res, 400, { ok: false, error: 'Which listings?' });
  if (ids.length > 10) return send(res, 400, { ok: false, error: 'At most 10 at a time.' });
  const by = user.name || user.username || '';
  const results = [];
  for (const itemId of ids) {
    const rows = await ebayListingRows(itemId);
    if (!rows.length) { results.push({ itemId, ok: false, skipped: true, error: 'Not in the last pull — pull again first.' }); continue; }
    if (rows.some((r) => r.in_shopify !== false)) { results.push({ itemId, ok: false, skipped: true, error: 'Some sizes of this listing ARE in Shopify (or weren’t checked) — not ended.' }); continue; }
    const skus = rows.map((r) => r.sku).filter(Boolean);
    let back;
    try { back = await shopifySkusPresent(skus); }
    catch (e) { results.push({ itemId, ok: false, skipped: true, error: `Couldn’t re-check Shopify: ${e.message}` }); continue; }
    if (back.size) { results.push({ itemId, ok: false, skipped: true, error: `Now in Shopify (${[...back].join(', ')}) — not ended. Pull again.` }); continue; }
    const reason = [...new Set(rows.map((r) => VERDICT_LABEL[r.shopify_verdict] || r.shopify_verdict))].join('; ');
    const out = await endEbayItem(itemId);
    await logEbayEnd({ itemId, title: rows[0].title, skus: skus.join(' '), reason, ok: out.ok, error: out.error, by });
    if (out.ok) await dropEbayListing(itemId);
    results.push({ itemId, ok: out.ok, already: out.already || false, error: out.error });
    if (out.auth) return send(res, 200, { ok: true, results, needsReconnect: true });
  }
  return send(res, 200, { ok: true, results });
}
