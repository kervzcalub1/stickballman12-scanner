// THE pricing hierarchy PH lists by — one canonical table, shared by the Alias
// resolver (`aliasPriceWithBasis`), the endpoints that persist/validate a basis,
// and the history lines. The PH grid mirrors the display half in `src/lib/ph.js`.
//
//   1  Global Indicator - Consigned     5  Last Sold - Consigned
//   2  Global Indicator - With You      6  Last Sold - With You
//   3  Lowest - Consigned               7  Highest - Consigned
//   4  Lowest - With You                8  Highest - With You
//
// A size takes the FIRST level that has a real price, and EVERY level is marked
// up the same way — Final = value × the configured margin (`app_settings`). The
// level that priced it is recorded on `items.gi_basis` so the grid can show which
// one was used; ranks 1 and 2 keep the original 'consigned' / 'with_you' keys the
// column already held, so rows priced before this shipped still read correctly
// (nothing to backfill).
//
// `field` is the `aliasPriceInsights` field to read; `consigned` is the basis to
// read it from (both bases come from ONE call each, so resolving all 8 levels
// still costs at most 2 Alias calls per size).
export const PRICE_HIERARCHY = [
  { rank: 1, key: 'consigned',           field: 'globalIndicator', consigned: true,  label: 'Global Indicator - Consigned', short: null },
  { rank: 2, key: 'with_you',            field: 'globalIndicator', consigned: false, label: 'Global Indicator - With You',  short: 'WY' },
  { rank: 3, key: 'lowest_consigned',    field: 'lowestListing',   consigned: true,  label: 'Lowest - Consigned',           short: 'LOW' },
  { rank: 4, key: 'lowest_with_you',     field: 'lowestListing',   consigned: false, label: 'Lowest - With You',            short: 'LOW·WY' },
  { rank: 5, key: 'last_sold_consigned', field: 'lastSold',        consigned: true,  label: 'Last Sold - Consigned',        short: 'LAST' },
  { rank: 6, key: 'last_sold_with_you',  field: 'lastSold',        consigned: false, label: 'Last Sold - With You',         short: 'LAST·WY' },
  { rank: 7, key: 'highest_consigned',   field: 'highestOffer',    consigned: true,  label: 'Highest - Consigned',          short: 'HIGH' },
  { rank: 8, key: 'highest_with_you',    field: 'highestOffer',    consigned: false, label: 'Highest - With You',           short: 'HIGH·WY' },
];

// Every valid `items.gi_basis` value. Anything else means "a person typed it".
export const PRICE_BASIS_KEYS = PRICE_HIERARCHY.map((h) => h.key);

export const isPriceBasis = (k) => PRICE_BASIS_KEYS.includes(k);

const BY_KEY = new Map(PRICE_HIERARCHY.map((h) => [h.key, h]));
export const priceBasisStep = (key) => BY_KEY.get(key) || null;

// "Lowest - With You" for a basis key, or '' when it is unknown/manual. Rank 1 is
// the normal case and returns '' too — history lines only call out a fallback.
export function priceBasisLabel(key) {
  const step = BY_KEY.get(key);
  return step && step.rank > 1 ? step.label : '';
}

// A usable price = a positive number. Alias reports 0 cents (→ 0) for a size with
// no demand on that basis, which reads as "no price" — treat 0 as empty.
export const hasPrice = (v) => v != null && Number(v) > 0;

// Walk the hierarchy over two already-fetched `aliasPriceInsights` results (either
// may be null) and return the FIRST level with a real price:
// { value, basis, rank }, all null when no level had one. Pure — the fetching
// lives in aliasPriceWithBasis (alias.js).
export function resolveFromInsights(consignedP, withYouP) {
  for (const step of PRICE_HIERARCHY) {
    const v = (step.consigned ? consignedP : withYouP)?.[step.field];
    if (hasPrice(v)) return { value: Number(v), basis: step.key, rank: step.rank };
  }
  return { value: null, basis: null, rank: null };
}
