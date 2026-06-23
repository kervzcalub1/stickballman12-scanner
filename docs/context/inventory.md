# Inventory (warehouse browse)

Component: `Inventory` in `src/App.jsx`. Data: `api/items/query.js` →
`queryItems` (per-VIN rows; returns upc/colorway/gender; ORDER BY vin).

## SKU-merge
- Rows are **merged by SKU + status** (regardless of size) via `groupPhRows`
  (shared with the PH report). Each row shows the size breakdown as **qty chips**
  (`SizesQty`) + a total.
- A merged row's checkbox selects **all member VINs** for bulk actions; expand
  shows a per-VIN **Units** list (each links to its detail/history; labels print
  per VIN). Status change on a group applies to all its VINs via bulk-status.

## Features
- Search box: scan a VIN (gun/camera) to open it, or type VIN / SKU / name.
- **Day/Week/Month + Custom** date filter (`DateRangeBar` for day/week/month;
  Inventory also keeps a Custom from/to). Supplier / status / intake filters.
- Bulk **Edit status** → `api/items/bulk-status.js` (`bulkSetStatus`), one
  `status_change` event per VIN; sold/shipped cascades clear sync flags.
- **Print labels** → `LabelSheet` (VIN barcodes, `jsbarcode` CODE128).
- CSV export.

## Status editing
- Per-group dropdown + Save → `bulkStatus(vins, status)`.
- Selling/shipping a unit auto-delists it (clears II/AL/SX/SH) — see `statuses.md`.
