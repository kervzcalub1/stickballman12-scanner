// StockX DAILY price update — the settings, the day's record and the automatic queueing
// (docs/context/stockx-reprice.md → "Daily, automatic"). Alex's ask (T-1334): the price update
// must happen by itself every day, by rules people can teach it — not by someone remembering
// to press Pull and Reprice. The worker (stockx-daily-worker.js) calls these once a day; the
// StockX Listings page reads and changes the settings through api/stockx/daily.js.
//
// The SAME rules as a manual run (src/lib/stockxReprice.js planListing): match the Standard
// lowest ask, never under the floor, only ever lower, never a 🔒 or a Pre-sell listing — plus
// what people taught it per size (stockx_teach) and the no-cost guard (a cut bigger than
// `maxCutNoCost` % on a pair with no cost waits for a person).
import { getSetting, setSetting, listStockxListings, queueStockxEdits, saveStockxDaily } from './db.js';
import { planListing, ruleLabel, dailyStats, RULES, MAX_CUT_NO_COST } from '../../src/lib/stockxReprice.js';

export const AUTO_KEY = 'stockx_auto';
// OFF until an admin turns it on: this changes live asks on the one StockX account.
export const AUTO_DEFAULTS = { on: false, rule: 'standard', offset: 0, minProfit: 5, maxCutNoCost: MAX_CUT_NO_COST, hour: 9 };
export const AUTO_BY = 'auto (daily)';

const clamp = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.max(lo, Math.min(hi, Number(v))) : dflt);
export function cleanAuto(o = {}) {
  const d = AUTO_DEFAULTS;
  return {
    on: o.on === true,
    rule: RULES.some(([k]) => k === o.rule) ? o.rule : d.rule,
    offset: Math.round(clamp(o.offset, 0, 500, d.offset)),
    minProfit: clamp(o.minProfit, 0, 500, d.minProfit),
    maxCutNoCost: Math.round(clamp(o.maxCutNoCost, 0, 90, d.maxCutNoCost)),
    hour: Math.round(clamp(o.hour, 0, 23, d.hour)),
    ...(o.changedBy ? { changedBy: String(o.changedBy).slice(0, 80) } : {}),
    ...(o.changedAt ? { changedAt: String(o.changedAt).slice(0, 40) } : {}),
  };
}
export async function readAuto() {
  let o = {};
  try { o = JSON.parse((await getSetting(AUTO_KEY)) || '{}') || {}; } catch { /* defaults */ }
  return cleanAuto(o);
}
export async function writeAuto(patch, by) {
  const next = cleanAuto({ ...(await readAuto()), ...patch, changedBy: by || '', changedAt: new Date().toISOString() });
  await setSetting(AUTO_KEY, JSON.stringify(next), by || null);
  return next;
}

// Everything is EST — the day a run belongs to is the EST civil day, whatever the host's clock.
const EST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const EST_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
export const estDay = (d = new Date()) => EST_DAY.format(d);
export const estHour = (d = new Date()) => Number(EST_HOUR.format(d));

const planOpts = (s) => ({ rule: s.rule, offset: s.offset, minProfit: s.minProfit, maxCutNoCost: s.maxCutNoCost });

// The picture right after a market read, saved on today's row. -> { rows, stats }
export async function recordStockxDay(settings = null) {
  const s = settings || await readAuto();
  const rows = await listStockxListings();
  const stats = dailyStats(rows, planOpts(s));
  await saveStockxDaily(estDay(), { stats });
  return { rows, stats };
}

// The price changes the automatic run makes from these rows. Pure.
export function autoEdits(rows, s) {
  const opts = planOpts(s);
  const out = [];
  for (const r of rows || []) {
    if (['queued', 'sent'].includes(r.last_status)) continue;
    const p = planListing(r, opts);
    if (p.state !== 'change' && p.state !== 'floored') continue;
    out.push({ listing_id: r.listing_id, product_name: r.product_name, style_id: r.style_id, size: r.size, old_amount: r.amount,
      new_amount: p.price, standard_lowest: r.standard_lowest, direct_lowest: r.direct_lowest,
      rule: `Daily auto · ${ruleLabel(s.rule, s.offset)}${p.state === 'floored' ? ` (floor $${p.floor})` : ''}${p.noCost ? ' · no cost' : ` · min profit $${s.minProfit}`}` });
  }
  return out;
}

// Queue today's changes and write what was done on today's row. -> { queued, cutUsd }
export async function queueStockxAuto(rows, s, by = AUTO_BY) {
  const edits = autoEdits(rows, s);
  const ids = await queueStockxEdits(edits, by);
  // queueStockxEdits skips a listing with a change already in flight, so count what went in.
  const cutUsd = ids.length === edits.length ? Math.round(edits.reduce((n, e) => n + (Number(e.old_amount) - Number(e.new_amount)), 0)) : null;
  const auto = { at: new Date().toISOString(), by, queued: ids.length, planned: edits.length, cutUsd, settings: planOpts(s) };
  await saveStockxDaily(estDay(), { auto });
  return auto;
}
