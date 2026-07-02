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
- **Frozen columns** (`ph.js` `frozenStyle`/`rightStyle`): left = Date/Title/SKU/Qty;
  right = **Action + Added by** (both sticky, kept together). Their contents **wrap**
  inside the fixed column width (`.ph-addedby`, `.ph-rfrozen-first`) rather than
  expanding it, so the two right columns' sticky offsets stay aligned. The **expanded
  per-size drawer is pinned left** (`.ph-drow > td { position: sticky; left: 0 }`) so
  it stays under the frozen columns instead of drifting with the middle scroll.

## Editable fields (one Edit ⇄ Submit per group)
- **Per size**: Global indicator (number) → **Final price auto-calculates** = GI +
  20% (`calcFinalPrice`, `PRICE_MARKUP = 1.2`); Final price stays editable so it
  can be overridden. Plus **II / AL / SX / SH** Yes/No toggles per size (soft blue =
  yes, soft red = no — rendered as a colored **checkbox** in edit mode) plus a
  per-size **Note**. Persist to `items` (`global_indicator`, `price`, sync flags, `ph_note`).
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
  overrides are preserved**: a size whose current price isn't exactly the auto
  GI+20% keeps its price (only its GI refreshes); no-op refreshes log nothing.
  Excludes sold/shipped units. Blocked while a row is being edited.
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
- Sync flags (`II/AL/SX/SH`) cascade to stores; selling clears them (`statuses.md`).
