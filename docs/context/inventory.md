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

## Correcting a style code (2026-09-17)
`api/items/set-sku.js` (GET preview + POST) · `findSkuSiblings` / `setItemsSku` in db.js ·
`SkuEditModal` in `Inventory.jsx` (the ✎ beside SKU on the item detail, warehouse/admin/PH).
E2E: `e2e/inventory-edit-sku.spec.js`.

**Why:** a box UPC does not always name one style code forever. Jordan re-coded
553558-100 → 553558-136 for size 10.5 in 2022 and kept the barcode (196149780863), so a
scan of that box resolves to -100 through the catalogue while the box says -136. The
warehouse can read the code on the box; the API cannot. Nothing else on the unit is wrong.
- **One field.** VIN, UPC, size, cost, location, status all stay. The UPC stays on
  purpose — the barcode is the truth about the box; the catalogue's answer was the error.
- **Look up the new code first** (`sku-search`): the name / colorway / image travel with
  it, each only when the catalogue returned one (`coalesce`) — a -136 under a -100's name
  is half a fix. A code the catalogue does not know can still be saved; the name stays.
- **Scope:** *just this pair*, or *this pair and the N others scanned in the same way* =
  same old code **and** same size **and** same box UPC (a unit with no UPC matches on code
  + size within its own batch). Never a different size — the 9 may genuinely still be
  -100. The count is fetched (GET) before anyone commits.
- **Listed pairs are corrected too**, and counted back (`listed` = any `synced_*` or
  `added_to_intel_inv`): our record has to be right, but the listing on the store still
  carries the old code and PH fixes that by hand. The modal and the notice both say so.
- Every unit gets a `note` event: `SKU changed 553558-100 → 553558-136 (name) — reason`,
  with `sku_from` / `sku_to` in `details` so it is queryable.
- Same code → 400; a code that fails `SKU_RE` → 400. No schema change.

## SKU-merge
- Rows are **merged by SKU + status** (regardless of size) via `groupPhRows`
  (shared with the PH report). Each row shows the size breakdown as **qty chips**
  (`SizesQty`) + a total.
- A merged row's checkbox selects **all member VINs** for bulk actions; expand
  shows a per-VIN **Units** list (each links to its detail/history; labels print
  per VIN). Status change on a group applies to all its VINs via bulk-status.
- **A size chip is a filter (2026-09-15).** `SizesQty` takes `onPick`/`active`; on
  Inventory (row, mobile card, and the detail's Sizes line) tapping a chip opens the
  row narrowed to that size (`sizePick[g.key]`, `pickSize`). The Units list, Location,
  and **every action's count** — Print labels (n), Move to shelf (n), Remove pairs, and
  the group Status ("size 7W · 3") — act on the narrowed set. Same chip again, or "Show
  all N", widens it. PH's use of `SizesQty` passes no `onPick` and stays plain text.
  `e2e/inventory-size-chip.spec.js`.

## Features
- Search box: scan a VIN (gun/camera) to open it, or type VIN / SKU / name /
  UPC / colorway. **A shelf code** (`MNH-WH-A2-04`, typed or scanned) returns that
  **shelf's contents** (`queryItems` matches `location_code`); rows/detail show a
  **📍 location chip**. See `locations.md`.
- **A pre-printed 1ID sticker** (`SBM-R-…`) that no pair wears doesn't dead-end in
  "No item found" — the detail view says whether it's **still on the roll, in use,
  voided, or not one of ours**, and a pair wearing one carries a `1ID · in use` chip
  by its VIN. `docs/context/vin-stock.md`.
- **Apparel sizes sort by their own scale** (`apparelRank` / `compareSizes` in
  `src/lib/codes.js`). Both naive readings are wrong in a way that looks like a bug:
  alphabetically it is `L, M, S, XL, XS`, and `sizeNum` reads the **2 inside "2XL"** and
  files a garment among the toddler shoes. Nike writes `XXL` and `2XL` interchangeably, so
  both spell the same rank. Every size list — the PH grid rows and per-size drawer, the
  Costs page, `SizesQty` — goes through `compareSizes` rather than its own `sizeNum`
  sort, so one rule orders them all. Pinned by `e2e/sku-search-fallback.spec.js`.
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
  Inventory also keeps a Custom from/to).
  - **A search and a date range compose — the server has always taken both at once**
    (`load` merges `q` with `from`/`to` into one `queryItems` call). Searching still
    **widens** the window to all dates, because a SKU scoped to today usually finds
    nothing and the empty result would read as "we don't have it". Picking a date range
    afterwards is a deliberate *narrowing* and keeps the search (2026-09-18) — the
    Day/Week/Month buttons and the ‹ › steppers all run through `gotoPeriod`, which used
    to clear `q` and so threw away what the user had just typed the moment they tried to
    narrow it. **`Today` is the exception and still clears everything**: it resets
    supplier / status / intake too, so it is a "back to the default view" button rather
    than a date control. Guarded by `e2e/inventory-search-date.spec.js`.
  - The empty state's two remedies both RUN, rather than only staging a filter: **Try
    this month** goes through `gotoPeriod` (it used to set the segment alone, so it lit
    up Month and handed back the same empty table) and **Show all dates** loads its own
    cleared range instead of waiting for Apply.
  The **Supplier** dropdown is the LIVE
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

## Rapid scan (2026-09-02)
A **Rapid scan** toggle on the search row (persisted per device as `prefs.rapidScan`).
Off — the default — a scanned VIN opens that pair's detail, which is right when you are
looking one pair up. On, a scan **appends to a running list instead of navigating**, so
walking a shelf with a gun stops being scan → read → Back → scan. The camera runs
`continuous` only in this mode; outside it the first scan navigates away and a decoder
running behind the detail view is just battery.

`ScanSession` (in `Inventory.jsx`) renders the list newest-first — the pair just scanned
sits under the operator's thumb. Each row is a button into the full detail, and **the
session survives that trip**: `openDetail` only changes `mode`, so Back comes back to a
list with every scan still on it. Rows carry the same four answers the detail view gives:
a found pair (name · SKU · size · shelf + status pill), a **1ID sticker** with its
`vin_stock` state (reusing `.sr-state`, so an unused sticker is an answer and not an
error), and a plain not-found. Re-scanning a pair already listed **bumps a `scanned ×N`
count and floats it back to the top** rather than stacking a duplicate — on a shelf walk
the same pair genuinely gets crossed twice, and two identical rows read as two pairs.
`isCameraReread` guards the camera only: a gun fires once per trigger pull, so a
deliberate second scan must always count.

It is a **lookup and nothing more** — no staged edit, no bulk commit. Marking a batch of
pairs sold or shelved already has its own screens (`StatusScanPage`, Move to shelf), and
growing a second one behind a scanner is how two screens end up disagreeing about what a
scan means. A shelf barcode still searches that shelf's contents in either mode; it isn't
a pair, so it has nothing to add to a scan list.

Guarded by `e2e/inventory-rapid-scan.spec.js` (six cases, including that the toggle OFF
still opens the pair). Note for anyone writing tests here: **the detail view has its own
`.searchrow`** (the custom-tag row), so "did it navigate" must assert on the
*Back to list* button, not on input counts.

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

### Deleting a whole batch (2026-09-16)
**Delete batch…** on the Batch page (warehouse + PH; not read-only views) →
`POST /api/batches/delete { batchId, reason }` → `deleteBatch`. Every pair goes through
`deleteItems` (one `deleted_items` tombstone each, reason prefixed "Batch deleted: …",
so the Deleted page shows them), then the batch row is archived as JSON in
**`deleted_batches`** (`batch_json` = the row + its `batch_boxes` + `shipment_issues`,
which cascade, + the VINs) and deleted. The references that do NOT cascade are cleared
in the same transaction: `purchase_orders.received_batch_id`, `batches.merged_into_batch_id`,
`batches.duplicate_of`. Needs **`db:setup`** (new table).
- **Refused whole while any pair is sold/shipped** (409 naming the count), checked
  BEFORE `deleteItems` — otherwise the live pairs would go and the sold ones would be
  left in a batch that then could not be removed. Remove the unsold pairs instead.
- Consequences are the same as a miscount fix, at batch scale: counts, the PO's
  received total and reconciliation, and the pending queues all move.
- `e2e/batch-delete.spec.js`.
