// Pre-sell Listings — what a pair cost and where it comes from (docs/context/presell-listings.md).
// Shared by the screen and the server so both read a cost stack and a pasted tracking
// list the same way.
import { DEFAULT_FEE_PCT } from './payout.js';

// The supplier preset as used for ONE purchase (maybe edited for it). The server rebuilds
// it from whatever the browser sent — numbers clamped, unknown keys dropped — and computes
// the landed cost itself (landedFromShelf), never trusting a cost from the browser.
const pct = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0; };
const amt = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 0; };
const text = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };
export function cleanCostStack(cs) {
  if (!cs || typeof cs !== 'object') return null;
  return {
    preset: text(cs.preset, 60), presetId: Number(cs.presetId) || null, edited: cs.edited === true,
    taxPct: pct(cs.taxPct), giftPct: pct(cs.giftPct), storePct: pct(cs.storePct), promoPct: pct(cs.promoPct),
    cashbackPct: pct(cs.cashbackPct), tipAmt: amt(cs.tipAmt), shippingAmt: amt(cs.shippingAmt),
  };
}

// A shelf price, or null. Blank is not $0 (blank-vs-zero rule).
export function cleanShelf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 100_000 ? Math.round(n * 100) / 100 : null;
}

// Tracking numbers pasted in any shape — one per line, comma / space / semicolon separated,
// or copied out of a supplier's message with words around them. A token counts when it is
// 8–40 letters/digits with at least 6 digits (UPS 1Z…, FedEx/USPS all-digit, DHL…); words
// like "tracking" or "UPS" are left out. Upper-cased, de-duplicated, order kept.
export const MAX_TRACKING = 200;
export function parseTrackingList(input) {
  const raw = Array.isArray(input) ? input.join('\n') : String(input || '');
  const out = [];
  const seen = new Set();
  for (const tok of raw.split(/[\s,;|]+/)) {
    const t = tok.replace(/[^0-9a-z]/gi, '').toUpperCase();
    if (t.length < 8 || t.length > 40 || (t.match(/\d/g) || []).length < 6 || seen.has(t)) continue;
    seen.add(t); out.push(t);
    if (out.length >= MAX_TRACKING) break;
  }
  return out;
}

// What a pre-sell sale left us, in dollars: the platform's payout (its own number when it
// gave one, else price less the default fee — `estimated`), the pair's landed cost (null
// when none was entered — never $0), and payout − cost. One function for the Telegram post,
// the Sales tab and the report, so they never disagree.
export function saleNet({ platform, price_cents, payout_cents, unit_cost }) {
  const price = price_cents != null ? Number(price_cents) / 100 : null;
  let payout = payout_cents != null ? Number(payout_cents) / 100 : null;
  let estimated = false;
  if (payout == null && price != null) {
    payout = Math.round(price * (1 - (DEFAULT_FEE_PCT[platform] ?? 10) / 100) * 100) / 100;
    estimated = true;
  }
  const cost = unit_cost != null && unit_cost !== '' && Number.isFinite(Number(unit_cost)) ? Number(unit_cost) : null;
  const profit = payout != null && cost != null ? Math.round((payout - cost) * 100) / 100 : null;
  return { price, payout, estimated, cost, profit };
}

// ARRIVALS BY THE PAIR + PH TAKES OVER (owner, 2026-10-11). The first build treated ANY
// receive of a SKU + size as "the shipment arrived" and deleted every listing: Brent received
// 37 of 213 Jordan 1 Royal pairs and 162 pairs' listings came down. Now:
//   · a receive only COUNTS: arrived pairs first cover pairs already SOLD in transit (set
//     aside for the buyers); the rest are RELEASED for PH to list as normal inventory
//     (presell_stock.arrived_qty / released_qty);
//   · a pre-sell listing comes down on a platform only once PH has LISTED a released pair
//     there (the PH grid's AL / SX flag — or the pair sold), one for one. So a pair is never
//     unlisted in between.
// ph_alias_n / ph_stockx_n = received pairs of this shipment PH has listed (or sold) there.
export const pairsLeft = (s) => Math.max(0, Number(s?.qty || 0) - Number(s?.sold || 0));
export const phTookOver = (s, platform) => Math.min(Number(s?.released_qty || 0), Number(s?.[`ph_${platform}_n`] || 0));
// How many listings pre-sell may hold on a platform.
export const listableOn = (s, platform) => Math.max(0, pairsLeft(s) - phTookOver(s, platform));
// Set aside so far = arrived − released; still owed to buyers = sold − that.
export const pairsOwed = (s) => Math.max(0, Number(s?.sold || 0) - (Number(s?.arrived_qty || 0) - Number(s?.released_qty || 0)));
// n pairs just arrived → { n (capped at what was still on the way), aside, release, full }
export function arrivalSplit(s, n) {
  const onTheWay = Math.max(0, Number(s.qty) - Number(s.arrived_qty || 0));
  const got = Math.min(Math.max(0, Number(n) || 0), onTheWay);
  const aside = Math.min(got, pairsOwed(s));
  return { n: got, aside, release: got - aside, full: Number(s.arrived_qty || 0) + got >= Number(s.qty) };
}
