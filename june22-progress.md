# Progress — June 22–23, 2026

Status snapshot for the Stickballman12 Shoe Scanner (V5). All work below is
**committed and pushed to `main`** (`8a39154`, then `31ea280`). Build passes;
local DB has been reset (inventory cleared, accounts kept).

---

## 1. What we accomplished

### Rescale workflow — now a full two-way loop
- **PH "Request Rescale"** form: PH enters SKU, sizes + qty, current price, and a
  reason (Mismatch / Quantity / Recount / Returned / Re-listing / Other). The SKU
  field has a **Search** button that auto-fills the shoe name (KicksDB lookup;
  `sku-search` now allows `ph_team`).
- **Warehouse audit**: each open request has **🔍 Audit shelf** → the warehouse
  enters the **actual** qty counted per size (pre-filled from reported sizes; can
  add sizes found, set 0 for none) + an audit note. Status flips `open → audited`.
- **Shared report** (`RescaleRequestsReport`): each request shows a compact
  **Reported (top) / Actual (bottom)** grid per size, discrepancies highlighted
  red. Both roles see it; warehouse audits, PH views + creates. Filter by
  Open / Audited / All and by date.
- Backend: `rescale_requests` table (+ `actual_sizes`, `audit_note`);
  `createRescaleRequest` / `listRescaleRequests` / `auditRescaleRequest`;
  endpoints `create` / `list` / `audit`.

### Report + Inventory merged by SKU
- Both pages now show **one row per SKU + status** (regardless of size). The row
  lists each size as a **chip with its qty** (`SizesQty`), plus a total.
- One **Price / II / AL / SX / SH / Note** per SKU, applied to every member VIN.
  A sync flag reads "Yes" only when *all* units have it; `~` marks a mixed
  price/cost. Inventory keeps a per-VIN **Units** drill-down for history/labels.

### Home pending badges
- `GET /api/items/pending-counts` powers live count chips:
  - **II / AL / SX / SH** = sellable units not yet synced to each store.
  - **Needs shelf**, **No box**, **Restock**, **Rescale requests (open)**.
- Counts are **per pending unit**, not per entry (verified with the 21-unit
  example: II 1 / AL 21 / SX 21 / SH 21).

### Rescale tracking + No Box resolution
- New `items.restock_pending` column — set when a unit is rescaled. **Rescale
  Stock** is a pending worklist; **✓ Restocked** clears the flag and the unit
  rejoins normal inventory.
- **No Box → With Box**: "📦 Box found → With Box" sets `with_box=true` +
  needs-shelf, making the unit sellable (we never sell without a box).

### Date filtering everywhere
- Reusable **Day / Week / Month** `DateRangeBar` on Report, Rescale Stock,
  No Box, and Rescale Requests. Defaults: **Month** for Report, **Day** for the
  others. Backend list queries take an EST `from`/`to` range.
- Fixed the week label to read e.g. **`Jun 21 – 27, 2026`**.

### Multi-session PH editing (shared accounts)
- Edit locks keyed by a **per-session UUID** (not per-account), so two people on
  the *same* account edit independently and can't override each other's row.
- **One row at a time per session** — other Edit buttons disable while a row is
  open. 1-hour idle auto-release still applies.

### Other
- **Alias auto-relogin** on 401 (Alias only, not StockX) via `api/_lib/alias.js`.
- **UPC box-label printing** on the No Box page (box-style label w/ barcode);
  `scripts/backfill-upc.mjs` to backfill colorway by SKU.
- **Mobile responsive cards** for No Box / Inventory / Mark Sold-Shipped.
- Fixed the rescale-request form **field alignment** (caption wrapping).
- Docs: `RAILWAY.md`, `SOP-WAREHOUSE.md`, `SOP-PH-TEAM.md`, `version-5.md`
  (through §20), plus `db:reset` script + npm alias.

---

## 2. Current state

- **Branch:** `main`, clean, up to date with `origin/main` (`31ea280`).
- **Build:** passes (`npm run build`).
- **Local DB:** reset — inventory cleared, 3 user accounts kept.
- **Schema additions live locally:** `rescale_requests` (+ `actual_sizes`,
  `audit_note`), `items.restock_pending`, `items.colorway`, `items.gender`.
- **Roles:** admin / warehouse / ph_team unchanged; `sku-search` now also
  allows `ph_team`.

---

## 3. Next steps

### Deploy / data (do this on Railway)
1. **Run `npm run db:setup` on Railway** so the new tables/columns exist
   (`rescale_requests` + `actual_sizes`/`audit_note`, `restock_pending`,
   `colorway`, `gender`). See `RAILWAY.md`.
2. **Reset the Railway DB** if you want a clean start (keeps accounts):
   - Railway Postgres → **Data** tab → run the TRUNCATE SQL, **or**
   - `railway ssh` into the app container → `npm run db:reset`.
3. Hard-refresh the browser after deploys (cached bundle can show stale UI).

### Open product decisions (awaiting your call)
- **"All" option on the date filter** for the pending queues (No Box / Rescale /
  Requests) so older outstanding items aren't hidden by the Day default.
- **Auto-refresh** home badges (currently fetch once per home visit).
- Whether **rescale should auto-reset the store sync flags** (II/AL/SX/SH) so a
  rescanned unit is re-listed cleanly.
- Confirm the **rescale reasons** wording with both teams.

### Deferred (explicitly set aside)
- Official **alias.org API** integration (using the Railway bypass proxy for now).
- Manual **"add UPC"** field for legacy no-box items (UPC can't be backfilled by
  SKU — per-size UPCs aren't in the KicksDB SKU lookup).

### Suggested QA before heavy use
- End-to-end on the live deploy: receive → shelf, no-box → box-found, rescale →
  restocked, PH request → warehouse audit (reported vs actual), multi-session
  editing under one PH account.
