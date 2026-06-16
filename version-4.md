# Stickballman12 · Version 4 — Design / Structure (for review)

> **Status:** design only. No code written yet. Review this, mark decisions in
> §13 (now confirmed), and I'll implement after you approve.
>
> **Hard constraint:** V4 **adds** to the app — every V3 feature (accounts,
> Check Access, **Bulk Scan**, **Rapid Scan**, the confirm dialog, the Google
> Sheet writes, camera, security) stays exactly as-is. V4 appears as **new
> option(s) on the home page** after login.

---

## 1. What the client asked for (analysis)

Grouping the client's message into concrete features:

| # | Client wants | Becomes (V4 feature) |
|---|---|---|
| A | "Scan many shoes in a row, then click *add to sheet* once at the end." Speed matters; eventually thousands of items. | **Batch Intake** — a rapid multi-scan "cart": scan continuously, commit once. |
| B | Shipment/batch details: buyer, supplier, tracking #, date received, cost, notes, special rules. | **Batch record** (header form on a batch). |
| C | Problem notes: mismatched shoe, stolen package, ripped open, improperly packed, missing boxes, supplier shortfall (10 expected / 5 arrived), other. | **Shipment issues** (structured, per batch). |
| D | "Create one large bulk batch and input everything together." | A batch groups many items + details + issues; commit as one unit. |
| E | Our own **internal barcode system** per item, tied to our DB: name, style/SKU, date received, **VIN / unique internal ID**, cost, supplier/buyer history, notes. Scanning it later pulls up the item; VIN tracks full history. | **Internal barcode + VIN** (generate, print labels, scan-to-lookup) + **per-item history**. |
| F | Better organization/visibility/**reporting**: daily report of all products; eventually **profit tracking** (sale price − cost − fees). | **Reports** (daily inventory now; profit later). |
| G | If an item is not scannable, allow **manual entry**. | Manual add form inside Batch Intake. |
| H | Main goal: organized, auditable, scalable; track origin; record issues; clean per-item history. | The DB-backed model below delivers this. |

### The core shift this implies
V1–V3 treat the **Google Sheet as the source of truth** (scan → append/consolidate).
V4's requirements (VIN per item, full per-item history, internal barcodes that
"pull up the original product", supplier/buyer history, profit later) can't live
in a flat sheet — they need a **relational database as the source of truth**. We
already run **Neon Postgres** (for accounts), so V4 extends that DB with
inventory tables. The Google Sheet stays as an **export/mirror** (see §10), so
nothing existing breaks.

---

## 2. Guiding principles

1. **Additive only.** New home tile(s); existing flows untouched.
2. **DB is the source of truth for V4 data** (batches, items, VIN, history);
   the Sheet remains an optional mirror for continuity/reporting.
3. **Speed for intake.** Scanning must never block on a network call — scans go
   into a local list instantly; product lookups resolve in the background.
4. **Auditability.** Every item has a VIN and an append-only event history.
5. **Reuse.** Reuse existing lookup (StockX→Alias→KicksDB), camera, auth, locks.

---

## 3. Home page changes  ✅ confirmed

Add **three new home tiles** (the V4 workflows are distinct and frequent, and
warehouse speed favors direct access over a nested hub):

- **📥 Receiving / Batch Intake** — create & fill batches, scan items, commit.
- **🔎 Inventory / Item Lookup** — scan an internal barcode or VIN → item + history.
- **📊 Reports** — daily inventory report (profit later).

Role visibility (**confirmed:** all three visible to both roles; financial
profit views gated to admin when Phase 4 lands):

| Tile | Admin | Employee |
|---|---|---|
| Check Access | ✓ | — |
| Bulk Scan | ✓ | ✓ |
| Rapid Scan | ✓ | ✓ |
| **Receiving (Batch Intake)** | ✓ | ✓ |
| **Inventory / Item Lookup** | ✓ | ✓ |
| **Reports** | ✓ | ✓ |

---

## 4. Feature designs

### 4.1 Receiving / Batch Intake
The headline V4 workflow.

1. **Create / open a batch.** Header form:
   - Buyer name, Supplier name, Tracking number, Date received (default today),
     Default product cost (optional, pre-fills each item), Notes, Special rules.
   - On save → a `batch` row with a short **Batch Code** (e.g. `B-100023`).
2. **Scan items rapidly (the "cart").**
   - A focused scanner-gun input + camera (reusing `CameraScanner`, including
     vertical-barcode support). Each scan **immediately** adds a line to an
     on-screen list (no waiting), then a **background lookup** fills in
     name/SKU/size/image (StockX→Alias for UPC; KicksDB for SKU). A line shows a
     small "resolving…" state until filled.
   - **One physical box = one item = one VIN** (confirmed). Each scan adds a
     distinct line; duplicate UPCs are **separate items** (each gets its own VIN
     and label) — this is what makes per-item tracking / "find the missing box"
     work. Per line you can edit: size, cost (defaults to batch cost), and a
     per-item note. (Quantity is implicitly 1 per item.)
   - **Manual add** button for non-scannable items (type name, SKU, size, cost,
     note) → adds a line flagged `source: manual`.
   - Running totals: item count, total cost.
3. **Record shipment issues** (any number) for the batch: pick a type
   (mismatched / stolen / ripped / improperly_packed / missing_boxes / shortfall
   / other), description, and for shortfall an expected vs received count.
4. **Commit batch once.** On "Finish / Add batch":
   - Assigns each item a **VIN** (atomic from a Postgres sequence), persists
     `items` + `item_events('received')`, links them to the batch.
   - Optionally **mirrors** committed items to the Google Sheet (§10).
   - Offers to **print internal barcode labels** for the batch (§9).
   - The confirm-before-send dialog (V3) can gate the commit for accuracy
     (confirmed: a single batch-summary confirm, not per item — §13.8).

   Speed note: the commit is **one** DB transaction (or a few batched inserts),
   not 200 round trips — so committing a 200-item batch is fast.

### 4.2 Internal barcode + VIN system
- **VIN** = unique internal id, atomically generated from a DB sequence, e.g.
  **`SB-100001`** (prefix + zero-padded number). Human-readable, unique, and
  **Code128-encodable** (works with the existing `@zxing` camera, which already
  decodes Code128). Using a DB sequence means no race/coordination issues.
- **Label** (printable): a card with the barcode (Code128 of the VIN) + human
  text (shoe name, SKU, size, VIN, date, batch). Rendered with a barcode lib
  (`jsbarcode`/`bwip-js`) and printed via a browser print stylesheet (label
  sheet) — see §9.
- **Scan-to-lookup routing.** When a scan is decoded:
  - If it matches our VIN pattern (`^SB-\d+`) **or** the symbology is Code128 →
    look it up in **our DB** (`/api/items/lookup`) → show the item + full
    history.
  - Else (UPC 8–14 digits / SKU) → the existing external lookup.
- This makes the internal barcode "pull up the original product" and, via the
  VIN, surface the item's whole history.

### 4.3 Item lookup & history
- **Lookup** by scanning the internal barcode, or typing a VIN/SKU.
- Shows: product details, batch/shipment it came from (buyer/supplier/tracking/
  date), cost, current status, and a **timeline** of `item_events`
  (received → moved → issue → status change → sold …). This is the "full
  history" / "supplier-buyer history" the client wants for tracking missing or
  problematic items.

### 4.4 Reporting
- **Daily report (now):** all items received/active for a date (or range) with
  filters (batch, supplier, status) → on-screen table + CSV export. Also a
  per-batch summary (counts, total cost, issues).
- **Profit tracking (future / phased):** a `sales` record per item
  (sale_price, fees) → profit = sale_price − cost − fees; rolled up into reports.
  Designed for now (schema in §6), built later (client said "eventually").

---

## 5. Data model (Neon Postgres) — sketch

New tables (added by `npm run db:setup`; existing `users/login_attempts/locks`
stay). Final column types/constraints finalized at coding time.

```
batches
  id              bigint identity PK
  batch_code      text unique           -- e.g. 'B-100023' (from a sequence)
  buyer_name      text
  supplier_name   text
  tracking_number text
  date_received   date
  default_cost    numeric(12,2)
  notes           text
  special_rules   text
  status          text  -- 'open' | 'committed'
  created_by      text  -- user name/username
  created_at      timestamptz default now()
  committed_at    timestamptz

items
  id              bigint identity PK
  vin             text unique           -- 'SB-100001' (from a sequence)
  batch_id        bigint FK -> batches
  name            text
  sku             text
  size            text
  upc             text                  -- original scanned UPC (if any)
  image_url       text
  cost            numeric(12,2)
  source          text  -- 'stockx' | 'alias' | 'kicksdb' | 'manual'
  status          text  -- 'in_stock' | 'sold' | 'missing' | 'issue' | ...
  notes           text
  created_by      text
  created_at      timestamptz default now()
  updated_at      timestamptz

item_events                              -- append-only per-item history
  id          bigint identity PK
  item_id     bigint FK -> items
  type        text  -- 'received' | 'status_change' | 'issue' | 'note' | 'moved' | 'sold'
  details     jsonb -- flexible payload (old/new status, note text, etc.)
  created_by  text
  created_at  timestamptz default now()

shipment_issues
  id              bigint identity PK
  batch_id        bigint FK -> batches
  type            text  -- 'mismatched' | 'stolen' | 'ripped' | 'improperly_packed'
                        --  | 'missing_boxes' | 'shortfall' | 'other'
  description     text
  expected_count  int   -- for 'shortfall'
  received_count  int
  created_by      text
  created_at      timestamptz default now()

sales                                    -- FUTURE (profit tracking)
  id          bigint identity PK
  item_id     bigint FK -> items unique
  sale_price  numeric(12,2)
  fees        numeric(12,2)
  sold_at     timestamptz
  -- profit = sale_price - items.cost - fees  (computed in reports)

-- sequences for human-readable codes
vin_seq    (start 100001)   -> VIN  'SB-' || nextval
batch_seq  (start 100001)   -> batch_code 'B-' || nextval
```

Relationships: `batches 1—* items 1—* item_events`; `batches 1—* shipment_issues`;
`items 1—0..1 sales`.

---

## 6. New API endpoints (all auth-gated; reuse `requireAuth`)

```
POST /api/batches/create        { ...batch fields }            -> { batch }
GET  /api/batches               (list, filters)                -> { batches }
GET  /api/batches/:id           (one batch + items + issues)   -> { batch, items, issues }
POST /api/batches/commit        { batchId, items[], issues[] } -> { committed, vins[] }
POST /api/batches/issue         { batchId, ...issue }          -> { issue }

POST /api/items/lookup          { code }   (VIN or internal barcode) -> { item, history }
GET  /api/items                 (inventory list, filters/report)     -> { items }
POST /api/items/manual          { ...item fields, batchId }          -> { item }
POST /api/items/event           { itemId, type, details }            -> { event }   (status change / note / issue)

GET  /api/reports/daily         { date|range, filters }              -> { rows, totals }

(FUTURE) POST /api/sales/record  { itemId, salePrice, fees }
```

- VIN/batch-code generation uses Postgres sequences (atomic, no lock needed).
- The bulk **commit** writes all items in one transaction, then mirrors them to
  the Sheet (consolidated) reusing the existing global `sheet:write` lock +
  `upsertVariants`.
- Reuses existing `/api/upc-search`, `/api/sku-search` for per-scan resolution.

---

## 7. New frontend (in `src/App.jsx` + maybe split files)

- **Home**: new tile(s) (§3), role-gated.
- **Receiving / BatchIntake**: batch header form → scan cart (list with
  resolving lines, per-line edit, manual add) → issues panel → commit + print.
- **ItemLookup**: scan/enter → item card + history timeline.
- **Reports**: filters + table + CSV export.
- **LabelPrint**: printable label sheet (barcodes) with a print CSS.
- New API methods in `src/api.js`. New styles in `src/styles.css`.
- Reuses `CameraScanner`, `ConfirmSend`, `TopBar`, prefs.

If `App.jsx` gets too large, split components into `src/views/` (internal
refactor, no behavior change).

---

## 8. Internal barcode format & label design

- **Symbology:** Code128 (alphanumeric, compact, already decodable by the app).
- **VIN encoded:** `SB-100001`. Routing: a scanned value matching `^SB-\d+`
  (or decoded as Code128) → internal lookup; otherwise external UPC/SKU.
- **Label content (printable card):**
  ```
  [ |||| Code128 of SB-100001 |||| ]
  Nike Vomero Plus  ·  HV8154-100  ·  8.5W
  VIN SB-100001   ·   Recv 2026-06-15   ·   Batch B-100023
  ```
- **Printing:** render barcodes with `jsbarcode` (SVG) and lay labels out in a
  grid with an `@media print` stylesheet; user prints to a label printer or
  paper. (PDF export is a possible later add.)

---

## 9. Relationship to the Google Sheet  ✅ confirmed

**DB is the source of truth; the Sheet is a one-way mirror.** On batch commit,
items are also written to the existing Google Sheet using the V3 rules
(A–J, `Scanned by`, **consolidated** by SKU + Size + scanner) so the current
sheet stays a clean summary and existing reporting keeps working. Per-item VIN
detail and history live in the **DB** (surfaced via Inventory/Lookup + Reports).

**Bulk Scan and Rapid Scan keep writing to the Sheet exactly as in V3.**

---

## 10. Speed & concurrency

- **Non-blocking scanning:** a scan appends to the local cart instantly; lookups
  run async (a small concurrency-limited queue) and fill in details. Scanning a
  stream of 200 never waits on the network.
- **One commit:** persisting a batch is a single DB transaction → fast and atomic.
- **Atomic codes:** VIN/batch codes from Postgres sequences (no races, unlike the
  sheet — which is why VINs can be clean sequential numbers now).
- **Sheet mirror** reuses the global `sheet:write` lock.
- **Neon cold start** still applies (first DB call after idle ~1–3s); match
  Vercel/Neon regions for best latency.

---

## 11. Security

- All new endpoints behind `requireAuth` (admin-only where appropriate, e.g.
  maybe Reports). Parameterized SQL (Neon tagged templates). Input validation &
  size caps as in V3. No new public surface. Internal barcodes are not secrets,
  but item lookups still require a valid session.

---

## 12. New dependencies

- **`jsbarcode`** (or `bwip-js`) — render Code128 labels in the browser.
- (Optional, later) a CSV/PDF helper — CSV can be done with no dependency.

Everything else reuses current stack (React/Vite, Neon driver, zxing,
google-auth-library).

---

## 13. Decisions — ✅ confirmed (recommended options locked in)

These are now baked into the design above. Override any before I start coding.

1. **Home tiles:** **three tiles** — Receiving, Inventory/Lookup, Reports
   (distinct, frequent tasks; direct access > nested hub).
2. **Sheet relationship:** **DB is truth, Sheet is a one-way mirror** of
   committed batches (consolidated, V3 format). §9.
3. **Roles:** Receiving, Inventory/Lookup, and Reports are **visible to both
   roles**; profit/financial views become **admin-only** when Phase 4 ships.
4. **VIN format:** **`SB-100001`** — sequential, atomic from a Postgres sequence
   (human-readable, Code128-friendly, no date noise).
5. **Cost:** **per-item cost with a batch-level default**, currency **USD**.
6. **One physical box = one item = one VIN** — duplicate scans create separate,
   individually-labeled items (enables "track the missing box"). The Sheet mirror
   still shows consolidated quantities; the DB holds per-VIN detail.
7. **Label printing:** **browser-printed label cards in an Avery-compatible
   grid** (works on plain Letter/A4 too) now; thermal-printer-specific layouts
   later if needed.
8. **Commit confirm:** **one batch-summary confirm** (item count + total cost +
   issues), not per-item — keeps intake fast.
9. **Profit tracking:** **schema now, UI later** (Phase 4) — matches the client's
   "eventually."
10. **Labels:** **every item gets a VIN**; **label printing is on-demand per
    batch** (print all after commit, or reprint a batch/item later).

---

## 14. Suggested phased delivery

- **Phase 1 — Data + Batch Intake core:** DB tables/sequences, batch create,
  scan cart (async lookups), manual add, commit (DB), basic list. Home tile.
- **Phase 2 — Internal barcodes + lookup + history:** VIN labels + print,
  scan-to-lookup routing, item history timeline, status changes/issues.
- **Phase 3 — Reporting:** daily report + CSV export; per-batch summaries.
- **Phase 4 (later) — Profit tracking:** sales records + profit in reports.
- Sheet mirror (if chosen) folded into Phase 1's commit.

---

## 15. Risks / non-goals

- **Scope:** this is the biggest version — it turns a scan-to-sheet tool into a
  small inventory system. Phasing keeps each step shippable.
- **Two sources of truth** (DB + Sheet) can drift; the mirror is one-way
  (DB → Sheet) to limit that.
- **Label printing** depends on the user's printer/labels; we'll target a sane
  default and iterate.
- **Non-goals (for now):** multi-warehouse/locations, returns/RMA, barcode label
  PDF batch export, and live profit dashboards (beyond the schema) unless you
  want them pulled earlier.
