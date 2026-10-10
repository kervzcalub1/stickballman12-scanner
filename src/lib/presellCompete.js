// Pre-sell market competition — the decision (docs/context/presell-listings.md → "Market
// competition"). Pure: given the market's lowest ask, our live price and the price WE set,
// where should our listings be? All amounts in CENTS. Shared by the engine and the screen.
//
// Owner's rules (2026-10-11):
//   · undercut — be $1 under the lowest ask;  match — sit at the lowest ask.
//   · the protection: never more than $5 under the price we set (floor = base − $5).
//   · the market goes UP → we go up with it, no cap (undercut stays $1 under it).
//   · lowest ask = our price → HOLD. The platforms' lowest ask may include our own listings;
//     without this an undercut would chase itself to the floor.

export const COMP_PROTECT_CENTS = 500;
export const COMP_STEP_CENTS = 100;
export const COMP_MODES = { undercut: 'Undercut $1', match: 'Match lowest ask' };

export const compFloor = (baseCents) => Math.max(100, Number(baseCents) - COMP_PROTECT_CENTS);

// → { action, target, floor, want }
//   action: hold | down | up | floor (pinned at the floor) | none (no market)
export function compDecide({ mode, marketCents, currentCents, baseCents }) {
  const current = Number(currentCents);
  const base = Number(baseCents ?? currentCents);
  const floor = compFloor(base);
  if (!(Number(marketCents) > 0)) return { action: 'none', target: current, floor, want: null };
  const market = Number(marketCents);
  const want = mode === 'match' ? market : market - COMP_STEP_CENTS;
  if (market === current) return { action: 'hold', target: current, floor, want };
  if (market < current) {
    if (want >= floor) return { action: want === current ? 'hold' : 'down', target: want, floor, want };
    // The market went under our protection: sit at the floor (or stay there).
    return { action: floor === current ? 'hold' : 'floor', target: floor, floor, want };
  }
  // market > current: everyone else is above us — follow them up (undercut keeps $1 under).
  // A "rise" that isn't above where we already are (undercut, market $1 over us) is a hold.
  const up = Math.max(want, floor);
  return up > current ? { action: 'up', target: up, floor, want } : { action: 'hold', target: current, floor, want };
}

// Which mode a size competes in, or null when it doesn't. `sku` = its presell_comp_sku row
// (or null), `all` = { on, mode } from "All shoes", `override` = the size's 'on'|'off'|null.
export function compEffective({ master, all, sku, override }) {
  if (!master) return null;
  const mode = sku?.mode || all?.mode || 'undercut';
  if (override === 'off') return null;
  if (override === 'on') return mode;
  if (sku) return sku.enabled ? mode : null;
  return all?.on ? mode : null;
}

// The 2-HOUR RULE (owner, 2026-10-11): the market sitting BELOW our floor means we can't meet
// it; after 2 hours straight of that, the price we set follows the market — the market
// becomes the new "price we set" (and the new lock), and the mode applies from there.
//   → { farSince (ISO or null), rebase: bool }
export const COMP_REBASE_AFTER_MS = 2 * 3600_000;
export function compFarCheck({ marketCents, floorCents, farSince, now = Date.now() }) {
  const far = Number(marketCents) > 0 && Number(marketCents) < Number(floorCents);
  if (!far) return { farSince: null, rebase: false };
  const since = farSince && !Number.isNaN(Date.parse(farSince)) ? farSince : new Date(now).toISOString();
  return { farSince: since, rebase: now - Date.parse(since) >= COMP_REBASE_AFTER_MS };
}
