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
`synced_alias` (AL), `synced_stockx` (SX), `synced_shopify` (SH) — applied in the
PH grid's editor (`setSizeFlag`, on-tick only, `ph-report.md`), not in the DB, so
PH can still untick a store whose push failed. Shown as `SyncBadges`, which reads
**on / partial (n/total) / not yet** — see the two-wave trap in `ph-report.md`.

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
- **Sold/shipped closes the PH side too.** The unit reads as `done` in the PH grid
  whatever its store flags say, leaves the Pending/In-Progress tabs, and can no longer
  be edited or re-flagged by PH (`PH_CLOSED_STATUSES`; full rule in `ph-report.md`).
  A pair sold before it was ever listed is not listing work — it's gone.

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

## Bulk scan-out (`/shipped`, `/sold` — `StatusScanPage`)
Built for 150–300+ pairs a shift. The loop is **scan → scan → scan → review →
submit**: the scanner never closes, nothing pops up mid-run, and one deliberate
submit commits the reviewed list via `bulk-status.js`. (Per-scan auto-commit was
considered and rejected — the reviewable list is what makes a stray scan
recoverable.)
- **Two answers per scan:** a colour banner *and* a tone (`src/lib/beep.js`,
  WebAudio — no assets, no CSP risk). Staff watch the box, not the screen, so the
  tone is the primary signal. Muted via the 🔊 TopBar toggle (`prefs.scanSound`).
- **Failures are kept, not overwritten.** A scan that doesn't make the list
  (non-VIN, unknown VIN, duplicate, already at the target status) is appended to a
  persistent failure log with its reason + time. The old single `error` line was
  wiped by the next scan — useless on a 300-pair run. `error` now only carries
  save/system failures.
- **Duplicates:** a re-read of the same code inside the **1.2 s cooldown** is a gun
  double-trigger — swallowed silently. A deliberate re-scan after it is a real
  duplicate and is logged as one.
- **Undo last** pops the newest row and clears its cooldown so it can be
  re-scanned immediately.
- **Counters:** Scanned · Remaining · Errors · Last scanned. **Remaining** =
  `pendingCounts().awaiting_shipment` (units in `sold`) minus what's staged — the
  only genuine "still to ship" queue in the data. **Shipped only**; Mark Sold has
  no pending queue, so it hides that counter.
- Submitting shows an end-of-session summary ("N pairs scanned out successfully,
  M errors") and refetches the backlog.
- The failure card sits **below** the sticky `.batch-bar`: a card directly above it
  gets covered once the bar wraps to two rows on a phone.
