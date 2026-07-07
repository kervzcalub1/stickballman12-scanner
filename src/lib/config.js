// App-wide client config fetched once after auth (see App.jsx). Currently just the
// price margin percent (GI → Final markup). Kept as a module-level value so pure
// helpers like calcFinalPrice (src/lib/ph.js) can read it without prop-drilling;
// App bumps a re-render after loading it so labels/prices reflect the real value.

let markupPct = 20; // default until /api/settings loads (matches the DB seed)

export function getMarkupPct() { return markupPct; }
export function getMarkupMult() { return 1 + markupPct / 100; }
export function markupSuffix() { return `${markupPct}%`; } // e.g. "20%" — for "GI + 20%" labels
export function setMarkupPct(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v >= 0) markupPct = v;
}
