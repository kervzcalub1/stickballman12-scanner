// Reading the market for ONE requested pair — the shared half of `cart/price-line` and
// the add branch of `cart/line`.
//
// It lives in its own module because there are now two callers and there must never be
// two answers. The StockX corroboration rule below is subtle enough that a second
// hand-rolled copy would drift, and the thing that would drift is the number an
// approver releases money against.
//
// Same sources and the same failure independence as `payout/quote`: a StockX outage
// must not cost the Alias half of the answer.
import { priceInquiryForSkuSizes } from './intake.js';
import { stockxConfigured, stockxPriceForSkuSize } from './stockx.js';
import { shopifyConfigured, shopifyVelocity } from './shopify.js';

const money = (n) => (Number(n) > 0 ? Math.round(Number(n) * 100) / 100 : null);

/**
 * @returns {{ aliasPrice, stockxPrice, liquidity, priced, market }}
 *   `priced` is false when NEITHER side answered — the caller must store nothing
 *   rather than two more zeros, because a stored zero reads as "priced, and worthless".
 */
export async function readMarketForLine({ sku, size, upc = null, consigned = false }) {
  const sizes = [String(size)];
  const [alias, sx, vel] = await Promise.allSettled([
    priceInquiryForSkuSizes(sku, sizes, { consigned }),
    stockxConfigured() ? stockxPriceForSkuSize(sku, String(size), { upc: upc || null }) : Promise.resolve(null),
    shopifyConfigured() ? shopifyVelocity(sku, { days: 30 }) : Promise.resolve(null),
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

  return {
    aliasPrice,
    stockxPrice,
    liquidity,
    priced: aliasPrice != null || stockxPrice != null,
    market: {
      alias: aliasPrice, stockx: stockxPrice, liquidity,
      stockxConfigured: stockxConfigured(),
      // Reported either way, so a screen can say HOW StockX was matched rather than
      // implying a style-code hit.
      stockxInexact: sxInexact,
      stockxTitle: sxInexact ? (sxHit?.product?.title || null) : null,
    },
  };
}
