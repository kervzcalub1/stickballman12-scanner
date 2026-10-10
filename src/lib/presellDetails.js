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
