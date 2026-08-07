# PH report / grid

Component: `PHGrid` in `src/App.jsx`. Endpoints: `api/ph/list.js`
(`phListItems(from,to,kind)`), `api/ph/update.js` (`phUpdateItems`),
`api/ph/locks.js` (edit-lock presence).

The admin/warehouse Home card + page title for this grid is **"Listings & Sync"**
(the old "Report" name); the code route/key is still `report`.

## kinds
- `kind=null` — admin/warehouse **Listings & Sync**: everything in range (incl no_box), by scan date.
- `kind='receiving'` — PH "New Inventory": newly received (excludes rescale
  batches + no_box), by scan date.
- `kind='rescale'` — PH "Rescale Stock": `restock_pending` units, by rescale-event
  date (see `rescale.md`).
- **`kind='instore'` is excluded from ALL of the above** (both `phListItems`
  branches) — in-store buys bypass PH entirely; they're listed to stores by hand on
  the In-Store Listing page. See `in-store.md` for every guard.

## SKU-merge — expandable per-size rows (`groupPhSized`)
- One **collapsed row per SKU + status**: Date · Shoe · SKU · size×qty chips ·
  total Qty · Status · sync badges (`SyncBadges`) · Edit. Click the row (or the
  caret) to **expand** a detail drawer; editing auto-expands it.
- The drawer holds a **per-size table** — `Size | Qty | Cost | Global indicator |
  Final price | II | AL | SX | SH | Note` — because **every editable field is per
  SIZE** (cost/GI/final price/flags/note can all differ; `~` marks units that differ
  within a size). The collapsed-row `SyncBadges` is the group summary (a flag reads
  "on" only if **all** units have it).
- The PH-team Inventory browse page still uses the merged `groupPhRows`.
- **Click-to-copy (PH work pages only):** on **New Inventory** (`kind='receiving'`)
  and **Rescale** (`kind='rescale'`), the shoe **name** and **SKU** are wrapped in
  `CopyText` (`common.jsx`) — clicking either copies it to the clipboard (brief
  "Copied ✓" cue) and `stopPropagation`s so the row doesn't expand. Gated by
  `canCopy` (excludes the admin/warehouse `kind=null` "Listings & Sync" grid).
  Admin/warehouse get the same affordance on **Inventory** and **Box Labels**
  (`inventory.md`, `no-box.md`), not on this grid.
- **Frozen columns** (`ph.js` `frozenStyle`/`rightStyle`): left = Date/Title/SKU/Qty;
  right = **Action + Added by** (both sticky, kept together). Their contents **wrap**
  inside the fixed column width (`.ph-addedby`, `.ph-rfrozen-first`) rather than
  expanding it, so the two right columns' sticky offsets stay aligned. The **expanded
  per-size drawer is pinned left** (`.ph-drow > td { position: sticky; left: 0 }`) so
  it stays under the frozen columns instead of drifting with the middle scroll.

## Editable fields (one Edit ⇄ Submit per group)
- **Per size**: Global indicator (number) → **Final price auto-calculates** = GI ×
  markup, **rounded to the nearest whole dollar** (`calcFinalPrice`; server
  `roundFinal` in intake.js, `round()` in db.js). The markup is the **configurable
  price margin** (default +20%), NOT a hard-coded constant: client reads it from
  `src/lib/config.js`, server from `getPriceMarkupMult()` (db.js,
  `app_settings.price_markup_pct`); admin/superadmin edit it on the Settings screen.
  All "GI + N%" labels render `markupSuffix()`. Final price stays editable so it can
  be overridden (a manual override may carry cents; `fmtPrice` in format.js shows
  whole dollars without a trailing `.00` and keeps real cents).
- **Pricing hierarchy + basis chip**: every automatic price walks the 8-level
  `PRICE_HIERARCHY` — Global Indicator → Lowest → Last Sold → Highest, consigned
  before "With You" — and takes the first level Alias has a real price for
  (`aliasPriceWithBasis`; full table in `integrations.md`). The level is persisted
  on `items.gi_basis` and shown beside the value as a small chip (`BasisChip` in
  `components/common.jsx`, labels in `src/lib/ph.js` `PRICE_BASES` — a mirror of the
  server table, keep them in step): nothing for rank 1, then **WY / LOW / LOW·WY**
  in amber and **LAST / LAST·WY / HIGH / HIGH·WY** in rose (the far levels are a
  past sale or a bid, so they want a second look). Hover gives the full label + rank.
  A hand-typed GI clears the basis (`setSizeGI` sends `gi_basis:null`), so the chip
  means "Alias priced this, at that level" and no chip on a filled row means a
  person did. The bulk "Refresh prices" notice breaks down how many sizes landed on
  each level. **The margin applies at every level** — see the under-cost warning in
  `integrations.md`. The same chip shows in the Rescale Requests listing editor,
  where the basis rides along in the request's jsonb `listing` blob.
- Plus **II / AL / SX / SH** Yes/No toggles per size (soft blue =
  yes, soft red = no — rendered as a colored **checkbox** in edit mode) plus a
  per-size **Note**. Persist to `items` (`global_indicator`, `gi_basis`, `price`, sync flags, `ph_note`).
- **GOAT only** (`items.goat_only`, warehouse-set at intake or toggled on the grid
  via `ph/set-goat`; group rollup = all units): shoe lists to **Alias(GOAT)+II only**
  — SX/SH show **N/A** (not editable), a purple **GOAT only** chip marks the group,
  and completion (`phListingStatus`) + the SX/SH badges/`pendingCounts` ignore SX/SH.
  Required flags: `requiredFlags(g)` in `lib/ph.js`.
- Nothing is group-level anymore; each size's fields apply to that size's VINs.
- **GI fetched at receiving** (Alias pricing insights, per unit) seeds these; PH
  reviews/overrides. GI fetched best-effort, so it may be null. See `integrations.md`.
- **Per-group GI refresh (edit mode):** a **↻ beside the Global-indicator** header
  in the size table pulls the current Alias GI for THIS group's sizes straight into
  the open draft (Final recomputes GI + 20%) — a focused alternative to the toolbar's
  bulk Refresh prices. Uses the generic `POST /api/ph/gi-lookup` (`giForSkuSizes`, no
  save; fills the draft). Same endpoint powers the Rescale Requests listing editor.
- **↻ Refresh prices** (grid toolbar, shown when `showPricing` = admin + PH, hidden
  from warehouse) re-fetches the Global Indicator from Alias for **every item
  currently shown** and recomputes **Final = GI + 20%**, then reloads. `POST
  /api/ph/refresh-gi { vins }` → `getItemsForGiRefresh` → `refreshGiForItems`
  (`api/_lib/intake.js`, Alias calls deduped by catalog+size) → `refreshItemGi`
  (logs a **system-generated** `ph_update` per changed unit). **Manual price
  overrides are preserved ONLY for listed units** (on II or synced to any store) —
  a listed size whose price isn't exactly the auto GI×margin keeps it, so a live
  listing isn't disturbed. **UNLISTED units always take the fresh Final = GI ×
  current margin** (`isListed` check in `refreshGiForItems`), so a margin change
  actually lands on Refresh prices (an old-margin auto price would otherwise look
  like an override). No-op refreshes log nothing. Excludes sold/shipped units.
  Blocked while a row is being edited.
- **Global indicator + Final price are hidden from the warehouse role**
  (`showPricing = role !== 'warehouse'`); admin sees them read-only.
- Save: one `phUpdateMany(vins, fields, baseEditedAt)` **per size** (sizes touch
  disjoint VINs → run in parallel), each using the group's `last_edit_at` as the
  optimistic-concurrency baseline (409 → reload fresh). **`baseEditedAt` is now
  REQUIRED server-side** (`ph/update.js` 400s if the key is absent) — omitting it
  used to bypass the conflict check and silently overwrite a concurrent edit; the
  grid always sends it (`g.last_edit_at || null`). Every changed field → one
  `ph_update` event.

## Added by / Last edited by / History (all roles)
- **Added by** column = the **first** PH editor (`items.first_edit_by/at`, set once
  via `coalesce` on the first `phUpdateItems`). When later edits happen it also
  shows **"Last edited by: {name} {date} EST"** (`last_edit_by/at`). "Subsequent
  edits exist" = any unit whose `last_edit_at > first_edit_at` (`groupPhSized`
  `_hasSubsequent`). Visible to PH, warehouse, and admin.
- **Shoe thumbnail (all roles):** each row shows a `ShoeThumb` of the SKU's listing
  photo — **side view preferred** (chosen server-side), **`logo.png` fallback** when
  the SKU has none. `phListItems`/`queryItems` return `photo_url` (preferred angle)
  + `photo_count` per SKU (carried by `groupPhSized`/`groupPhRows`). When photos
  exist the thumb is a button → `PhotosModal`: view every angle (`api/photos/list`)
  and **Download** — a single image, or a **.zip** for 2+ (`GET /api/photos/download`
  fetches the R2 URLs server-side and builds a store-only zip via `api/_lib/zip.js`,
  so the browser needs no bucket CORS/creds). Same thumbnails render on the
  warehouse/admin **Inventory** list; **view + delete** live in the item detail.
- **History** button per size → `HistoryModal` (`api/items/history.js` →
  `getEventsForVins`, allowed for warehouse + ph_team, admin auto). Shows the
  who/what/when timeline (`eventLabel`); identical per-VIN edits are collapsed
  (`dedupeEvents`). Read-only, all roles.
- **System-generated vs by-name** (per `ph_update` event, `details.system` flag):
  - **Global indicator**: the auto Alias fetch (`setItemGlobalIndicators`) logs it
    **system-generated**; a manual change in the grid logs **by name**.
  - **Final price**: **system-generated** while it equals the calculated GI + 20%;
    **by name** only when the user **overrides** that calculated value.
  - `eventLabel` shows "(system-generated)" when `details.system` (or `soldCascade`).
  - Money changes are compared **numerically** (pg returns NUMERIC as a string),
    so an unchanged resubmit logs nothing.

## Live list (auto-refresh)
- The grid quietly re-fetches `phList` every `LIST_POLL_MS` (15s) so **new shoes
  from the warehouse and other users' saved edits appear without a manual reload**
  (`quietRefresh`). No spinner; expanded rows stay open.
- **Skipped while this session is editing or saving** (and while a fetch is in
  flight) so an in-progress draft is never disturbed; resumes after submit/cancel.
- Respects the current date filter (only refreshes what's in view); runs for
  read-only viewers (admin/warehouse) too.

## Edit locks (concurrent / shared accounts)
- Per-**session** holder id (UUID per tab/device) — two sessions of the SAME
  account are independent; one can't override the other's locked row.
- **One row at a time per session** (other Edit buttons disable while editing).
- claim → heartbeat (10s) → release; 30s TTL; presence poll 2s; **1-hour idle
  auto-release**. A **presence** badge "`<name> editing…`" (`.presence-badge`, a live
  pulsing dot — softened from a padlock since the lock is advisory, not a hard
  server gate; `baseEditedAt` is the real write guard) shows on rows others hold.

## Pending badges
- `api/items/pending-counts.js` → `pendingCounts()`. Home `CardBadges` show
  per-unit pending: II/AL/SX/SH, needs_shelf, no_box, restock_pending, and
  rescale_requests (open) / rescale_requests_audited (done, green variant).
- Counts are **per pending unit**, not per merged row.
- The II/AL/SX/SH badges **exclude `kind='instore'`** (a `not_instore` flag in the
  `pendingCounts` CTE); `needs_shelf`/`no_box` still include in-store. A separate
  `instore_unlisted` count feeds the In-Store Listing card (`in-store.md`).
- Sync flags (`II/AL/SX/SH`) cascade to stores; selling clears them (`statuses.md`).

## Price Inquiry (`PriceInquiry`, `/ph/price-inquiry`)
A **read-only** "what's this worth right now?" lookup — PH-home *Work* card "Price
Inquiry" (ph_team + admin; nothing is saved, no inventory touched). Flow:
1. Enter/paste a SKU → `POST /api/sku-search` (`aliasCatalogBySku`) resolves the
   canonical title + full size run + catalog_id.
2. **Tap a size chip → fetches that size on the spot** (`POST /api/ph/price-inquiry
   { sku, sizes:[one] }` → `priceInquiryForSkuSizes`, `api/_lib/intake.js`, which
   resolves the catalog_id once then calls `aliasPriceInsights` per size). Tapping a
   priced chip again removes it; **"Price all"** fetches the whole size run in one
   request. A chip shows a spinner while loading and a muted "empty" state when Alias
   returned nothing for that size.
- Result table per size: **Lowest ask · Highest offer · Last sold · Global
  indicator · Final (GI + 20%)**. All five come from the ONE Alias
  `pricing_insights/availability` call (`lowest_listing_price_cents`,
  `highest_offer_price_cents`, `last_sold_listing_price_cents`,
  `global_indicator_price_cents`); Final = `GI × PRICE_MARKUP`. See `integrations.md`.
- `aliasPriceInsights` returns dollars (0/absent → null); the UI shows `—` for any
  value ≤ 0 (Alias reports `"0"` when a size has no current listing/offer/sale).
- Endpoint is `requireRole(['ph_team'])` (admin auto), rate-limited 30/min (one
  upstream call per size). `aliasGlobalIndicator` is now a thin wrapper over
  `aliasPriceInsights`.

## PH Edited Photos (V7 — `EditedPhotosPanel`, embedded in Find Image Listings)
**CONSOLIDATED (2026-07-15):** the standalone "Edited Photos" page was merged into **"Find
Image Listings"** (the renamed Image Finder, `/ph/image-finder`). `PhEditedPhotos.jsx` now
exports `EditedPhotosPanel({ sku, reloadKey, onSignOut })` (self-loads the SKU's photos, no
TopBar/SKU-form) which ImageFinder renders as the "manage" view; a **Build from template**
button opens the Brand & Fill generate flow, **← Back to photos** returns (bumping `reloadKey`
so just-saved slides show). The old `/ph/edited-photos` URL redirects to `imagefinder`
(`phPageForPath`); the separate PH-home card is gone. — The warehouse shoots raw listing
photos on intake (`source='warehouse'`). PH uploads their own **edited** images per SKU
(upload-as-is / bulk drop + reorder / remove; ph_team + admin). Both sets coexist in
`product_photos` (keyed by `(sku, angle, source)`)
— a PH upload never overwrites the warehouse original.
- **Precedence:** per angle — `ph_edited` wins within an angle, warehouse fills any
  angle PH hasn't edited. The `photo_url` thumbnail sub-queries in `db.js` order
  **angle-first** (side→diagonal→top→outsole→rear), THEN `(source='ph_edited') DESC` —
  so the thumbnail is the best angle (side) with PH's edit preferred, and PH editing a
  non-side angle first doesn't hijack the thumbnail away from a good warehouse side shot.
  `extra*` are excluded from thumbnails.
- **Slots:** 1–5 are the standard angles; **6–7 (`extra1`/`extra2`) are PH-only extra
  images** that never appear as a thumbnail — they show in the photo viewer (click a
  thumbnail) and are downloadable.
- **Bulk upload + reorder:** a drop-zone (drag or tap-to-select, `multiple`) stages up
  to 7 images mapped **positionally** to the fixed angle slots (Side→Extra 2). The
  **angles never move** — the user rearranges the *photos* onto the right angle by drag
  or ◀/▶ (`reorder`), then `uploadStaged` pushes them to R2 in order (each via the
  shared `putPhoto` = compress → `photoSign` → PUT → `photoAttach`). Previews use object
  URLs (revoked on clear/unmount). The per-slot single upload/replace still works.
  Reordering is live-animated (`@formkit/auto-animate` on the stage grid): dragging a
  photo shifts the others like a placeholder opening up, and the position-based angle
  labels stay correct.
- **Shoe name on load:** loading a SKU also does a best-effort `searchSku` (Alias
  catalog) to show the **product name** next to the SKU (race-guarded via `skuRef`;
  never blocks/errors the page).
- **Download all** (prominent primary button in a `pe-actionbar`): grabs **every**
  image for the SKU — edited + warehouse originals — as a zip via `photoDownload(sku)`
  with **no source filter** (`GET /api/photos/download?sku=` returns all sources; files
  named `<sku>-<source>-<angle>`).
- **Replace-gate:** when a SKU **already has edited images** the bulk drop-zone is
  hidden behind a **"Replace listing images"** button (`showBulk = !hasEdited ||
  replacing || staged.length`); this only rewrites the `ph_edited` set — **warehouse
  originals are never touched** (kept for future reference, the hard invariant).
- **Roles (`api/_lib/photos.js` `photoSourceForRole`):** warehouse→`warehouse` only,
  ph_team→`ph_edited` only, admin→both. Enforced in `photos/sign|attach|remove`.
- The page shows the warehouse originals as read-only reference + "Download originals"
  (`photoDownload(sku,'warehouse')`). The warehouse capture screen (`ListingPhotos`)
  shows a "PH edited on file" banner when edits exist. The viewer (`PhotosModal`) groups
  **PH edited** vs **Warehouse originals**.

## Image Finder (`ImageFinder`, `/ph/image-finder`)
Auto-sources listing photos for a SKU from **every image source at once** (PH-home card
"Image Finder"; ph_team + admin). Saves straight into the **`ph_edited`** set — no new
source, no schema change — so found images behave exactly like hand-edited uploads
(precedence, thumbnail, viewer). Flow:
1. Enter/scan a SKU → `GET /api/images/search?sku=` (`requireRole(['ph_team'])`) queries the
   sources **concurrently** and returns them ALL as `sources[]` (best-first), so PH picks the
   angle rather than trusting one catalogue's ordering. `product` = `sources[0]`, kept for
   backwards compatibility. The brand sources lead because they **LABEL their angles**:
   - **Nike / Jordan** (`api/_lib/nike.js`) — `api.nike.com/product_feed/threads/v2`, **no API
     key**, filtered on `productInfo.merchProduct.styleColor`. The mandatory `channelId` filter
     is `d9a5bc42-…` (the feed 400s without it). Every image carries a `view` LETTER; verified by
     eye on three unrelated silhouettes: **A=lateral, B=outsole, C=medial, D=top-down, E=3/4,
     F=heel** → fills **all five slots**. Jordan resolves through the same channel
     (`brand:'Jordan'`). One cached feed round-trip per SKU serves both images and specs.
   - **adidas** (`api/_lib/adidas.js`) — adidas has no usable first-party route (hash-based CDN
     URLs, Akamai-WAF'd APIs, CDN not search-indexed). Instead a **cached catalogue index** is
     crawled from `asphalt-nyc.com/products.json`, which republishes adidas' studio files with
     adidas' **semantic filenames** intact: `_01`=lateral, **`_02`=top-down**, **`_03`=outsole**,
     `_04`=3/4, `_05`=rear (plus a modern `FOOTWEAR_Photography_<View>` form). ~226–234 codes.
     Angle comes from the FILENAME, never a gallery position — the higher-res alternative
     (Sneakersnstuff, 2500px) can only be read positionally and its order shifts per product.
   - **KicksDB** (`api/_lib/kicksdb.js`, `KICKSDB_KEY`) — unchanged cascade: **GOAT curated
     gallery** → **StockX 360° spin** (36 frames, rotational only) → **hero image(s)**. Still the
     only source for everything else. Note **GOAT has no top-down at all** — the asset isn't shot.
     It's the only **metered** source, so it is **skipped whenever Nike or adidas answered**
     (they self-gate on the code pattern before any network call, so the check is free). PH gets
     an **"Also search GOAT/StockX"** button when it was skipped → `?all=1`: extra strips are
     appended and only **empty** slots are topped up, so nothing already picked moves. Results
     are cached 12 h per SKU and shared with the spec slide. Details → `integrations.md`.
   A missing `KICKSDB_KEY` no longer fails the search; it just means one fewer source.
2. **Slots** are the 5 standard `product_photos` angles: side · diagonal · **top** · **outsole** ·
   rear. Each slot is seeded from the **first source that can fill it**, so Nike/adidas labelled
   angles win and GOAT only fills what's left (GOAT: `0→side`, `3→outsole` — `GOAT_SUGGESTIONS`).
   The gallery renders **one strip per source** with a header and a per-image angle caption
   (real for the brand sources, `Photo N` for the marketplaces). PH taps any image to (re)assign.
3. UI: 5 slots; the confident ones pre-filled, tap a slot to make it active, tap any gallery
   image to (re)assign it. Each slot also has **Upload** — a PH photo for a blank/any angle
   (raw → R2 via `photoSign`, then the slot points at that R2 URL). Editable **title** field
   (pre-filled from the API name) is stamped on every branded slide.
4. **Brand & Fill = PREVIEW, then Upload = COMMIT** (the flow is *find → angles → Brand & Fill →
   review/adjust → Upload → Download*; nothing is saved until Upload).
   `POST /api/images/brand { sku, title, picks, includeSpec, includeWelcome, size, mode }`
   (`requireRole(['ph_team'])`), run **sequentially** (each AI cutout is CPU/network-bound):
   - **`mode:'preview'` (Brand & Fill)** — for each shoe pick: fetch (SSRF-allowlisted by
     `api/_lib/imgsources.js` to `image.goat.com` / `images.stockx.com` / `static.nike.com` /
     `cdn.shopify.com` **or** our R2 host) → **cut out ONCE**
     (`cutoutForEditMaybePreCut`) → **stage** the transparent PNG on R2 → composite onto the
     template (name+SKU) at a small
     **preview size (900²)** → return the slide as a **data-URI** plus its `cutoutUrl` + `bbox`.
     Spec + welcome likewise. **Nothing is persisted to `product_photos`.** Slots→templates:
     side→1, diagonal→2, top→3, outsole→4, rear→5; **spec→6** (extra1); **welcome→7** (extra2).
   - **Pre-cut sources skip the AI matte.** `hiResSourceUrl` rewrites a Nike gallery URL to its
     background-free twin (`/a/images/w_1728/<id>/image.png`), which is a genuine RGBA PNG
     (~77% transparent). `cutoutForEditMaybePreCut` samples the four corner alphas and, when the
     source is already transparent, uses it as-is — **no Replicate call, no throttling** for
     Nike/Jordan. It falls back to the normal cutout when the corners are opaque, so a rendition
     change degrades to the old path instead of compositing a grey box. adidas renders carry a
     **baked drop shadow**, so they still need the full cutout.
   - **Spec slide data is MERGED, not either/or** (`nikeSpecData` + `kicksdbSpecData`). Nike is
     authoritative for what's printed verbatim (official colourway naming/order, and `subtitle`
     as the product category, e.g. "Men's Road Racing Shoes"); the keyword inference reads
     **both** descriptions because Nike's copy is shorter and often omits the upper material
     (only GOAT's prose says "leather" for the Air Jordan 1). The GOAT half is now fetched
     **on demand**: KicksDB is only called when Nike's description matches no material keyword
     (`MATERIAL_RE`, exported from `branding.js` and kept in sync with the "Upper" branch of
     `specBulletsFromDescription`) or when neither Nike nor Alias has a colourway — i.e. exactly
     when the merge would have changed the bullets. Nike's `techSpec`/`bestFor`/
     `widths` are **always empty** — don't build on them. `specBulletsFromDescription` no longer
     asserts "Regular Fit"/"Rubber Outsole" unconditionally: with no description text those
     defaults are skipped rather than printing unsupported claims on a listing.
   - **Adjust (live position & resize editor)**: each **preview** shoe slide has an **Adjust size**
     button opening `ShoeEditor` — a Canva-style overlay that reuses the slide's staged `cutoutUrl`
     + `bbox` (**no re-cut**), draws it over a lightweight template preview
     (`src/components/ImageTemplate/previews/{1..5}.jpg`, ~200 KB — the real templates are 5 MB), and
     lets PH **drag / drag a corner handle / pinch / scroll / slider-scale**. Geometry is in the
     **1600² design space**; save emits `{ dx,dy,dw,dh }`. The client re-runs `mode:'preview'` for
     just that slot (precut) to refresh its thumbnail (`edits[angle]` holds the transform).
   - **Cutout (per-shoe re-cut)**: every preview shoe slide (and every failed shoe in the error list)
     has a **Cutout** button (`recutSlot`) that re-sends the shoe's **original** source image
     (`picks[slot]`, NOT the staged cutout) through a fresh `mode:'preview'` render → new Replicate
     cutout + new staged PNG, re-rendering just that slide. For a shoe that got 429'd or cut poorly.
     A fresh cut has a new shape, so its prior size adjustment (`edits[slot]`) is dropped.
   - **`mode:'commit'` (Upload to server)** — the picks now carry the staged `cutoutUrl`
     (`precut:true`) + each slot's `transform`; re-render at full `size` (**no re-cut**), upload the
     final JPEG to R2, and `setProductPhoto(source='ph_edited')`. Then **Download all** zips them
     (`api.photoDownload`, enabled after Upload). `brandPhoto` with `precut` loads the transparent
     PNG as-is and honours the transform (auto-fit when null) — identical bytes → identical bbox, so
     the preview == the saved result.
   - **Listing-photo filenames** (`listingPhotoBaseName` in `api/_lib/photos.js`, the single source
     of truth for `images/brand`, `images/import` and `photos/download`):
     **`<sku>-<position>-<angle>`** — e.g. `FD8311-401-4-outsole.jpg`. Position is the marketplace
     upload order (side=1 · diagonal=2 · top=3 · outsole=4 · rear=5 · spec=6 · welcome=7); the
     angle word makes the file self-describing for whoever uploads it. Two slots are renamed for
     humans: **`side`→`lateral`, `rear`→`heel`** (the DB still stores the internal slot names —
     nothing re-derives an angle from a filename). The **R2 key keeps a `-<ts>` suffix** so
     re-branding an angle writes a NEW key; without it the public URL would be unchanged and
     browsers/CDN would keep serving the previous image. The **download name has no timestamp**.
     `photos/download` sorts entries 1→7 so the zip unpacks in upload order, and disambiguates
     with a `-<source>` suffix only when the same angle appears twice (a warehouse original AND a
     PH edit would otherwise collide to one zip entry and silently drop a photo).
   - **Output size** (`size`): **1600** (design size, default) or **1400** (eBay's recommendation) —
     the *commit* render size. Everything renders at 1600 then `encodeJpeg` resamples to the chosen
     size, so composition is pixel-identical; only resolution differs (`OUTPUT_SIZES`; `clampOutSize`
     accepts 200–2000 so the 900 preview passes through).
   - **Cutout reliability (no "land effect")**: a Replicate **429** (throttle at < $5 credit) is
     rejected before a prediction exists (invisible in the dashboard). `cutoutReplicate` now retries
     up to 7× honouring `Retry-After` (waits ≤30 s) to ride out the ~60 s window. If a **hosted**
     provider still fails, `brandPhoto` **re-throws instead of using the colour-threshold fallback**
     (`cutoutProvider() !== 'local'`) — the threshold cut leaves the source's baked reflection (the
     "land effect"), so the slot reports a clear throttle error (`throttled`) rather than silently
     saving a bad slide. Real fix = ≥ $5 Replicate credit. Staged cutout PNGs live at
     `listings/<sku>/_cut/*.png` (reused across preview/adjust/commit; harmless orphans if abandoned).
   - **Source-format normalisation** (`api/_lib/imgformat.js`, applied in `images/brand.js` +
     `images/cutout.js` right after the source fetch): the cutout provider is Pillow-based and reads
     only JPEG/PNG/WebP/GIF/BMP/TIFF. A PH upload is whatever the phone/browser produced — **AVIF**
     (what Chrome saves brand-site photos as, e.g. adidas.com) made Replicate fail with the opaque
     `cannot identify image file '/tmp/….png'`, surfaced as "Could not cut out this shoe". Worse,
     `@napi-rs/canvas` `loadImage` **SEGFAULTS on HEIC** (raw iPhone photo) — it doesn't throw, it
     kills the Node process. So `normalizeSourceImage()` sniffs the **magic bytes** (never the
     Content-Type — the upload path stamps `image/jpeg` on anything), passes readable formats through
     untouched, transcodes AVIF → PNG via canvas, and **rejects HEIC before it reaches the decoder**
     with a fixable message. Client side, `toUploadableImage()` (`src/lib/image.js`) converts HEIC/AVIF
     **in the browser** at upload time (the only place that can still decode them), so odd formats
     never reach R2; `compressImage` likewise clamps its output type to jpeg/png/webp.
   - **Branding engine** = `api/_lib/branding.js` using **`@napi-rs/canvas`** (registers the font
     files explicitly — same native binary on Railway; sharp's SVG renderer ignores `@font-face`,
     so it was dropped). Templates in `src/components/ImageTemplate/{1..7}.png` (1600²); fonts in
     `assets/branding/fonts/` — **Bebas Neue** (SKU/specs, OFL) + **The Youngest** (`TheYoungest-Serif-Book.ttf`,
     the real Canva serif title face, registered as `SbTitle`). The shoe is cut out by `cutoutToPng()` in
     `api/_lib/cutout.js` — a **full BiRefNet-general** AI matte (`@tugrul/rembg` on
     onnxruntime-node, CPU, ~928MB model auto-downloaded to the gitignored
     `assets/branding/models/`, ~50s–2.5min/image), falling back to the old colour-threshold
     flood-fill only if the model is unavailable. Spec bullets = `specBulletsFromDescription()` heuristic over
     the marketplace description + `colorway` from the API (no structured spec feed; Claude
     extraction would be sharper but needs an `ANTHROPIC_API_KEY`, none configured). On the spec
     slide each bullet **word-wraps** to `SPEC.maxW` (a long colorway spans multiple lines and
     pushes later bullets down, instead of running off the slide). Layout is tunable in the
     **Spec Slide Playground** (a self-contained HTML artifact: real template-6 background on a
     canvas mirroring the pipeline's draw math, sliders → px to paste into the `SPEC`/`TITLE`/`SKU`
     constants).
   - **Output quality**: JPEG q**90** (napi-canvas quality is 0–100, not 0–1 — the trap that
     first shipped 30 KB images), 96 DPI (`encodeJpeg` patches the JFIF header), and the shoe is
     fetched from GOAT's **`/original/`** rendition (`hiResSourceUrl`), not the soft `/medium/`
     gallery size. ~0.75 MB/slide — Canva-parity.
   - **Cutout + shadows**: the AI matte returns a clean alpha cut (no baked studio shadow to
     strip), so `brandPhoto` just adds a synthetic soft ground shadow on the drawImage. White
     shoes on GOAT's near-white bg are the hard case: ISNet/BiRefNet-lite give white parts too
     little confidence and leave see-through holes, so `cutout.js` uses the **full** BiRefNet and
     rescales its globally-offset matte to opaque via an **adaptive Otsu `liftAlpha()`** (bg→
     transparent, shoe→opaque) plus a **border flood-fill** that clears any residual halo
     (verified on white / all-black / multicolour shoes). Text shadows copied from the Canva samples — `SOFT_SHADOW` for the
     serif title, `HARD_SHADOW` (crisp offset down-right) for the SKU + spec bullets.
6. **Preview + download**: after Brand & Fill the UI shows a **Branded set** grid (tap a
   thumbnail → full-size in a new tab) and **Download all** → a zip of every branded slide via
   the existing `api.photoDownload(sku,'ph_edited')` (`GET /api/photos/download`).
5. (Legacy) `POST /api/images/import` still exists — imports the raw picks un-branded into
   `ph_edited`; the UI now uses Brand & Fill instead.
- Rate-limited (search 40/min, import 20/min, brand 12/min). Degrades gracefully when
  `KICKSDB_KEY`/R2 are unset (503 + clear message).
