# Data model

PostgreSQL. Schema defined/migrated by `scripts/db-setup.mjs` (idempotent:
`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS`). All
access via `api/_lib/db.js` (tagged-template `sql` shim, parameterized).

## Tables
- **users** — `id, name, username UNIQUE, pass_hash, role, status, created_at`.
  role ∈ admin | warehouse | ph_team. status ∈ pending | approved | rejected.
- **login_attempts** — brute-force throttle (per-username + per-IP, 15-min window).
- **locks** — `acquireLock('sheet:write')` style distributed lock (`locked_until`).
- **batches** — `id, batch_code (B-<seq>), buyer_name, supplier_name,
  tracking_number, date_received, default_cost, notes, special_rules, kind,
  batch_tag, expected_boxes, duplicate_of`.
  kind ∈ receiving | rescale | **instore** (pairs bought at a store; no shipment,
  `origin` = store name; admin/warehouse only, never PH — see `in-store.md`).
  `batches_kind_check` CHECK enforces the three values. **V6:** `batch_tag`
  (handwritten label code), `expected_boxes` (the "X OF N" on the label),
  `duplicate_of` → another batch when a tracking number repeats.
- **batch_boxes** (V6) — one row per physical box in a multi-box batch:
  `id, batch_id, box_number, tracking_number, status (pending|received),
  received_by, received_at`. Each box carries its own tracking number.
- **suppliers** (V6) — vendor names for the receiving dropdown: `name UNIQUE,
  created_by, created_at`. Seeded list + auto-saved custom names (the commit
  upserts whatever supplier was typed). Listed by `GET /api/suppliers`.
- **product_photos** (V6) — per-SKU listing photos (files in Cloudflare R2):
  `sku, angle, url, source, created_by`. `angle ∈ side|diagonal|outsole|top|rear`
  (+ `extra1|extra2` for PH-only extra images). **`source ∈ 'warehouse'|'ph_edited'`**
  (V7): warehouse raw shots and PH‑uploaded edits coexist for the same angle — unique
  per **(sku, angle, source)**. Display prefers `ph_edited` per angle (the `photo_url`
  sub‑queries order angle‑first then `(source='ph_edited') DESC`, and exclude `extra*`).
  PH manages `ph_edited`, warehouse manages `warehouse`, admin both — see `ph-report.md`.
  (Defect photos are NOT here — they ride per-unit `item_events(type='issue')`.)
- **items** — one row per physical unit (`gi_basis` = which of the 8 pricing-hierarchy
  levels priced this size, NULL = a person typed it; `integrations.md`). Key columns:
  `id, vin UNIQUE NOT NULL, batch_id, box_id, name, sku, size, status, cost, price,
  global_indicator, gi_basis, with_box, upc, gender, colorway, restock_pending,
  added_to_intel_inv, synced_alias, synced_stockx, synced_shopify,
  ph_note, first_edit_by, first_edit_at, last_edit_by, last_edit_at,
  instore_listed_alias, instore_listed_stockx, instore_listed_shopify,
  instore_listed_at, instore_listed_by,
  created_by, created_at, updated_at`. (The `instore_listed_*` per-store flags are
  set ONLY by the In-Store Listing page, guarded to `kind='instore'` — separate from
  the PH `synced_*` flags so the two workflows never conflate; see `in-store.md`.
  `first_edit_*` set once = "Added by";
  `last_edit_*` = most recent edit = "Last edited by". `box_id` → which
  `batch_boxes` row the unit arrived in, V6.)
- **products** — catalog cache keyed by `upc UNIQUE`: `sku, size, name, colorway,
  gender, brand, image_url, catalog_id, source`. Sourced from **Alias** (only API
  returning a `catalog_id` + full colorway). Powers **Box Labels** and stores the
  Alias `catalog_id` for **Global Indicator** pricing. Upsert coalesces (a later
  richer lookup fills gaps without wiping good values).
- **item_events** — audit trail. `item_id, type, details JSONB, created_by,
  created_at`. types: scanned, received, rescaled, status_change, ph_update,
  note, issue.
- **locations** (shelf spots) — `id, code UNIQUE (barcode = SITE-AREA-BAY-SHELF,
  e.g. MNH-WH-A2-04; pods omit shelf → MNH-PD-1), warehouse, area, bay, shelf,
  label, active, sort_order, created_by`. `items` gains `location_id` (FK) +
  `location_code` (snapshot). `item_events` type `shelved`. Seeded for Manheim
  (253) via `npm run db:seed-manheim`; other sites added in the Locations UI.
  See `locations.md`.
- **shipment_issues** — per-batch issues (e.g. no-box auto-listed).
- **payout_presets** — supplier cost stacks for the Payout Calculator. `id, name
  (UNIQUE on `lower(btrim(name))`), tip_amt, shipping_amt, tax_pct, gift_pct,
  store_pct, promo_pct, cashback_pct, note, created_by, updated_by, updated_at`.
  Every rate is `NOT NULL DEFAULT 0` — a preset states the WHOLE register stack, so a
  no-tax supplier CLEARS the last one's tax rather than leaving it. Seeded with five
  suppliers **only into an empty table** (`db:setup` runs on every deploy; a deleted
  preset must stay deleted). See `payout-calculator.md`.
- **sales** — schema present for future profit tracking.
- **edit_locks** — PH grid presence locks (`vin, holder_id, holder_name,
  locked_until`); 30s TTL, claim/heartbeat/release.
- **rescale_requests** — PH→warehouse audit. `id, sku, name, sizes JSONB
  [{size,qty}], actual_sizes JSONB, audit_note, price, reason, note, status
  (open|audited), requested_by, resolved_by, resolved_at, created_at`. Plus PH's
  post-audit listing decision: `listing JSONB` (`[{size, global_indicator, gi_basis,
  price, added_to_intel_inv, synced_alias, synced_stockx, synced_shopify}]`), `listed_by`,
  `listed_at`. Requests aren't tied to VINs → the listing lives on the request.

## Sequences (never reused → gaps are fine)
- `vin_seq` → VIN format `SBM-YYMMDD-000001` (zero-padded, atomic `nextval`).
- `batch_seq` → starts 100001.

## Key db.js functions (by area)
- Auth: `createUser, findUserByUsername, listUsers, reviewUser, setUserRole,
  deleteUser, recordLoginAttempt, countRecentFailures`.
- Locks: `acquireLock, releaseLock`.
- Receiving: `createBatch, reserveVins, insertItems, insertIntakeEvents,
  insertIssues, listBatches, getBatch`. V6: `listSuppliers, addSupplier,
  findBatchByTracking`. Multi-box: `createOpenBatch, listBatchBoxes, addBatchBox
  (find-or-create by box number), syncBatchBoxes (persist tracking-only slots),
  getBatchWithBoxes (batch+boxes+items), listItemsByBatch, commitBoxItems`.
- Inventory/items: `queryItems, getItemByVin, getEventsForVins, addItemEvent,
  bulkSetStatus, rescaleItem, markBoxFound, markRestocked, pendingCounts,
  setItemGlobalIndicators`. GI refresh: `getItemsForGiRefresh, refreshItemGi`
  (PH "Refresh prices" — re-fetch Alias GI, recompute Final=GI+20%, keep overrides).
- In-store: `listInstoreItems(from,to)` (In-Store Listing worklist), `setInstoreListed
  (vins,flags,by)` (per-store Alias/StockX/Shopify flags, guarded to `kind='instore'`).
  `queryItems`/`phListItems`/`pendingCounts`/`getItemsForGiRefresh`/`rescaleItem` all
  exclude or reject `kind='instore'` from PH surfaces — see `in-store.md`.
- Locations: `listLocations, getLocationByCode, createLocation, bulkCreateLocations,
  updateLocation, listItemsAtLocation, shelveItems` (put-away/transfer). See `locations.md`.
- Catalog: `upsertProduct, getProductByUpc, getCatalogIdBySku`.
- PH report: `phListItems(from,to,kind), phUpdateItems, phUpdateItem`.
- Edit locks: `claimEditLocks, heartbeatEditLocks, releaseEditLocks, listActiveEditLocks`.
- No-box: `listNoBoxItems(from,to)`.
- Payout presets: `listPayoutPresets, savePayoutPreset (upsert; throws `.duplicate` on a
  name clash), deletePayoutPreset`. Numerics are cast to JS numbers on the way out.
- Rescale requests: `createRescaleRequest, listRescaleRequests(status,from,to),
  auditRescaleRequest`.

## Gotchas
- The shim CANNOT nest `sql` fragments. Build alternate queries with if/else.
- **`BIGINT` ids come back as STRINGS** (the `pg` driver won't coerce int8 to a JS
  number). So `rows[].id` is `"6"`, not `6`. Comparing a DB id against a
  `Number(...)`'d request value with `===` silently fails (`"6" === 6` → false).
  Coerce first: `Number(row.id) === id`. (This caused box-commit's "Box not found
  in this batch" — the freshly-added box id never matched.)
- Date filters compare `(col AT TIME ZONE 'America/New_York')::date` to from/to.
- **`DATE` columns come back as `'YYYY-MM-DD'` strings**, not JS `Date`s
  (`pg.types.setTypeParser(1082, …)` in db.js). A DATE is a calendar day, not an
  instant: the driver's default parses it at LOCAL midnight, which JSON then
  serialises as UTC, so on a server east of UTC — this team runs `Asia/Manila` —
  every date reached the client **a day early** (a purchase made on the 5th read as
  the 4th), and an edit form that round-tripped the value walked it back again on
  every save. Every consumer already did `String(d).slice(0, 10)`, which is now
  exactly right.
- Adding a column? Put an `ADD COLUMN IF NOT EXISTS` in db-setup.mjs AND run
  `db:setup` on every environment (see `deploy.md` — prod drift is the #1 trap).
