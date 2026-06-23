# Progress — June 22–23, 2026

Status snapshot for the Stickballman12 Shoe Scanner (V5).

> ⚠️ **Top priority:** production (Railway) DB schema is **out of sync** with the
> deployed code — deploy logs show `column "colorway" / "restock_pending" does
> not exist`. Fix = run the migration on Railway (see Next steps §3).

---

## 1. What we accomplished

### Rescale workflow — full two-way audit loop
- **PH "Request Rescale"** form: SKU, sizes + qty, current price, reason
  (Mismatch / Quantity / Recount / Returned / Re-listing / Other). The SKU field
  has a **Search** button that auto-fills the shoe name (KicksDB; `sku-search`
  now allows `ph_team`).
- **Warehouse audit** ("🔍 Audit shelf"): enters the **actual** qty counted per
  size (pre-filled from reported; can add sizes, set 0) + audit note. Status
  flips `open → audited`.
- **Shared report** (`RescaleRequestsReport`): compact **Reported (top) / Actual
  (bottom)** grid per size. Discrepancies = **red**, matches = **green**.
  Filter Open / Audited / All + by date. Warehouse audits; PH views + creates.
- Backend: `rescale_requests` table (+ `actual_sizes`, `audit_note`) and
  `create` / `list` / `audit` endpoints.

### Report + Inventory merged by SKU
- One row per **SKU + status** (regardless of size); sizes shown as **qty chips**.
- Price / II / AL / SX / SH / Note set **once per SKU**, applied to all member
  VINs. Inventory keeps a per-VIN **Units** drill-down for history/labels.

### Home pending badges
- `GET /api/items/pending-counts` → live chips, all **per pending unit**:
  - **II / AL / SX / SH** (units not yet synced to each store)
  - **Needs shelf**, **No box**, **Restock**
  - **Rescale requests**: 🟡 **Pending audit** (open) + 🟢 **Audited** (done) —
    two-color badge on the PH Request-Rescale card and warehouse card.

### Rescale tracking + No Box resolution
- `items.restock_pending` — set on rescale; **✓ Restocked** clears it and the
  unit rejoins normal inventory. Rescale Stock is a pending worklist.
- **No Box → With Box** ("📦 Box found"): sets `with_box=true` + needs-shelf so
  the unit becomes sellable (we never sell without a box).

### Date filtering everywhere
- Reusable **Day / Week / Month** `DateRangeBar` on Report, Rescale Stock,
  No Box, Rescale Requests. Defaults: **Month** for Report, **Day** for others.
- Week label fixed to read e.g. **`Jun 21 – 27, 2026`**.

### Multi-session PH editing (shared accounts)
- Edit locks keyed by a **per-session UUID** → two people on the same account
  edit independently and can't override each other. **One row at a time per
  session**; 1-hour idle auto-release.

### Other
- **Alias auto-relogin** on 401 (Alias only) via `api/_lib/alias.js`.
- **UPC box-label printing** on No Box; `scripts/backfill-upc.mjs` (colorway).
- **Mobile responsive cards**; rescale-form field-alignment fix.
- `db:reset` script + `npm run db:reset`. Docs: `RAILWAY.md`, SOPs,
  `version-5.md` (through §20).

---

## 2. Current state

- **Branch:** `main`. Pushed through `31ea280` (rescale audit, SKU-merge, badges,
  date filters, `db:reset` script).
- **Uncommitted (local only):** the latest UI polish — bigger reported/actual
  cells, **green match highlight**, and the **Pending audit / Audited** two-color
  badge (+ `rescale_requests_audited` in `pending-counts`).
- **Build:** passes (`npm run build`).
- **Local DB:** migrated + reset (accounts kept). Schema has all V5 columns +
  `rescale_requests`.
- **Production (Railway):** code deployed, **DB NOT migrated** → runtime errors
  on `colorway` / `restock_pending` (and `batches/commit`).

---

## 3. Next steps

### 🔴 Migrate the Railway DB (unblocks production)
Run the idempotent migration against Railway (adds missing columns, **keeps
data**). Pick one:
- **Railway Data tab** → paste the `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`
  block (items columns + `rescale_requests`), or
- **`railway ssh`** into the app container → `npm run db:setup`, or
- locally with the **public** URL: `DATABASE_URL='<DATABASE_PUBLIC_URL>' npm run db:setup`.

After it runs, hard-refresh the app; the column errors stop.

### Commit the pending UI polish
- Green-match highlight, bigger compare cells, two-color rescale badge are
  **uncommitted** — commit & push when ready.

### Suggested hardening
- **Auto-run `db:setup` on server boot** (in `server.mjs`) so schema drift can't
  recur on future deploys. ← offered, not yet built.

### Open product decisions (awaiting your call)
- **"All"** option on the pending-queue date filters (No Box / Rescale /
  Requests) so older outstanding items aren't hidden by the Day default.
- **Auto-refresh** home badges (currently fetch once per home visit).
- Whether **rescale auto-resets** the store sync flags for clean re-listing.
- Confirm **rescale reasons** wording with both teams.

### Deferred (set aside)
- Official **alias.org API** (using the Railway bypass proxy for now).
- Manual **"add UPC"** for legacy no-box items (per-size UPCs aren't in the
  KicksDB SKU lookup, so they can't be backfilled).

### Suggested QA on the live deploy (after migration)
Receive → shelf · no-box → box-found · rescale → restocked · PH request →
warehouse audit (reported vs actual, red/green) · multi-session PH editing.
