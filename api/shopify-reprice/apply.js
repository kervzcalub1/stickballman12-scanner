// POST /api/shopify-reprice/apply
//   { markupPctH, changes: [{ variantId, productId, oldPrice, marketCents, productTitle, style, size }] }  (≤ 100)
//   -> { ok, results: [{ variantId, status: 'updated'|'conflict'|'same'|'missing'|'failed', price?, error? }], code? }
// PH team (admin auto-allowed). Writes LIVE prices to Shopify (docs/context/shopify-reprice.md).
//
// The browser sends the market price, not the new price: the new price is recomputed here
// with the same integer half-up math, so the number written is always market × markup.
// Every variant's CURRENT price is re-read first; one that moved since the pull is left
// alone ('conflict') rather than overwritten blind. Each confirmed change is logged to
// shopify_price_changes — Shopify keeps no price history of its own.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { shopifyConfigured, shopifyVariantPrices, shopifyUpdateVariantPrices } from '../_lib/shopify.js';
import { insertShopifyPriceChanges } from '../_lib/db.js';
import { repriceDollars } from '../../src/lib/ebayReprice.js';

const MAX = 100;
const cents = (p) => Math.round(Number(p) * 100);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['ph_team']);
  if (!user) return;
  if (!rateLimit(req, { windowMs: 60_000, max: 60 })) return send(res, 429, { ok: false, error: 'Rate limit exceeded.' });

  const b = await getJsonBody(req);
  const pctH = Number(b.markupPctH);
  if (!Number.isInteger(pctH) || pctH < 0 || pctH > 10000) return send(res, 400, { ok: false, error: 'Markup must be 0–100 %.' });
  const changes = (Array.isArray(b.changes) ? b.changes : []).map((c) => ({
    variantId: String(c?.variantId || ''), oldPrice: String(c?.oldPrice ?? ''), marketCents: Number(c?.marketCents),
    productTitle: String(c?.productTitle || '').slice(0, 300), style: String(c?.style || '').slice(0, 60), size: String(c?.size || '').slice(0, 20),
  }));
  if (!changes.length) return send(res, 400, { ok: false, error: 'Nothing to change.' });
  if (changes.length > MAX) return send(res, 400, { ok: false, error: `At most ${MAX} per call.` });
  if (changes.some((c) => !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(c.variantId) || !Number.isInteger(c.marketCents) || c.marketCents < 1)) {
    return send(res, 400, { ok: false, error: 'Each change needs a Shopify variant id and a market price.' });
  }

  if (!shopifyConfigured()) return send(res, 500, { ok: false, error: 'Shopify is not configured on the server.' });
  try {
    const now = await shopifyVariantPrices(changes.map((c) => c.variantId));
    if (now.error) return send(res, 502, { ok: false, error: now.error, code: now.code });
    const results = [];
    const byProduct = new Map();
    for (const c of changes) {
      const cur = now.prices.get(c.variantId);
      const next = repriceDollars(c.marketCents, pctH);
      if (!cur) { results.push({ variantId: c.variantId, status: 'missing', error: 'No longer in Shopify.' }); continue; }
      if (cents(cur.price) !== cents(c.oldPrice)) { results.push({ variantId: c.variantId, status: 'conflict', price: cur.price, error: `Price changed in Shopify since the pull (now $${cur.price}).` }); continue; }
      if (cents(cur.price) === next * 100) { results.push({ variantId: c.variantId, status: 'same', price: cur.price }); continue; }
      const list = byProduct.get(cur.productId) || [];
      list.push({ ...c, productId: cur.productId, old: cur.price, next });
      byProduct.set(cur.productId, list);
    }
    const audit = [];
    let code;
    for (const [productId, list] of byProduct) {
      if (code === 'denied' || code === 'unauthorized') {
        for (const c of list) results.push({ variantId: c.variantId, status: 'failed', error: 'Not attempted — Shopify refused the first change.' });
        continue;
      }
      const r = await shopifyUpdateVariantPrices(productId, list.map((c) => ({ id: c.variantId, price: `${c.next}.00` })));
      if (r.error) {
        code = r.code;
        for (const c of list) results.push({ variantId: c.variantId, status: 'failed', error: r.error });
        continue;
      }
      for (const c of list) {
        const price = r.updated.get(c.variantId) ?? `${c.next}.00`;
        results.push({ variantId: c.variantId, status: 'updated', price, old: c.old });
        audit.push({ variantId: c.variantId, productId, productTitle: c.productTitle, style: c.style, size: c.size,
          oldPrice: Number(c.old), newPrice: c.next, marketCents: c.marketCents, markupPct: pctH / 100 });
      }
    }
    if (audit.length) await insertShopifyPriceChanges(audit, user.name || user.username || null);
    return send(res, 200, { ok: true, results, code });
  } catch (e) {
    console.error('[shopify-reprice/apply]', e.message);
    return send(res, 502, { ok: false, error: `Could not finish — check Recent changes for what went through (${e.message}).` });
  }
}
