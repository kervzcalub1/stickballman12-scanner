// POST /api/items/backfill-upc
//   { upc }                      -> ask first: { ok, updated: 0, confirm: {…} | reason }
//   { upc, confirm: { sku, size } } -> write:   { ok, updated, sku, size, vins }
//
// Close the UPC gap from the other end. Receiving records a pair's UPC at intake,
// but plenty of stock has none: everything received before per-size UPCs were
// recorded correctly had its borrowed code cleared (2026-09-03, PR #178), old
// stock and in-store buys never had one, and the No-Box prompt only ever fixes the
// single pair in front of you. So when somebody scans a UPC on Inventory or Box
// Labels, the answer can be written back to every pair it belongs to.
//
// TWO PHASES, because the catalogue is not always right. A UPC can come back with
// variants from several different products, and `variants[0]` then makes the style
// and the size a guess — which is exactly the kind of guess that put one code
// across a whole size run in the first place. So nothing is written until a person
// has looked at the shoe the lookup named and said it matches the box in their
// hand. The prompt asks ONLY about the information; it doesn't mention saving,
// because "is this right?" and "shall I save this?" get different answers out of
// somebody who is busy.
//
// The client can VETO or APPROVE. It can never dictate: phase two re-runs the
// lookup and refuses if the style or size it was shown is no longer what comes
// back, so a hand-edited request can't put an arbitrary code on arbitrary stock.
import { getJsonBody, send, applySecurity, rateLimit, requireRole, cleanUpc } from '../_lib/util.js';
import { stockxUpcLookup } from '../upc-search.js';
import { backfillUpcBySkuSize, countUnitsMissingUpc, dbConfigured } from '../_lib/db.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // PH search the same Inventory page, and a person is confirming every write —
  // there is nothing here for a role to get wrong.
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

    const answer = body.confirm;
    if (!answer) {
      // Never interrupt somebody for a question whose answer changes nothing.
      const pending = await countUnitsMissingUpc({ sku: hit.sku, size: hit.scannedSize });
      if (!pending) return send(res, 200, { ok: true, updated: 0, reason: 'nothing-to-fill' });
      return send(res, 200, {
        ok: true,
        updated: 0,
        confirm: {
          upc,
          sku: hit.sku,
          size: hit.scannedSize,
          name: hit.name,
          colorway: hit.colorway,
          gender: hit.gender,
          image: hit.image,
          ambiguous: !!hit.ambiguous,
        },
      });
    }

    // The approval has to be for what the person actually saw. A cache expiring or
    // a `variants[0]` landing differently between the two calls means the shoe on
    // screen isn't the shoe we'd write — ask again rather than write the new one.
    if (String(answer.sku || '') !== hit.sku || String(answer.size || '') !== hit.scannedSize)
      return send(res, 200, { ok: true, updated: 0, reason: 'changed' });

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
