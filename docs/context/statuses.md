# Statuses & transitions

Defined centrally: `src/statuses.js` (labels/colors, client) + `api/_lib/statuses.js`
(server whitelist + `normalizeStatus`). Custom tags allowed via `normalizeStatus`.

## Keys (label)
- `needs_shelf` — Needs to be Added to Shelf (default on receive w/ box)
- `in_stock` — In Stock
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
  across II + stores) and logs the change as **(system-generated)**.
- "Listable" / sellable = `with_box = true AND status NOT IN (sold, shipped,
  missing, issue, no_box)` — this drives the pending-count badges.

## Status change paths
- Inventory: per-group dropdown or bulk **Edit status** → `bulk-status.js`.
- No Box: "Box found → With Box" (`box-found.js`) or other status (`event.js`).
- Mark Sold / Mark Shipped: `StatusScanPage` scans VINs → `bulk-status.js`.
- Every change writes an `item_events` row (audit trail).
