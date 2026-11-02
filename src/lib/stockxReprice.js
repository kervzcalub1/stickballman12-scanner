// StockX Reprice — the one set of rules the screen previews and the server enforces
// (docs/context/stockx-reprice.md). Pure: no clock, no network.
//
// The problem (Alex, 2026-11-03): our ~1,750 listings sit in StockX's DIRECT programme, whose
// lowest ask can be far above the standard (Ship to Verify) lowest ask — $170 vs $48 on a slow
// shoe — and nobody pays that premium. The default rule MATCHES THE STANDARD LOWEST ASK, never
// below the profit floor, and only ever LOWERS (this is for moving old stock).

export const STOCKX_FEE_PCT = 10;   // the same default the Payout Calculator and Pre-sell use

export const RULES = [
  ['standard', 'Match the Standard lowest ask'],
  ['standard_minus', 'Standard lowest ask − $X'],
  ['bid', 'Match the highest bid (sell now)'],
];
export const ruleLabel = (k, offset = 0) => (k === 'standard_minus'
  ? `Standard lowest ask − $${Number(offset) || 0}`
  : (RULES.find(([v]) => v === k) || [])[1] || k);

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// The lowest whole-dollar ask that still pays `minProfit` after StockX's fee. null = no cost.
export function floorPrice(cost, minProfit = 5, feePct = STOCKX_FEE_PCT) {
  const c = num(cost);
  if (c == null || !(c > 0)) return null;
  return Math.ceil((c + (num(minProfit) ?? 0)) / (1 - feePct / 100));
}

export const payoutAt = (price, feePct = STOCKX_FEE_PCT) => Math.round(price * (1 - feePct / 100) * 100) / 100;

// The rule's price for a listing, before the floor. null = the market doesn't say.
export function rulePrice(row, rule = 'standard', offset = 0) {
  if (rule === 'bid') return num(row.highest_bid) > 0 ? Math.round(num(row.highest_bid)) : null;
  const std = num(row.standard_lowest);
  if (!(std > 0)) return null;
  const off = rule === 'standard_minus' ? Math.max(0, Math.round(num(offset) ?? 0)) : 0;
  return Math.max(1, Math.round(std) - off);
}

/**
 * What to do with one listing.
 * @param row  a stockx_listings row (+ `locked`, `presell`, `cost` as listStockxListings gives it)
 * @param opts { rule, offset, minProfit, allowNoCost }
 * @returns { state, price?, target?, floor?, why }
 *   state: 'change' (lower to `price`) · 'floored' (lower, but held at the floor above the rule)
 *          · 'kept' (already at or under) · 'below_floor' (even the floor isn't under today's ask)
 *          · 'no_cost' · 'no_market' · 'locked' · 'presell' · 'ended'
 */
export function planListing(row, { rule = 'standard', offset = 0, minProfit = 5, allowNoCost = false } = {}) {
  if (row.ended_at) return { state: 'ended', why: 'No longer live on StockX' };
  if (row.locked) return { state: 'locked', why: '🔒 Kept — Keep price is on' };
  if (row.presell) return { state: 'presell', why: 'A Pre-sell listing — its price is set on the Pre-sell page' };
  const now = num(row.amount);
  const target = rulePrice(row, rule, offset);
  if (target == null || !(now > 0)) return { state: 'no_market', why: rule === 'bid' ? 'No bid on this size' : 'No Standard lowest ask for this size' };
  const floor = floorPrice(row.cost, minProfit);
  if (floor == null && !allowNoCost) return { state: 'no_cost', target, why: 'No cost on file — the profit floor can’t be checked' };
  const price = floor == null ? target : Math.max(target, floor);
  if (price >= now) {
    return floor != null && floor >= now && target < now
      ? { state: 'below_floor', target, floor, why: `The ${ruleLabel(rule, offset)} ($${target}) is under the floor ($${floor}) — kept` }
      : { state: 'kept', target, floor, why: 'Already at or under it' };
  }
  return { state: price > target ? 'floored' : 'change', price, target, floor,
    why: price > target ? `Held at the floor ($${floor}) — the rule says $${target}` : null };
}

// How far over the Standard lowest ask our ask sits, as a % of that ask. null = unknown.
export function gapPct(row) {
  const std = num(row.standard_lowest);
  const now = num(row.amount);
  return std > 0 && now > 0 ? ((now - std) / std) * 100 : null;
}

// Whole days since a listing was made (pass `now` in — no clock in here).
export const daysListed = (row, now) => (row.sx_created_at ? Math.floor((now - Date.parse(row.sx_created_at)) / 864e5) : null);
