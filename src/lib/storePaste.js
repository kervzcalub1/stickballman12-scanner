// Paste a store-by-store list into a store order (docs/store-orders-plan.md §4.2):
//
//   Store: AF #1234 Dallas
//   DZ5485-612 $110
//   8 x2
//   9 x3
//   Store: AF #2210 New Orleans
//   DZ5485-612 $110
//   10 x4
//
// A `Store:` line (also "Store - …", "Store #12") starts a block; everything under it until
// the next one belongs to that store. Each block is read ON ITS OWN by the ordinary PO paste
// (src/lib/poPaste.js) — run over the whole text, that parser merges the same SKU across
// stores and applies the LAST price to every pair, which is exactly the error the list
// exists to prevent. Blank `Store:` names and anything before the first `Store:` line are
// returned in `skipped`, never guessed at.
//
// The list is the invoice, so every SKU needs its price: unpriced ones come back in
// `unpriced`, and the caller refuses the paste until they're fixed.
import { parsePoPaste } from './poPaste.js';

// "Store: AF #1234", "Store - AF 1234", "Store #12", "Store 12" — never "Store Exclusive Dunk"
// (a shoe-name line), so a bare word after "Store" doesn't start a block.
const STORE_LINE = /^store\s*(?:[:\-–]\s*|(?=#)|\s(?=\d))(.*)$/i;

export const normStoreName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

export function parseStorePaste(text) {
  const blocks = [];
  const skipped = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/[​ ]/g, ' ').trim();
    if (!line) { if (cur) cur.text.push(''); continue; }
    const m = STORE_LINE.exec(line);
    if (m) {
      const name = normStoreName(m[1]);
      if (!name) { skipped.push({ line, why: 'a Store line with no name' }); cur = null; continue; }
      // The same store twice in one paste is one store (its blocks are read together).
      cur = blocks.find((b) => b.name.toLowerCase() === name.toLowerCase()) || null;
      if (!cur) { cur = { name, text: [] }; blocks.push(cur); }
      continue;
    }
    if (!cur) { skipped.push({ line, why: 'before any "Store:" line' }); continue; }
    cur.text.push(line);
  }
  const stores = [];
  const unpriced = [];
  let pairs = 0;
  let total = 0;
  for (const b of blocks) {
    const r = parsePoPaste(b.text.join('\n'));
    for (const s of r.skipped) skipped.push({ ...s, store: b.name });
    if (!r.shoes.length) { skipped.push({ line: `Store: ${b.name}`, why: 'a store with no shoes under it' }); continue; }
    for (const s of r.shoes) {
      if (s.unitCost == null) unpriced.push({ store: b.name, sku: s.sku });
      const n = s.sizes.reduce((k, z) => k + z.qty, 0);
      pairs += n;
      if (s.unitCost != null) total += n * s.unitCost;
    }
    stores.push({
      name: b.name,
      shoes: r.shoes,
      pairs: r.pairs,
      total: r.shoes.reduce((t, s) => t + (s.unitCost == null ? 0 : s.unitCost * s.sizes.reduce((k, z) => k + z.qty, 0)), 0),
    });
  }
  return { stores, skipped, unpriced, pairs, total: Math.round(total * 100) / 100 };
}

// Does the text look like a store list at all? (So the paste box can switch mode itself.)
export const looksLikeStorePaste = (text) => String(text || '').split(/\r?\n/).some((l) => STORE_LINE.test(l.trim()));
