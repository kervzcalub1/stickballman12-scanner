# PH report / grid

Component: `PHGrid` in `src/App.jsx`. Endpoints: `api/ph/list.js`
(`phListItems(from,to,kind)`), `api/ph/update.js` (`phUpdateItems`),
`api/ph/locks.js` (edit-lock presence).

## kinds
- `kind=null` — admin Report: everything in range (incl no_box), by scan date.
- `kind='receiving'` — PH "New Inventory": newly received (excludes rescale
  batches + no_box), by scan date.
- `kind='rescale'` — PH "Rescale Stock": `restock_pending` units, by rescale-event
  date (see `rescale.md`).

## SKU-merge (`groupPhRows`)
- One row per **SKU + status** (regardless of size). Size breakdown as qty chips
  (`SizesQty`) + total qty. Price / II / AL / SX / SH / Note set **once per SKU**,
  applied to every member VIN. A sync flag shows "Yes" only if **all** units have
  it; `~` marks a mixed price/cost.

## Editable fields (Edit ⇄ Submit per row)
- Price, **added_to_intel_inv (II)**, **synced_alias/stockx/shopify (AL/SX/SH)**,
  ph_note. Yes/No toggles: soft blue = yes, soft red = no.
- Save = `phUpdateMany(vins, fields, baseEditedAt)` — optimistic concurrency:
  409 if `last_edit_at` moved (reloads fresh). Every changed field → one
  `ph_update` event.

## Edit locks (concurrent / shared accounts)
- Per-**session** holder id (UUID per tab/device) — two sessions of the SAME
  account are independent; one can't override the other's locked row.
- **One row at a time per session** (other Edit buttons disable while editing).
- claim → heartbeat (10s) → release; 30s TTL; presence poll 2s; **1-hour idle
  auto-release**. "🔒 being edited by X" shown on locked rows.

## Pending badges
- `api/items/pending-counts.js` → `pendingCounts()`. Home `CardBadges` show
  per-unit pending: II/AL/SX/SH, needs_shelf, no_box, restock_pending, and
  rescale_requests (open) / rescale_requests_audited (done, green variant).
- Counts are **per pending unit**, not per merged row.
- Sync flags (`II/AL/SX/SH`) cascade to stores; selling clears them (`statuses.md`).
