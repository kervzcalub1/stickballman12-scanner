// Shopify Listings — the pure half (docs/context/shopify-listings.md).
//
// The page holds the store as pulled (variants), groups it into products, and keeps the
// person's edits as DRAFTS beside it — nothing is written until Save, and the save
// payload carries the value each field had when they looked (`old…`) so the server can
// refuse to overwrite anything Shopify changed in the meantime.
//
// Repricing sets a size to market + markup in BOTH directions (owner, 2026-10-07).
import { cacheKey, repriceDollars, priceCents } from './ebayReprice.js';
import { compareSizes } from './codes.js';

// A suggestion this far from today's price (either way) is a "big swing" — usually a
// wrong style code pricing the shoe off some other shoe — and bulk "use suggested"
// leaves it out.
export const BIG_SWING = 0.5;
export const STATUSES = [['ACTIVE', 'Active'], ['DRAFT', 'Draft'], ['ARCHIVED', 'Archived']];

const codesOf = (style) => String(style || '').split('/').map((p) => p.trim()).filter(Boolean);
export const inStock = (v) => v.qty == null || v.qty > 0;
export const priceable = (v) => !!v.style && /\d/.test(v.size || '');

// Variants → products, sizes in size order, products in title order.
export function groupProducts(variants) {
  const by = new Map();
  for (const v of variants) {
    let p = by.get(v.productId);
    if (!p) {
      p = { productId: v.productId, title: v.productTitle, status: v.status, style: v.style, image: v.image, handle: v.handle, variants: [] };
      by.set(v.productId, p);
    }
    p.variants.push(v);
  }
  for (const p of by.values()) p.variants.sort((a, b) => compareSizes(a.size, b.size));
  return [...by.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// Every search word must appear in the title, style code or a size's SKU.
export function productMatches(p, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${p.title} ${p.style || ''} ${p.variants.map((v) => v.sku).join(' ')}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// The (style code, size) lookups these variants need — one per code of a multi-code style.
export function jobsFor(variants) {
  const seen = new Map();
  for (const v of variants) {
    if (!priceable(v)) continue;
    for (const code of codesOf(v.style)) seen.set(cacheKey(code, v.size), { sku: code, size: v.size });
  }
  return [...seen.values()];
}

// What the market says about one size at this markup:
//   { state: 'no_style' | 'not_priced' | 'no_data' | 'ok', marketCents, suggestedCents, diffCents, kind, big }
// `kind` = 'lower' | 'raise' | 'same' against `priceText` (the draft price if there is
// one, else Shopify's).
export function suggestion(v, cache, pctH, priceText = v.price) {
  if (!priceable(v)) return { state: 'no_style' };
  const quotes = codesOf(v.style).map((c) => [c, cache[cacheKey(c, v.size)]]);
  if (quotes.some(([, q]) => !q)) return { state: 'not_priced' };
  const priced = quotes.filter(([, q]) => q.status === 'ok' && q.valueCents != null);
  if (!priced.length) return { state: 'no_data', why: quotes.map(([c, q]) => `${c}: ${q.status.replace('_', ' ')}`).join('; ') };
  if (pctH == null) return { state: 'not_priced' };
  const [code, best] = priced.reduce((a, b) => (b[1].valueCents < a[1].valueCents ? b : a));
  const suggestedCents = repriceDollars(best.valueCents, pctH) * 100;
  const now = priceCents(priceText);
  const diffCents = now == null ? null : suggestedCents - now;
  const kind = diffCents == null ? 'raise' : diffCents < 0 ? 'lower' : diffCents > 0 ? 'raise' : 'same';
  return { state: 'ok', code, marketCents: best.valueCents, suggestedCents, diffCents, kind,
    big: diffCents != null && kind !== 'same' && now > 0 && Math.abs(diffCents) / now > BIG_SWING };
}

const dollarsText = (cents) => (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));
export const centsToPrice = (c) => (c / 100).toFixed(2);

/* -------------------------------- drafts -------------------------------- */
// drafts = { variants: { [variantId]: { price?, compareAt?, source?, marketCents? } },
//            products: { [productId]: { title?, status? } } }
// A field equal to Shopify's value is not a draft — editing back removes it.
export const emptyDrafts = () => ({ variants: {}, products: {} });

const sameMoney = (a, b) => priceCents(a ?? '') === priceCents(b ?? '') || ((a ?? '') === '' && (b ?? '') === '');

export function setVariantDraft(drafts, v, patch) {
  const cur = { ...(drafts.variants[v.variantId] || {}), ...patch };
  if ('price' in cur && sameMoney(cur.price, v.price)) { delete cur.price; delete cur.source; delete cur.marketCents; }
  if ('compareAt' in cur && sameMoney(cur.compareAt, v.compareAt)) delete cur.compareAt;
  const variants = { ...drafts.variants };
  if (Object.keys(cur).some((k) => k === 'price' || k === 'compareAt')) variants[v.variantId] = cur; else delete variants[v.variantId];
  return { ...drafts, variants };
}

export function setProductDraft(drafts, p, patch) {
  const cur = { ...(drafts.products[p.productId] || {}), ...patch };
  if ('title' in cur && cur.title.trim() === p.title) delete cur.title;
  if ('status' in cur && cur.status === p.status) delete cur.status;
  const products = { ...drafts.products };
  if (Object.keys(cur).length) products[p.productId] = cur; else delete products[p.productId];
  return { ...drafts, products };
}

// Stage market + markup on every given size whose suggestion is a real, not-big change.
export function draftSuggested(drafts, variants, cache, pctH) {
  let d = drafts;
  let n = 0;
  for (const v of variants) {
    const s = suggestion(v, cache, pctH);
    if (s.state !== 'ok' || s.kind === 'same' || s.big) continue;
    d = setVariantDraft(d, v, { price: dollarsText(s.suggestedCents), source: 'market', marketCents: s.marketCents });
    n++;
  }
  return { drafts: d, staged: n };
}

// Counts + money for the save bar and the confirm dialog.
export function summarizeDrafts(drafts, variantsById) {
  const out = { prices: 0, cutCents: 0, raiseCents: 0, compareAt: 0, titles: 0, statuses: 0 };
  for (const [id, d] of Object.entries(drafts.variants)) {
    const v = variantsById.get(id);
    if (!v) continue;
    if ('price' in d) {
      out.prices++;
      const diff = (priceCents(d.price) ?? 0) - (priceCents(v.price) ?? 0);
      if (diff < 0) out.cutCents += diff; else out.raiseCents += diff;
    }
    if ('compareAt' in d) out.compareAt++;
  }
  for (const d of Object.values(drafts.products)) { if ('title' in d) out.titles++; if ('status' in d) out.statuses++; }
  out.total = out.prices + out.compareAt + out.titles + out.statuses;
  return out;
}

// Save payload chunks (≤ 100 sizes, ≤ 50 products each), every field with what was SEEN.
export function savePayloads(drafts, variantsById, productsById, pctH) {
  const vs = Object.entries(drafts.variants).map(([id, d]) => {
    const v = variantsById.get(id);
    const row = { variantId: id, oldPrice: v.price, oldCompareAt: v.compareAt, productTitle: v.productTitle, style: v.style, size: v.size };
    if ('price' in d) Object.assign(row, { price: d.price, source: d.source || 'manual', marketCents: d.marketCents ?? null });
    if ('compareAt' in d) row.compareAt = d.compareAt === '' ? null : d.compareAt;
    return row;
  });
  const ps = Object.entries(drafts.products).map(([id, d]) => {
    const p = productsById.get(id);
    return { productId: id, oldTitle: p.title, oldStatus: p.status, ...('title' in d ? { title: d.title.trim() } : {}), ...('status' in d ? { status: d.status } : {}) };
  });
  const n = Math.max(Math.ceil(vs.length / 100), Math.ceil(ps.length / 50));
  const out = [];
  for (let k = 0; k < n; k++) out.push({ markupPctH: pctH, variants: vs.slice(k * 100, k * 100 + 100), products: ps.slice(k * 50, k * 50 + 50) });
  return out;
}
