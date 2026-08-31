# Inventory (warehouse browse)

## Who can open it
- **Warehouse / admin / superadmin:** `/inventory`, full page.
- **Where it came from** (2026-08-28): every pair's detail carries a block naming its
  **purchase order, batch and tracking number** — or stating outright that it was *not*
  received against a PO. Same component on `/ph/inventory`, since PH reads this page and
  asks the same question. Full rules (including why the tracking number is the pair's own
  BOX, not its batch) in `docs/context/purchase-orders.md`.
- **PH team:** `/ph/inventory` (card in *Pricing & Listing*) — the **same
  `Inventory` component** rendered by `PHTeamApp` with **`canEditStock={false}`**.
  They get search, filters, groups/units, detail + history, listing photos, labels,
  CSV and **Remove pairs** (they already have that on their own grid). Hidden: the
  **status editor** (group, bulk and detail), **Move to shelf**, and **Add note**.
- That split is enforced **server-side, not by the prop**: `items/query` and
  `items/lookup` accept `ph_team`; `items/bulk-status`, `items/shelve` and
  `items/event` stay `['warehouse']` and answer a PH token with 403. `canEditStock`
  only hides buttons that would fail — it grants nothing. Moving stock between
  statuses/shelves is warehouse work, and `sold`/`shipped` cascades off it
  (`statuses.md`); flip the flag *and* the endpoint roles together if that changes.

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
- Search box: scan a VIN (gun/camera) to open it, or type VIN / SKU / name /
  UPC / colorway. **A shelf code** (`MNH-WH-A2-04`, typed or scanned) returns that
  **shelf's contents** (`queryItems` matches `location_code`); rows/detail show a
  **📍 location chip**. See `locations.md`.
- **A pre-printed 1ID sticker** (`SBM-R-…`) that no pair wears doesn't dead-end in
  "No item found" — the detail view says whether it's **still on the roll, in use,
  voided, or not one of ours**, and a pair wearing one carries a `1ID · in use` chip
  by its VIN. `docs/context/vin-stock.md`.
- **Keyword search, not phrase search.** The query is split on whitespace
  (`searchTokens` in `db.js`) and **every** token must match somewhere — any of
  vin / sku / name / upc / colorway / location_code — so "Kobe Air Force" (or
  "kobe air") finds `Kobe Bryant x Nike Air Force 1 Low 'Triple Black'`, which a
  single `%kobe air force%` LIKE never could: those words aren't adjacent in the
  name. Word order doesn't matter and each extra word narrows rather than kills
  the result. Tokens are escaped for `%` / `_` / `\` (legal in a shoe name; an
  unescaped `_` matches any character). Tokens may match *different* columns, so
  a short numeric one ("1") tends to match every VIN and effectively drops out.
- **Day/Week/Month + Custom** date filter (`DateRangeBar` for day/week/month;
  Inventory also keeps a Custom from/to). The **Supplier** dropdown is the LIVE
  list (`GET /api/suppliers` → `listSuppliers`), not the static `SUPPLIERS`
  constant — that constant is only the fallback if the fetch fails. A vendor
  added during receiving has to be filterable here the same day, so `listSuppliers`
  returns the `suppliers` table **UNION every distinct `batches.supplier_name`**
  (batches received before the name was ever saved still need an option). The
  active filter value is appended if it isn't in the list, so a shared/refreshed
  URL doesn't show "All" over filtered results. Status / **intake** filters
  (intake = receiving | rescale | **in-store**, passed as `kind` to `queryItems`).
- **In-store** units (`b.kind='instore'`) show an **"In-store" chip** in place of
  the PH sync badges (they bypass PH); detail shows "Intake: In-store (store)".
  See `in-store.md`.
- **Click-to-copy** (`CopyText`, same component the PH grid uses — see
  `ph-report.md`): shoe **name** + **SKU** on the list row (desktop table and
  mobile card), **VIN** + **UPC** on each unit in the expanded Units list, and
  name/VIN/SKU/UPC in the single-item detail. UPC is shown **per unit**, never on
  the SKU group — UPCs are per size, and a merged group only carries its first
  unit's. `CopyText` `stopPropagation`s, so **clicking the name copies instead of
  expanding** the row; the caret (and the rest of the row) still expands. On the
  mobile card the SKU line sits *outside* the expand `<button>` — a `role=button`
  can't be nested inside one.
- Bulk **Edit status** → `api/items/bulk-status.js` (`bulkSetStatus`), one
  `status_change` event per VIN; sold/shipped cascades clear sync flags.
- **Print labels** → `LabelSheet` (VIN barcodes, `jsbarcode` CODE128) — a small
  stock-picker dialog, **no on-screen label preview**. Builds an exact-size,
  one-label-per-page **PDF** (`src/lib/labelPdf.js`) instead of `window.print()`
  and hands it to the share sheet / print dialog — see `docs/context/locations.md`
  "Labels" for why (iOS AirPrint mis-scaling + url/date footer) and "One step, not
  three" for the dispatch order.
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

## Removing pairs (miscount fix) + the Deleted archive
- **"Remove pairs…"** on an Inventory group (and **"Remove…"** on a PH New Inventory
  row — `ph-report.md`) opens the shared `RemoveUnitsModal` (`components/common.jsx`).
  Both pages use the same component so the two teams never see different behaviour.
- It's a **quantity editor, not a delete button**: each size shows what's on file and
  takes a new "Keep" count, because "there are 3, not 5" is how the warehouse actually
  finds this — nobody knows *which* two VINs were the phantom pairs. Choosing is
  therefore ours: **newest scanned first** (least likely to be shelved, priced or
  listed), and the exact VINs are **named in the modal before anything happens**,
  since this can't be undone from the UI. An optional reason is stored with the record.
- **"Delete entire row"** clears every size in one click (and the primary button then
  says so, plus a line naming the count and size spread). Zeroing thirteen size inputs by
  hand to clear one shoe was the wrong amount of work — but it's the SAME confirm, with
  the VINs still listed, not a separate one-click nuke on the page.
- **The server REFUSES a call over 1,000 VINs instead of slicing to it.** It used to
  `.slice(0, 200)`, which whole-row delete turns into a trap: a big SKU would report a
  clean success while silently leaving stock behind — the exact miscount this feature
  exists to fix.
- **The rows are genuinely DELETED** (`POST /api/items/delete` → `deleteItems`), not
  re-statused. That was the deliberate call: both pages, every pending count and the
  batch's own received total have to read true after a miscount is corrected, and a
  status change can't deliver that. Note the consequence — a PO's received count and
  therefore its reconciliation move too, which is *right* for a genuine miscount.
- **`sold`/`shipped` pairs are refused** server-side and come back as `blocked`: that
  money already happened, and `sales` cascades off `items`. The UI reports them.
- **Archive first, delete second.** `item_events` is `ON DELETE CASCADE`, so deleting
  the item silently takes its whole history with it. `deleteItems` writes a
  `deleted_items` row per unit inside the same transaction as the delete, holding
  `to_jsonb(i)` (the WHOLE row — not a hand-listed subset, which would quietly drop
  any column added later) plus the unit's full `item_events` as JSONB.
  **Both jsonb params are `JSON.stringify(...)::jsonb`** — node-pg serializes a JS
  array as a Postgres *array literal*, so passing `events` straight through writes
  something that isn't JSON and the insert dies on `invalid input syntax for type json`.
- **Deleted page** (`/deleted`, and `/ph/deleted` for the PH team — `DeletedItems.jsx`,
  `GET /api/items/deleted`): every removed pair, newest first, searchable by **SKU** /
  VIN / name with a removed-on date range, and each row expands to the unit's frozen
  history. Home card in *Browse & Reports*; PH home card under *Help*.
- Roles: warehouse + PH team (admin/superadmin auto-allowed via `requireRole`).
  Rate limit is tighter than bulk-status (20/min vs 30) — this one can't be undone
  from the UI, so a stuck button costs real rows.
