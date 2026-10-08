// Waitlist — pure helpers shared by the New Inventory Waitlist tab (browser) and the
// daily report the server sends on Telegram (api/_lib/waitlist-worker.js), so the file a
// person downloads and the one that arrives at the end of the shift are the same file.
// docs/context/waitlist.md.
import { estDate, estCivil, ymd } from './format.js';
import { calcPayout, DEFAULT_FEE_PCT } from './payout.js';
import { buildXlsx } from './xlsx.js';

// How long a pair is held when nobody says otherwise: a month (the owner's "wait a
// month before we list it"), with the shorter holds a button away.
export const WAITLIST_DEFAULT_DAYS = 30;
export const WAITLIST_DAY_CHOICES = [7, 14, 30, 60];

// The EST calendar date `days` from now, as the END of that EST day — "back on Nov 8"
// means the pair is on Nov 8's list, not that it reappears at 7pm on Nov 7 because the
// server counted 30 × 24 h from the moment the button was pressed.
export function waitlistUntil(days, now = new Date()) {
  const d = estCivil(now);
  d.setUTCDate(d.getUTCDate() + Math.max(1, Math.min(365, Number(days) || WAITLIST_DEFAULT_DAYS)));
  // Midnight EST at the START of that day: the hold ends as that day begins.
  return `${ymd(d)}T00:00:00${estOffset(d)}`;
}

// EST or EDT for a civil date — "America/New_York" moves, and a hold that ends at
// 01:00 instead of 00:00 for half the year is a small lie on every row.
function estOffset(civil) {
  const probe = new Date(Date.UTC(civil.getUTCFullYear(), civil.getUTCMonth(), civil.getUTCDate(), 12));
  const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value;
  return name === 'EDT' ? '-04:00' : '-05:00';
}

// Whole EST days until a pair comes back (0 = today).
export function waitlistDaysLeft(until, now = new Date()) {
  if (!until) return null;
  const a = estCivil(now); const b = estCivil(new Date(until));
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// What a pair would make right now at the cached lowest asks, after each platform's fee
// — the number the review is deciding on ("has the market come back yet?"). Blank when
// there is no cost or no ask: "we don't know" must not print as a profit.
export function waitlistMarketNow(row) {
  const cost = Number(row.cost);
  if (!(cost > 0)) return { best: '', profit: null };
  const opts = [['Alias', 'alias', row.alias_ask], ['StockX', 'stockx', row.stockx_ask]]
    .filter(([, , ask]) => Number(ask) > 0)
    .map(([label, key, ask]) => ({ label, ...calcPayout(key, Number(ask), cost, DEFAULT_FEE_PCT[key]) }));
  if (!opts.length) return { best: '', profit: null };
  const top = opts.reduce((a, b) => (b.profit > a.profit ? b : a));
  return { best: top.label, profit: top.profit };
}

// The report's columns. Money and counts are real NUMBERS in the file (they sort and sum);
// everything else is text. VINs are capped narrower — the cell still holds them all.
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const COLS = [
  ['SKU', 'text', (r) => r.sku],
  ['Name', 'text', (r) => r.name],
  ['Size', 'text', (r) => r.size],
  ['Qty', 'int', (r) => num(r.qty)],
  ['Cost ea', 'money', (r) => num(r.cost)],
  ['Global Indicator', 'money', (r) => num(r.global_indicator)],
  ['Final price', 'money', (r) => num(r.price)],
  ['Alias ask (cached)', 'money', (r) => num(r.alias_ask)],
  ['StockX ask (cached)', 'money', (r) => num(r.stockx_ask)],
  ['Best now', 'text', (r) => waitlistMarketNow(r).best],
  ['Profit/pr now', 'money', (r) => num(waitlistMarketNow(r).profit)],
  ['Waitlisted on (EST)', 'text', (r) => (r.waitlisted_at ? estDate(r.waitlisted_at) : '')],
  ['Waitlisted by', 'text', (r) => r.waitlisted_by],
  ['Back on (EST)', 'text', (r) => (r.waitlist_until ? estDate(r.waitlist_until) : '')],
  ['Days left', 'int', (r) => waitlistDaysLeft(r.waitlist_until)],
  ['Reason', 'text', (r) => r.note],
  ['Supplier', 'text', (r) => r.suppliers],
  ['Batch', 'text', (r) => r.batches],
  ['VINs', 'text', (r) => r.vins, 40],
];

// The daily report as an Excel file — columns sized to their text, header bold and
// frozen, a filter on every column (src/lib/xlsx.js). A CSV can't carry any of that.
export function waitlistXlsx(rows) {
  return buildXlsx({
    sheetName: 'Waitlist',
    columns: COLS.map(([label, type, , maxWidth]) => ({ label, type, ...(maxWidth ? { maxWidth } : {}) })),
    rows: (rows || []).map((r) => COLS.map(([, , get]) => get(r))),
  });
}

export const waitlistFileName = (day) => `waitlist-${day}.xlsx`;
