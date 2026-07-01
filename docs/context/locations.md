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
Scan a **shelf barcode** → scan each shoe's **VIN** → **Shelve here**.
`POST /api/items/shelve { locationCode, units:[{vin, nowHasBox}] }` → `shelveItems`:
- Boxed unit (or one flagged "has a box now?") → `status='in_stock'` at the shelf.
- A unit still **without a box** keeps `no_box` but its **location is still recorded**
  (locatable, not sellable). "Box now?" → `with_box=true` + `in_stock` (logged as
  box-found). Re-shelving an in-stock unit is a **transfer** (just moves it).
- `GET /api/locations/lookup?code=` resolves a scanned shelf for the page.
- Status stays a preset key (`in_stock`) + a separate location — the "listable"
  rule, filters, and sync badges keep working (see `statuses.md`).

## Locate
- Inventory rows show a **📍 location chip** (one code, or "N shelves"); item detail
  shows "Location: 📍 Manheim Main Shed · A2-04" (`getItemByVin` joins `locations`).
- Inventory search matches `location_code`, so typing/scanning a shelf code
  (`MNH-WH-A2-04`) returns that **shelf's contents**; the camera routes a shelf
  scan → search vs a VIN → detail.

## Locations page (`/locations`, `Locations`, warehouse+admin)
Browse/manage shelves: filter by warehouse/area/active/search; grouped by
warehouse·area with a **live item_count**; expand a shelf → its contents.
**Rename** label, **activate/deactivate**. **Add** one shelf or **bulk-add** a
site's bays (one per line, `A1 5`). Warehouse & Area pickers have a **"＋ Custom…"**
free-text option (`ComboField`) to add a new site/area; the Area picker **suggests
the selected site's own areas first** (`siteAreas`). Endpoints (query-param style):
`GET /api/locations`, `GET /api/locations/items?id=`, `POST /api/locations/{create,bulk,update}`.
db: `listLocations, getLocationByCode, createLocation, bulkCreateLocations,
updateLocation, listItemsAtLocation, shelveItems`.

## Labels (`ShelfLabelSheet`)
Bulk-select shelves on the Locations page → **Print labels** → pick paper. Each
label is an **ATM-card (CR80, 3.375 × 2.125")**: big name (`A2-04`), warehouse·area
line, **CODE128 barcode of `code`**, code text. Paper picker (Letter / A4 / US Legal
/ A5 / 4×6, default Letter) sets `@page` size; cards tile N-up + cut guides.

## Seed / deploy
`scripts/seed-manheim-locations.mjs` (`npm run db:seed-manheim`) generates the
**253** Manheim locations (Warehouse Rows 189 · Pods 4 · Office 8 · Basement 52),
idempotent. On deploy run `db:setup` **then** `db:seed-manheim`. Other sites are
added via the Locations page (single / bulk / custom). See `deploy.md`.
