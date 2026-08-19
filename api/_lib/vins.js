// VIN shapes — the single server-side answer to "is this one of our VINs?".
//
// There are TWO series, and both are ours:
//
//   SBM-260819-001234   minted at intake, dated with the day it was received
//   SBM-R-001234        pre-printed ROLL stock ("1ID"), minted before anyone knows
//                       which shoe it will land on, so it cannot carry a date
//
// This lived as six separate copies of the same regex (intake.js, commit.js,
// shelve.js, sign-issue.js, …), which is exactly how a new series gets half-adopted:
// `normalizeItems` NULLS a VIN it doesn't recognise and `insertItems` then mints a
// fresh one, so an unrecognised roll sticker would be silently swapped for a
// different VIN — the shoe would leave the bench wearing a number the system
// doesn't have. One definition, imported everywhere.
export const VIN_RE = /^SBM-(?:\d{6}-\d+|R-\d+)$/i;
export const isVin = (s) => VIN_RE.test(String(s || '').trim());

// The roll series only. `R` is not a valid date segment, so the two can never collide.
export const ROLL_VIN_RE = /^SBM-R-\d+$/i;
export const isRollVin = (s) => ROLL_VIN_RE.test(String(s || '').trim());

// How a roll VIN is rendered from its sequence number. Six digits keeps the barcode
// short (167 CODE128 modules → 0.34 mm bars on a 1" label, which phone cameras read
// first time; the 17-char dated VIN squeezes to 0.26 mm and starts missing).
export const rollVin = (n) => `SBM-R-${String(n).padStart(6, '0')}`;

// A pre-printed sticker scanned onto two different shoes shows up as a UNIQUE
// violation on items.vin — which is the guard working, but it reaches the warehouse
// as "Could not save the batch. Please try again." and retrying can never help.
// Pull the VIN out so the screen can name the sticker that needs pulling off a shoe.
export function duplicateVin(err) {
  if (!err || err.code !== '23505') return null;
  const m = /\(vin\)=\(([^)]+)\)/.exec(err.detail || '');
  if (m) return m[1];
  return String(err.constraint || '').includes('vin') ? 'unknown' : null;
}
