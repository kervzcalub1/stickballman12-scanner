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
- Phases 2–5 (not started): receive-against-PO → reconciliation → 17TRACK tracking → polish.

## Phase 1 — endpoints & flow
`api/po/*` (house order: `applySecurity → requireRole → rateLimit → getJsonBody`; supplier
scoped to own POs on every one; admin/superadmin auto-allowed):
- `create` (ph_team) — PO shell + one `po_boxes` row per label.
- `suppliers` (ph_team) — approved supplier accounts for the create picker.
- `list` / `get` — ph_team/warehouse/admin see all; supplier only their own.
- `scan` (supplier) — add/increment a `po_lines` row under a label; **only** while the PO is
  `draft` and the label `pending`. Writes po tables only — never the receiving commit path.
- `line` (supplier) — adjust/remove a line qty.
- `ship` (supplier) — mark a label shipped (needs ≥1 item); PO flips to `shipped` when all
  labels are shipped.

**UI:** PH `CreatePO` lives in PHTeamApp (`/ph/purchase-orders`). Supplier `SupplierApp`
renders for `role === 'supplier'` (any host) and on the `supplier.` subdomain
(`App.jsx` `SUPPLIER_HOST`); the hostname is UX-only — the server scoping is the boundary.

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
  `carrier` / `tracking_status` / `last_checkpoint` / `checked_at` (filled by the tracking
  aggregator later), `status` ∈ `pending | shipped | in_transit | delivered`, `shipped_at`.
  The PO flips to `shipped` only when **all** its labels are shipped.
- **`po_lines`** — the "what the supplier says he shipped." `po_id`, `po_box_id` (which
  label — **NOT NULL**), `sku`, `size`, `name/upc/colorway/gender`, `qty_expected`,
  `unit_cost`. **Unique `(po_box_id, sku, size)`** — one line per SKU+size **per label**, so
  the same SKU+size can appear under different labels; a re-scan increments `qty_expected`.
- **`batches.po_id`** → `purchase_orders(id)` — set on scan-in. Reconciliation joins
  `po_lines` (expected) against `items` under that batch (actual), grouped by `(sku, size)`.

## Roles
- **`supplier`** — new DB role (`users.role` CHECK now includes it). **Admin-assigned
  only**: `api/auth/signup.js` offers only `warehouse | ph_team`; admin sets `supplier` via
  Check Access (`api/admin/review.js` ROLES). Per-PO scoping lands with the endpoints
  (Phase 1). See `auth-roles.md`.

## Gotchas
- Schema-drift trap: run `npm run db:setup` on **local and prod** after this lands
  (additive/idempotent — `deploy.md`).
- BIGINT ids come back as **strings** from `pg` — coerce `Number(row.id)` before `===`
  (same trap that caused the multi-box "Box not found" bug).
- Supplier scan-out must write **only** `purchase_orders` / `po_boxes` / `po_lines` — never
  the receiving `commit` path.
