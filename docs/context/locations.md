# Shelf locations (put-away, locate, labels)

Where each unit is physically stored. Full design/rationale:
`docs/shelf-location-system-plan.md`.

## Model
- **`locations`** table — one row per shelf spot. `code` (UNIQUE) is the scannable
  barcode value, globally unique: **`SITE-AREA-BAY-SHELF`** (e.g. `MNH-WH-A2-04`);
  whole-bay spots (pods) omit the shelf → `MNH-PD-1`. Plus `warehouse, area, bay,
  shelf, label (big text on the tag, e.g. "A2-04"), active, sort_order`.
- **`items.location_id`** (FK) + **`items.location_code`** (denormalized snapshot
  for fast search/print). Set together at shelve time.
- `item_events` gets `type='shelved'` (`{ locationCode, label, from, gotBox }`);
  `eventLabel` renders "Shelved at A2-04 (box found → With Box)".

## Code scheme (`api/_lib/locations.js`)
`SITE-AREA-BAY-SHELF`. Site/area prefixes from `SITE_PREFIXES`/`AREA_PREFIXES`
(MNH/MTJ/KRF · WH/PD/OF/BS); **custom** sites/areas derive a prefix
(`sitePrefixFor`/`areaPrefixFor` → `derivePrefix`), e.g. "Downtown Depot · Loft" →
`DOW-LO-…`. `bayCodeFor` uppercases + strips spaces. `isLocationCode` (mirrored in
`src/lib/codes.js`) tells a shelf barcode from a VIN / UPC. **Area is per-row +
tied to its warehouse — sites can have entirely different areas (or none).**

## Shelve / Put-away (`/shelve`, `ShelvePage`, warehouse+admin)
Two modes (tabs): **Scan shelf → shoes** (classic: scan a shelf barcode → scan each
VIN → Shelve here) and **Pick from pending list** — a selectable list of `needs_shelf`
shoes (grouped by SKU) → assign a shelf by **scanning** OR the hierarchical
**`ShelfPicker`** (search + Site→Area→Bay→Shelf drill, `src/components/ShelfPicker.jsx`).
Every scan gets loud feedback (`pulse()` → colored `.scan-flash` banner + row
highlight + best-effort `navigator.vibrate`): green for shelf-set / VIN-added,
amber for duplicate/rejected. A VIN already on the list is refused (each per-box
VIN is unique). **Camera dedupe gotcha (fixed):** `CameraScanner`'s decode loop
lives in an effect keyed on `[deviceId, restartKey]`, so it must call
`onDetectedRef.current` (a ref synced each render) — capturing `onDetected`
directly froze `routeScan` at mount with an empty `rows`, so continuous mode
re-added the same VIN. It also fires each code once per appearance (`firedRef`).
`POST /api/items/shelve { locationCode, units:[{vin, nowHasBox}] }` → `shelveItems`:
- Boxed unit (or a no-box one flagged "box found now") → `status='in_stock'` at the shelf.
- **A no-box unit without a confirmed box is REFUSED** (`results[].reason='no_box'`,
  `noBoxBlocked` count) — a boxless shoe can't go on a shelf. "Box found now?" →
  `with_box=true` + `in_stock` (logged as box-found). Re-shelving an in-stock unit is a
  **transfer**. Inventory's "In Stock" put-away shows a per-unit **"Box found now"**
  toggle for no-box units; unticked → refused, pointing to the No-Box queue.
- `GET /api/locations/lookup?code=` resolves a scanned shelf; `GET /api/locations`
  (active) feeds the `ShelfPicker`.
- Status stays a preset key (`in_stock`) + a separate location — the "listable"
  rule, filters, and sync badges keep working (see `statuses.md`).

## Locate
- Inventory rows show a **📍 location chip** (one code, or "N shelves"); item detail
  shows "Location: 📍 Manheim Main Shed · A2-04" (`getItemByVin` joins `locations`).
- Inventory search matches `location_code`, so typing/scanning a shelf code
  (`MNH-WH-A2-04`) returns that **shelf's contents**; the camera routes a shelf
  scan → search vs a VIN → detail.

## Locations page (`/locations`, `Locations`, warehouse+admin)
Browse/manage shelves as a **drill-down tile view** (like a desktop file
manager): Site → Area → (Row) → Bay → Shelf → shoes. Each level is a full-width
**responsive tile grid** (`repeat(auto-fill, minmax(160px,1fr))`) that wraps to
any screen — **no columns, no horizontal scroll** — so it reads the same on a
warehouse phone as on a wide monitor. Clicking a tile **pushes a real URL
segment** so every level is deep-linkable and browser/device **Back** drills up:
`/locations/manheim-main-shed/warehouse-rows/a/a2/4`. The screen owns its
sub-path (like `PHTeamApp` owns `/ph/*`): `segsFromPath`/`pathFromSegs` +
`pushState`, a `popstate` listener, and `resolve()` walks the tree by URL slug →
current position + breadcrumb `trail`. Segments are slugged real names (unique
per level), so refresh restores the exact tile.

An **adaptive Row/aisle level** sits between Area and Bay only where it subdivides
a long bay list: the row key is derived from the bay's leading letters
(`A1,A2 → "A"`, `Pod 1 → "POD"`; `rowKeyOf`), shown when the bays fall into `≥2`
groups fewer than the bays (`Ar.grouped`) — so Warehouse Rows (44 bays → 10 rows
A–K) and Basement (18 → A,B) get it, while Pods/Office (one group) skip straight
to bays. **Whole-bay pods** (single location, `shelf=null`) skip the shelf level —
the bay tile opens its shoes directly.

The tree is built client-side from one `locationList({ active, q })` fetch; every
tile shows a **live item_count** (folders aggregate). The last level (a shelf, or
a whole-bay pod) loads its contents lazily (`locationItems`) and shows the shoes
as rows with a **thumbnail** + name / `US size` chip / status pill / `vin · sku`,
plus **Rename** / **activate-deactivate** / print that one **Label**. The thumb
`photo_url` is `COALESCE(team listing photo ('side' first), items.image_url
catalog image)` from `listItemsAtLocation` — real pair where we have one (~40%),
catalog image otherwise (~95% coverage), logo placeholder as last resort
(`ShoeThumb`); tapping it enlarges the SKU's listing photos or the catalog image
(`PhotoLightbox`). No schema change — both columns already exist. **Print-selection** checkboxes sit on every tile (folders roll
up their ids; `Select all` per level); the count + **Print labels** live in the
crumb bar. A **breadcrumb** tracks the path and jumps to any ancestor.

**Locate Shoe** — the page/card is titled **Locate Shoe** (warehouse ops look for
a shoe, not a shelf). The search box runs a **shoe search**
(`api.itemsQuery({ q })` by name / SKU / VIN / **UPC**, `runLocate`; `queryItems`
matches `i.upc` too). Hits are **grouped by SKU** (`.loc-sku-group`): one header
(thumbnail + name + `SKU · N shelved · M not shelved` summary) then compact
per-unit rows with **fixed-width aligned columns** — `VIN | US size | status |
where`. The `where` column is a **shelf chip** (`loc-locate-chip`, `Icon
name="pin"`) that resolves `location_code` → the shelf's tile path
(`segsForLocation`, mirrors `resolve()`) and **jumps to that shelf** on click, or
an amber **"Not shelved yet"** chip — so you know you *have* the pair, it just
isn't on a shelf. The redundant `needs_shelf` status pill is suppressed (the amber
chip already says it), and on ≤480px the empty status column collapses. When every hit shares one SKU (e.g.
a size-specific UPC scan), a **"↕ Show all sizes of {SKU}"** button re-runs the
search by SKU to surface all sizes.

**Camera scan** — a **📷 Scan** button opens the lazy `CameraScanner`
(`mode='rescale'` reads both **CODE-128 VINs and UPC/EAN**); `routeScan` feeds the
decoded value into the same shoe search, so scanning a VIN label *or* a box UPC
locates the pair. Browsing the tiles down to a shelf gives the reverse — **what
shoes are on this shelf**. The **Show** filter is active/inactive/all (browse
only). **Add** one shelf or
**bulk-add** a site's bays (one per line, `A1 5`). Warehouse & Area pickers have a
**"＋ Custom…"** free-text option (`ComboField`) to add a new site/area; the Area
picker **suggests the selected site's own areas first** (`siteAreas`). Endpoints (query-param style):
`GET /api/locations`, `GET /api/locations/items?id=`, `POST /api/locations/{create,bulk,update}`.
db: `listLocations, getLocationByCode, createLocation, bulkCreateLocations,
updateLocation, listItemsAtLocation, shelveItems`.

## Labels (`ShelfLabelSheet`)
Bulk-select shelves on the Locations page → **Print labels** → pick label stock.
Each label has a big name (`A2-04`), warehouse·area line, **CODE128 barcode of
`code`**, code text. Printing builds an **exact-size, one-label-per-page PDF**
(`src/lib/labelPdf.js`, `LABEL_STOCKS` — CR80 card default, plus Small **1.1 ×
3.5"**/Rollo/Dymo/Box/Brother **62 × 100 mm DK-11202**), not a `window.print()`
of the page. VIN labels **omit the shoe name on any stock smaller than 62 × 100 mm**
(`NAME_MIN_SHORT_MM`) — SKU + size + VIN barcode is all shelving needs, and the
name just shrinks what actually gets scanned on a small label. This is
deliberate: iOS Safari/AirPrint ignores CSS `@page { size }` and force-injects a
url/date/"Page X of Y" footer, so page-printing came out mis-scaled with the site
URL along the bottom and one label spilled across two sheets. A PDF whose page IS
the label prints 1:1 (no browser chrome), batches as multi-page, and works on
iPhone → Brother QL as well as desktop. Same mechanism backs `LabelSheet` (VIN /
box labels). On touch devices we open the PDF in a new tab (share → Print); on
desktop we auto-print via a hidden iframe.

## Seed / deploy
`scripts/seed-manheim-locations.mjs` (`npm run db:seed-manheim`) generates the
**253** Manheim locations (Warehouse Rows 189 · Pods 4 · Office 8 · Basement 52),
idempotent. On deploy run `db:setup` **then** `db:seed-manheim`. Other sites are
added via the Locations page (single / bulk / custom). See `deploy.md`.
