// Payout calculator — what a pair really costs at the register, what each store
// actually pays out after its fees, and whether that adds up to a buy.
//
// Ported from the public GemsClean/payout-calculator "Payout Engine". That repo has
// no licence file, so nothing is copied: it's Next.js + TypeScript + Tailwind and
// this is a re-implementation in our idiom (pure helpers in src/lib, screen in
// src/screens, our dark design system). The ARITHMETIC is kept faithful, including
// the two quirks flagged below — the numbers the floor has been quoting each other
// come out of that math, and silently "fixing" it would make this screen disagree
// with the tool they already trust.

// Platform fee as a PERCENT of the sale price. Defaults, not law — every store runs
// reduced-fee seller programs, so both are overridable per calculation:
//   StockX  7% seller + 3% payment processing  = 10%
//   Alias   7% commission + 2.9% ACH           = 9.9%
export const DEFAULT_FEE_PCT = { alias: 9.9, stockx: 10 };

// Alias first, unlike the source, which leads with StockX: we can fetch a live Alias
// price for a SKU + size (api/payout/quote.js) and have no StockX price feed at all,
// so the column that fills itself belongs where the eye lands first.
export const PLATFORMS = [
  { key: 'alias', label: 'Alias' },
  { key: 'stockx', label: 'StockX' },
];

// A deal is a "Buy" only when it clears BOTH of these; one of the two makes it a
// "Watch". Their numbers, kept as-is: $15 a pair is the floor that survives a price
// dip, and 15% ROI is what makes the capital worth tying up.
export const BUY_MIN_PROFIT = 15;
export const BUY_MIN_ROI = 15;

export const LIQUIDITY = [
  { key: 'daily', label: 'Daily', hint: 'Sells daily — fast turnaround, low holding risk.' },
  { key: 'weekly', label: 'Weekly', hint: 'Sells weekly — moderate turnaround. Don’t overstock.' },
  { key: 'monthly', label: 'Monthly', hint: 'Sells monthly — slow mover. High holding risk, ties up capital.' },
];

// Blank fields are 0, not NaN: the whole form is optional except the shelf price, and
// a single empty box must never turn every number downstream into "$NaN".
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The register total, discount by discount. The ORDER is the point — the three
 * percentages compound (each one comes off what's left, not off the shelf price), a
 * flat coupon lands after them, and only then does tax apply.
 *
 * Two quirks carried over from the source deliberately:
 *  1. **Cashback is netted off the total but calculated PRE-tax** (`afterCoupon × %`).
 *     A real card pays it on the amount actually charged, tax included, so this runs
 *     a few cents light on a big ticket. Faithful to the tool the floor already uses.
 *  2. **`totalSaved` is savings off the shelf price only** — it counts the discounts,
 *     the coupon and the cashback, and ignores tax/tip/shipping. It answers "how much
 *     did I knock off the sticker", not "shelf minus what I paid".
 */
export function calcCostBreakdown(inputs = {}) {
  const shelf = num(inputs.shelfPrice);
  const storePct = num(inputs.storePct);
  const promoPct = num(inputs.promoPct);
  const giftPct = num(inputs.giftPct);
  const couponAmt = num(inputs.couponAmt);
  const cashbackPct = num(inputs.cashbackPct);
  const taxPct = num(inputs.taxPct);
  const tip = num(inputs.tipAmt);
  const shipping = num(inputs.shippingAmt);

  const afterStore = shelf * (1 - storePct / 100);
  const storeSaved = shelf - afterStore;

  const afterPromo = afterStore * (1 - promoPct / 100);
  const promoSaved = afterStore - afterPromo;

  const afterGift = afterPromo * (1 - giftPct / 100);
  const giftSaved = afterPromo - afterGift;

  // A $50 coupon on a $30 balance takes it to zero, not to −$20.
  const couponSaved = Math.min(couponAmt, afterGift);
  const afterCoupon = afterGift - couponSaved;

  const cashback = afterCoupon * (cashbackPct / 100);
  const tax = afterCoupon * (taxPct / 100);
  const finalCost = afterCoupon + tax + tip + shipping - cashback;
  const totalSaved = shelf - afterCoupon + cashback;

  return {
    shelf,
    afterStore, storeSaved,
    afterPromo, promoSaved,
    afterGift, giftSaved,
    couponSaved, afterCoupon,
    cashback, tax, tip, shipping,
    finalCost, totalSaved,
  };
}

/**
 * What one platform actually pays and what's left after cost.
 * `feePct` is a percent (9.9), not a fraction.
 */
export function calcPayout(platform, salePrice, finalCost, feePct, markupPct = 0) {
  const sale = num(salePrice);
  const cost = num(finalCost);
  const pct = num(feePct);
  // Listing ABOVE the market: "the ask is $130, I'll list at +10%". The markup is a
  // percentage OF the sale price, and everything downstream is computed on the price
  // you'd actually be paid at — fees included, because a platform takes its cut of the
  // real sale, not of the ask you started from.
  const markup = num(markupPct);
  const markupAmount = sale * (markup / 100);
  const listedPrice = sale + markupAmount;
  const feeAmount = listedPrice * (pct / 100);
  const payout = listedPrice - feeAmount;
  const profit = payout - cost;
  return {
    platform,
    label: PLATFORMS.find((p) => p.key === platform)?.label || platform,
    salePrice: sale,
    markupPct: markup,
    markupAmount,
    // What the pair is actually sold at. Equals salePrice when there's no markup, which
    // is why every existing caller keeps its old numbers exactly.
    listedPrice,
    feePct: pct,
    feeAmount,
    payout,
    profit,
    // ROI is meaningless against a zero cost — a free pair isn't an infinite return,
    // it's an unanswered question. Left at 0 so the verdict falls through to Need data.
    roi: cost > 0 ? (profit / cost) * 100 : 0,
    // Margin is profit over the SALE price (not cost) — that's what the risk bands read.
    // The LISTED price, not the ask: with a markup, that's the number the pair sells at.
    margin: listedPrice > 0 ? (profit / listedPrice) * 100 : 0,
  };
}

// The platform to actually sell on: most profit wins. Only priced platforms count —
// an untouched sale-price box is "no opinion", not "$0 payout".
export function bestPayout(payouts) {
  const live = (payouts || []).filter((p) => p && p.salePrice > 0 && p.payout > 0);
  if (!live.length) return null;
  return live.reduce((best, p) => (p.profit > best.profit ? p : best));
}

// How exposed you are if the price moves before it sells. Margin carries the answer,
// liquidity shifts the bands: the same 15% margin is fine on a pair that sells daily
// and uncomfortable on one that moves monthly.
export function riskLevel(margin, liquidity) {
  if (liquidity === 'monthly') return margin >= 20 ? 'medium' : 'high';
  if (liquidity === 'weekly') {
    if (margin >= 20) return 'low';
    return margin >= 10 ? 'medium' : 'high';
  }
  if (margin >= 20) return 'low';
  if (margin >= 10) return 'medium';
  return margin >= 0 ? 'high' : 'loss';
}

/**
 * The buy call. Returns null until there's both a cost and at least one priced
 * platform — an empty form should say nothing rather than advise "Pass" on no data.
 */
export function dealVerdict(payouts, finalCost, liquidity = '') {
  const best = bestPayout(payouts);
  if (!best || num(finalCost) <= 0) return null;

  const profitPass = best.profit >= BUY_MIN_PROFIT;
  const roiPass = best.roi >= BUY_MIN_ROI;
  const call = profitPass && roiPass ? 'buy' : (profitPass || roiPass) ? 'watch' : 'pass';

  let note;
  if (best.profit <= 0) note = `Not profitable at these prices — you'd lose $${Math.abs(best.profit).toFixed(2)} a pair.`;
  else if (best.roi >= 30) note = `Strong deal — ${best.roi.toFixed(1)}% ROI via ${best.label}.`;
  else if (best.roi >= BUY_MIN_ROI) note = `Good deal — a solid ${best.roi.toFixed(1)}% ROI via ${best.label}.`;
  else if (best.roi >= 5) note = `Marginal — ${best.roi.toFixed(1)}% ROI via ${best.label}. Thin, and fees eat thin.`;
  else note = `Risky — only ${best.roi.toFixed(1)}% ROI. A small price drop erases it.`;

  const liq = LIQUIDITY.find((l) => l.key === liquidity);
  if (liq) note += ` ${liq.hint}`;

  // Spread only means something with two real quotes: "$120 better on Alias" is a
  // lie when the StockX box is simply empty.
  const priced = (payouts || []).filter((p) => p && p.salePrice > 0 && p.payout > 0);
  const spread = priced.length > 1
    ? Math.max(...priced.map((p) => p.profit)) - Math.min(...priced.map((p) => p.profit))
    : null;

  return { call, best, risk: riskLevel(best.margin, liquidity), spread, note };
}
