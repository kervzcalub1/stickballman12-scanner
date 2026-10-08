// POST /api/shopify-listings/save
//   { markupPctH?, variants: [{ variantId, oldPrice, oldCompareAt, price?, compareAt?, source?,
//                              marketCents?, productTitle?, style?, size? }],            (≤ 100)
//     products: [{ productId, oldTitle, oldStatus, title?, status? }] }                 (≤ 50)
//   -> { ok, variants: [{ variantId, status, price?, compareAt?, error? }],
//        products: [{ productId, status, title?, statusValue?, error? }], code? }
// PH team (admin auto-allowed). Writes LIVE listing fields to Shopify
// (docs/context/shopify-listings.md).
//
// Each field carries the value the person SAW (`old…`). Shopify's current value is
// re-read first and a field that moved since the page loaded is skipped ('conflict') —
// never overwritten blind. A price marked `source: 'market'` must equal
// round_half_up(market × markup), recomputed here, so the audit's "market" claim is true.
// Every confirmed field change is logged to shopify_listing_edits.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { shopifyConfigured, shopifyListingState, shopifyUpdateVariants, shopifyUpdateProduct } from '../_lib/shopify.js';
import { insertShopifyListingEdits } from '../_lib/db.js';
import { repriceDollars } from '../../src/lib/ebayReprice.js';

const MAX_VARIANTS = 100;
const MAX_PRODUCTS = 50;
const STATUSES = ['ACTIVE', 'DRAFT', 'ARCHIVED'];
const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const PRODUCT_ID = /^gid:\/\/shopify\/Product\/\d+$/;
const MONEY = /^\d{1,6}(\.\d{1,2})?$/;
// Money as cents for comparing ("85" = "85.0" = "85.00"); null/"" = no value.
const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));
const money = (v) => (Number(v)).toFixed(2);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function readVariant(c, pctH) {
  const v = { variantId: String(c?.variantId || ''), oldPrice: c?.oldPrice ?? null, oldCompareAt: c?.oldCompareAt ?? null,
    source: c?.source === 'market' ? 'market' : 'manual', marketCents: c?.marketCents == null ? null : Number(c.marketCents),
    productTitle: String(c?.productTitle || '').slice(0, 300), style: String(c?.style || '').slice(0, 60), size: String(c?.size || '').slice(0, 20) };
  if (!VARIANT_ID.test(v.variantId)) return { error: 'Not a Shopify variant id.' };
  if (has(c, 'price')) {
    const p = String(c.price ?? '').trim();
    if (!MONEY.test(p) || Number(p) < 1 || Number(p) > 100000) return { error: `Price “${c.price}” isn’t between $1 and $100,000.` };
    v.price = money(p);
    if (v.source === 'market') {
      if (!Number.isInteger(v.marketCents) || v.marketCents < 1 || pctH == null) return { error: 'A market price needs the market value and the markup.' };
      if (cents(v.price) !== repriceDollars(v.marketCents, pctH) * 100) return { error: 'That price isn’t market + markup.' };
    }
  }
  if (has(c, 'compareAt')) {
    const p = c.compareAt == null ? '' : String(c.compareAt).trim();
    if (p !== '' && (!MONEY.test(p) || Number(p) > 100000)) return { error: `Compare-at “${c.compareAt}” isn’t a price.` };
    v.compareAt = p === '' || Number(p) === 0 ? null : money(p);
  }
  if (!has(v, 'price') && !has(v, 'compareAt')) return { error: 'Nothing to change.' };
  return { v };
}

function readProduct(c) {
  const p = { productId: String(c?.productId || ''), oldTitle: c?.oldTitle ?? null, oldStatus: c?.oldStatus ?? null };
  if (!PRODUCT_ID.test(p.productId)) return { error: 'Not a Shopify product id.' };
  if (has(c, 'title')) {
    const t = String(c.title ?? '').trim();
    if (!t || t.length > 255) return { error: 'A title needs 1–255 characters.' };
    p.title = t;
  }
  if (has(c, 'status')) {
    if (!STATUSES.includes(c.status)) return { error: 'Status must be Active, Draft or Archived.' };
    p.status = c.status;
  }
  if (!has(p, 'title') && !has(p, 'status')) return { error: 'Nothing to change.' };
  return { p };
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  const b = await getJsonBody(req);
  const pctH = b.markupPctH == null ? null : Number(b.markupPctH);
  if (pctH != null && (!Number.isInteger(pctH) || pctH < 0 || pctH > 10000)) return send(res, 400, { ok: false, error: 'Markup must be 0–100 %.' });
  const rawV = Array.isArray(b.variants) ? b.variants : [];
  const rawP = Array.isArray(b.products) ? b.products : [];
  if (!rawV.length && !rawP.length) return send(res, 400, { ok: false, error: 'Nothing to change.' });
  if (rawV.length > MAX_VARIANTS || rawP.length > MAX_PRODUCTS) return send(res, 400, { ok: false, error: `At most ${MAX_VARIANTS} sizes and ${MAX_PRODUCTS} products per call.` });
  const variants = [];
  const products = [];
  for (const c of rawV) { const r = readVariant(c, pctH); if (r.error) return send(res, 400, { ok: false, error: r.error }); variants.push(r.v); }
  for (const c of rawP) { const r = readProduct(c); if (r.error) return send(res, 400, { ok: false, error: r.error }); products.push(r.p); }
  if (!shopifyConfigured()) return send(res, 500, { ok: false, error: 'Shopify is not configured on the server.' });

  try {
    const now = await shopifyListingState(variants.map((v) => v.variantId), products.map((p) => p.productId));
    if (now.error) return send(res, 502, { ok: false, error: now.error, code: now.code });
    const outV = [];
    const outP = [];
    const audit = [];
    let code;
    const stopped = () => code === 'denied' || code === 'unauthorized';

    // Variants: keep only the fields that still match what the person saw.
    const byProduct = new Map();
    for (const v of variants) {
      const cur = now.variants.get(v.variantId);
      if (!cur) { outV.push({ variantId: v.variantId, status: 'missing', error: 'No longer in Shopify.' }); continue; }
      const moved = [];
      if (has(v, 'price') && cents(cur.price) !== cents(v.oldPrice)) moved.push(`price is now $${cur.price}`);
      if (has(v, 'compareAt') && cents(cur.compareAt) !== cents(v.oldCompareAt)) moved.push(`compare-at is now ${cur.compareAt ? `$${cur.compareAt}` : 'empty'}`);
      if (moved.length) { outV.push({ variantId: v.variantId, status: 'conflict', price: cur.price, compareAt: cur.compareAt, error: `Changed in Shopify since you loaded it — ${moved.join(', ')}.` }); continue; }
      const input = { id: v.variantId };
      if (has(v, 'price') && cents(v.price) !== cents(cur.price)) input.price = v.price;
      if (has(v, 'compareAt') && cents(v.compareAt) !== cents(cur.compareAt)) input.compareAtPrice = v.compareAt;
      if (Object.keys(input).length === 1) { outV.push({ variantId: v.variantId, status: 'same', price: cur.price, compareAt: cur.compareAt }); continue; }
      const list = byProduct.get(cur.productId) || [];
      list.push({ v, cur, input });
      byProduct.set(cur.productId, list);
    }
    for (const [productId, list] of byProduct) {
      if (stopped()) { for (const { v } of list) outV.push({ variantId: v.variantId, status: 'failed', error: 'Not attempted — Shopify refused the first change.' }); continue; }
      const r = await shopifyUpdateVariants(productId, list.map((x) => x.input));
      if (r.error) { code = code || r.code; for (const { v } of list) outV.push({ variantId: v.variantId, status: 'failed', error: r.error }); continue; }
      for (const { v, cur, input } of list) {
        const got = r.updated.get(v.variantId) || { price: input.price ?? cur.price, compareAt: has(input, 'compareAtPrice') ? input.compareAtPrice : cur.compareAt };
        outV.push({ variantId: v.variantId, status: 'updated', price: got.price, compareAt: got.compareAt });
        const base = { target: 'variant', refId: v.variantId, productId, productTitle: v.productTitle, style: v.style, size: v.size };
        if (input.price) audit.push({ ...base, field: 'price', oldValue: cur.price, newValue: input.price, source: v.source, marketCents: v.source === 'market' ? v.marketCents : null, markupPct: v.source === 'market' ? pctH / 100 : null });
        if (has(input, 'compareAtPrice')) audit.push({ ...base, field: 'compare_at', oldValue: cur.compareAt, newValue: input.compareAtPrice, source: 'manual' });
      }
    }

    // Products: title / status.
    for (const p of products) {
      const cur = now.products.get(p.productId);
      if (!cur) { outP.push({ productId: p.productId, status: 'missing', error: 'No longer in Shopify.' }); continue; }
      const moved = [];
      if (has(p, 'title') && cur.title !== p.oldTitle) moved.push(`title is now “${cur.title}”`);
      if (has(p, 'status') && cur.status !== p.oldStatus) moved.push(`status is now ${cur.status}`);
      if (moved.length) { outP.push({ productId: p.productId, status: 'conflict', title: cur.title, statusValue: cur.status, error: `Changed in Shopify since you loaded it — ${moved.join(', ')}.` }); continue; }
      const input = { id: p.productId };
      if (has(p, 'title') && p.title !== cur.title) input.title = p.title;
      if (has(p, 'status') && p.status !== cur.status) input.status = p.status;
      if (Object.keys(input).length === 1) { outP.push({ productId: p.productId, status: 'same', title: cur.title, statusValue: cur.status }); continue; }
      if (stopped()) { outP.push({ productId: p.productId, status: 'failed', error: 'Not attempted — Shopify refused the first change.' }); continue; }
      const r = await shopifyUpdateProduct(input);
      if (r.error) { code = code || r.code; outP.push({ productId: p.productId, status: 'failed', error: r.error }); continue; }
      const got = r.product || {};
      outP.push({ productId: p.productId, status: 'updated', title: got.title ?? input.title ?? cur.title, statusValue: got.status ?? input.status ?? cur.status });
      const base = { target: 'product', refId: p.productId, productId: p.productId, productTitle: cur.title, source: 'manual' };
      if (input.title) audit.push({ ...base, field: 'title', oldValue: cur.title, newValue: input.title });
      if (input.status) audit.push({ ...base, field: 'status', oldValue: cur.status, newValue: input.status });
    }

    if (audit.length) await insertShopifyListingEdits(audit, user.name || user.username || null);
    return send(res, 200, { ok: true, variants: outV, products: outP, code });
  } catch (e) {
    console.error('[shopify-listings/save]', e.message);
    return send(res, 502, { ok: false, error: `Could not finish — check Recent changes for what went through (${e.message}).` });
  }
}
