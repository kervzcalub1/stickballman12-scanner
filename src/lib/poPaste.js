// Paste a supplier's list into a purchase order's manifest (docs/context/purchase-orders.md
// → "Paste a list"). Suppliers send orders the way they send everything else:
//
//   DZ5485-201
//   8.5 x 2
//   9 x 3
//   9.5 x 4
//
//   IB4025-100 $120          ← optional shelf price ea, for every size under it
//   10 x 1
//
// = the Pre-sell Listings paste (src/lib/presellPaste.js — style code, optional name line,
// "size x qty" lines), so a list that pastes there pastes here. Several shoes in one paste;
// the same SKU twice is ONE shoe with its sizes added together. Anything that isn't one of
// those is returned in `skipped` — never guessed at.
import { parsePresellPaste } from './presellPaste.js';

// "DZ5485-201 $120", "DZ5485-201 @ 120", "DZ5485-201 - $120.50": the code and a price.
const PRICED = /^(?:sku[:\s]+)?([A-Z0-9]{2,}(?:[-\s][A-Z0-9]{2,4})?)\s*(?:[-–@:]\s*)?\$\s*(\d{1,5}(?:\.\d{1,2})?)\s*(?:ea(?:ch)?)?$/i;
// "DZ5485 201" — the code typed with a space. Both halves need a digit, so "Dunk Low" isn't one.
const SPACED = /^(?:sku[:\s]+)?((?=[A-Z0-9]*\d)[A-Z0-9]{5,8})\s+((?=[A-Z0-9]*\d)[A-Z0-9]{3})$/i;

export function parsePoPaste(text) {
  const price = new Map();   // SKU → shelf price ea typed on its line
  const lines = String(text || '').split(/\r?\n/).map((raw) => {
    const line = raw.replace(/[​ ]/g, ' ').trim();
    const p = PRICED.exec(line);
    if (p) {
      const sku = p[1].toUpperCase().replace(/\s+/, '-');
      price.set(sku, Number(p[2]));
      return sku;
    }
    const s = SPACED.exec(line);
    return s ? `${s[1]}-${s[2]}`.toUpperCase() : line;
  });
  const { shoes, skipped } = parsePresellPaste(lines.join('\n'), { strict: true });
  // The same SKU in two blocks (a supplier adds a size run they forgot) is one shoe.
  const bySku = new Map();
  for (const s of shoes) {
    const had = bySku.get(s.sku);
    if (!had) { bySku.set(s.sku, { sku: s.sku, name: s.name, sizes: s.sizes.map((z) => ({ ...z })), unitCost: price.get(s.sku) ?? null }); continue; }
    if (!had.name && s.name) had.name = s.name;
    for (const z of s.sizes) {
      const same = had.sizes.find((x) => x.size === z.size);
      if (same) same.qty += z.qty; else had.sizes.push({ ...z });
    }
  }
  const out = [...bySku.values()];
  return { shoes: out, skipped, pairs: out.reduce((n, s) => n + s.sizes.reduce((k, z) => k + z.qty, 0), 0) };
}
