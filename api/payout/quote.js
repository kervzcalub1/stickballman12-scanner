// POST /api/payout/quote  { sku, sizes:[…] }
//   -> { ok, configured, results:[…], stockx:{ configured, results:[…], error } }
//
// Live market prices for the Payout Calculator, so the "what would this sell for"
// boxes fill themselves instead of being typed off a phone in a store aisle. Read
// only — nothing is saved.
//
// TWO independent sources, and they fail independently on purpose:
//   · **Alias** — `configured` + `results[]` (Global Indicator, lowest listing,
//     highest offer, last sold). Shares PH Price Inquiry's engine,
//     `priceInquiryForSkuSizes`.
//   · **StockX** — `stockx.results[]` (lowest ask, highest bid) from the OFFICIAL
//     Public API (api/_lib/stockx.js). Optional: with no StockX credentials set the
//     endpoint still answers with Alias prices and `stockx.configured:false`, and the
//     screen keeps that column manual. StockX being down must never cost the buyer
//     their Alias number.
//
// **Roles are deliberately wider here than anywhere else pricing appears.** Every
// other pricing surface is PH + admin, because the warehouse doesn't set prices. The
// Payout Calculator is the exception on purpose: it exists to answer "should I buy
// this pair, standing in the store", and that is warehouse work. Widening this one
// endpoint is what makes the tool usable by the person actually holding the shoe —
// Price Inquiry (api/ph/price-inquiry.js) stays PH + admin.
import { getJsonBody, send, applySecurity, rateLimit, requireRole } from '../_lib/util.js';
import { dbConfigured } from '../_lib/db.js';
import { priceInquiryForSkuSizes } from '../_lib/intake.js';
import { stockxConfigured, stockxPriceForSkuSize } from '../_lib/stockx.js';

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireRole(req, res, ['warehouse', 'ph_team']); // admin/superadmin auto-allowed
  if (!user) return;
  // One upstream Alias call per size — throttle it like Price Inquiry does.
  if (!rateLimit(req, { windowMs: 60_000, max: 30 }))
    return send(res, 429, { ok: false, error: 'Please wait a moment before pricing again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const sku = String(body.sku ?? '').trim();
  // The calculator prices the ONE size in your hand, so the cap is far below Price
  // Inquiry's 100 — a run of 20 is already more than this screen ever asks for.
  const sizes = (Array.isArray(body.sizes) ? body.sizes : [])
    .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 20);
  // Consigned is the daily-ops basis (same default as Price Inquiry); 'with_you'
  // prices the seller-holds-it case.
  const consigned = body.consigned === false ? false : true;
  // Optional. A UPC lets the StockX side resolve the exact variant from the barcode
  // instead of searching by name, which is both cheaper and impossible to mismatch.
  const upc = String(body.upc ?? '').replace(/\D/g, '') || null;
  if (!sku) return send(res, 400, { ok: false, error: 'Missing SKU.' });
  if (!sizes.length) return send(res, 400, { ok: false, error: 'No sizes to price.' });

  try {
    // Both sources at once — neither waits on the other, and a StockX outage can't
    // take the Alias half of the answer down with it (hence allSettled, not all).
    const [alias, sx] = await Promise.allSettled([
      priceInquiryForSkuSizes(sku, sizes, { consigned }),
      quoteStockx(sku, sizes, upc),
    ]);
    if (alias.status === 'rejected') throw alias.reason;
    const { configured, results } = alias.value;
    const stockx = sx.status === 'fulfilled'
      ? sx.value
      // A refused token or a 500 upstream is worth SAYING on screen. Silence here
      // would read as "StockX has no ask for this shoe", which is a different claim.
      : { configured: stockxConfigured(), results: [], error: 'StockX prices are unavailable right now.' };
    return send(res, 200, { ok: true, configured, results, consigned, stockx });
  } catch (e) {
    console.error('[payout/quote]', e.message);
    return send(res, 500, { ok: false, error: 'Could not fetch prices.' });
  }
}

// StockX side of the quote: one lookup per size, sequential because the sizes of a
// SKU share a cached product + variant list — firing them in parallel on a cold
// cache would make the same two catalogue calls N times over, against a 25k/day
// account-wide quota.
async function quoteStockx(sku, sizes, upc) {
  if (!stockxConfigured()) return { configured: false, results: [] };
  const results = [];
  for (const size of sizes) {
    const hit = await stockxPriceForSkuSize(sku, size, { upc });
    if (!hit?.market) continue;
    const { lowest_ask, highest_bid, sell_faster, earn_more } = hit.market;
    if (lowest_ask == null && highest_bid == null) continue;
    results.push({
      size, lowest_ask, highest_bid, sell_faster, earn_more,
      // Flagged so the screen can warn instead of quietly pricing the wrong colourway.
      inexact: hit.product?.exact === false,
      title: hit.product?.title || null,
    });
  }
  return { configured: true, results };
}
