// POST /api/po/line-price  (supplier / ph_team / admin)  { poId, sku, unitCost }
// "Shelf price ea — all sizes": ONE price on every size line of ONE SKU in an order's
// whole-order list (Path C — `po_box_id` NULL, not a store order), in one request. A PO
// price is the SHELF price only. `unitCost` blank / null CLEARS them all — "no price",
// never $0. A single size keeps its own field on its row (`po/line`), so one size can
// still be priced differently afterwards.
//
// The gate is EXACTLY the one a single line's price edit has (`po/line` → `poLineEditBlock`):
// a supplier on their own order only (403), never an order-level list that is our buying
// receipt ('order+box', 403), `manifestEditBlock` for the window (open while the order is a
// draft or being received, closed once reconciled / archived); staff on the supplier's
// behalf as today. Store orders are refused here (409) — their list is per store, edited
// line by line on the store panel. `po/line` writes no history for a whole-order line (only
// for a CONFIRMED store list, which can't reach here), so neither does this. Each changed
// line is re-stamped with who edited it, as `po/line` does; a line already at this price is
// left alone.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { getPo, setPoOrderSkuPrice, dbConfigured } from '../_lib/db.js';
import { poLineEditBlock, parseMoney } from '../_lib/po-manifest.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['supplier', 'ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const poId = Number(body.poId);
  const sku = String(body.sku ?? '').trim().slice(0, 60);
  if (!Number.isInteger(poId)) return send(res, 400, { ok: false, error: 'A valid order is required.' });
  if (!sku) return send(res, 400, { ok: false, error: 'A SKU is required.' });
  // Same reading as po/line: absent = nothing to do, blank = clear, junk = refused.
  const unitCost = parseMoney(body.unitCost === '' ? null : body.unitCost);
  if (unitCost === undefined) return send(res, 400, { ok: false, error: 'Give the shelf price ea (or leave it blank to clear it).' });
  if (Number.isNaN(unitCost)) return send(res, 400, { ok: false, error: 'Enter a cost between 0 and 10,000,000.' });

  try {
    const po = await getPo(poId);
    if (!po) return send(res, 404, { ok: false, error: 'Purchase order not found.' });
    const blocked = poLineEditBlock({ user, po, box: null });
    if (blocked) return send(res, blocked.code, { ok: false, error: blocked.error });
    if (po.by_store)
      return send(res, 409, { ok: false, error: 'This order is split by store — set prices on each store’s list.' });

    const onBehalf = user.role !== 'supplier';
    const uidNum = Number(user.uid);
    const enteredBy = onBehalf && Number.isInteger(uidNum) ? uidNum : null;
    const r = await setPoOrderSkuPrice({ poId, sku, unitCost, enteredBy, enteredOnBehalf: onBehalf });
    if (!r.lines)
      return send(res, 404, { ok: false, error: `${sku} isn’t on this order’s list — reload the order.` });
    return send(res, 200, { ok: true, sku, unitCost, lines: r.lines, updated: r.updated });
  } catch (e) {
    console.error('[po/line-price]', e.message);
    return send(res, 500, { ok: false, error: 'Could not set the price.' });
  }
}
