// POST /api/payout/batch  { skus: [{ sku, sizes: [size…] }], consigned? }
//   -> { ok, quotes: { [SKU]: { alias:{configured,results}, stockx:{configured,results,error?} } } }
//
// The many-pairs half of the Payout Calculator: price a whole pasted list in one round
// trip instead of one request per line. Same two sources and the same shapes as
// `quote.js` — this is that endpoint with a loop and a concurrency cap around it, on
// purpose, so a batch row and a single-pair row can never be priced by two different
// code paths and disagree.
//
// What bounds it, and why each bound exists:
//  · MAX_SKUS / MAX_SIZES — each SKU is an upstream Alias call plus one StockX call per
//    size, against a shared quota. A 400-line paste would be a self-inflicted outage.
//  · CONCURRENCY — a few at a time. Firing 40 at once gets us throttled by Alias and
//    buys nothing: the wall-clock is dominated by the slowest, not the sum.
//  · Sizes are priced SEQUENTIALLY within a SKU on the StockX side, because they share
//    a cached product + variant list. In parallel on a cold cache they'd each repeat
//    the same two catalogue calls.
//  · One SKU failing returns an empty result FOR THAT SKU, never a failed request. A
//    style Alias has never heard of must not cost you the other thirty-nine.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { priceInquiryForSkuSizes } from '../_lib/intake.js';
import { stockxConfigured, stockxPriceForSkuSize } from '../_lib/stockx.js';

const MAX_SKUS = 40;
const MAX_SIZES = 24;      // per SKU — a full size run and then some
const CONCURRENCY = 4;

// Run `job` over `items`, `n` at a time. Order preserved; a rejection is impossible
// because every job catches its own.
async function pool(items, n, job) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await job(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function quoteOne({ sku, sizes }, consigned) {
  const out = { alias: { configured: false, results: [] }, stockx: { configured: stockxConfigured(), results: [] } };
  try {
    const a = await priceInquiryForSkuSizes(sku, sizes, { consigned });
    out.alias = { configured: !!a.configured, results: a.results || [] };
  } catch (e) {
    // Said out loud rather than left as an empty market: "we couldn't ask" and "there
    // is no ask" are opposite answers, and only one of them means pass on the pair.
    out.alias = { configured: true, results: [], error: 'Alias lookup failed for this style.' };
  }
  if (stockxConfigured()) {
    try {
      for (const size of sizes) {
        const hit = await stockxPriceForSkuSize(sku, size);
        const m = hit?.market;
        if (!m || (m.lowest_ask == null && m.highest_bid == null)) continue;
        out.stockx.results.push({
          size,
          lowest_ask: m.lowest_ask, highest_bid: m.highest_bid,
          sell_faster: m.sell_faster, earn_more: m.earn_more,
          inexact: hit.product?.exact === false,
          title: hit.product?.title || null,
        });
      }
    } catch {
      out.stockx.error = 'StockX prices are unavailable right now.';
    }
  }
  return out;
}

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  // Same roles as quote.js — including suppliers, who are the ones handed a list in a
  // shop and asked whether it's worth taking.
  const user = requireRole(req, res, ['warehouse', 'ph_team', 'supplier']); // admin/superadmin auto-allowed
  if (!user) return;
  // One request here is worth many of quote.js's, so it's throttled far harder.
  if (!rateLimit(req, { windowMs: 60_000, max: 6 }))
    return send(res, 429, { ok: false, error: 'Give the last batch a moment to finish before running another.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const consigned = body.consigned === true;   // the calculator's default is "with you"
  const raw = Array.isArray(body.skus) ? body.skus : [];
  const skus = [];
  const seen = new Set();
  for (const entry of raw) {
    const sku = String(entry?.sku ?? '').trim().toUpperCase();
    if (!sku || seen.has(sku)) continue;
    const sizes = [...new Set((Array.isArray(entry?.sizes) ? entry.sizes : [])
      .map((s) => String(s ?? '').trim()).filter(Boolean))].slice(0, MAX_SIZES);
    if (!sizes.length) continue;
    seen.add(sku);
    skus.push({ sku, sizes });
    if (skus.length >= MAX_SKUS) break;
  }
  if (!skus.length) return send(res, 400, { ok: false, error: 'Nothing to price — every row needs a style code and a size.' });

  try {
    const results = await pool(skus, CONCURRENCY, (s) => quoteOne(s, consigned));
    const quotes = {};
    skus.forEach((s, i) => { quotes[s.sku] = results[i]; });
    return send(res, 200, {
      ok: true, quotes, consigned,
      // Said in the response, not assumed by the client: a silently dropped style is
      // how a batch reads as "priced" when a third of it never got looked at.
      ...(raw.length > skus.length ? { skipped: raw.length - skus.length, limit: MAX_SKUS } : {}),
    });
  } catch (e) {
    console.error('[payout/batch]', e.message);
    return send(res, 500, { ok: false, error: 'Could not price that batch.' });
  }
}
