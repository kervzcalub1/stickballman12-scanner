// Costs page domain logic. `items.cost` is written once, at intake — suppliers
// routinely leave cost off a manifest, so pairs land with nothing on file and
// nothing in the app could fill it in afterwards.
import { sizeNum, compareSizes, sizeLabel } from './codes.js';
import { estDate } from './format.js';
import { calcCostBreakdown } from './payout.js';

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
      .sort((a, b) => compareSizes(a.size, b.size))
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

// What the supplier declared for this SKU + size on the PO — `{ shelf, tip }`, or null.
// Since 2026-09-29 the line's `unit_cost` is the SHELF price (relabelled "Shelf price
// ea" on the manifest); the landed cost is worked out from it with the supplier's
// preset stack (`landedFromShelf`). Matched on the code with spaces/dashes stripped and
// on the NUMERIC size ("9.5W" is "9.5" — the reconciliation learned this the hard way,
// po-reconciliation-notation-matching). A line for the box being received wins over the
// same SKU + size declared on another label; a whole-order (Path C) manifest has no box
// on its lines, so it matches too.
//
// A STORE order (`storeId` passed, even as null): each store bought at its own price, so
// only the box's store's lines count — and a box tied to no store gets NO price rather
// than a guess at some other store's (store-orders-plan §8b).
export function poLineMoney(lines, sku, size, poBoxId = null, storeId = undefined) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const want = bareSku(sku);
  if (!want) return null;
  if (storeId === null) return null;
  const n = sizeNum(size);
  let any = null;
  for (const l of lines) {
    if (bareSku(l.sku) !== want) continue;
    if (storeId !== undefined && Number(l.po_store_id) !== Number(storeId)) continue;
    const ln = sizeNum(l.size);
    if (!(Number.isNaN(n) && Number.isNaN(ln)) && ln !== n) continue;
    const shelf = costOrNull(l.unit_cost);
    if (shelf == null) continue;
    const m = { shelf, tip: costOrNull(l.tip) };
    if (poBoxId != null && Number(l.po_box_id) === Number(poBoxId)) return m;
    if (any == null) any = m;
  }
  return any;
}

// The PO's shelf price for the size, or null.
export function poLineCost(lines, sku, size, poBoxId = null, storeId = undefined) {
  return poLineMoney(lines, sku, size, poBoxId, storeId)?.shelf ?? null;
}

// Shelf price → landed cost, through the SAME register maths as the Payout Calculator
// (calcCostBreakdown), so a received pair and a calculator line can never disagree.
// The tip is ALWAYS the preset's (owner's rule, 2026-10-08). A tip typed on the PO line
// used to win, so a line carrying $8 costed DZ2628-110 8W at $78.99 while the Payout
// Calculator with the same preset said $75.99 — the same pair, two costs. The line's tip
// is still kept on the PO (and passed in here), it just no longer prices the pair.
//
// NO PRESET → NULL, not the shelf price (2026-09-30, the owner's rule). What a supplier
// declares is only the shelf price; the actual cost is that shelf price PLUS the
// supplier's preset — tax, gift card, tip, shipping. Without the preset the actual cost
// is not known, and writing shelf + tip would put a number on the pair that looks
// landed but is short by the tax and shipping. Blank is the honest answer; link a
// preset to the supplier and the pair can be costed (Costs → Fill costs from POs).
// A pair from a BUYING REQUEST (`presetForShipment` adds `requestLines`) goes by that shoe's
// own approved line: its shelf price, and any premium tip approved for it on top of the
// request's. Pass `pair` ({ sku, size }) so it can be found.
export function landedFromShelf(shelf, _lineTip, preset, pair = null) {
  if (!preset) return null;
  const n = pair ? sizeNum(pair.size) : NaN;
  const own = pair && Array.isArray(preset.requestLines)
    ? preset.requestLines.find((l) => bareSku(l.sku) === bareSku(pair.sku)
      && ((Number.isNaN(n) && Number.isNaN(sizeNum(l.size))) || sizeNum(l.size) === n))
    : null;
  const s = costOrNull(own?.shelf ?? shelf);
  if (s == null) return null;
  const tip = (preset.tipAmt ?? 0) + (own?.tip || 0);
  const b = calcCostBreakdown({
    shelfPrice: s,
    storePct: preset?.storePct, promoPct: preset?.promoPct, giftPct: preset?.giftPct,
    cashbackPct: preset?.cashbackPct, taxPct: preset?.taxPct,
    tipAmt: tip, shippingAmt: preset?.shippingAmt,
  });
  return Math.round(b.finalCost * 100) / 100;
}

// A buying request's shipping: what its labels cost, shared across its pairs. Labels are only
// known when the buyer is about to ship, so before then there is no figure (null).
export function requestShipping({ perLabel, labels, pairs }) {
  const rate = Number(perLabel) || 0;
  const n = Number(labels) || 0;
  const p = Number(pairs) || 0;
  if (!n || !p) return null;
  const total = Math.round(rate * n * 100) / 100;
  return { total, each: (rate * n) / p };
}

// The cost a unit is committed with. `shoeCost` is what was typed on the card,
// `poCost` what the PO declared for the size, `defaultCost` the batch header.
export function unitCost(shoeCost, poCost, defaultCost) {
  return costOrNull(shoeCost) ?? costOrNull(poCost) ?? costOrNull(defaultCost);
}

// ── Costs page: filter by supplier + export (2026-11-20) ─────────────────────
// The supplier is the batch's (`batches.supplier_name`), filtered on the server
// (listItemsMissingCost). A pair with none (an in-store trip, a receive with no supplier
// typed) is its own choice in the list, not hidden. Same value as db.js COST_NO_SUPPLIER.
export const NO_SUPPLIER = '(none)';
const supKey = (s) => String(s || '').trim().toLowerCase();

// One row per SKU PER SUPPLIER, whatever the size and whatever shipment it came in on: the
// list someone takes away to find the costs. The supplier is part of the row because the
// same shoe from two suppliers has two costs, and it is what the upload maps a cost back by. Sizes ride along as one cell ("8 ×2 · 9.5 ×1").
// SKUs group with case/spaces/dashes ignored, the way the rest of the app matches them.
export function costExportRows(rows) {
  const bare = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const map = new Map();
  for (const r of rows || []) {
    const key = `${bare(r.sku) || `name:${supKey(r.name)}`}|#|${supKey(r.supplier_name)}`;
    let g = map.get(key);
    if (!g) {
      g = { sku: r.sku || '', name: r.name || '', colorway: r.colorway || '', pairs: 0,
            _sizes: new Map(), _sup: new Map(), _batches: new Set(), first: null, last: null };
      map.set(key, g);
    }
    g.pairs += 1;
    if (!g.name && r.name) g.name = r.name;
    if (!g.colorway && r.colorway) g.colorway = r.colorway;
    const label = sizeLabel(r.size, r.gender, r.name) || String(r.size || '').trim() || '?';
    const s = g._sizes.get(label);
    if (s) s.qty += 1; else g._sizes.set(label, { label, size: r.size || '', qty: 1 });
    const sk = supKey(r.supplier_name);
    if (sk && !g._sup.has(sk)) g._sup.set(sk, String(r.supplier_name).trim());
    if (r.batch_code) g._batches.add(r.batch_code);
    const day = r.created_at ? estDate(r.created_at) : '';
    if (day) {
      if (!g.first || day < g.first) g.first = day;
      if (!g.last || day > g.last) g.last = day;
    }
  }
  return [...map.values()]
    .map((g) => ({
      sku: g.sku, name: g.name, colorway: g.colorway, pairs: g.pairs,
      sizes: [...g._sizes.values()].sort((a, b) => compareSizes(a.size, b.size))
        .map((s) => `${s.label} ×${s.qty}`).join(' · '),
      suppliers: [...g._sup.values()].sort().join('; '),
      batches: [...g._batches].sort().join('; '),
      first: g.first || '', last: g.last || '',
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku) || a.name.localeCompare(b.name) || a.suppliers.localeCompare(b.suppliers));
}

// The CSV of exactly the rows on screen. `zero` = the "$0, check these" tab. The last
// column is left empty on purpose: it is where the cost gets written in.
export function costExportCsv(rows, { zero = false } = {}) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['SKU', 'Name', 'Colorway', zero ? 'Pairs at $0' : 'Pairs without a cost', 'Sizes',
    'Supplier', 'Batch', 'First received (EST)', 'Last received (EST)', 'Cost per pair'];
  const body = costExportRows(rows).map((r) =>
    [r.sku, r.name, r.colorway, r.pairs, r.sizes, r.suppliers, r.batches, r.first, r.last, '']);
  return '﻿' + [head, ...body].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// ── Upload the filled CSV back (2026-11-20) ──────────────────────────────────
// The export leaves "Cost per pair" empty; someone fills it in a spreadsheet and the
// file comes back. One cost per SKU + supplier (the file's Supplier column), for every size
// and shipment of it the filters hold. An empty Supplier cell means the pairs that have no
// supplier. A file with no Supplier column at all fills the SKU whoever it came from.
// A SKU as a key: letters and digits only, upper case.
export const skuKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const COST_IMPORT_MAX = 3000;
const MAX_IMPORT_COST = 100000;

// RFC 4180: quoted commas, "" escapes, CRLF or LF. Excel also saves with ";" in some
// regions, so the separator is whichever the header row uses.
function csvRows(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const head = s.slice(0, s.search(/[\r\n]|$/));
  const sep = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === sep) { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/**
 * Read a filled-in export. → { error } or { rows: [{ sku, supplier, cost }], bySupplier, skipped: [{ sku, why }], blank }
 *   bySupplier — the file has a Supplier column, so each cost goes to that supplier's pairs only;
 *   rows    — SKUs with a usable cost (what is sent to the server);
 *   skipped — a row that has something in the cost cell we will not use, and why;
 *   blank   — rows whose cost cell is still empty (not a problem: not filled in yet).
 */
export function readCostImport(text) {
  const all = csvRows(text).filter((r) => r.some((c) => String(c).trim() !== ''));
  if (!all.length) return { error: 'That file is empty.' };
  const head = all[0].map((h) => String(h).trim().toLowerCase());
  const skuAt = head.indexOf('sku');
  const costAt = head.findIndex((h) => h === 'cost per pair' || h === 'cost');
  if (skuAt < 0 || costAt < 0) return { error: 'This isn’t the Costs export: it needs a “SKU” column and a “Cost per pair” column. Use Export CSV, fill in the last column, and upload that file.' };
  const supAt = head.indexOf('supplier');
  const bySupplier = supAt >= 0;
  const seen = new Map(); const skipped = []; let blank = 0;
  for (const r of all.slice(1)) {
    const sku = String(r[skuAt] ?? '').trim();
    const raw = String(r[costAt] ?? '').trim();
    if (raw === '') { blank += 1; continue; }
    if (!skuKey(sku)) { skipped.push({ sku: sku || '(no SKU)', why: 'no SKU on this row' }); continue; }
    const n = Number(raw.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) { skipped.push({ sku, why: `“${raw}” is not an amount` }); continue; }
    if (n === 0) { skipped.push({ sku, why: '$0 is not filled in bulk. If the pair really was free, type 0 on the page' }); continue; }
    if (n > MAX_IMPORT_COST) { skipped.push({ sku, why: `$${raw} looks wrong` }); continue; }
    const cost = Math.round(n * 100) / 100;
    const supplier = bySupplier ? String(r[supAt] ?? '').trim() : '';
    const key = `${skuKey(sku)}|${supKey(supplier)}`;
    const had = seen.get(key);
    if (had && had.cost !== cost) { had.clash = true; continue; }
    if (!had) seen.set(key, { sku, supplier, cost, clash: false });
  }
  const rows = [];
  for (const v of seen.values()) {
    if (v.clash) skipped.push({ sku: v.sku, why: `the file has this SKU${v.supplier ? ` from ${v.supplier}` : ''} twice with two different costs` });
    else rows.push({ sku: v.sku, supplier: v.supplier, cost: v.cost });
  }
  if (rows.length > COST_IMPORT_MAX) return { error: `That file fills ${rows.length} SKUs. Upload at most ${COST_IMPORT_MAX} at a time.` };
  return { rows, bySupplier, skipped, blank };
}
