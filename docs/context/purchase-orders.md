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
  (`/ph/reconciliation`). **PH can reconcile + archive too** (`canReconcile` on both routes;
  `po/reconcile` and `po/close` accept `['warehouse','ph_team']`) — PH is the side chasing the
  supplier over a shortage, so gating the close on warehouse just parked POs in the queue.
  - **Auto-reconcile (a clean PO closes itself).** `autoReconcileIfClean(poId)` snapshots + flips
    `receiving`→`reconciled` with **no human tap** when *every* guard holds: PO is still
    `receiving`; its `received_batch_id` batch is **`committed`**; **no `po_boxes` row is
    `pending`/`packed`** (nothing left at the supplier); and the reconciliation is
    `clean` + `!no_manifest` + `expected_units > 0` + `received == expected`. Anything short/over/
    blind/mid-intake stays in the manual queue. Called (best-effort, never blocks the response)
    from `batches/commit`, `batches/box-commit` (on `autoCompleted`), `batches/set-status`
    (manual "done"), and as a **self-heal sweep in `po/reconcile-list`** so POs received before
    this existed clear themselves on the next page load. Without it, a no-discrepancy PO sat in
    the queue forever and the supplier read the `receiving` chip as still-outstanding.
  - **The chip says what's actually true** (`poChip()` in `Reconciliation.jsx`), because
    "To reconcile" on a 13-of-13 all-matched PO reads as a chore when there's nothing to decide:
    `Reconciled` / `Receiving` (intake unfinished) / `Received blind` / `N discrepancies` /
    `Boxes still out` / `Matched · ready to close`. Fed by **`getPoReconcileState(poId)`**
    (`{ po, rows, summary, intakeDone, awaitingBoxes }`) — the *same* helper the auto-close guard
    uses, so a badge can never contradict it. `reconcile-list` attaches it per open PO as `rc`
    (closed POs reuse their frozen `reconciliation->'summary'`); `po/reconciliation` returns
    `intake_done`/`awaiting_boxes` for the detail header. New `.po-chip.bad`/`.warn` variants.
    **The Home badge is split in two** so narrowing it never hides a live PO:
    `pendingCounts.po_to_reconcile` (amber, intake `committed` — a human must decide) +
    **`po_receiving`** (neutral `info`, batch not committed — arrived, still being scanned in).
    They partition the old single `status='receiving'` count exactly. `homeCardBadges('reconcile')`
    returns both (PHTeam's card now calls it instead of hand-rolling its own badge array); only
    the amber one feeds Home's "Needs attention" strip.
    Closing mid-intake still works but shows a "closing now freezes the count" note.
  - **Report table UI.** Classes are prefixed **`rcn-`, not `rc-`** — `RescaleRequests.jsx` owns
    `rc-*` and `.rc-item` there paints a bordered card, which drew a stray pill around every SKU
    cell. Rows are two-line (SKU · size, then product name), qty is one `got/exp` cell, and a chip
    shows only on problem rows (matched get a green ✓ + a fold: **"N lines matched ✓ — Show"**).
    A **By size / By SKU** switch groups the lines one-per-SKU with a chip per size; grouping runs
    **before** the problem/matched split so a SKU that's short in one size isn't torn across both
    sections (it inherits its worst flag). Duplicate `tag_code`/`supplier_name` is suppressed.
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

## Supplier non-compliance — on-behalf manifest entry + no-manifest receiving
Two escape hatches for when a supplier won't use the scan-out portal:

- **Option 1 — supplier hands over a manual list → PH enters it on their behalf.**
  `scan`/`line` now accept **`ph_team`** (not just `supplier`); admin/superadmin auto-allowed.
  A supplier is still scoped to their own POs, but PH/admin may fill **any** PO the team
  owns (only while it's `draft` + label `pending`, the same window a supplier scan uses).
  Every write stamps `po_lines.entered_by` (the staff user's id) + `entered_on_behalf=true`.
  **Attribution is dual-visibility:** `getPoFull` joins `entered_by_name`; `po/get` **strips
  `entered_by`/`entered_by_name` from a supplier's response** (keeps `entered_on_behalf`),
  so the **supplier sees only "{business}'s Staff"** while **warehouse/PH see the real
  person**. Business name = `app_settings.business_display_name` (default `Stickballman12 LLC`),
  returned as `businessName` on `po/get` and via `getBusinessName()`. If a supplier later edits
  a PH-entered line, `onBehalf` becomes false and `entered_by` clears (they take ownership).
  Env admin/superadmin have a non-numeric `uid`, so their writes set the flag but leave
  `entered_by` NULL (no real `users` row to reference).
  **UI:** the shared **`src/components/PoScanModal.jsx`** (extracted from `SupplierApp` — exports
  `PoScanModal` + `PoLineRow`, used by both sides) is opened from **`PoOverview`** per draft/pending
  label ("Add items on their behalf"), which also renders each line's internal attribution.
  `SupplierApp` shows "Entered for you by {business}'s Staff" on flagged lines.

- **Option 2 — no list at all → warehouse receives blind.** Already works (receive against a
  `draft`/`shipped` PO, scan the actual items). `getPoReconciliation` now sets
  **`summary.no_manifest`** (received PO with 0 expected units + >0 received). `Reconciliation.jsx`
  then shows a **"No manifest provided — received blind"** banner, labels every row **"Received"**
  instead of "Not on PO", and the copy-report says so — no wall of phantom overages.

- **Option 3 (Path C) — supplier gives ONE list for the whole purchase, not per box.** PH enters it
  against the **PO itself** (a `po_lines` row with **`po_box_id` NULL**), not a label —
  `POST /api/po/scan-order` (ph_team; always on-behalf) via `addPoOrderScan` (conflict target =
  partial unique index `(po_id, sku, size) WHERE po_box_id IS NULL`), which flips
  **`purchase_orders.manifest_scope` `box`→`po`** (`setPoManifestScope`). **A PO is one scope
  or the other** — `scan-order` 409s if the PO already has per-box lines (`poHasBoxLines`), and the
  per-box `scan` 409s if `manifest_scope='po'`. **Reconciliation branches on scope:** `'po'` counts
  the **entire** manifest order-wide (no shipped-label filter — the lines have no label); `'box'`
  keeps the shipped-labels-only filter. **Receiving is unchanged — still per box, exactly like a
  blind receive** (the manifest just isn't per-box, so there's no per-label checklist). `updatePoLine`
  branches its size-merge sibling lookup for null-box lines (match within the PO, not the label).
  **UI:** shared `PoScanModal` gains an order mode (`po` prop instead of `box`) → `api.poScanOrder`;
  `PoOverview` shows a **"Whole-order manifest"** block with an **"Add whole-order manifest"** button
  (draft PO, no per-box lines) + internal attribution; `SupplierApp` shows a read-only **"Order
  manifest"** card with the "…'s Staff" note. **Schema-touch: `po_box_id` nullable + `manifest_scope`
  + partial index → run `db:setup`.**

## Tracking pushes (17TRACK webhook) — works for the non-compliant paths too
For the pushes to actually fire when a supplier never uses the portal:
- **Register at PO creation.** `create.js` calls `registerTracking()` on the labels' numbers right
  after `createPo` (best-effort, no-ops without `TRACKING_API_KEY`) — not only at `po/ship` (which
  non-compliant suppliers never hit). Registration is what makes 17TRACK watch the box + push.
  **Consumes 1 quota/number** at register time.
- **Webhook auth = the `?secret=` on the configured URL.** 17TRACK posts to the EXACT URL set in its
  dashboard (`api.17track.net/admin/settings` — dashboard-only, no API to set it), query string
  included, so configure `https://<host>/api/po/tracking-webhook?secret=<TRACKING_WEBHOOK_SECRET>`.
  17TRACK also sends a `sign` header (SHA256 of body + API key) we could additionally verify later.
- **`pre_transit` box status** (schema: added to the `po_boxes` status CHECK). `mapBoxStatus` maps
  17TRACK **`InfoReceived` → `pre_transit`** ("label made, still with the supplier"), distinct from
  `in_transit` ("courier has it"). UI shows it as a slate "With supplier · label made" chip.
  `setPoBoxTracking` is now **forward-only** (rank pending<packed<pre_transit<shipped<in_transit<
  delivered) so a late lower push never moves a box backwards. **Schema-touch: run `db:setup`.**
- **Google Sheets mirror** (optional): `forwardTrackingToSheet` (env `GOOGLE_SHEETS_TRACKING_URL`)
  posts every update to a Google Apps Script Web App from BOTH the webhook and `track-refresh`
  (best-effort, env-gated). Setup + Apps Script in `docs/google-sheets-tracking.md`.

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
  `unit_cost`, **`entered_by`** → `users(id)` (staff who entered/last-edited an on-behalf
  line; NULL when the supplier scanned it), **`entered_on_behalf`** bool. **Unique
  `(po_box_id, sku, size)`** — one line per SKU+size **per label**, so the same SKU+size can
  appear under different labels; a re-scan increments `qty_expected` (and re-stamps the actor).
  **Schema-touch: run `db:setup`** (adds `entered_by`/`entered_on_behalf` + seeds the
  `business_display_name` app_setting).
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
