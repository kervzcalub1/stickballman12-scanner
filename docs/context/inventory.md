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
  **A shelf code** (`MNH-WH-A2-04`, typed or scanned) returns that **shelf's
  contents** (`queryItems` matches `location_code`); rows/detail show a **📍
  location chip**. See `locations.md`.
- **Day/Week/Month + Custom** date filter (`DateRangeBar` for day/week/month;
  Inventory also keeps a Custom from/to). Supplier / status / **intake** filters
  (intake = receiving | rescale | **in-store**, passed as `kind` to `queryItems`).
- **In-store** units (`b.kind='instore'`) show an **"In-store" chip** in place of
  the PH sync badges (they bypass PH); detail shows "Intake: In-store (store)".
  See `in-store.md`.
- Bulk **Edit status** → `api/items/bulk-status.js` (`bulkSetStatus`), one
  `status_change` event per VIN; sold/shipped cascades clear sync flags.
- **Print labels** → `LabelSheet` (VIN barcodes, `jsbarcode` CODE128).
- CSV export.

## Listing photos (thumbnails + detail view/delete)
- Every list row shows a `ShoeThumb` — the SKU's listing photo (side view preferred,
  from `queryItems.photo_url`), falling back to `logo.png` when there are none.
- The **item detail** view has a **Listing photos** panel: view each angle (opens
  full size), **delete** a photo (`api/photos/remove`, warehouse/admin), and
  **Download** (single image, or a `.zip` for 2+ via `api/photos/download`).
- Photos are per-SKU (`product_photos`, R2); see `ph-report.md` for the shared
  `ShoeThumb`/`PhotosModal` and the server-side zip (`api/_lib/zip.js`).

## Status editing
- Per-group dropdown + Save → `bulkStatus(vins, status)`.
- Selling/shipping a unit auto-delists it (clears II/AL/SX/SH) — see `statuses.md`.
- **In Stock ⟺ shelved:** picking "In Stock" for an unshelved unit doesn't write
  a status — it opens **Move to shelf** (server also 409s the raw path). See the
  in-stock invariant in `statuses.md`.

## Move to shelf (put-away from Inventory)
- Places selected units on a scanned shelf **without leaving Inventory** — the
  same op as `/shelve`, reusing `POST /api/items/shelve` (`shelveItems`), so a
  boxed unit flips to **In Stock** at that location (no-box stays no_box but is
  located). Available three ways: a **group** button (all unshelved units of a
  SKU), the **bulk bar** button (all unshelved selected VINs — pick individual
  units via their checkboxes), and the **item detail** view (one VIN).
- The modal scans/types a shelf barcode (camera or gun), resolves it via
  `locationLookup` to confirm the shelf name, lists the units, then **Shelve N
  here**. On success the list refreshes so moved units show their shelf chip.
