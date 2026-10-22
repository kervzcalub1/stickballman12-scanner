// GET  /api/items/cost-backfill            -> { ok, plan }            (preview, writes nothing)
// POST /api/items/cost-backfill { apply }  -> { ok, filled, plan }    (fills the blanks)
//
// Fill costs from POs. `items.cost` is written once, at receiving, and only when the box
// is received AGAINST the PO — so a pair received before its shelf price was on the PO
// (or before the shelf-price rule existed, 2026-09-29) has no cost while the PO beside it
// plainly does. The Platform Profit report then shows it as "without a cost".
//
// The landed cost is worked out EXACTLY the way receiving does it, with the same code:
//   · the pair's PO: its batch's link, or — when the batch was never linked — the ONE shoes
//     PO whose label carries the parcel's tracking number (listCostBackfillCandidates);
//   · the PO line for the pair's SKU + size (`poLineMoney`) — the pair's own LABEL first
//     (matched by the box's tracking number), any label on the order after that;
//   · the shipment's supplier preset (`presetForShipment`: the PO's supplier account,
//     else the receiving supplier name);
//   · shelf → preset discounts / gift card → tax → + tip + shipping (`landedFromShelf`),
//     the line's own tip beating the preset's.
// A supplier with NO preset is skipped, not costed at shelf: the declared figure is only
// the shelf price, and the actual cost is shelf + preset (owner's rule, 2026-09-30). The
// preview names those POs and suppliers so a preset can be linked first.
// Only a BLANK cost is filled — never a $0 (a claim already on file) and never a real
// cost. Every filled pair gets a history note naming the PO and the numbers.
//
// Admin only: it writes cost onto thousands of pairs in one go. Preview first, always.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { buildCostPlan, applyCostPlan } from '../_lib/cost-backfill.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, []);   // admin / superadmin only (requireRole auto-allows them)
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 10 }))
    return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  try {
    if (req.method === 'GET') {
      const { summary } = await buildCostPlan();
      return send(res, 200, { ok: true, plan: summary });
    }
    const body = await getJsonBody(req);
    if (body.apply !== true) return send(res, 400, { ok: false, error: 'Nothing to do — preview with GET first.' });
    // Re-planned at the click, not taken from the preview: anything costed by hand in
    // between drops out (and fillItemsCost re-checks `cost IS NULL` row by row anyway).
    const plan = await buildCostPlan();
    const filled = await applyCostPlan(plan, user.username);
    return send(res, 200, { ok: true, filled, plan: plan.summary });
  } catch (e) {
    console.error('[items/cost-backfill]', e.message);
    return send(res, 500, { ok: false, error: 'Could not work out the costs from the POs.' });
  }
}
