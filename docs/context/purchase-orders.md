# Purchase Orders — supplier scan-out → reconciled receiving

Full product plan: `docs/po-scanout-plan.md`. This file tracks what's **built**.

## What it is
Inbound receiving that starts **before the box arrives**. The **PH team** opens an order
(the "Form / Batch"), an external **supplier** signs in and scans what they're shipping,
the courier carries it, and the **warehouse** receives it back **against the same order** —
reconciling what was promised vs. what actually arrived. A batch spans **multiple shipping
labels** (one tracking number each); it closes only when every label is shipped.

## Status
- **Phase 0 (done, merged):** schema + `supplier` role.
- **Phase 1 (built, on branch `feat/po-phase1-scanout` — not deployed):** PH create-batch
  form + supplier scan-out portal + subdomain gating. Endpoints under `api/po/*`, client
  methods `api.po*`, screens `CreatePO.jsx` (PH) + `SupplierApp.jsx` (supplier).
- **Phase 2 (built, on branch `feat/po-phase2-receive` — not deployed):** receive a shipment
  against a PO. `GET /api/po/open` (open shipments) + `GET /api/po/lookup?q=` (by PO code OR a
  label's tracking #). Receiving Step 1 gains a "Receive against a purchase order" picker
  (`PoPickerModal`) that pre-fills supplier/tag and maps each label → a box slot; commit
  (`commit.js` / `create-open.js`) accepts `poId`, sets `batches.po_id`, and `markPoReceiving`
  flips the PO **`draft`/`shipped` → `receiving`** (+ `received_batch_id`, idempotent). box-commit
  needs no change (the batch already carries `po_id`). **Receiving is allowed against a `draft` or
  `shipped` PO** — boxes arrive one at a time, often before the supplier marks every label shipped
  (a multi-label PO stays `draft` until ALL labels ship), so `commit.js`/`create-open.js` block only
  a `reconciled`/`closed` PO ("already … — can't be received against again"), not `draft`.
- **PH "Purchase Orders" overview (`PoOverview.jsx`, `/ph/po-status`):** read-only list of every PO
  the team opened — status chip + `shipped/box` label count + `delivered_count` (added to `listPos`)
  + units; tap to expand per-label tracking (status/carrier/checkpoint) with **Refresh all** +
  per-label refresh. Fixes "PH reconciliation page is blank" — Reconciliation only lists POs already
  in `receiving`/`reconciled`, so shipped/draft POs (with tracking) had nowhere to show.
- **Phase 2b (in progress) — receive by MANIFEST, not blind re-scan (2026-07-09 decision):**
  When a box is received against a PO, its expected lines (from `po_lines` for that label)
  pre-populate a **checklist**: one row per SKU+size with a **present checkbox + editable
  "received" count** (defaults to expected — lower it for a shortage). Each row has **add
  issue** (defect/no-box/etc. per shoe). Staff can **add an unexpected item** (scan/type) →
  received + flagged **overage / not-on-PO**. On confirm, the checklist builds the same
  `items[]` + `unitIssues[]` the scan flow produces and reuses **box-commit** (mints VINs).
  Reconciliation (received-vs-expected per SKU+size: shortage/overage/wrong-SKU) falls out of
  this at receipt; the full PO-level snapshot + PO→`reconciled` is Phase 3.
- **Phase 3 (built, on branch `feat/po-phase3-reconcile` — not deployed):** reconciliation.
  `GET /api/po/reconciliation?poId=` computes expected (po_lines) vs received (items under
  `received_batch_id`) grouped by (sku,size), flagging **match / shortage / overage /
  wrong_size (SKU expected, size not) / wrong_sku (SKU not on PO)**. `GET /api/po/reconcile-list`
  lists received/reconciled POs. `POST /api/po/reconcile` snapshots the table to
  `purchase_orders.reconciliation` (JSONB) + `reconciled_at` and flips status → `reconciled`
  (only from `receiving`; 409 otherwise). UI: `Reconciliation.jsx` screen (list → report table
  + summary + **Copy discrepancy report** for the group chat + **Reconcile & close**). Reachable
  from the main Home ("PO Reconciliation", warehouse/admin — full) and PHTeamApp
  (`/ph/reconciliation`, PH — view + copy only, `canReconcile={false}`).
- **Phase 4 (built, on branch `feat/po-phase4-tracking` — not deployed):** shipment tracking
  via **17TRACK**, behind a thin adapter (`api/_lib/tracking.js`) that **no-ops unless
  `TRACKING_API_KEY` is set**. On ship, `po/ship` registers the label's number; status lands
  either by **webhook push** (`POST /api/po/tracking-webhook?secret=…`, gated by
  `TRACKING_WEBHOOK_SECRET`) or an **on-demand pull** (`POST /api/po/track-refresh`
  `{poId, poBoxId?}`, warehouse/ph/supplier). Omit `poBoxId` → refresh **every** label
  (one lookup per tracking number); pass it → refresh just **that one** label (fewer
  tracking-API credits). Supplier portal has **Refresh all tracking** + a per-label
  **Refresh this label** button on each shipped label. Both write `carrier` / `tracking_status` / `last_checkpoint` / `checked_at`
  and advance `po_boxes.status` (17TRACK status → shipped/in_transit/delivered via
  `mapBoxStatus`). Supplier portal shows per-label status + a "Refresh tracking" button.
  Env: `TRACKING_API_KEY`, `TRACKING_WEBHOOK_SECRET` (see `.env.example`). Live register/
  gettrackinfo calls need a real key to validate; mapper/parser/DB-update verified locally.
- **Phase 5 (built, on branch `feat/po-phase5-polish` — not deployed):** polish.
  **Reconcile badge** — `pendingCounts` gains `po_to_reconcile` (count of `receiving` POs);
  the "PO Reconciliation" Home card + PH card show a "To reconcile" badge, and it appears in
  Home "Needs attention" when > 0. **Archive** — `POST /api/po/close` (warehouse) flips a
  `reconciled` PO → `closed` (409 otherwise); an **Archive** button on the reconciled report
  removes it from the reconcile list (which only shows receiving/reconciled). Supplier-account
  admin is already covered by **Check Access** (approve / set role / reset password / delete),
  so no new admin UI. Feature complete through Phase 5.

## Note — circular FK
`batches.po_id → purchase_orders(id)` and `purchase_orders.received_batch_id → batches(id)`
form a cycle. Creation order is fine (PO → batch(po_id) → set received_batch_id). Deletion of
either row is blocked until one link is nulled — the app never deletes these, so it only
matters for manual test-data cleanup (null `received_batch_id` first).

## Phase 1 — endpoints & flow
`api/po/*` (house order: `applySecurity → requireRole → rateLimit → getJsonBody`; supplier
scoped to own POs on every one; admin/superadmin auto-allowed):
- `create` (ph_team) — PO shell + one `po_boxes` row per label.
- `suppliers` (ph_team) — approved supplier accounts for the create picker.
- `list` / `get` — ph_team/warehouse/admin see all; supplier only their own.
- `scan` (supplier) — add/increment a `po_lines` row under a label; **only** while the PO is
  `draft` and the label `pending`. Writes po tables only — never the receiving commit path.
- `line` (supplier) — edit an already-scanned line's **size and/or qty** (`{ lineId, size?, qty? }`;
  qty ≤ 0 removes it), only while the PO is `draft` and the label is `pending`. Changing the size
  into an existing SKU+size line on the same label **merges** them (`updatePoLine`, respecting the
  unique `(po_box_id, sku, size)`). Surfaced as inline size input + qty stepper + remove on each
  line of a still-filling box in `SupplierApp` (`PoLineRow`); read-only once packed/shipped.
- `close-box` (supplier) — review then close a label for shipment: `pending` → `packed`
  (needs ≥1 item). Editing (scan/line) is blocked while `packed`.
- `reopen-box` (supplier) — `packed` → `pending`, to keep editing before shipping.
- `ship` (supplier) — ship a **`packed`** label; PO flips to `shipped` only when no label is
  still `pending` or `packed` (all shipped).

**Box lifecycle:** `pending` (filling — scan items) → `packed` (reviewed & closed, ready to
ship; reopenable) → `shipped` → `in_transit`/`delivered` (tracking). The supplier `ScanModal`
mirrors the warehouse Add-Item dialog (inline continuous camera, 1.2s de-dup, auto-filled size
+ size chips + "+ Custom", re-scan bumps qty, different-shoe switch prompt). "Review & close
box" opens a contents review before closing.

**UI:** PH `CreatePO` lives in PHTeamApp (`/ph/purchase-orders`). Supplier `SupplierApp`
renders for `role === 'supplier'` (any host) and on the `supplier.` subdomain
(`App.jsx` `SUPPLIER_HOST`); the hostname is UX-only — the server scoping is the boundary.

**PDF label import (`CreatePO`):** the Shipping-labels card has an **Upload labels PDF**
button (one shipping label per page). `decodeTrackingPdf` in `src/trackingOcr.js`
(lazy-loads `pdfjs-dist`) reads each page's tracking number — embedded PDF text first
(`pickTrackingFromItems`, carrier-aware: UPS `1Z…`, USPS/FedEx grouped digits, FedEx `96…`),
falling back to rendering the page and reusing the barcode/OCR image path. **Parses each
positioned text item separately** — joining the whole page merges the tracking number into
the adjacent zip / FedEx ASTRA form line and yields bogus numbers; it prefers an item that
is a tracking number on its own, then the most-repeated candidate. It appends one editable
label row per page; blanks are left for manual entry. All client-side.

**PH home (PHTeamApp):** cards are grouped **Pricing & Listing** (New Inventory, Rescale
Stock, Edited Photos, Price Inquiry) · **Purchase Orders** (New Batch, PO Reconciliation) ·
**Requests & Tracking** (No Box, Request Rescale).

## Schema (in `scripts/db-setup.mjs`)
Two entities, deliberately separate so **expected** (supplier) and **actual** (warehouse)
stay independent, and so **supplier scan-out never runs the receiving commit** (which mints
VINs + inserts `items` = phantom stock).

- **`purchase_orders`** — the order shell. `po_code` (`PO-<po_seq>`, from `po_seq` START
  100001), `supplier_name`, `supplier_user_id` → `users(id)` (the supplier account that
  fills it), `status` ∈ `draft | shipped | receiving | reconciled | closed`, `tag_code` +
  `date_of_purchase` (from the PH form), `expected_boxes` (how many shipping labels),
  `received_batch_id` → `batches(id)`, `reconciled_at`, `reconciliation JSONB` (snapshot).
- **`po_boxes`** — one row per **shipping label** (outbound mirror of `batch_boxes`).
  `po_id`, `box_number`, `tracking_number` (PH pre-assigns the real courier number),
  **`carrier_key`** (the 17TRACK numeric carrier code chosen in the New Batch dropdown or
  auto-detected from the labels PDF; passed to 17TRACK register/gettrackinfo so it pulls
  from the RIGHT courier), `carrier` (display NAME the aggregator returns), `tracking_status`
  / `last_checkpoint` / `checked_at`, `status` ∈ `pending | shipped | in_transit | delivered`,
  `shipped_at`. **Carrier UX:** `src/lib/carriers.js` = curated 17TRACK carriers (UPS/FedEx/
  USPS/… keyed by code) + `carrierName(code|name)` + `detectCarrierKey({text,number})`
  (label-text keyword first, then number format — 1Z→UPS, 96…→FedEx, 9x→USPS, etc.).
  `decodeTrackingPdf` returns `carrierKey` per page; `CreatePO` shows a per-label courier
  `<select>` (— Select courier — · UPS · FedEx · USPS · …) preselected from the PDF; the key
  flows create → `po_boxes.carrier_key` → `registerTracking`/`fetchTrackInfo` (items are
  `{number, carrier}`). `parseTrackEntry` prefers the provider name / maps the code so a
  label shows "UPS" not "100002". **Schema-touch: run `db:setup` (adds `carrier_key`).**
  The PO flips to `shipped` only when **all** its labels are shipped.
- **`po_lines`** — the "what the supplier says he shipped." `po_id`, `po_box_id` (which
  label — **NOT NULL**), `sku`, `size`, `name/upc/colorway/gender`, `qty_expected`,
  `unit_cost`. **Unique `(po_box_id, sku, size)`** — one line per SKU+size **per label**, so
  the same SKU+size can appear under different labels; a re-scan increments `qty_expected`.
- **`batches.po_id`** → `purchase_orders(id)` — set on scan-in. Reconciliation joins
  `po_lines` (expected) against `items` under that batch (actual), grouped by `(sku, size)`.

## Roles
- **`supplier`** — DB role (`users.role` CHECK includes it). **Self-signup on the
  `supplier.` subdomain, admin-approved**: `signup.js` forces role `supplier` when the
  request `Host` is `supplier.*` (pending until an admin approves); the main host stays
  `warehouse | ph_team` and can't be tricked into `supplier`. Admin can also set it via
  Check Access. Per-PO scoping on every endpoint. See `auth-roles.md`.

## Gotchas
- Schema-drift trap: run `npm run db:setup` on **local and prod** after this lands
  (additive/idempotent — `deploy.md`).
- BIGINT ids come back as **strings** from `pg` — coerce `Number(row.id)` before `===`
  (same trap that caused the multi-box "Box not found" bug).
- Supplier scan-out must write **only** `purchase_orders` / `po_boxes` / `po_lines` — never
  the receiving `commit` path.
