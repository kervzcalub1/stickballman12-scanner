// Cost lookup — "what did this shoe cost us?" across every way we buy it
// (docs/context/costs.md → "Cost lookup").
//
// Two sources, one row shape, so they sit in one spreadsheet:
//   · supplier PO lines   — the shelf price the supplier declared, turned into the landed
//                           cost with the supplier's preset (`landedFromShelf`, the same
//                           code receiving and "Fill costs from POs" use);
//   · online order lines  — the actual cost per pair `orderCosts` works out (coupon, tax,
//                           shipping share, gift card %, cashback %).
// Row: { source: 'po'|'online', ref, party, bought_on ('YYYY-MM-DD', EST), sku, name,
//        size, gender, qty, paid, cost, note, status }
// `paid` is the price on the order (shelf / unit price); `cost` is what one pair cost us,
// or null when it can't be known (no price on the PO, or no preset for the supplier) —
// blank is not $0 (costs.md).
//
// Pure: the API uses `codeMatches` to pick the online lines, the screen uses the rest.

import { toCsv } from './manifestCsv.js';
import { sizeNum } from './codes.js';

export const bareCode = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

// A line matches the search when its SKU contains the code (spaces/dashes ignored, so
// "DZ5485 612" finds "DZ5485-612") or its NAME contains the words as typed.
export function codeMatches(q, sku, name) {
  const term = String(q || '').trim();
  if (!term) return true;
  const bare = bareCode(term);
  if (bare && bareCode(sku).includes(bare)) return true;
  return String(name || '').toUpperCase().includes(term.toUpperCase());
}

export const SOURCE_LABEL = { po: 'Supplier PO', online: 'Online order' };

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Size keys: numeric when there is a number ("10W" ≡ "10", like a PO line match),
// else the text itself.
const sizeKey = (s) => {
  const n = sizeNum(s);
  return Number.isNaN(n) ? String(s || '').trim().toUpperCase() : String(n);
};

// One row per SKU + size: the latest cost (newest purchase that has one), the range,
// the average per pair (weighted by quantity) and how many pairs that covers. Rows with
// no cost count toward `pairs` but never toward the figures — a blank is not a $0.
export function sizeSummary(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const k = `${bareCode(r.sku)}|${sizeKey(r.size)}`;
    if (!by.has(k)) by.set(k, { key: k, sku: r.sku, name: r.name, size: r.size, gender: r.gender, pairs: 0, costedPairs: 0, total: 0, min: null, max: null, latest: null, latestOn: null, latestSource: null, sources: new Set() });
    const g = by.get(k);
    const q = Number(r.qty) || 0;
    g.pairs += q;
    g.sources.add(r.source);
    if (!g.name && r.name) g.name = r.name;
    const c = num(r.cost);
    if (c == null) continue;
    g.costedPairs += q;
    g.total += c * q;
    g.min = g.min == null ? c : Math.min(g.min, c);
    g.max = g.max == null ? c : Math.max(g.max, c);
    if (g.latestOn == null || String(r.bought_on || '') > g.latestOn) {
      g.latest = c; g.latestOn = String(r.bought_on || ''); g.latestSource = r.source;
    }
  }
  return [...by.values()]
    .map((g) => ({ ...g, sources: [...g.sources], avg: g.costedPairs ? Math.round((g.total / g.costedPairs) * 100) / 100 : null }))
    .sort((a, b) => bareCode(a.sku).localeCompare(bareCode(b.sku))
      || (sizeNum(a.size) - sizeNum(b.size)) || String(a.size).localeCompare(String(b.size)));
}

// Spreadsheet sort. Blank money sorts last in either direction, so "cheapest first"
// never opens on a page of unknowns.
export function sortCostRows(rows, key = 'bought_on', dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  const money = key === 'paid' || key === 'cost' || key === 'qty';
  return [...(rows || [])].sort((a, b) => {
    if (money) {
      const x = num(a[key]); const y = num(b[key]);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sign;
    }
    if (key === 'size') {
      const d = (sizeNum(a.size) - sizeNum(b.size)) * sign;
      if (d) return d;
    }
    const d = String(a[key] ?? '').localeCompare(String(b[key] ?? ''), undefined, { numeric: true }) * sign;
    return d || String(b.bought_on || '').localeCompare(String(a.bought_on || ''));
  });
}

const money2 = (v) => (num(v) == null ? '' : num(v).toFixed(2));

const COLS = [
  ['bought_on', 'Bought (EST)'], ['source', 'Source'], ['ref', 'Order'], ['party', 'Supplier / store'],
  ['sku', 'SKU'], ['name', 'Shoe'], ['size', 'Size'], ['qty', 'Pairs'],
  ['paid', 'Price paid ea'], ['cost', 'Actual cost ea'], ['status', 'Status'], ['note', 'Note'],
];

// One row = one purchase line, every column filled, so it sorts and pivots. A blank cost
// stays an empty cell (SUM() and AVERAGE() skip it) rather than a 0.
export function costLookupCsv(rows) {
  return toCsv(COLS, (rows || []).map((r) => ({
    ...r, source: SOURCE_LABEL[r.source] || r.source, paid: money2(r.paid), cost: money2(r.cost),
  })));
}
