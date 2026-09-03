// POST /api/items/backfill-upc { upc }  ->  { ok, updated, sku, size, vins, reason? }
//
// Close the UPC gap from the other end. Receiving records a pair's UPC at intake,
// but plenty of stock has none: everything received before per-size UPCs were
// recorded correctly had its borrowed code cleared (2026-09-03, PR #178), old
// stock and in-store buys never had one, and the No-Box prompt only ever fixes the
// single pair in front of you. So when somebody scans a UPC on Inventory or Box
// Labels, the answer is written back to every pair it belongs to.
//
// The caller sends the CODE ONLY. The style and the size come from the StockX
// lookup here, never from the client: a UPC identifies one size's box, and taking
// the size on trust is precisely how one scanned code ended up stamped across a
// whole size run in the first place. No size from the lookup → nothing is written.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, cleanUpc } from '../_lib/util.js';
import { stockxUpcLookup } from '../upc-search.js';
import { backfillUpcBySkuSize, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // PH search the same Inventory page, and this only ever fills in blanks from an
  // authoritative lookup — there is nothing here for a role to get wrong.
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const upc = cleanUpc(body.upc);
  if (!upc || ![8, 12, 13, 14].includes(upc.length))
    return send(res, 400, { ok: false, error: 'Provide a valid 8-, 12-, 13- or 14-digit UPC/EAN.' });

  try {
    let hit = null;
    try { hit = await stockxUpcLookup(upc); } catch { hit = null; }
    // Quiet, not an error: a code the catalogue can't place is an ordinary outcome
    // on a search bar, and the page still has its own results to show.
    if (!hit?.sku) return send(res, 200, { ok: true, updated: 0, reason: 'unknown-upc' });
    if (!hit.scannedSize) return send(res, 200, { ok: true, updated: 0, reason: 'no-size', sku: hit.sku });

    const rows = await backfillUpcBySkuSize({
      upc, sku: hit.sku, size: hit.scannedSize, by: user.username || user.name || null,
    });
    return send(res, 200, {
      ok: true,
      updated: rows.length,
      sku: hit.sku,
      size: hit.scannedSize,
      vins: rows.map((r) => r.vin),
    });
  } catch (e) {
    console.error('[items/backfill-upc]', e.message);
    return send(res, 500, { ok: false, error: 'Could not save the UPC.' });
  }
}
