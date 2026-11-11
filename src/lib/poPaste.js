// Paste a supplier's list into a purchase order's manifest (docs/context/purchase-orders.md
// → "Paste a list"). Suppliers send orders the way they send everything else:
//
//   DZ5485-201
//   8.5 x 2
//   9 x 3 $110             ← a price on a size line is THAT size's shelf price ea
//
//   IB4025-100 $120        ← a price on the SKU line is the price ea for every size under it
//   10 x 1
//
// = the Pre-sell Listings paste (src/lib/presellPaste.js — style code, optional name line,
// "size x qty" lines), so a list that pastes there pastes here, plus the PRICES suppliers
// write (see `takePrice`). Several shoes in one paste; the same SKU twice is ONE shoe with
// its sizes added together. Anything that isn't one of those is returned in `skipped` —
// never guessed at — and in this strict reader an unclear line ENDS the shoe above, so the
// sizes after it are refused rather than handed to the wrong SKU.
//
// A PO price is the SHELF price only ([[cost-is-shelf-plus-preset]]): what's read here is
// the number the supplier wrote per pair, nothing added.
import { SIZE_LINE, looksLikeStyle } from './presellPaste.js';

// "DZ5485 201" — the code typed with a space. Both halves need a digit, so "Dunk Low" isn't one.
const SPACED = /^((?=[A-Z0-9]*\d)[A-Z0-9]{5,8})\s+((?=[A-Z0-9]*\d)[A-Z0-9]{3})$/i;
const SKU_PREFIX = /^(?:sku|style(?:\s*(?:code|#|no\.?))?)\s*(?:[:#]\s*|\s+)/i;
// A style code and the shoe's name on one line: "DZ5485-201 Air Jordan 1 Low" (the name must
// start with a letter or a quote, so "DZ5485-201 9 x 2" is never read as one).
const SKU_NAME = /^([A-Z0-9]{2,}(?:-[A-Z0-9]{2,4})?)\s*(?:[-–—:|,]\s*)?\s((?:["'“‘(]|[A-Z]).*)$/i;
const BULLET = /^(?:[•·*▪◦]\s*|[-–—]\s+)/;

// Suppliers decorate: "$42.71 ✅", "✔️ 9 x 2", "*$120*" (WhatsApp bold), "❌". Ticks, crosses,
// emoji and WhatsApp's *bold* / _italic_ / ~strike~ markers carry nothing we read.
const DECOR = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0E}\u{FE0F}\u{20E3}]/gu;
export const clean = (raw) => String(raw ?? '')
  .replace(/[​‌‍﻿]/g, '').replace(DECOR, ' ').replace(/[  ]/g, ' ').trim()
  .replace(/^[*_~]+/, '').replace(/[*_~]+$/, '').trim();

// A style code on its own (optionally "SKU: …", or typed with a space), upper-cased; else null.
export function skuOf(text) {
  const t = clean(text).replace(SKU_PREFIX, '').trim();
  if (looksLikeStyle(t)) return t.toUpperCase();
  const s = SPACED.exec(t);
  return s ? `${s[1]}-${s[2]}`.toUpperCase() : null;
}

// "8.5 x 2", "US 9 - 3", "7W x 3 pairs" → { size, qty }; else null.
export function sizeLineOf(text) {
  // Also "Size 9 x 2", "Sz: 9 - 2" and "9 x 2 prs".
  const m = SIZE_LINE.exec(clean(text).replace(/^(?:size|sz)\s*[:#]?\s*(?=\d|us)/i, '').replace(/(\d)\s*prs?\.?$/i, '$1'));
  if (!m) return null;
  return { size: String(Number(m[1])) + (m[2] ? m[2].toUpperCase() : ''), qty: Number(m[3]) };
}

/* -------------------------------- prices -------------------------------- */

// A number as suppliers type money: 120 · 120.5 · 120.00 · 1,050 · 1,234.50
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.(\d{1,2}))?`;
const CUR = String.raw`(?:us\$|usd\s*|\$)`;
const CUR_AFTER = String.raw`(?:\s*(?:\$|usd|dollars?))`;
// "per pair" in all its spellings: 120 ea · 120 each · 120/pr · 120 per pair · 120 a pair · 120pp
const UNIT = String.raw`(?:\s*(?:\/\s*(?:pr|pair|ea|each)\b|ea\b\.?|each\b|per\s+(?:pair|pr)\b|a\s+pair\b|pp\b))`;
const KEY = String.raw`(?:unit\s*price|unit\s*cost|price\s*(?:ea(?:ch)?|per\s*pair)?|cost\s*(?:ea(?:ch)?)?|each|ea)`;
const TOTAL = String.raw`(?:total|ttl)`;
const SEP = String.raw`\s*[:=\-–]?\s*`;
// Tried in order on the END of a line; `rest` is what's in front of the price. Every shape
// carries a currency sign, a keyword or a unit — a bare number is never a price (it's a
// size, a quantity or part of a style code) — except a number with exactly two decimals,
// which no size or quantity is ever written as.
const PRICE_SHAPES = [
  { total: true, re: new RegExp(String.raw`^(.*?)(?:^|\s|[-–:|,=])${TOTAL}${SEP}${CUR}?\s*${NUM}${CUR_AFTER}?\s*$`, 'i') },
  { total: true, re: new RegExp(String.raw`^(.*?)(?:^|\s|[-–:|,=@])\s*(?:${CUR}\s*${NUM}${CUR_AFTER}?|${NUM}${CUR_AFTER})\s*${TOTAL}\s*$`, 'i') },
  { re: new RegExp(String.raw`^(.*?)(?:^|\s|[-–:|,=])${KEY}${SEP}${CUR}?\s*${NUM}${CUR_AFTER}?${UNIT}?\s*$`, 'i') },
  { re: new RegExp(String.raw`^(.*?)@${SEP}${CUR}?\s*${NUM}${CUR_AFTER}?${UNIT}?\s*$`, 'i') },
  { re: new RegExp(String.raw`^(.*?)${CUR}\s*${NUM}${CUR_AFTER}?${UNIT}?\s*$`, 'i') },
  { re: new RegExp(String.raw`^(.*?)(?:^|\s|[-–:|,=])${NUM}${CUR_AFTER}${UNIT}?\s*$`, 'i') },
  { re: new RegExp(String.raw`^(.*?)(?:^|\s|[-–:|,=])${NUM}${UNIT}\s*$`, 'i') },
  { re: new RegExp(String.raw`^(.*?)(?:^|\s|[-–:|,=])(\d{1,3}(?:,\d{3})+|\d{1,6})\.(\d{2})\s*$`, 'i') },
];
// "9 x 2 - 110": a dash and a number after the quantity. Only ever on a SIZE line (never
// after a style code, where "-201" is part of the code) and only ≥ $20 (no shoe is
// shelved for less, while "8 - 9 - 2"-style typos are small numbers).
const DASH_PRICE = /^(.*?)\s*[-–—]\s*(\d{2,5}(?:\.\d{1,2})?)\s*$/;

const amountOf = (whole, cents) => {
  const n = Number(String(whole).replace(/,/g, '') + (cents != null ? `.${cents}` : ''));
  return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.round(n * 100) / 100 : null;
};
const trimRest = (s) => s.replace(/[\s\-–—:@|,=/]+$/, '').trim();

// The price at the end of a line → { rest, amount, total }; null when there is none.
export function takePrice(text) {
  const line = clean(text);
  for (const { re, total } of PRICE_SHAPES) {
    const m = re.exec(line);
    if (!m) continue;
    const amount = amountOf(m[2] ?? m[4], m[2] != null ? m[3] : m[5]);
    if (amount == null) continue;
    return { rest: trimRest(m[1]), amount, total: !!total };
  }
  return null;
}

/* -------------------------- merging into shoes -------------------------- */

const round2 = (n) => Math.round(n * 100) / 100;

// Entries → shoes. An entry is one size of one shoe as read:
//   { sku, name, size, qty, price (that size's own), blockPrice (its SKU line's), from, line }
// The same SKU in two places is one shoe; the same SKU + size adds its quantities. A price on
// the SKU applies to every size of that SKU; a price on the size overrides it. Two different
// prices for one SKU + size can't be one manifest line, so the later one is refused.
export function mergeEntries(entries, skipped = []) {
  const bySku = new Map();
  for (const e of entries) {
    let s = bySku.get(e.sku);
    if (!s) { s = { sku: e.sku, name: e.name || '', blockPrices: new Map(), sizes: new Map() }; bySku.set(e.sku, s); }
    if (!s.name && e.name) s.name = e.name;
    if (e.blockPrice != null) s.blockPrices.set(e.blockPrice, e.blockFrom || null);
    const had = s.sizes.get(e.size);
    if (!had) { s.sizes.set(e.size, { size: e.size, qty: e.qty, price: e.price ?? null, from: e.price != null ? e.from || null : null, blockPrice: e.blockPrice ?? null, blockFrom: e.blockFrom || null }); continue; }
    const mine = e.price ?? e.blockPrice ?? null;
    const theirs = had.price ?? had.blockPrice ?? null;
    if (mine != null && theirs != null && mine !== theirs) {
      skipped.push({ line: e.line, row: e.row, why: `${e.sku} size ${e.size} is already listed at $${theirs.toFixed(2)} — one price per size` });
      continue;
    }
    had.qty += e.qty;
    if (had.price == null && e.price != null) { had.price = e.price; had.from = e.from || null; }
    if (had.blockPrice == null && e.blockPrice != null) { had.blockPrice = e.blockPrice; had.blockFrom = e.blockFrom || null; }
  }
  const shoes = [];
  for (const s of bySku.values()) {
    const sizes = [...s.sizes.values()];
    // One SKU-line price → it's the shoe's price. Two different ones (the same SKU in two
    // blocks at two prices) → each size keeps the price of the block it came from.
    let unitCost = null; let priceFrom = null;
    if (s.blockPrices.size === 1) { [[unitCost, priceFrom]] = [...s.blockPrices.entries()]; }
    const own = sizes.map((z) => {
      if (z.price != null) return { p: z.price, from: z.from };
      if (s.blockPrices.size > 1 && z.blockPrice != null) return { p: z.blockPrice, from: z.blockFrom };
      return null;
    });
    // Every size priced the same → that's the shoe's price, said once.
    if (own.length && own.every((o) => o) && new Set(own.map((o) => o.p)).size === 1) {
      unitCost = own[0].p; priceFrom = own.every((o) => o.from === 'total') ? 'total' : null;
      own.fill(null);
    }
    const shoe = {
      sku: s.sku,
      name: s.name,
      unitCost,
      sizes: sizes.map((z, i) => {
        const o = own[i];
        if (!o || o.p === unitCost) return { size: z.size, qty: z.qty };
        return o.from ? { size: z.size, qty: z.qty, unitCost: o.p, priceFrom: o.from } : { size: z.size, qty: z.qty, unitCost: o.p };
      }),
    };
    if (priceFrom && unitCost != null) shoe.priceFrom = priceFrom;
    shoes.push(shoe);
  }
  return shoes;
}

export const pairsOf = (shoes) => shoes.reduce((n, s) => n + s.sizes.reduce((k, z) => k + z.qty, 0), 0);
// What the list comes to at the prices read (sizes with no price count as $0, and say so).
export function listValue(shoes, typed = {}) {
  let total = 0; let unpriced = 0;
  for (const s of shoes) {
    const t = typed[s.sku];
    const base = t !== undefined && String(t).trim() !== '' && Number.isFinite(Number(t)) ? Number(t) : s.unitCost;
    for (const z of s.sizes) {
      const p = z.unitCost ?? base;
      if (p == null) unpriced += z.qty; else total += p * z.qty;
    }
  }
  return { total: round2(total), unpriced };
}

// One shoe → one entry per distinct price, each with a single unitCost and plain sizes —
// for a caller that takes one price per shoe (the store list).
export function splitByPrice(shoe) {
  const groups = new Map();
  for (const z of shoe.sizes) {
    const p = z.unitCost ?? shoe.unitCost ?? null;
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push({ size: z.size, qty: z.qty });
  }
  return [...groups.entries()].map(([p, sizes]) => ({ sku: shoe.sku, name: shoe.name, unitCost: p, sizes }));
}

/* -------------------------------- the paste ------------------------------- */

export function parsePoPaste(text) {
  const skipped = [];
  const totals = [];          // "Total $1,050" lines — checked against the list, never used as a price
  const blocks = [];
  let cur = null;
  const startShoe = (sku, name, pr, line) => {
    cur = { sku, name: name || '', price: pr && !pr.total ? pr.amount : null, total: pr?.total ? pr.amount : null, sizes: [], line };
    blocks.push(cur);
  };
  const addSize = (z, pr, line) => {
    if (!cur) { skipped.push({ line, why: blocks.length ? 'a size under a line that isn’t a style code' : 'a size before any style code' }); return; }
    if (!(z.qty >= 1)) { skipped.push({ line, why: 'quantity 0' }); return; }
    let price = null; let from = null;
    if (pr) { price = pr.total ? round2(pr.amount / z.qty) : pr.amount; from = pr.total ? 'total' : null; }
    cur.sizes.push({ ...z, price, from, line });
  };
  const unclear = (line, why = 'not a style code, a name, a price or “size x quantity”') => { skipped.push({ line, why }); cur = null; };
  // One shoe, one price ea. A second, DIFFERENT one (price above the SKU and another under
  // it, or on the SKU line too) is never settled by picking: the shoe is left unpriced and
  // the line is listed, so somebody types the right one.
  const setPrice = (shoe, amount, line) => {
    if (shoe.priceConflict) { skipped.push({ line, why: `another price for ${shoe.sku} — its price was left blank, type it in` }); return; }
    if (shoe.price == null) { shoe.price = amount; shoe.priceLine = line; return; }
    if (shoe.price === amount) return;
    skipped.push({ line, why: `two different prices for ${shoe.sku} ($${shoe.price.toFixed(2)} on “${shoe.priceLine}”, $${amount.toFixed(2)} here) — its price was left blank, type the right one` });
    shoe.price = null; shoe.priceConflict = true;
  };

  // Pass 1: what each line IS, on its own. The whole line first: a size or a style code is
  // never re-read for a price.
  const toks = String(text || '').split(/\r?\n/).map((raw) => {
    const line = clean(raw).replace(BULLET, '').trim();
    if (!line) return { t: 'blank' };
    const z = sizeLineOf(line);
    if (z) return { t: 'size', z, pr: null, line };
    const sku = skuOf(line);
    if (sku) return { t: 'sku', sku, name: '', pr: null, line };
    const pr = takePrice(line);
    if (pr) {
      const rest = pr.rest;
      if (!rest) return { t: pr.total ? 'total' : 'price', pr, line };
      const rz = sizeLineOf(rest);
      if (rz) return { t: 'size', z: rz, pr, line };
      const rs = skuOf(rest);
      if (rs) return { t: 'sku', sku: rs, name: '', pr, line };
      const rn = SKU_NAME.exec(rest.replace(SKU_PREFIX, ''));
      return { t: 'other', line, rest, pr, nameOk: !pr.total && /[a-z]{3}/i.test(rest), skuName: rn && looksLikeStyle(rn[1]) ? rn : null };
    }
    const d = DASH_PRICE.exec(line);
    if (d && Number(d[2]) >= 20) {
      const dz = sizeLineOf(d[1]);
      if (dz) return { t: 'size', z: dz, pr: { amount: Number(d[2]), total: false }, line };
    }
    const sn = SKU_NAME.exec(line.replace(SKU_PREFIX, ''));
    return { t: 'other', line, rest: line, pr: null, nameOk: true, skuName: sn && looksLikeStyle(sn[1]) ? sn : null };
  });
  const startsShoe = (tk) => tk && (tk.t === 'sku' || (tk.t === 'other' && tk.skuName));

  // Which side does a price on its own line belong to? Suppliers write it UNDER the code
  // ("DZ5485-201 / $120 ea / 9 x 2") or ABOVE it ("$42.71 ✅ / 900001-007 / 8 x 1", blocks
  // split by blank lines). The paste says which: its first lone price, sitting right above
  // a code with nothing of a shoe before it (start, or after a blank line), means "above".
  const firstPrice = toks.findIndex((tk) => tk.t === 'price');
  const above = firstPrice >= 0 && startsShoe(toks[firstPrice + 1])
    && (toks.slice(0, firstPrice).every((tk) => tk.t === 'blank' || tk.t === 'total') || toks[firstPrice - 1]?.t === 'blank');

  // Pass 2: attribute. `open` = the current shoe has had a line since the last blank one.
  let open = false;
  let pending = null;   // a price waiting for the code on the very next line
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'blank') { open = false; continue; }
    if (tk.t === 'total') { totals.push({ line: tk.line, amount: tk.pr.amount }); continue; }
    if (tk.t === 'price') {
      const nextIsShoe = startsShoe(toks[i + 1]);
      if (nextIsShoe && (!cur || !open || above)) pending = { amount: tk.pr.amount, line: tk.line };
      else if (cur && open && !nextIsShoe) setPrice(cur, tk.pr.amount, tk.line);
      else if (cur && open) skipped.push({ line: tk.line, why: `a price between ${cur.sku} and the next code — put it on the SKU’s line, or a blank line between the shoes` });
      else skipped.push({ line: tk.line, why: 'a price with no style code next to it' });
      continue;
    }
    const hold = pending; pending = null;
    if (tk.t === 'size') { addSize(tk.z, tk.pr, tk.line); open = !!cur; continue; }
    if (tk.t === 'sku') {
      startShoe(tk.sku, '', null, tk.line);
      if (hold) setPrice(cur, hold.amount, hold.line);
      if (tk.pr) { if (tk.pr.total) cur.total = tk.pr.amount; else setPrice(cur, tk.pr.amount, tk.line); }
      open = true; continue;
    }
    // 'other': the first plain line after a bare code (before any size) is the shoe's name
    // ("Air Jordan 1 Low — $120" too). Checked before "code + name" so a name that happens
    // to start like a code ("1906R Silver") stays a name.
    if (!hold && cur && !cur.name && !cur.sizes.length && tk.nameOk) {
      cur.name = tk.rest;
      if (tk.pr) setPrice(cur, tk.pr.amount, tk.line);
      open = true; continue;
    }
    if (tk.skuName) {
      startShoe(tk.skuName[1].toUpperCase(), tk.skuName[2].trim(), null, tk.line);
      if (hold) setPrice(cur, hold.amount, hold.line);
      if (tk.pr) { if (tk.pr.total) cur.total = tk.pr.amount; else setPrice(cur, tk.pr.amount, tk.line); }
      open = true; continue;
    }
    unclear(tk.line);
    open = false;
  }

  const entries = [];
  for (const b of blocks) {
    if (!b.sizes.length) { skipped.push({ line: b.line, why: 'a style code with no sizes under it' }); continue; }
    let blockPrice = b.price; let blockFrom = null;
    // "DZ5485-201 total $1,050" with its sizes under it → price ea = total ÷ its pairs.
    if (blockPrice == null && b.total != null) {
      blockPrice = round2(b.total / b.sizes.reduce((n, z) => n + z.qty, 0));
      blockFrom = 'total';
    }
    for (const z of b.sizes) entries.push({ sku: b.sku, name: b.name, size: z.size, qty: z.qty, price: z.price, from: z.from, blockPrice, blockFrom, line: z.line });
  }
  const shoes = mergeEntries(entries, skipped);
  return { shoes, skipped, totals, pairs: pairsOf(shoes) };
}
