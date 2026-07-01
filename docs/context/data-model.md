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
  kind ∈ receiving | rescale. **V6:** `batch_tag` (handwritten label code),
  `expected_boxes` (the "X OF N" on the label), `duplicate_of` → another batch
  when a tracking number repeats.
- **batch_boxes** (V6) — one row per physical box in a multi-box batch:
  `id, batch_id, box_number, tracking_number, status (pending|received),
  received_by, received_at`. Each box carries its own tracking number.
- **suppliers** (V6) — vendor names for the receiving dropdown: `name UNIQUE,
  created_by, created_at`. Seeded list + auto-saved custom names (the commit
  upserts whatever supplier was typed). Listed by `GET /api/suppliers`.
- **product_photos** (V6) — per-SKU listing photos (files in Cloudflare R2):
  `sku, angle (side|diagonal|outsole|top|rear), url, created_by`. Unique per
  (sku, angle) so re-capturing an angle replaces it. (Defect photos are NOT
  here — they ride per-unit `item_events(type='issue')`.)
- **items** — one row per physical unit. Key columns:
  `id, vin UNIQUE NOT NULL, batch_id, box_id, name, sku, size, status, cost, price,
  global_indicator, with_box, upc, gender, colorway, restock_pending,
  added_to_intel_inv, synced_alias, synced_stockx, synced_shopify,
  ph_note, first_edit_by, first_edit_at, last_edit_by, last_edit_at,
  created_by, created_at, updated_at`. (`first_edit_*` set once = "Added by";
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
- **shipment_issues** — per-batch issues (e.g. no-box auto-listed).
- **sales** — schema present for future profit tracking.
- **edit_locks** — PH grid presence locks (`vin, holder_id, holder_name,
  locked_until`); 30s TTL, claim/heartbeat/release.
- **rescale_requests** — PH→warehouse audit. `id, sku, name, sizes JSONB
  [{size,qty}], actual_sizes JSONB, audit_note, price, reason, note, status
  (open|audited), requested_by, resolved_by, resolved_at, created_at`. Plus PH's
  post-audit listing decision: `listing JSONB` (`[{size, global_indicator, price,
  added_to_intel_inv, synced_alias, synced_stockx, synced_shopify}]`), `listed_by`,
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
- Catalog: `upsertProduct, getProductByUpc, getCatalogIdBySku`.
- PH report: `phListItems(from,to,kind), phUpdateItems, phUpdateItem`.
- Edit locks: `claimEditLocks, heartbeatEditLocks, releaseEditLocks, listActiveEditLocks`.
- No-box: `listNoBoxItems(from,to)`.
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
- Adding a column? Put an `ADD COLUMN IF NOT EXISTS` in db-setup.mjs AND run
  `db:setup` on every environment (see `deploy.md` — prod drift is the #1 trap).
