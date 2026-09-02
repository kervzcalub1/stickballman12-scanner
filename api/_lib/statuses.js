// Canonical item-status keys (server-side whitelist). The human labels + colors
// live in the frontend (src/statuses.js); the keys are the contract between
// them. Keep the two in sync.
//
//   needs_shelf  Needs to be Added to Shelf   (default on receive)
//   in_stock     In Stock
//   pre_sold     Pre-Sold
//   no_box       Bought Without Box           (auto when "With Box" unchecked)
//   shipped      Shipped
//   sold         Sold
//   returned     Returned
//   missing      Missing
//   issue        Issue
//   used         Used on a pair   (empty shoe boxes only — the carton is spent)
export const STATUS_KEYS = [
  'needs_shelf', 'in_stock', 'pre_sold', 'no_box', 'shipped', 'sold', 'returned', 'missing', 'issue',
  'used',
];

// Terminal states: a unit here has left active inventory. Reactivating one into a
// sellable status is the "double-sell" loophole — guard rescale + bulk-status
// against it. (sold→shipped and shipped→sold stay allowed; both are terminal.)
// 'used' is terminal for the same reason: an empty box that has gone onto a pair is
// physically gone. Letting it back into a shelvable status would hand one carton to two
// different shoes — the double-sell loophole, wearing a different hat.
export const TERMINAL_STATUSES = ['sold', 'shipped', 'used'];
export const isTerminalStatus = (s) => TERMINAL_STATUSES.includes(s);

// Normalize a status/tag for storage. Returns a preset key as-is, or a sanitized
// CUSTOM tag (free text the warehouse types in the item detail view): trimmed,
// ≤40 chars, limited to safe printable characters. Returns null if invalid.
// The `items.status` column is plain TEXT (no DB enum), so custom tags persist;
// presets get colors/labels from src/statuses.js, customs render as plain pills.
export function normalizeStatus(s) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  if (STATUS_KEYS.includes(v)) return v;
  if (v.length > 40) return null;
  if (!/^[\w \-/&().+]+$/.test(v)) return null;
  return v;
}
