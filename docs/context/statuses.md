# Statuses & transitions

Defined centrally: `src/statuses.js` (labels/colors, client) + `api/_lib/statuses.js`
(server whitelist + `normalizeStatus`). Custom tags allowed via `normalizeStatus`.

## Keys (label)
- `needs_shelf` — Needs to be Added to Shelf (default on receive w/ box)
- `in_stock` — In Stock (set by **shelving** a boxed unit; carries a `location_id`,
  shown as "In Stock · A2-04" — see `locations.md`)
- `pre_sold` — Pre-Sold
- `no_box` — Bought Without Box (auto when "With Box" unchecked; not sellable)
- `shipped` — Shipped
- `sold` — Sold
- `returned` — Returned
- `missing` — Missing
- `issue` — Issue

## Sync flags (cross-store listing, set by PH)
`added_to_intel_inv` (II = Intelligent Inventory, the master) → cascades to
`synced_alias` (AL), `synced_stockx` (SX), `synced_shopify` (SH).
Shown as `SyncBadges`.

## Cascades (in db.js: `bulkSetStatus` / `addItemEvent`)
- Marking a unit **sold** or **shipped** **clears all sync flags** (auto-delist
  across II + stores) and logs the change as **(system-generated)**. `clearsSyncFlags`
  drives both paths; `cascadeTextFor` picks the Sold/Shipped audit text.
- **Terminal-status guard (anti double-sell):** `sold`/`shipped` = `TERMINAL_STATUSES`
  (`_lib/statuses.js`). A terminal unit **can't be reactivated** into an active status —
  `api/items/rescale.js` rejects rescanning one (409), `api/items/bulk-status.js`
  rejects a bulk change of a terminal unit to any active status (409, lists blocked
  VINs), and `shelveItems` **skips** a terminal unit (won't reactivate it to
  in_stock by shelving — `reason:'terminal'` in results). `sold→shipped` /
  `shipped→sold` stay allowed (both terminal).
- "Listable" / sellable = `with_box = true AND status NOT IN (sold, shipped,
  missing, issue, no_box)` — this drives the pending-count badges.

## Shelving (`needs_shelf` → located)
- **Shelve / Put-away** (`/shelve`) sets a boxed unit's `location` and flips
  `needs_shelf → in_stock`. **A no-box unit can NOT be shelved** — it's refused unless
  "box found now?" is confirmed (→ `with_box + in_stock`); otherwise it stays `no_box`
  (resolve via the No-Box queue). Inventory's "In Stock" put-away enforces the same box
  prompt. Transfer = re-shelve an in-stock unit. Logs a `shelved` event. See `locations.md`.

## In-stock invariant (in_stock ⟺ shelved)
A unit is only **In Stock** once it's physically on a shelf (`location_id` set).
Manual status paths **cannot** set `in_stock` on an unshelved unit — both
`bulk-status.js` and `event.js` (single-item) return **409** with a message
pointing to **"Move to shelf"**. The proper path is put-away (`shelveItems`),
which sets `in_stock` as it records the location. In the UI, picking "In Stock"
for an unshelved unit (group dropdown, bulk modal, or item detail) **opens the
Move-to-shelf scanner** instead of a doomed status write. `getItemStatesByVins`
(status + `location_id`) backs the server guard.

## Status change paths
- **In-store** (`kind='instore'`) units use the same status keys + paths as any
  stock (land at `needs_shelf`/`no_box`; shelve → `in_stock`; sold/shipped, etc.).
  The ONE difference: `POST /api/items/rescale` **rejects** an in-store VIN (409) so
  it can never enter `restock_pending` / the PH Rescale grid (`in-store.md`).
- Inventory: per-group dropdown or bulk **Edit status** → `bulk-status.js`.
- Inventory **Move to shelf** (per SKU-group or per selected VINs) → `shelve.js`.
- No Box: "Box found → With Box" (`box-found.js`) or other status (`event.js`).
- Mark Sold / Mark Shipped: `StatusScanPage` scans VINs → `bulk-status.js`.
- Every change writes an `item_events` row (audit trail).
