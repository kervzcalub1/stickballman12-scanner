// POST /api/cart/price-line  { cartId, lineId }  -> { ok, line, market }
//
// Put a market price on one requested pair, and the buy call that follows from it.
//
// **Why this has to exist.** A line's call is a snapshot, frozen as the buyer saw it, so
// that an approver judges the same picture. That rule assumes there IS a call. A pair
// added while Alias was timing out — which happens, api.alias.org runs 20–45s TTFB on a
// bad day — stored no market price at all, and reads "Not priced" forever with no way
// back short of deleting the line and re-adding it. Meanwhile the same SKU prices fine
// an hour later.
//
// So the market can be re-read on demand. It is deliberately an explicit act by a named
// person, never automatic: `line_priced` lands in `buy_cart_events` with the prices it
// found, what the call was before and what it is now. An approver who re-prices has
// chosen to look at today's market instead of the buyer's, and the record says so.
//
// Same sources and same failure independence as `payout/quote` — a StockX outage must
// not cost the Alias half of the answer.
import { getJsonBody, send, applySecurity, rateLimit, requireAuth, blockIfMustChange } from '../_lib/util.js';
import { getBuyCartFull, priceBuyCartLine, dbConfigured } from '../_lib/db.js';
import { priceInquiryForSkuSizes } from '../_lib/intake.js';
import { stockxConfigured, stockxPriceForSkuSize } from '../_lib/stockx.js';
import { shopifyConfigured, shopifyVelocity } from '../_lib/shopify.js';
import { cartVisibleTo, canWriteCosts, costStackEditable, repriceLine } from '../_lib/buycart.js';

const money = (n) => (Number(n) > 0 ? Math.round(Number(n) * 100) / 100 : null);
const fmt = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

export default async function handler(req, res) {
  applySecurity(req, res);
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  const user = requireAuth(req, res);
  if (!user) return;
  if (blockIfMustChange(user, res)) return;
  // One upstream Alias call per press — the same throttle Price Inquiry and the
  // calculator run under, for the same reason.
  if (!rateLimit(req, { windowMs: 60_000, max: 20 }))
    return send(res, 429, { ok: false, error: 'Please wait a moment before pricing again.' });
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Database is not configured.' });

  const body = await getJsonBody(req);
  const cartId = Number(body.cartId);
  const lineId = Number(body.lineId);
  if (!Number.isInteger(cartId) || !Number.isInteger(lineId))
    return send(res, 400, { ok: false, error: 'A valid cartId and lineId are required.' });

  try {
    const full = await getBuyCartFull(cartId);
    if (!full) return send(res, 404, { ok: false, error: 'That buying request does not exist.' });
    if (!cartVisibleTo(user, full)) return send(res, 403, { ok: false, error: 'You do not have access to this request.' });
    // The same people who may state the costs: the buyer whose request it is, or either
    // desk. Pricing writes the number an approval gets judged on, so it belongs with the
    // cost side rather than with reading the request.
    if (!(await canWriteCosts(user, full)))
      return send(res, 403, {
        ok: false,
        error: 'Only the buyer, or somebody who can approve or audit buying requests, can price a line.',
      });
    if (!costStackEditable(full))
      return send(res, 409, { ok: false, error: 'This request is finished — its lines can no longer be re-priced.' });

    const line = (full.lines || []).find((l) => Number(l.id) === lineId);
    if (!line) return send(res, 404, { ok: false, error: 'That line does not exist.' });
    if (!line.size)
      return send(res, 400, { ok: false, error: 'This line has no size, and the market is priced per size — add the size first.' });
    if (!(Number(line.shelf_price) > 0))
      return send(res, 400, { ok: false, error: 'This line has no shelf price, so there is nothing to price against.' });

    // The basis the line was quoted on, kept: consigned and with-you are different
    // numbers, and re-pricing must not quietly switch which question was asked.
    const consigned = line.basis === 'consigned';
    const sizes = [String(line.size)];
    const [alias, sx, vel] = await Promise.allSettled([
      priceInquiryForSkuSizes(line.sku, sizes, { consigned }),
      stockxConfigured() ? stockxPriceForSkuSize(line.sku, String(line.size), { upc: line.upc || null }) : Promise.resolve(null),
      shopifyConfigured() ? shopifyVelocity(line.sku, { days: 30 }) : Promise.resolve(null),
    ]);
    if (alias.status === 'rejected') throw alias.reason;

    const aliasRow = (alias.value?.results || [])[0] || null;
    const aliasPrice = money(aliasRow?.lowest_listing);
    const v = vel.status === 'fulfilled' ? vel.value : null;
    const liquidity = v && !v.error ? (v.liquidity || null) : null;

    // StockX's catalogue search falls back to the FIRST result when no product actually
    // carries the style code, and flags that with `exact:false` (api/_lib/stockx.js). On
    // the calculator an inexact hit is still shown — it is usually the right shoe in
    // another colourway and a person is looking at the title. Here nobody is: this writes
    // the number an approval gets judged on. Probed with a style code no shop has ever
    // sold, and it came back a confident "$264, BUY" off a completely unrelated shoe.
    //
    // But refusing every inexact hit throws away real prices: StockX's styleId formatting
    // often differs from the code on the box, so the RIGHT shoe frequently comes back
    // inexact — IO8116-600 does. So it is CORROBORATION that decides, not the flag alone:
    //
    //   Alias priced it too  → the style code is a real shoe and we have a second
    //                          opinion beside it. Use the inexact hit, say it was matched
    //                          by name in the trail.
    //   Alias found nothing  → nothing says this style code exists at all, and a lone
    //                          first-search-result is a guess. Refuse it.
    //
    // That is exactly what separates ZZ0000-999 (no Alias, inexact StockX) from a real
    // shoe whose StockX styleId is written differently.
    const sxHit = sx.status === 'fulfilled' ? sx.value : null;
    const sxInexact = !!sxHit?.market && sxHit?.product?.exact === false;
    const sxUsable = !!sxHit?.market && (!sxInexact || aliasPrice != null);
    const stockxPrice = sxUsable ? money(sxHit.market.lowest_ask) : null;
    const marketOut = {
      alias: aliasPrice, stockx: stockxPrice, liquidity,
      stockxConfigured: stockxConfigured(),
      // Reported either way, so the screen can say HOW StockX was matched rather than
      // implying a style-code hit.
      stockxInexact: sxInexact,
      stockxTitle: sxInexact ? (sxHit?.product?.title || null) : null,
    };

    // Neither side answered. Say so rather than writing two more zeros — the whole
    // reason this line reads "Not priced" is that somebody once did exactly that.
    if (aliasPrice == null && stockxPrice == null)
      return send(res, 200, {
        ok: true, line, priced: false, market: marketOut,
        error: sxInexact
          ? `Nothing carries the style code ${line.sku}: Alias has no price for it, and StockX's closest match is a different shoe (${sxHit?.product?.title || 'unnamed'}), so it is not being used. Check the code.`
          : `No Alias or StockX price for ${line.sku} in size ${line.size} right now.`,
      });

    const snap = {
      ...repriceLine({ ...line, alias_price: aliasPrice, stockx_price: stockxPrice, liquidity }, full.cost_stack || {}),
      aliasPrice, stockxPrice, liquidity,
    };
    const was = line.verdict
      ? `was ${line.verdict}, ${fmt(line.profit)} profit`
      : 'was not priced';
    const saved = await priceBuyCartLine(cartId, lineId, snap, user,
      `${line.sku}${line.size ? ` size ${line.size}` : ''} — Alias ${fmt(aliasPrice)}`
      + ` · StockX ${stockxPrice == null ? (sxInexact ? 'no style-code match, ignored' : '—') : `${fmt(stockxPrice)}${sxInexact ? ' (matched by name)' : ''}`}`
      + ` → ${snap.verdict || 'no call'}, ${fmt(snap.profit)} profit (${was})`);
    if (!saved) return send(res, 404, { ok: false, error: 'That line does not exist.' });

    return send(res, 200, { ok: true, line: saved, priced: true, market: marketOut });
  } catch (e) {
    console.error('[cart/price-line]', e.message);
    return send(res, 500, { ok: false, error: 'Could not price that line.' });
  }
}
