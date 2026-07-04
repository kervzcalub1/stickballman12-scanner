// Single source of truth for item statuses on the frontend (keys mirror
// api/_lib/statuses.js). Soft, low-contrast colors so the pills/dropdowns are
// easy on the eyes. `fg` = text color, `bg` = pill background.
export const STATUSES = [
  { key: 'needs_shelf', label: 'Needs Shelf', fg: '#e9c46a', bg: 'rgba(233,196,106,0.14)' },
  { key: 'in_stock',    label: 'In Stock',                   fg: '#7bc99a', bg: 'rgba(123,201,154,0.14)' },
  { key: 'pre_sold',    label: 'Pre-Sold',                   fg: '#b9a3e8', bg: 'rgba(185,163,232,0.16)' },
  { key: 'no_box',      label: 'Bought Without Box',         fg: '#e0a878', bg: 'rgba(224,168,120,0.15)' },
  { key: 'shipped',     label: 'Shipped',                    fg: '#86b3e6', bg: 'rgba(134,179,230,0.16)' },
  { key: 'sold',        label: 'Sold',                       fg: '#9aa0e0', bg: 'rgba(154,160,224,0.16)' },
  { key: 'returned',    label: 'Returned',                   fg: '#e9c46a', bg: 'rgba(233,196,106,0.14)' },
  { key: 'missing',     label: 'Missing',                    fg: '#e08f8f', bg: 'rgba(224,143,143,0.14)' },
  { key: 'issue',       label: 'Issue',                      fg: '#e08f8f', bg: 'rgba(224,143,143,0.14)' },
];

export const STATUS_MAP = Object.fromEntries(STATUSES.map((s) => [s.key, s]));
export const statusLabel = (key) => STATUS_MAP[key]?.label || String(key || '').replace(/_/g, ' ');
export const DEFAULT_STATUS = 'needs_shelf';
