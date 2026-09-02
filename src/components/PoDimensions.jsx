// Declaring how big an empty shoe box is — the one field an empty-box order has that a
// shoe order doesn't, and the one that identifies a line (a 13x9x5 carton and a 15x10x6
// carton of the same SKU are two different things to order, count and pay for).
//
// Two shapes on purpose, because it's declared twice in very different moments:
//   · `DimensionsFields` — three numbers and a unit, for DECLARING. Separate boxes make
//     "which number is which" unambiguous on a phone, and the numeric keypad opens.
//   · a plain text box (`dimsToText` / the server's normaliser) — for CORRECTING one line
//     in a list, where three inputs in a table cell is unreadable. Anything with three
//     numbers in it parses; the server writes back the canonical `L x W x H unit`.
// Both end at the same stored string, normalised server-side once so two people typing
// "13x9x5" and "13 X 9 X 5 in" never declare the same carton twice.
import React from 'react';

export const DIM_UNITS = ['in', 'cm'];
export const emptyDims = () => ({ l: '', w: '', h: '', unit: 'in' });
export const dimsComplete = (d) => ['l', 'w', 'h'].every((k) => {
  const n = Number(String(d?.[k] ?? '').trim());
  return Number.isFinite(n) && n > 0;
});

// The same canonical shape the server writes, so a draft row reads back identically to
// what's stored and a re-declared carton dedupes instead of doubling.
export function dimsToText(d) {
  if (!dimsComplete(d)) return '';
  const n = (v) => String(Math.round(Number(v) * 100) / 100);
  const unit = DIM_UNITS.includes(d.unit) ? d.unit : 'in';
  return `${n(d.l)} x ${n(d.w)} x ${n(d.h)} ${unit}`;
}

// Read a stored string back into the three fields (for editing one that already exists).
export function textToDims(s) {
  const str = String(s || '').trim().toLowerCase();
  if (!str) return emptyDims();
  const nums = str.match(/\d+(?:\.\d+)?/g) || [];
  return {
    l: nums[0] ?? '', w: nums[1] ?? '', h: nums[2] ?? '',
    unit: /\bcm\b/.test(str) ? 'cm' : 'in',
  };
}

export function DimensionsFields({ value, onChange, disabled = false, label = 'Box dimensions', hint = true }) {
  const d = value || emptyDims();
  const set = (patch) => onChange({ ...d, ...patch });
  const num = (k, ph) => (
    <input className="dim-n" type="number" inputMode="decimal" min="0" step="0.1" placeholder={ph}
      value={d[k] ?? ''} disabled={disabled} aria-label={`${label} ${ph}`}
      onChange={(e) => set({ [k]: e.target.value })} />
  );
  return (
    <div className="po-dims">
      {label && <span className="muted xs po-dims-label">{label}</span>}
      <div className="po-dims-row">
        {num('l', 'L')}<span className="po-dims-x" aria-hidden="true">×</span>
        {num('w', 'W')}<span className="po-dims-x" aria-hidden="true">×</span>
        {num('h', 'H')}
        <select className="dim-u" value={d.unit || 'in'} disabled={disabled} aria-label={`${label} unit`}
          onChange={(e) => set({ unit: e.target.value })}>
          {DIM_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      {hint && <span className="muted xs">Outside of the box — length × width × height.</span>}
    </div>
  );
}
