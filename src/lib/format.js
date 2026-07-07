// Date/time formatting + calendar-period helpers shared across screens.

// Live clock, always rendered in US Eastern with a literal "EST" suffix so the
// PH team (in PH time) is never confused about which timezone a time is in.
export const EST_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: '2-digit',
  year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
});

// PH grid timestamps (EST): short date, and date + time.
export const PH_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: '2-digit' });
export const PH_DATETIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true });

// The Day/Week/Month filters must follow the **EST calendar**, not the viewer's
// timezone — the server dates/filters everything by EST (`AT TIME ZONE
// 'America/New_York'`), so a PH user in PH time picking "Today" must get the EST
// day, not their local one. We normalize any instant to the EST calendar day it
// falls on, then do all period math on a **noon-UTC "civil date"** (UTC getters,
// DST- and timezone-immune; noon keeps it on the same calendar day everywhere).
const EST_YMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

// Any Date → the EST calendar day it falls on, as a noon-UTC civil Date.
export function estCivil(date = new Date()) {
  const [y, m, d] = EST_YMD.format(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

// Format a dollar amount, dropping a trailing ".00" (Final prices round to whole
// dollars) but keeping real cents on a manual override. 94 → "94", 94.5 → "94.50".
export const fmtPrice = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

// Today's date as YYYY-MM-DD in EST — NOT `new Date().toISOString().slice(0,10)`,
// which is UTC and rolls over ~4-5h early (evening EST → tomorrow), mis-dating a
// batch/VIN and showing the wrong "Today" in Inventory. Server filters are EST too.
export const estToday = () => ymd(estCivil());

export function periodRange(mode, a) {
  const c = estCivil(a);
  if (mode === 'week') { const s = new Date(c); s.setUTCDate(c.getUTCDate() - c.getUTCDay()); const e = new Date(s); e.setUTCDate(s.getUTCDate() + 6); return [s, e]; }
  if (mode === 'month') return [new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), 1, 12)), new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 0, 12))];
  return [new Date(c), new Date(c)]; // day
}

export function shiftAnchor(mode, a, dir) {
  const n = estCivil(a);
  if (mode === 'week') n.setUTCDate(n.getUTCDate() + 7 * dir);
  else if (mode === 'month') n.setUTCMonth(n.getUTCMonth() + dir);
  else n.setUTCDate(n.getUTCDate() + dir);
  return n;
}

export function periodLabel(mode, a) {
  const c = estCivil(a);
  const opt = (o) => ({ timeZone: 'UTC', ...o }); // c is a noon-UTC civil date
  if (mode === 'month') return c.toLocaleDateString('en-US', opt({ month: 'long', year: 'numeric' }));
  const [s, e] = periodRange(mode, a);
  if (mode === 'day') return s.toLocaleDateString('en-US', opt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }));
  // Week — built explicitly so it reads e.g. "Jun 21 – 27, 2026" (same month),
  // "Jun 28 – Jul 4, 2026" (cross-month), "Dec 29, 2025 – Jan 4, 2026" (cross-year).
  const mon = (d) => d.toLocaleDateString('en-US', opt({ month: 'short' }));
  if (s.getUTCFullYear() !== e.getUTCFullYear()) return `${mon(s)} ${s.getUTCDate()}, ${s.getUTCFullYear()} – ${mon(e)} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  if (s.getUTCMonth() !== e.getUTCMonth()) return `${mon(s)} ${s.getUTCDate()} – ${mon(e)} ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
  return `${mon(s)} ${s.getUTCDate()} – ${e.getUTCDate()}, ${e.getUTCFullYear()}`;
}

// from/to (YYYY-MM-DD) for the current period.
export const rangeOf = (mode, anchor) => periodRange(mode, anchor).map(ymd);
