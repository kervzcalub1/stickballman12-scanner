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
  tracking_number, date_received, default_cost, notes, special_rules, kind`.
  kind ∈ receiving | rescale.
- **items** — one row per physical unit. Key columns:
  `id, vin UNIQUE NOT NULL, batch_id, name, sku, size, status, cost, price,
  with_box, upc, gender, colorway, restock_pending,
  added_to_intel_inv, synced_alias, synced_stockx, synced_shopify,
  ph_note, last_edit_by, last_edit_at, created_by, created_at, updated_at`.
- **item_events** — audit trail. `item_id, type, details JSONB, created_by,
  created_at`. types: scanned, received, rescaled, status_change, ph_update,
  note, issue.
- **shipment_issues** — per-batch issues (e.g. no-box auto-listed).
- **sales** — schema present for future profit tracking.
- **edit_locks** — PH grid presence locks (`vin, holder_id, holder_name,
  locked_until`); 30s TTL, claim/heartbeat/release.
- **rescale_requests** — PH→warehouse audit. `id, sku, name, sizes JSONB
  [{size,qty}], actual_sizes JSONB, audit_note, price, reason, note, status
  (open|audited), requested_by, resolved_by, resolved_at, created_at`.

## Sequences (never reused → gaps are fine)
- `vin_seq` → VIN format `SBM-YYMMDD-000001` (zero-padded, atomic `nextval`).
- `batch_seq` → starts 100001.

## Key db.js functions (by area)
- Auth: `createUser, findUserByUsername, listUsers, reviewUser, setUserRole,
  deleteUser, recordLoginAttempt, countRecentFailures`.
- Locks: `acquireLock, releaseLock`.
- Receiving: `createBatch, reserveVins, insertItems, insertIntakeEvents,
  insertIssues, listBatches, getBatch`.
- Inventory/items: `queryItems, getItemByVin, addItemEvent, bulkSetStatus,
  rescaleItem, markBoxFound, markRestocked, pendingCounts`.
- PH report: `phListItems(from,to,kind), phUpdateItems, phUpdateItem`.
- Edit locks: `claimEditLocks, heartbeatEditLocks, releaseEditLocks, listActiveEditLocks`.
- No-box: `listNoBoxItems(from,to)`.
- Rescale requests: `createRescaleRequest, listRescaleRequests(status,from,to),
  auditRescaleRequest`.

## Gotchas
- The shim CANNOT nest `sql` fragments. Build alternate queries with if/else.
- Date filters compare `(col AT TIME ZONE 'America/New_York')::date` to from/to.
- Adding a column? Put an `ADD COLUMN IF NOT EXISTS` in db-setup.mjs AND run
  `db:setup` on every environment (see `deploy.md` — prod drift is the #1 trap).
