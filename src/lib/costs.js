// Costs page domain logic. `items.cost` is written once, at intake — suppliers
// routinely leave cost off a manifest, so pairs land with nothing on file and
// nothing in the app could fill it in afterwards.
import { sizeNum } from './codes.js';

// Group flat item rows into one card per BATCH + SKU, with a row per size inside.
//
// The batch is part of the key on purpose: one amount covers every pair of that size
// in that shipment, and the same shoe bought again next month may well have cost
// something different. Merging batches would quietly overwrite the older shipment's
// price with the newer one's.
export function groupCostRows(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const key = `${r.batch_id ?? 'none'}|#|${r.sku || ''}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        batch_id: r.batch_id ?? null,
        batch_code: r.batch_code || null,
        supplier_name: r.supplier_name || null,
        kind: r.kind || null,
        sku: r.sku || '',
        name: r.name || '',
        colorway: r.colorway || '',
        date_received: r.date_received || null,
        created_at: r.created_at,
        created_by: r.created_by || null,
        qty: 0,
        _sizes: new Map(),
      };
      map.set(key, g);
    }
    g.qty += 1;
    if (r.created_at < g.created_at) g.created_at = r.created_at;
    if (!g.name && r.name) g.name = r.name;
    const sz = r.size || '—';
    let s = g._sizes.get(sz);
    if (!s) {
      s = { size: sz, gender: r.gender || null, vins: [], qty: 0, cost: null, _costs: new Set() };
      g._sizes.set(sz, s);
    }
    s.vins.push(r.vin);
    s.qty += 1;
    // First non-null wins for display; `_costs` catches the case where two pairs of
    // one size disagree, which the row marks with "~" rather than picking a winner.
    if (s.cost == null && r.cost != null) s.cost = r.cost;
    s._costs.add(r.cost == null ? '' : String(r.cost));
  }
  return [...map.values()].map((g) => ({
    ...g,
    missing: [...g._sizes.values()].reduce((n, s) => n + (s.cost == null ? s.qty : 0), 0),
    sizes: [...g._sizes.values()]
      .sort((a, b) => (sizeNum(a.size) - sizeNum(b.size)) || String(a.size).localeCompare(b.size))
      .map((s) => ({
        size: s.size, gender: s.gender, vins: s.vins, qty: s.qty,
        cost: s.cost, costMixed: s._costs.size > 1,
      })),
  }));
}

// What goes in a size row's input when the card opens: the cost already on file, or
// blank. Blank must round-trip as blank — saving it clears the cost to "unknown",
// which is a different claim from $0 and must never become one.
export const costFieldValue = (s) => (s.cost == null ? '' : String(s.cost));

// A row is worth saving only if the typed value actually differs from what's stored.
// Compared numerically so "95" and "95.00" don't read as an edit — otherwise every
// card would offer to save the moment it rendered.
export function costChanged(draft, stored) {
  const d = String(draft ?? '').trim();
  const hasDraft = d !== '';
  const hasStored = stored != null;
  if (!hasDraft && !hasStored) return false;
  if (hasDraft !== hasStored) return true;
  return Math.abs(Number(d) - Number(stored)) >= 0.005;
}

/* ------------------------- Receiving: cost per shoe ------------------------- */
// Receiving used to carry ONE cost for the whole batch ("Default cost") and stamp it
// on every pair, so fifteen SKUs at fifteen prices meant fifteen trips to the Costs
// page afterwards. A shoe in the cart can now carry its own cost, and a pair received
// against a PO inherits what the supplier declared for that size. Resolution order,
// most specific first:
//   typed on the shoe card  →  the PO line for that SKU + size  →  the batch default
// Blank at every level stays blank (NULL, "not known"): a missing number is never
// turned into $0 here, the same rule `toCost` enforces on the server (intake.js).

// A typed cost as a number, or null for blank / not a number / negative. Negative is
// nulled rather than kept because the server rejects it outright (receiving.md) — the
// card reads "no cost" and the person types it again, instead of a 400 at commit.
export function costOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const bareSku = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

// What the supplier declared this SKU + size cost on the PO, or null. Matched on the
// code with spaces/dashes stripped and on the NUMERIC size ("9.5W" is "9.5" — the
// reconciliation learned this the hard way, po-reconciliation-notation-matching).
// A line for the box being received wins over the same SKU + size declared on another
// label; a whole-order (Path C) manifest has no box on its lines, so it matches too.
export function poLineCost(lines, sku, size, poBoxId = null) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const want = bareSku(sku);
  if (!want) return null;
  const n = sizeNum(size);
  let any = null;
  for (const l of lines) {
    if (bareSku(l.sku) !== want) continue;
    const ln = sizeNum(l.size);
    if (!(Number.isNaN(n) && Number.isNaN(ln)) && ln !== n) continue;
    const c = costOrNull(l.unit_cost);
    if (c == null) continue;
    if (poBoxId != null && Number(l.po_box_id) === Number(poBoxId)) return c;
    if (any == null) any = c;
  }
  return any;
}

// The cost a unit is committed with. `shoeCost` is what was typed on the card,
// `poCost` what the PO declared for the size, `defaultCost` the batch header.
export function unitCost(shoeCost, poCost, defaultCost) {
  return costOrNull(shoeCost) ?? costOrNull(poCost) ?? costOrNull(defaultCost);
}
