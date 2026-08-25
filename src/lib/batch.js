// Batch analysis — pricing a whole list at once and calling each line.
//
// Ported from GemsClean/payout-calculator (`bulk-analyze-core.ts`). Same shape of
// answer: per row a best platform, a payout, a profit and a verdict; underneath, one
// summary line for the deal as a whole.
//
// Three deliberate differences from the source, all of them so this screen cannot
// disagree with the single-pair one two tabs away:
//
//  1. **The verdict is OURS.** The source calls a Watch on `profit > 0 && roi >= 5`;
//     `dealVerdict` in lib/payout.js says a Buy needs BOTH thresholds and either one
//     alone is a Watch. That function is the single definition the calculator, the
//     advisor prompt and this all read, so it wins.
//  2. **No estimated eBay / Stadium Goods column.** The source multiplies the Alias ask
//     by 1.25 and 1.2 and prints the results as prices. They aren't prices, they're a
//     guess wearing a currency symbol, and this app doesn't put those on screen.
//  3. **A missing cost is not a zero.** A row nobody priced comes back "Needs cost" and
//     is left out of the totals, rather than reading as a free pair with infinite ROI.
import { calcPayout, calcCostBreakdown, bestPayout, dealVerdict, DEFAULT_FEE_PCT } from './payout.js';

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const hasCost = (v) => String(v ?? '').trim() !== '' && num(v) > 0;

// The market rows for one row's exact size. We ASKED for that label, so the result
// carries it back verbatim — no fuzzy matching, and nothing is folded in that we
// didn't request. "9" and "9W" are different shoes on different feet.
const forSize = (rows, size) => (rows || []).find((r) => String(r.size) === String(size)) || null;
const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

/**
 * Price one parsed row against a SKU's quotes.
 *
 * `costMode` says what the number in the list MEANS:
 *   · 'shelf' — a sticker price, so the Store cost stack filled in above this section
 *     runs over every row: the three compounding discounts, tax, cashback, and the
 *     per-pair tip and shipping. This is the default, because the stack is on screen
 *     right there and it is the whole reason the two live on one page.
 *   · 'final' — the number is already what the pair costs, landed. A supplier's offer
 *     sheet is this: they quote you a price, not a shelf price you then discount.
 *
 * **The COUPON is deliberately never applied**, in either mode. It's a flat amount off
 * one transaction, not a rate — carrying a $10 coupon into forty rows would quietly take
 * $400 off the batch and turn a Pass into a Buy. Whoever wants it applies it to the one
 * pair it belongs to, upstairs.
 */
export function analyseRow(row, quote, { costMode = 'shelf', stack = {}, feePct = {} } = {}) {
  const out = { ...row, alias: null, stockx: null, best: null, verdict: null };
  const aliasRow = forSize(quote?.alias?.results, row.size);
  const sxRow = forSize(quote?.stockx?.results, row.size);
  // Alias's lowest ask and StockX's lowest ask — the two "what does this actually
  // sell for" numbers, one per platform, same as the single-pair screen's first column.
  const aliasSale = money(aliasRow?.lowest_listing);
  const sxSale = money(sxRow?.lowest_ask);
  out.aliasSale = aliasSale;
  out.stockxSale = sxSale;
  out.inexact = !!sxRow?.inexact;

  if (!hasCost(row.cost)) {
    out.finalCost = 0;
    out.status = (aliasSale || sxSale) ? 'no_cost' : 'no_price';
    out.priced = !!(aliasSale || sxSale);
    return out;
  }

  const listed = num(row.cost);
  out.listedCost = listed;
  out.finalCost = costMode === 'shelf'
    // couponAmt is NOT spread in — see the note above.
    ? calcCostBreakdown({
      shelfPrice: listed,
      storePct: stack.storePct, promoPct: stack.promoPct, giftPct: stack.giftPct,
      cashbackPct: stack.cashbackPct, taxPct: stack.taxPct,
      tipAmt: stack.tipAmt, shippingAmt: stack.shippingAmt,
    }).finalCost
    : listed;

  const fee = (k) => (String(feePct[k] ?? '').trim() === '' ? DEFAULT_FEE_PCT[k] : num(feePct[k]));
  const payouts = [
    aliasSale ? calcPayout('alias', aliasSale, out.finalCost, fee('alias')) : null,
    sxSale ? calcPayout('stockx', sxSale, out.finalCost, fee('stockx')) : null,
  ].filter(Boolean);

  out.alias = payouts.find((p) => p.platform === 'alias') || null;
  out.stockx = payouts.find((p) => p.platform === 'stockx') || null;
  out.priced = payouts.length > 0;
  if (!payouts.length) { out.status = 'no_price'; return out; }

  out.best = bestPayout(payouts);
  out.verdict = dealVerdict(payouts, out.finalCost);
  out.status = out.verdict?.call || 'no_price';
  // What the LINE is worth, not the pair — a $6 margin on forty pairs is a different
  // conversation from a $6 margin on one, and it's the number that decides the deal.
  out.lineProfit = (out.best?.profit || 0) * (row.qty || 1);
  out.lineCost = out.finalCost * (row.qty || 1);
  out.linePayout = (out.best?.payout || 0) * (row.qty || 1);
  return out;
}

export function analyseBatch(rows, quotes, opts) {
  return (rows || []).map((r) => analyseRow(r, quotes?.[String(r.sku).toUpperCase()], opts));
}

/**
 * The deal as one line. Rows we could not both price AND cost are excluded from the
 * money and counted separately — averaging a blank into a blended ROI is how a bad
 * batch reads as an acceptable one.
 */
export function batchSummary(analysed) {
  const rows = analysed || [];
  const counted = rows.filter((r) => r.status === 'buy' || r.status === 'watch' || r.status === 'pass');
  const sum = (f) => counted.reduce((t, r) => t + (r[f] || 0), 0);
  const totalCost = sum('lineCost');
  const totalProfit = sum('lineProfit');
  const pairs = (list) => list.reduce((t, r) => t + (r.qty || 1), 0);
  return {
    rows: rows.length,
    pairs: pairs(rows),
    pricedPairs: pairs(counted),
    totalCost,
    totalPayout: sum('linePayout'),
    totalProfit,
    blendedRoi: totalCost > 0 ? (totalProfit / totalCost) * 100 : 0,
    buys: counted.filter((r) => r.status === 'buy'),
    // Two different gaps, kept apart: nobody gave us a price to sell at, versus nobody
    // gave us a cost to buy at. The first is a market problem, the second is a typo.
    noPrice: rows.filter((r) => r.status === 'no_price').length,
    noCost: rows.filter((r) => r.status === 'no_cost').length,
  };
}

export const STATUS_LABEL = {
  buy: 'Buy', watch: 'Watch', pass: 'Pass',
  no_cost: 'Needs cost', no_price: 'No market',
};
