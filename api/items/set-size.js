// GET  /api/items/set-size?vin=…                        -> { ok, item, siblings }
// POST /api/items/set-size { vin, size, scope, reason? } -> { ok, updated, listed, item, events }
//
// Correct the SIZE on a pair that was received under the wrong one.
//
// Why this exists: the size is the one fact at intake that nobody can scan. A UPC names
// a size's box, but plenty of pairs arrive with no readable barcode, a SKU scan answers
// for whichever size the catalogue felt like, and a `size?` row is typed by hand off the
// tongue label — so "declared a 9, it's a 9.5" is an ordinary Tuesday. Until now the
// only route back was to remove the pair and receive it again, which burns its VIN, its
// shelf and its history for a one-character mistake.
//
// `scope`: 'one' fixes this VIN; 'same_group' fixes every pair that was received onto
// the same line — same style code, same wrong size, same box of the same batch. That is
// the set one typed size produced; a pair of the same code and size in a DIFFERENT box
// is a different declaration and stays put. GET reports how many that would be before
// anyone commits to it.
//
// Changing the size clears the unit's box UPC (a UPC belongs to one size's box) and, for
// a pair that is neither on a store nor already sold, its Global Indicator and price
// (Alias quotes per size) — see `setItemsSize`. A pair already LISTED is corrected here
// too, because our record has to be right, but the response counts them (`listed`): the
// live listing still says the old size and PH has to fix that by hand.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getItemByVin, findSizeSiblings, setItemsSize, dbConfigured } from '../_lib/db.js';
import { normalizeSize } from '../../src/lib/codes.js';

const clean = (v, n) => String(v ?? '').trim().slice(0, n) || null;

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = req.method === 'POST' ? await getJsonBody(req) : {};
  const vin = String(req.method === 'GET'
    ? new URL(req.url, 'http://x').searchParams.get('vin') || ''
    : body.vin || '').trim().toUpperCase();
  if (!vin) return send(res, 400, { ok: false, error: 'Missing VIN.' });

  try {
    const found = await getItemByVin(vin);
    if (!found) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });
    const item = found.item;
    const siblings = await findSizeSiblings(item);

    if (req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        item: {
          vin: item.vin, sku: item.sku, name: item.name, size: item.size, upc: item.upc,
          status: item.status, batch_code: item.batch_code, box_id: item.box_id ?? null,
          price: item.price, global_indicator: item.global_indicator,
          listed: !!(item.synced_alias || item.synced_stockx || item.synced_shopify || item.added_to_intel_inv),
        },
        siblings: siblings.filter((s) => s.vin !== item.vin)
          .map((s) => ({ vin: s.vin, status: s.status, listed: s.listed })),
      });
    }

    // The size is normalized server-side, not trusted as typed: stock is grouped by
    // sku + size everywhere, so "9 M" saved verbatim would be its own row that nothing
    // else matches (normalizeSize, src/lib/codes.js).
    const size = normalizeSize(body.size);
    if (!size) {
      return send(res, 400, {
        ok: false,
        error: 'Enter the size as it’s written on the box — e.g. 9, 10.5, 8.5W, 5Y (apparel: S, M, L, XL).',
      });
    }
    if (size === String(item.size || '').trim()) return send(res, 400, { ok: false, error: `This pair is already size ${size}.` });
    const scope = body.scope === 'same_group' ? 'same_group' : 'one';
    const targets = scope === 'same_group' ? siblings : siblings.filter((s) => s.vin === item.vin);
    if (!targets.length) return send(res, 404, { ok: false, error: `No item found for ${vin}.` });

    const rows = await setItemsSize(
      targets.map((t) => t.id), { from: item.size, to: size, reason: clean(body.reason, 300) },
      user.name || user.username || '',
    );
    const updated = await getItemByVin(vin);
    return send(res, 200, {
      ok: true,
      updated: rows.length,
      listed: rows.filter((r) => r.listed).length,
      // What the caller has to tell the person, so the UI doesn't have to re-derive it:
      // the barcode on record was the old size's box, and an unlisted pair lost the old
      // size's price on purpose.
      upcCleared: !!item.upc,
      repriced: rows.filter((r) => !r.kept_price).length,
      ...updated,
    });
  } catch (e) {
    console.error('[items/set-size]', e.message);
    return send(res, 500, { ok: false, error: 'Could not change the size.' });
  }
}
