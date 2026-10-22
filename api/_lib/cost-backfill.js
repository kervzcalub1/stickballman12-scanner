// The "fill costs from the POs" plan, shared by the admin-wide backfill
// (api/items/cost-backfill.js) and one order's "Fill costs from this order's list"
// (api/po/fill-costs.js). See cost-backfill.js for the rules; the store-order part
// (2026-10-23, store-orders-plan §4.4): the pair's own label is the one its box is TIED to
// (batch_boxes.po_box_id) before the one its tracking number reads as, and on a store
// order the price is that label's STORE's — a box tied to no store gets none.
import {
  listCostBackfillCandidates, countUncostedWithoutPo, listPoLinesForCost, listPoLabelsForCost,
  fillItemsCost, presetForShipment,
} from './db.js';
import { poLineMoney, landedFromShelf } from '../../src/lib/costs.js';

const money = (n) => `$${Number(n).toFixed(2)}`;

export async function buildCostPlan({ poId = null } = {}) {
  const everything = await listCostBackfillCandidates();
  // One order's fill: only pairs whose batch is linked to it (no tracking guesses).
  const all = poId == null ? everything : everything.filter((c) => Number(c.po_id) === Number(poId) && !c.by_tracking);
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
  const labels = await listPoLabelsForCost(cands.map((c) => c.po_id));
  const labelById = new Map(labels.map((l) => [Number(l.id), l]));
  const labelByTracking = new Map();   // "poId|TRACKING" -> label
  for (const l of labels) if (l.tracking) labelByTracking.set(`${l.po_id}|${l.tracking}`, l);
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
    // The pair's own label: the one its box is tied to, else the po_box whose tracking
    // number is this box's — the shared matcher.
    const own = (c.po_box_id != null ? labelById.get(Number(c.po_box_id)) : null)
      || (c.tracking ? labelByTracking.get(`${c.po_id}|${c.tracking}`) : null) || null;
    const byStore = own ? own.by_store === true : labels.some((l) => Number(l.po_id) === Number(c.po_id) && l.by_store === true);
    const m = poLineMoney(poLines, c.sku, c.size, own ? own.id : null,
      byStore ? (own?.po_store_id ?? null) : undefined);
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
      noPo: poId == null ? Math.max(0, (await countUncostedWithoutPo()) - reachedByTracking - ambiguous) : 0,
      byTracking: list.filter((g) => g.byTracking).reduce((n, g) => n + g.ids.length, 0),
      ambiguous,
      byPo: [...byPo.values()].sort((a, b) => b.pairs - a.pairs),
      noLineSample: [...noLineSkus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([k, n]) => ({ what: k, pairs: n })),
    },
  };
}

// Write a plan's groups, each with its history note.
export async function applyCostPlan(plan, by) {
  let filled = 0;
  for (const g of plan.groups) {
    const how = `${money(g.shelf)} shelf through the “${g.preset}” preset`;
    // Said in the note when the batch was never linked: the PO was found by the parcel's
    // tracking number, so whoever reads the history can check that match.
    const via = g.byTracking ? ` — batch not linked to the PO; matched by tracking ${g.tracking}` : '';
    filled += await fillItemsCost(g.ids, g.cost, g.shelf,
      `Cost filled from ${g.poCode}: ${money(g.cost)} landed (${how})${via}`, by);
  }
  return filled;
}
