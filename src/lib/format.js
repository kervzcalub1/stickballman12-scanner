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

export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function periodRange(mode, a) {
  if (mode === 'week') { const s = new Date(a); s.setDate(a.getDate() - a.getDay()); const e = new Date(s); e.setDate(s.getDate() + 6); return [s, e]; }
  if (mode === 'month') return [new Date(a.getFullYear(), a.getMonth(), 1), new Date(a.getFullYear(), a.getMonth() + 1, 0)];
  return [new Date(a), new Date(a)]; // day
}

export function shiftAnchor(mode, a, dir) {
  const n = new Date(a);
  if (mode === 'week') n.setDate(a.getDate() + 7 * dir);
  else if (mode === 'month') n.setMonth(a.getMonth() + dir);
  else n.setDate(a.getDate() + dir);
  return n;
}

export function periodLabel(mode, a) {
  if (mode === 'month') return a.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const [s, e] = periodRange(mode, a);
  if (mode === 'day') return s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  // Week — built explicitly so it reads e.g. "Jun 21 – 27, 2026" (same month),
  // "Jun 28 – Jul 4, 2026" (cross-month), "Dec 29, 2025 – Jan 4, 2026" (cross-year).
  const mon = (d) => d.toLocaleDateString('en-US', { month: 'short' });
  if (s.getFullYear() !== e.getFullYear()) return `${mon(s)} ${s.getDate()}, ${s.getFullYear()} – ${mon(e)} ${e.getDate()}, ${e.getFullYear()}`;
  if (s.getMonth() !== e.getMonth()) return `${mon(s)} ${s.getDate()} – ${mon(e)} ${e.getDate()}, ${e.getFullYear()}`;
  return `${mon(s)} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`;
}

// from/to (YYYY-MM-DD) for the current period.
export const rangeOf = (mode, anchor) => periodRange(mode, anchor).map(ymd);
