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

## Shelving (`needs_shelf`/`no_box` → located)
- **Shelve / Put-away** (`/shelve`) sets a unit's `location` and — for a boxed unit
  — flips `needs_shelf → in_stock`. A no-box unit keeps `no_box` but is still
  located; "has a box now?" makes it `with_box + in_stock`. Transfer = re-shelve.
  Logs a `shelved` event. Full flow in `locations.md`.

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
- Inventory: per-group dropdown or bulk **Edit status** → `bulk-status.js`.
- Inventory **Move to shelf** (per SKU-group or per selected VINs) → `shelve.js`.
- No Box: "Box found → With Box" (`box-found.js`) or other status (`event.js`).
- Mark Sold / Mark Shipped: `StatusScanPage` scans VINs → `bulk-status.js`.
- Every change writes an `item_events` row (audit trail).
