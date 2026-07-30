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
plus **Edit** / **activate-deactivate** / print that one **Label** / **Delete**. The thumb
`photo_url` is `COALESCE(team listing photo ('side' first), items.image_url
catalog image)` from `listItemsAtLocation` — real pair where we have one (~40%),
catalog image otherwise (~95% coverage), logo placeholder as last resort
(`ShoeThumb`); tapping it enlarges the SKU's listing photos or the catalog image
(`PhotoLightbox`). No schema change — both columns already exist. Every tile carries two
corner controls (`.loc-tile-tools`): an **edit pencil** (see "Edit any level" below) and a
**print-selection** checkbox (folders roll up their ids; `Select all` per level); the count +
**Print labels** live in the crumb bar. A **breadcrumb** tracks the path and jumps to any ancestor.

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
`GET /api/locations`, `GET /api/locations/items?id=`,
`POST /api/locations/{create,bulk,update,delete,rename-group,delete-group}`.
db: `listLocations, getLocationByCode, getLocationById, createLocation, bulkCreateLocations,
updateLocation, moveLocation, deleteLocation, deleteLocationGroup, listLocationGroup,
findLocationCodeConflicts, countLiveItemsAt, applyLocationMoves, listItemsAtLocation,
shelveItems`. Code helpers:
`api/_lib/locations.js` (`buildLocationCode, bayRowKey, autoLabelFor, …`).

### Edit any level of the tree (site / area / row / bay)
**Every folder tile carries a pencil** (`.loc-tile-edit`, beside its print checkbox) that opens
`EditGroupModal`; a shelf tile's pencil opens the per-shelf editor below instead. This exists
because **the folder levels are not rows in the database.** `locations` holds one row per
SHELF, and Site / Area / Bay are just its distinct `warehouse` / `area` / `bay` values — while
**Row is derived and stored nowhere at all** (`bayRowKey`/`rowKeyOf` = the bay's leading
letters, shown only when it usefully subdivides a long bay list). So "rename this area" *is*
"rewrite `area` on all 189 shelves under it", which through the per-shelf editor meant 189
passes. That's the gap this closes.

`POST /api/locations/rename-group` → `{ match, patch, dryRun? }`. How much of the path is
pinned in `match` picks the scope — `{warehouse}` = the site, `+area` = one area (`area: null`
is the real "(no area)" folder, hence `coalesce` matching, not `=`), `+bayPrefix` = one derived
row, `+bay` = one bay. `patch` renames in place **or moves the node** (patch an `area` onto a
bay to relocate it). `bayPrefix` in the patch substitutes just the prefix, so row A → B rewrites
`A1…A5` as `B1…B5` and `A10` as `B10`.

- **Barcodes.** The site and area segments are baked into `code` (`MNH-WH-A2-04`), so any of
  these reissues the code on every shelf beneath and every printed label needs reprinting.
  **`dryRun` runs the real endpoint** and returns `{ count, changedCount, liveItems, changes }`;
  the modal previews `from → to` and the affected-pair count live (debounced 350 ms). The code
  builder stays server-side on purpose — mirroring it in the client would drift.
- **Two-pass write.** `applyLocationMoves` parks every affected row on a throwaway `~mv~<id>`
  code, *then* writes the real ones. `locations.code` is a plain non-deferrable UNIQUE checked
  per statement, so any renumbering that shifts or swaps within the group (bay `A1→A2` while
  `A2→A3`) would otherwise collide with a row that is itself about to move. `~` can't appear in
  a real code (`normalizeLocationCode`), so the temporaries can't hit a shelf that isn't moving.
- **Collisions are rejected up front**, not left to a mid-transaction unique violation: two
  shelves landing on one code → 409 naming it; a clash with a shelf *outside* the group →
  409 listing them (`findLocationCodeConflicts`).
- `items.location_code` is rewritten for every unit in the same transaction, and auto-derived
  labels (`A1-03`) follow the move while typed ones are left alone — same rule as a single shelf.
- **Live stock does NOT block it.** Reorganising a rack with pairs on it is the normal case; the
  pairs don't move, only their codes do. The count is stated in the preview and the label sheet
  opens on save, since relabelling is the only part that can't fix itself.
- **Row itself stays uneditable as an entity** — renaming its bays is the only thing that can
  change it, which is exactly what the row scope does.

### Delete any level of the tree (site / area / row / bay)
`EditGroupModal` carries a **Delete {noun}** button (pushed to the far side of the footer, and
below Save/Cancel once they stack at ≤600px — a destructive action shouldn't sit a mis-tap away
from the one you came for). It opens `DeleteGroupModal`, a separate confirm with its own count.

`POST /api/locations/delete-group` → `{ match, dryRun? }` → `{ count, deleted, liveItems,
detached, shelves }`. `match` is scoped **exactly as in `rename-group`** (`{warehouse}` = the
site · `+area` = one area, `area: null` being the real "(no area)" folder · `+bayPrefix` = one
derived row · `+bay` = one bay), for the same reason: the folders aren't rows, so "delete this
area" IS "delete the 189 shelves under it". The modal opens on a `dryRun` through the **same
endpoint that does the write**, so the number on the button is the number that will go.

- **Live stock blocks the whole thing** (409, naming the count) and **nothing is deleted** —
  a half-deleted rack is worse than a refusal, so it's all-or-nothing rather than the empty
  shelves going and the occupied ones staying. This is the opposite call from a rename, where
  live stock is fine because the pairs don't move, only their codes do.
- **Sold/shipped units are detached** (`location_id = NULL`, `location_code` kept as history) in
  the same transaction, so an old, long-closed rack isn't permanently undeletable — same rule as
  the single-shelf delete, applied to the set (`deleteLocationGroup(ids, { dryRun })`).
- The print selection is cleared on success (it may have held ids that no longer exist), and the
  URL needs no fix-up: you're standing on the **parent** of the tile you deleted.
- **Deactivating is still the way to retire shelves you might want back** — delete is for
  levels that shouldn't exist (a mis-typed site, a rack that was torn out).

### Edit / move / delete a shelf
**Edit** opens `EditShelfModal` (a form on the raw `.modal` shell, `.modal.loc-edit-modal` to
out-specify the base rules) with **Display name + Site / Area / Bay / Shelf #**. Two shapes
behind one endpoint (`locations/update`):
- **label / active only** — the original cheap patch (`updateLocation`), `codeChanged: false`.
- **any structural field** — a **move**: the patch is merged onto the current row, the
  scannable `code` is **rebuilt server-side** from the new parts (same `buildLocationCode` as
  create), and `items.location_code` is rewritten **for every unit on the shelf in the same
  transaction** (`moveLocation`) — that snapshot has no FK, so leaving it behind would strand
  the stock on a barcode that no longer resolves. A collision on the unique `code` → **409**.
  The response carries `codeChanged` + `previousCode`; the client shows "Moved to X (was Y) —
  reprint it" and **opens the label sheet**, then re-opens the shelf at its **new URL** (the
  tile path is derived from site/area/bay/shelf, so the old path is dead — `pendingNav` defers
  the navigate to an effect, after the reloaded list has rebuilt the tree). A **display name
  still on its auto default** (`A1-03`) follows the move; a name someone typed is never
  overwritten (`labelTouched`).

**Delete** (`locations/delete`, `deleteLocation`) is a hard delete behind a confirm `Modal`,
reachable both from the open shelf's detail view and from `EditShelfModal` (the tile's pencil),
so removing a shelf doesn't mean drilling into it first. The confirm only steps the URL back to
the parent when you're **standing on** that shelf — from a tile you're already on the parent
level, and navigating up again would overshoot.
`items.location_id` is a real FK with **no `ON DELETE` rule**, so the check happens first and
returns a usable reason instead of a 500: **live stock blocks it** (409, "N pairs are still
shelved here — move them, or deactivate this one instead"), while **sold/shipped units are
detached** (`location_id = NULL`, `location_code` kept as a historical breadcrumb, and the
`shelved` item_event records it regardless) so a long-empty old shelf isn't held hostage by a
closed unit. **Deactivate is still the normal way to retire a shelf** — it keeps the history
and the put-away guard (`items/shelve` 409s on an inactive shelf); delete is for shelves that
shouldn't exist.

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
