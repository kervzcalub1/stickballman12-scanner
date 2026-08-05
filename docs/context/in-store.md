# In-Store Buying + In-Store Listing

Pairs bought at retail stores, scanned as they're bought. **admin + warehouse only**
(never `ph_team`). The hard rule: **in-store buys bypass the PH team entirely** — they
are listed to the stores **by hand**, never through Intelligent Inventory (II) or the
PH sync cascade. Same `items`/`batches` model as everything else, tagged
`kind='instore'` — **no separate table** (a split would mean re-implementing shelve/
locate/labels/no-box/sold-shipped). See also `receiving.md`, `ph-report.md`,
`statuses.md`, `data-model.md`.

## Two surfaces
1. **In-Store Buying** (`/instore`) — the intake. Reuses the `Receiving` component in
   `mode="instore"` (`src/App.jsx`). Home → *Intake* card "In-Store Buying".
2. **In-Store Listing** (`/instore-listing`) — the worklist to track manual store
   listing. `src/screens/InstoreListing.jsx`. Home → *Browse & Listings* card
   "In-Store Listing", badge = pairs still needing listing (`instore_unlisted`).

## Intake (`mode="instore"` in `Receiving.jsx`)
Full **4-step** wizard like receiving (**Store → Items → Review → Issues**) but with a
**shipment-less header** — only an optional **Store / location** field (→ `batch.origin`),
date, cost, notes. No supplier / buyer / tracking / dup-check / multi-box.
- Flag split: `isInstore = mode === 'instore'`; `noShipment = isRescale || isInstore`
  gates the *header* (drops supplier/buyer/tracking). The *step flow* (Review + Issues)
  is gated on `isRescale` alone, so in-store keeps all 4 steps. `isRescale` also still
  gates the VIN-rescan behaviour — **in-store is fresh stock, scanned like receiving**
  (UPC/SKU, `mode="product"` scanner), not rescanned by VIN.
- Commit: `POST /api/batches/commit { kind:'instore', ... }`. Lands at `needs_shelf`
  (boxed) / `no_box` (box unchecked or flagged) — identical to receiving, so Inventory,
  No-Box, labels, shelving, sold/shipped all work unchanged. GI-price enrichment is
  **skipped** for in-store (that's a PH concern).
- Listing photos are hidden in the in-store Add-Item modal (keep buying fast); the
  Review screen's per-unit **defect** flagging still works.

## PH exclusion (the hard invariant — guard in ALL of these)
Excluding in-store from `phListItems` alone is **not enough**. A warehouse rescale of an
in-store VIN sets `restock_pending`, which surfaced it on the PH **Rescale** grid, and
`ph/update` then wrote II/sync flags.

**This is now a shared list**: `api/_lib/db.js` exports
`PH_EXCLUDED_KINDS = ['instore','existing']` (existing = old stock, see
`existing-stock.md`), used as
`(b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))`. The `IS NULL` half is
required — these are `LEFT JOIN`s and `NULL <> ALL(...)` is `NULL`. In-store is
guarded in every PH path:
- `phListItems` — receiving/admin branch **and** the rescale branch.
- `pendingCounts` — the PH store-sync badges (`not_ii/alias/stockx/shopify`) exclude
  it via the `ph_managed` flag; `needs_shelf`/`no_box` still include it.
  ⚠️ The In-Store Listing badge is keyed on a **separate `is_instore` flag**, not on
  `NOT ph_managed` — otherwise every counted existing pair would land in this
  worklist.
- `recomputeUnlistedPrices` — a margin change must not re-price it.
- `rescaleItem` / `POST /api/items/rescale` — **rejects** an in-store VIN (409, root
  cause: in-store must never enter `restock_pending`).
- `phUpdateGroup` — its current-row query excludes in-store, so a PH write to an
  in-store VIN is silently skipped.
- `getItemsForGiRefresh` — excludes in-store.

## In-Store Listing page (manual store listing)
`GET /api/items/instore-list?from&to` → sellable in-store pairs (excludes
sold/shipped/missing/issue/no_box) + per-store flags. `POST /api/items/instore-listed
{ vins[], alias, stockx, shopify }` sets the whole desired triple (race-free), guarded
to `kind='instore'` in the db layer so the flags can never land on other stock; records
`instore_listed_at/_by` + a history event. Both endpoints `requireRole(['warehouse'])`
(admin auto-allowed, ph_team blocked).
- UI (`InstoreListing.jsx`): grouped **by SKU** (you list a SKU once, covering its
  sizes); three independent toggles **Alias / StockX / Shopify** applied to the whole
  group. Because this page is the only writer, every VIN in a SKU group stays in sync,
  so the group toggle is unambiguous. Shows each pair's **status** pill. "Needs listing
  only" filter (default **off** — the page is an overview of all in-store buys) drops a
  SKU once all three stores are ticked.

## Inventory
In-store units show an **"In-store" chip** (in place of the PH sync badges, which don't
apply) and are filterable via the **Intake → In-store** filter. Item detail shows
"Intake: In-store (store)". `queryItems`/`api/items/query` accept `kind='instore'`.

## Columns (see `data-model.md`)
`batches.kind='instore'`, `batches.origin` = store name. `items.instore_listed_alias/
_stockx/_shopify` (BOOLEAN), `items.instore_listed_at`/`_by` (audit). `batches_kind_check`
CHECK allows `('receiving','rescale','instore')`.

## ⚠️ Deploy
New columns + the CHECK change → **run `db:setup` on prod before deploying** this code,
or every in-store commit throws a CHECK violation (`deploy.md`).
