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
import {
  listCostBackfillCandidates, countUncostedWithoutPo, listPoLinesForCost, fillItemsCost,
  presetForShipment, dbConfigured,
} from '../_lib/db.js';
import { poLineMoney, landedFromShelf } from '../../src/lib/costs.js';

const money = (n) => `$${Number(n).toFixed(2)}`;

async function buildPlan() {
  const all = await listCostBackfillCandidates();
  // A tracking number on two POs is reported, never guessed.
  const ambiguous = all.filter((c) => c.ambiguous).length;
  const cands = all.filter((c) => c.po_id != null);
  const lines = await listPoLinesForCost(cands.map((c) => c.po_id));
  const linesByPo = new Map();
  for (const l of lines) {
    const k = Number(l.po_id);
    if (!linesByPo.has(k)) linesByPo.set(k, []);
    linesByPo.get(k).push(l);
  }
  // One preset per (PO, supplier name) — the same pair of facts receiving asks with.
  const presets = new Map();
  const presetFor = async (poId, supplier) => {
    const k = `${poId}|${String(supplier || '').trim().toLowerCase()}`;
    if (!presets.has(k)) presets.set(k, (await presetForShipment({ poId, supplierName: supplier || '' })).preset);
    return presets.get(k);
  };

  const groups = new Map();      // "cost|shelf|poCode|preset" -> { ids, cost, shelf, ... }
  let noLine = 0;
  const noPresetBy = new Map();  // "poCode|supplier" -> { poCode, supplier, pairs }
  const noLineSkus = new Map();  // a sample of what the POs don't price, for the screen
  for (const c of cands) {
    const poLines = linesByPo.get(Number(c.po_id)) || [];
    // The pair's own label: the po_box whose tracking number is this box's.
    const own = c.tracking ? poLines.find((l) => l.tracking && l.tracking === c.tracking) : null;
    const m = poLineMoney(poLines, c.sku, c.size, own ? own.po_box_id : null);
    if (!m) {
      noLine++;
      const k = `${c.sku} · ${c.size}`;
      noLineSkus.set(k, (noLineSkus.get(k) || 0) + 1);
      continue;
    }
    const poCode = poLines[0]?.po_code || `PO ${c.po_id}`;
    const preset = await presetFor(c.po_id, c.supplier_name);
    // No preset → no actual cost (shelf + preset IS the cost): skipped, and named per PO
    // and supplier so the fix — link a preset — is one step away.
    if (!preset) {
      const k = `${poCode}|${String(c.supplier_name || '').trim()}`;
      const r = noPresetBy.get(k) || { poCode, supplier: String(c.supplier_name || '').trim() || null, pairs: 0 };
      r.pairs++;
      noPresetBy.set(k, r);
      continue;
    }
    const cost = landedFromShelf(m.shelf, m.tip, preset);
    if (cost == null) { noLine++; continue; }
    const byTracking = c.by_tracking === true;
    const k = `${cost}|${m.shelf}|${poCode}|${preset?.id || ''}|${byTracking ? c.tracking : ''}`;
    if (!groups.has(k)) groups.set(k, { ids: [], cost, shelf: m.shelf, tip: m.tip, poCode, preset: preset?.name || null, byTracking, tracking: byTracking ? c.tracking : null });
    groups.get(k).ids.push(Number(c.id));
  }

  const list = [...groups.values()];
  const byPo = new Map();
  for (const g of list) {
    const r = byPo.get(g.poCode) || { poCode: g.poCode, pairs: 0, preset: g.preset, byTracking: 0 };
    r.pairs += g.ids.length;
    if (g.byTracking) r.byTracking += g.ids.length;
    byPo.set(g.poCode, r);
  }
  // Pairs the tracking match reached (fillable or not) are no longer "without a PO".
  const reachedByTracking = cands.filter((c) => c.by_tracking === true).length;
  return {
    groups: list,
    summary: {
      fillable: list.reduce((n, g) => n + g.ids.length, 0),
      noLine,
      noPreset: [...noPresetBy.values()].sort((a, b) => b.pairs - a.pairs),
      noPresetPairs: [...noPresetBy.values()].reduce((n, r) => n + r.pairs, 0),
      noPo: Math.max(0, (await countUncostedWithoutPo()) - reachedByTracking - ambiguous),
      byTracking: list.filter((g) => g.byTracking).reduce((n, g) => n + g.ids.length, 0),
      ambiguous,
      byPo: [...byPo.values()].sort((a, b) => b.pairs - a.pairs),
      noLineSample: [...noLineSkus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([k, n]) => ({ what: k, pairs: n })),
    },
  };
}

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
      const { summary } = await buildPlan();
      return send(res, 200, { ok: true, plan: summary });
    }
    const body = await getJsonBody(req);
    if (body.apply !== true) return send(res, 400, { ok: false, error: 'Nothing to do — preview with GET first.' });
    // Re-planned at the click, not taken from the preview: anything costed by hand in
    // between drops out (and fillItemsCost re-checks `cost IS NULL` row by row anyway).
    const plan = await buildPlan();
    let filled = 0;
    for (const g of plan.groups) {
      const how = `${money(g.shelf)} shelf through the “${g.preset}” preset`;
      // Said in the note when the batch was never linked: the PO was found by the parcel's
      // tracking number, so whoever reads the history can check that match.
      const via = g.byTracking ? ` — batch not linked to the PO; matched by tracking ${g.tracking}` : '';
      filled += await fillItemsCost(g.ids, g.cost, g.shelf,
        `Cost filled from ${g.poCode}: ${money(g.cost)} landed (${how})${via}`, user.username);
    }
    return send(res, 200, { ok: true, filled, plan: plan.summary });
  } catch (e) {
    console.error('[items/cost-backfill]', e.message);
    return send(res, 500, { ok: false, error: 'Could not work out the costs from the POs.' });
  }
}
