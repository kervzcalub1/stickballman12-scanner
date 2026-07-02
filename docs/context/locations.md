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
crumb bar. A **breadcrumb** tracks the path and jumps to any ancestor. **Search**
(code/label/bay) re-fetches, narrows the tree, and resets to the root; the
**Show** filter is active/inactive/all. **Add** one shelf or
**bulk-add** a site's bays (one per line, `A1 5`). Warehouse & Area pickers have a
**"＋ Custom…"** free-text option (`ComboField`) to add a new site/area; the Area
picker **suggests the selected site's own areas first** (`siteAreas`). Endpoints (query-param style):
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
