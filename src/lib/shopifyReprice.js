// Shopify Reprice — the pure half (docs/context/shopify-reprice.md). Unlike eBay Reprice
// this sets every variant to market + markup in BOTH directions (owner's call,
// 2026-10-07): a price above it is cut, a price below it is raised.
import { cacheKey, repriceDollars, priceCents } from './ebayReprice.js';

// A change bigger than this (either way) is flagged and left UNticked by default — a
// wrong style code prices a shoe off some other shoe, and the first sign is a huge swing.
export const BIG_SWING = 0.5;

const codesOf = (style) => String(style || '').split('/').map((p) => p.trim()).filter(Boolean);
export const inStock = (v) => v.qty == null || v.qty > 0;

// Every (style code, size) the pulled variants need priced.
export function jobsFromVariants(variants, { inStockOnly = true } = {}) {
  const seen = new Map();
  for (const v of variants) {
    if (inStockOnly && !inStock(v)) continue;
    if (!v.style || !/\d/.test(v.size)) continue;
    for (const code of codesOf(v.style)) seen.set(cacheKey(code, v.size), { sku: code, size: v.size });
  }
  return [...seen.values()];
}

// One row per variant with what would happen to it:
//   kind: 'lower' | 'raise' | 'same' | 'no_data' | 'no_style'
// `nextCents` / `diffCents` / `swing` are set when there is a market price; `market` is
// the cheapest of a multi-code style's codes, as on eBay.
export function planChanges(variants, cache, pctH, { inStockOnly = true } = {}) {
  const rows = [];
  for (const v of variants) {
    if (inStockOnly && !inStock(v)) continue;
    const oldCents = priceCents(v.price);
    const base = { ...v, oldCents };
    if (!v.style) { rows.push({ ...base, kind: 'no_style', why: 'No style code in the product title' }); continue; }
    const quotes = codesOf(v.style).map((c) => [c, cache[cacheKey(c, v.size)]]);
    const priced = quotes.filter(([, q]) => q?.status === 'ok' && q.valueCents != null);
    if (!priced.length || oldCents == null) {
      rows.push({ ...base, kind: 'no_data', why: oldCents == null ? 'Unreadable Shopify price' : quotes.map(([c, q]) => `${c}:${q?.status || 'not fetched'}`).join('; ') });
      continue;
    }
    const [code, best] = priced.reduce((a, b) => (b[1].valueCents < a[1].valueCents ? b : a));
    const nextCents = repriceDollars(best.valueCents, pctH) * 100;
    const diffCents = nextCents - oldCents;
    const kind = diffCents < 0 ? 'lower' : diffCents > 0 ? 'raise' : 'same';
    const swing = oldCents ? Math.abs(diffCents) / oldCents : 1;
    rows.push({ ...base, kind, marketCents: best.valueCents, marketCode: code, nextCents, diffCents, swing, big: kind !== 'same' && swing > BIG_SWING });
  }
  return rows;
}

// The rows a person would apply without looking twice: real changes, no big swings.
export const defaultSelected = (rows) => new Set(rows.filter((r) => (r.kind === 'lower' || r.kind === 'raise') && !r.big).map((r) => r.variantId));

const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
// What a run did, for the person's own records (the DB keeps the confirmed changes too).
export function changeLogText(rows, results, pctH) {
  const head = ['Product', 'Style', 'Size', 'Qty', 'Old price', 'Market', `New (x${(10000 + pctH) / 10000})`, 'Result', 'Note'];
  const byId = new Map(results.map((r) => [r.variantId, r]));
  const lines = rows.filter((r) => byId.has(r.variantId)).map((r) => {
    const x = byId.get(r.variantId);
    return [r.productTitle, r.style, r.size, r.qty ?? '', r.price, dollars(r.marketCents), dollars(r.nextCents), x.status, x.error || ''];
  });
  return '﻿' + [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
