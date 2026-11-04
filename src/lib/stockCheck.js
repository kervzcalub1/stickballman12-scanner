// Stock Check (docs/context/inventory.md "Stock Check"): scan a box or a VIN and get ONE
// answer — "Size 10 · Shopify has 3 for sale" and, for a VIN, "this pair is / is not in
// inventory". Then count a size: scan every pair of it you can find, and the tally says
// matched / short / extra against Shopify's number. Pure helpers; the server and the
// screen both use them.
//
// Shopify's number, not ours, is the "how many" — Nikki → II → Shopify → every platform,
// so Shopify is what we sell against (shopify-is-the-bridge). Our own record answers only
// the VIN question: is THIS pair still ours, or was it sold / shipped / removed.
//
// Shopify's "committed" quantity is deliberately NOT used: GOAT and StockX orders are never
// marked fulfilled in Shopify (24,222 orders before 2026-10-20 still read unfulfilled), so
// "committed" only ever grows and says nothing about what is on the shelf.
import { sizeKey } from './shopifyCheck.js';
import { statusLabel } from '../statuses.js';

// The pair's own answer, from its record. `events` = item_events, oldest first.
// tone: 'in' | 'out' | 'warn'.
export function pairVerdict(item, events = []) {
  if (!item) return null;
  const st = item.status;
  // When it reached the status it is in now — the last change TO that status.
  const when = [...events].reverse().find((e) => e.type === 'status_change' && e.details?.status === st)?.created_at || null;
  const shelf = item.location_label || item.location_code || null;
  if (st === 'sold' || st === 'shipped')
    return { tone: 'out', inInventory: false, headline: 'Not in inventory', detail: `Marked ${statusLabel(st)}`, when };
  if (st === 'used')
    return { tone: 'out', inInventory: false, headline: 'Not in inventory', detail: 'An empty box already put on a pair', when };
  if (st === 'missing')
    return { tone: 'warn', inInventory: false, headline: 'Marked missing', detail: 'You’ve found it — tell the office so it can be set back to In Stock', when };
  if (st === 'pre_sold')
    return { tone: 'warn', inInventory: true, headline: 'In inventory — pre-sold', detail: 'Already sold before it landed; held for its order', when, shelf };
  if (st === 'issue')
    return { tone: 'warn', inInventory: true, headline: 'In inventory — on hold', detail: 'An open Inbound Issue is holding it', when, shelf };
  return { tone: 'in', inInventory: true, headline: 'In inventory', detail: statusLabel(st), when, shelf };
}

// What Shopify holds for ONE size, across the listings actually for sale (ACTIVE).
// `products` = shopifyHoldings(...). An oversold negative counts as 0 for sale.
// listed=false: no active listing carries that size at all (which is 0 for sale, said so).
export function shopifyForSize(products = [], size) {
  const k = sizeKey(size);
  let qty = 0; let listed = false; let inactive = 0;
  for (const p of products) {
    for (const z of p.sizes || []) {
      if (sizeKey(z.size) !== k) continue;
      if (p.status === 'ACTIVE') { listed = true; if (z.qty > 0) qty += z.qty; }
      else if (z.qty > 0) inactive += z.qty;
    }
  }
  return { qty, listed, inactive };
}

// Every size on an ACTIVE listing, merged across listings, in shoe order.
export function shopifySizes(products = []) {
  const by = new Map();
  for (const p of products) {
    if (p.status !== 'ACTIVE') continue;
    for (const z of p.sizes || []) {
      const k = sizeKey(z.size);
      if (!by.has(k)) by.set(k, { size: z.size, qty: 0 });
      if (z.qty > 0) by.get(k).qty += z.qty;
    }
  }
  const num = (s) => { const m = String(s).match(/[\d.]+/); return m ? parseFloat(m[0]) : Infinity; };
  return [...by.values()].sort((a, b) => num(a.size) - num(b.size) || String(a.size).localeCompare(String(b.size)));
}

// The same shoe and size? Codes compare without dashes/spaces/case ("DD1391-100" ≡
// "dd1391100"); sizes through sizeKey ("9 W" ≡ "9W").
const skuKey = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');
export const sameShoe = (a, b) => !!a && !!b && !!a.sku && skuKey(a.sku) === skuKey(b.sku) && sizeKey(a.size) === sizeKey(b.size);

// The count's result line. expected = Shopify's for-sale number (null = couldn't read it).
export function countResult(counted, expected) {
  if (expected == null) return { tone: 'warn', text: `Counted ${counted} — Shopify’s number couldn’t be read, so there is nothing to compare` };
  if (counted === expected) return { tone: 'in', text: `Matches — counted ${counted}, Shopify has ${expected}` };
  if (counted < expected) return { tone: 'out', text: `${expected - counted} short — counted ${counted}, Shopify has ${expected}` };
  return { tone: 'warn', text: `${counted - expected} extra — counted ${counted}, Shopify has ${expected}` };
}

// Whether a scan counts toward `count` (a stock_counts row). Decided by the SERVER
// (api/items/stock-check.js) — the browser never says what was counted. `r` is
// resolveStockCode's answer ({ kind, shoe, verdict }).
export function countDecision(count, r) {
  if (r.kind === 'sku') return { counted: false, note: 'a typed SKU is not a pair — scan the box or its VIN' };
  if (!r.shoe) return { counted: false, note: r.kind === 'vin' ? 'no pair wears this sticker' : 'couldn’t tell which shoe this is' };
  if (count.vin_only && r.kind !== 'vin') return { counted: false, note: 'this count is VINs only — scan the VIN sticker' };
  if (!sameShoe(r.shoe, count)) return { counted: false, note: `a different shoe: ${r.shoe.sku}${r.shoe.size ? ` size ${r.shoe.size}` : ''}` };
  // In her hand, so it counts — but a record that says it left is said, and flagged.
  if (r.verdict && !r.verdict.inInventory) return { counted: true, note: `our record says ${r.verdict.detail.toLowerCase()}` };
  return { counted: true, note: null };
}

// How a code reached the input: a scanner gun types the whole code in one burst (a few ms a
// character), a person doesn't. `ms` = first to last keystroke. A HINT, recorded beside
// each scan — a determined person can fake it, but it shows a count built by typing VINs
// off a list instead of scanning the pairs in front of them.
export function entryVia(length, ms, pasted = false) {
  if (pasted) return 'typed';
  if (length >= 6 && ms >= 0 && ms / Math.max(1, length - 1) < 30) return 'scanner';
  return 'typed';
}
