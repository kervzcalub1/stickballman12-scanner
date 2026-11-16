// StockX Reprice — the one set of rules the screen previews and the server enforces
// (docs/context/stockx-reprice.md). Pure: no clock, no network.
//
// The problem (Alex, 2026-11-03): our ~1,750 listings sit in StockX's DIRECT programme, whose
// lowest ask can be far above the standard (Ship to Verify) lowest ask — $170 vs $48 on a slow
// shoe — and nobody pays that premium. The default rule MATCHES THE STANDARD LOWEST ASK, never
// below the profit floor, and only ever LOWERS (this is for moving old stock).

export const STOCKX_FEE_PCT = 10;   // the same default the Payout Calculator and Pre-sell use
// Daily price update (2026-11-16): ~87 % of our StockX listings have NO cost on file, so the floor
// could not be checked and the tool refused them — 624 of the 731 over-priced ones. With no cost
// the guard is the SIZE OF THE CUT instead: up to this % off today's ask goes with the daily run,
// a bigger cut waits for a person to look at it. 0 = every no-cost listing waits (the old rule).
export const MAX_CUT_NO_COST = 30;

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
 *          · 'no_cost' (no cost AND the cut is over `maxCutNoCost` % — a person decides; carries
 *            `target` + `cutPct`) · 'no_market' · 'locked' · 'presell' · 'ended'
 *   `noCost: true` on a 'change' = sent without a floor (a small cut, or `allowNoCost`).
 */
export function planListing(row, { rule = 'standard', offset = 0, minProfit = 5, allowNoCost = false, maxCutNoCost = 0 } = {}) {
  if (row.ended_at) return { state: 'ended', why: 'No longer live on StockX' };
  if (row.locked) return { state: 'locked', why: '🔒 Kept — Keep price is on' };
  if (row.presell) return { state: 'presell', why: 'A Pre-sell listing — its price is set on the Pre-sell page' };
  const now = num(row.amount);
  const target = rulePrice(row, rule, offset);
  if (target == null || !(now > 0)) return { state: 'no_market', why: rule === 'bid' ? 'No bid on this size' : 'No Standard lowest ask for this size' };
  // What a person taught the run for this size: "never ask less than $X" is a floor of its own
  // (the higher of it and the cost floor wins), and it makes a missing cost safe to act on.
  const taught = num(row.min_price) > 0 ? Math.ceil(num(row.min_price)) : null;
  const costFloor = floorPrice(row.cost, minProfit);
  const floor = costFloor == null ? taught : (taught == null ? costFloor : Math.max(costFloor, taught));
  if (floor == null && !allowNoCost && !row.big_cut_ok) {
    const cap = num(maxCutNoCost) ?? 0;
    const cutPct = ((now - target) / now) * 100;
    // No cap (the old rule): every no-cost listing waits. With a cap: only a cut bigger than it.
    if (!(cap > 0)) return { state: 'no_cost', target, cutPct, why: 'No cost on file — the profit floor can’t be checked' };
    if (cutPct > cap) return { state: 'no_cost', target, cutPct, why: `No cost on file and the cut is ${Math.round(cutPct)} % ($${now} → $${target}) — look at it first` };
  }
  const price = floor == null ? target : Math.max(target, floor);
  if (price >= now) {
    return floor != null && floor >= now && target < now
      ? { state: 'below_floor', target, floor, why: `The ${ruleLabel(rule, offset)} ($${target}) is under the floor ($${floor}) — kept` }
      : { state: 'kept', target, floor, why: 'Already at or under it' };
  }
  return { state: price > target ? 'floored' : 'change', price, target, floor, ...(floor == null ? { noCost: true } : {}),
    why: price > target ? `Held at ${taught != null && taught === floor ? 'the lowest price set for this size' : 'the floor'} ($${floor}) — the rule says $${target}`
      : (floor == null ? (row.big_cut_ok ? 'No cost on file — a person OK’d this cut' : 'No cost on file — market price, no floor') : null) };
}

// ---- The daily picture (the "Today" card and the stockx_daily record) --------------------
// One pass over the live listings with the day's rule: what goes with the run, what a person
// has to look at, and how far over the Standard lowest ask we sit. Pure.
export const BANDS = [['b10', 'up to 10 % over', 0, 10], ['b25', '10–25 % over', 10, 25], ['b50', '25–50 % over', 25, 50], ['b50p', 'more than 50 % over', 50, Infinity]];
export function dailyStats(rows, opts = {}) {
  const o = { rule: 'standard', minProfit: 5, maxCutNoCost: MAX_CUT_NO_COST, ...opts };
  const st = { active: 0, withCost: 0, over: 0, overUsd: 0, ready: 0, readyUsd: 0, readyNoCost: 0, review: 0, reviewUsd: 0,
    floorStops: 0, kept: 0, noMarket: 0, locked: 0, presell: 0, bands: Object.fromEntries(BANDS.map(([k]) => [k, 0])) };
  for (const r of rows || []) {
    if (r.ended_at) continue;
    st.active++;
    if (num(r.cost) > 0) st.withCost++;
    const g = gapPct(r);
    if (g != null && g > 0) {
      st.over++; st.overUsd += num(r.amount) - num(r.standard_lowest);
      const b = BANDS.find(([, , lo, hi]) => g > lo && g <= hi);
      if (b) st.bands[b[0]]++;
    }
    const p = planListing(r, o);
    if (p.state === 'change' || p.state === 'floored') { st.ready++; st.readyUsd += num(r.amount) - p.price; if (p.noCost) st.readyNoCost++; }
    else if (p.state === 'no_cost') { st.review++; st.reviewUsd += Math.max(0, num(r.amount) - p.target); }
    else if (p.state === 'below_floor') st.floorStops++;
    else if (p.state === 'kept') st.kept++;
    else if (p.state === 'no_market') st.noMarket++;
    else if (p.state === 'locked') st.locked++;
    else if (p.state === 'presell') st.presell++;
  }
  for (const k of ['overUsd', 'readyUsd', 'reviewUsd']) st[k] = Math.round(st[k]);
  return st;
}

// How far over the Standard lowest ask our ask sits, as a % of that ask. null = unknown.
export function gapPct(row) {
  const std = num(row.standard_lowest);
  const now = num(row.amount);
  return std > 0 && now > 0 ? ((now - std) / std) * 100 : null;
}

// Whole days since a listing was made (pass `now` in — no clock in here).
export const daysListed = (row, now) => (row.sx_created_at ? Math.floor((now - Date.parse(row.sx_created_at)) / 864e5) : null);
