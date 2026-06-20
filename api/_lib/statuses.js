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
export const STATUS_KEYS = [
  'needs_shelf', 'in_stock', 'pre_sold', 'no_box', 'shipped', 'sold', 'returned', 'missing', 'issue',
];

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
