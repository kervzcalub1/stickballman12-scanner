// Postgres access layer (standard `pg` driver + a connection pool).
// A thin tagged-template shim keeps the Neon-style API — `` sql`… ${v} …` ``
// builds a parameterized `$1,$2…` query, so values are never interpolated into
// SQL text (injection-safe) — and `sql.transaction([…])` runs a list of those
// queries on a single client inside BEGIN/COMMIT.
//
// V5: moved off the Neon HTTP driver to plain Postgres so the app runs on a
// local database now and on any real host later (not tied to Vercel/Neon).

import pg from 'pg';

const { Pool } = pg;

let _pool = null;
function pool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Managed hosts (Neon/RDS/etc.) require TLS; local dev does not.
    ssl: /\bsslmode=require\b|\.neon\.tech/.test(process.env.DATABASE_URL || '')
      ? { rejectUnauthorized: false }
      : undefined,
  });
  return _pool;
}

// Build a parameterized statement from the template parts + interpolated values.
function buildQuery(strings, values) {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
  return { text, values };
}

// A lazily-executed query. Awaiting it (or calling .then) runs it on the pool
// and resolves to the `rows` array — matching how the Neon `sql` tag behaves.
// Collected unexecuted by `sql.transaction([...])` so they run on one client.
class Query {
  constructor(text, values) { this.text = text; this.values = values; }
  then(onFulfilled, onRejected) {
    return pool().query(this.text, this.values).then((r) => r.rows).then(onFulfilled, onRejected);
  }
  catch(onRejected) { return this.then(undefined, onRejected); }
  finally(onFinally) { return this.then().finally(onFinally); }
}

function sqlTag(strings, ...values) {
  const { text, values: vals } = buildQuery(strings, values);
  return new Query(text, vals);
}
// Run the given queries in order inside a transaction; returns one rows[] per
// query (same contract as @neondatabase/serverless's sql.transaction).
sqlTag.transaction = async (queries) => {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = [];
    for (const q of queries) out.push((await client.query(q.text, q.values)).rows);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
};

function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  return sqlTag;
}

export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/* ------------------------------- Users -------------------------------- */

// Create a pending account with the requested role. Throws { code:
// 'USERNAME_TAKEN' } on conflict. Role is validated by the caller (signup).
export async function createUser({ name, username, passHash, role = 'warehouse' }) {
  const sql = db();
  try {
    const rows = await sql`
      INSERT INTO users (name, username, pass_hash, role, status)
      VALUES (${name}, ${username}, ${passHash}, ${role}, 'pending')
      RETURNING id, name, username, role, status, created_at
    `;
    return rows[0];
  } catch (e) {
    if (String(e.message || '').includes('users_username_key') || e.code === '23505') {
      const err = new Error('That username is already taken.');
      err.code = 'USERNAME_TAKEN';
      throw err;
    }
    throw e;
  }
}

export async function findUserByUsername(username) {
  const rows = await db()`
    SELECT id, name, username, pass_hash, role, status
    FROM users WHERE username = ${username} LIMIT 1
  `;
  return rows[0] || null;
}

// Admin views. Pending first, then most recent.
export async function listUsers() {
  return await db()`
    SELECT id, name, username, role, status, created_at, reviewed_at, reviewed_by
    FROM users
    ORDER BY (status = 'pending') DESC, created_at DESC
    LIMIT 500
  `;
}

export async function reviewUser(id, status, reviewer) {
  const rows = await db()`
    UPDATE users
    SET status = ${status}, reviewed_at = now(), reviewed_by = ${reviewer}
    WHERE id = ${id}
    RETURNING id, name, username, role, status
  `;
  return rows[0] || null;
}

// Admin: change an account's role.
export async function setUserRole(id, role, reviewer) {
  const rows = await db()`
    UPDATE users
    SET role = ${role}, reviewed_at = now(), reviewed_by = ${reviewer}
    WHERE id = ${id}
    RETURNING id, name, username, role, status
  `;
  return rows[0] || null;
}

// Admin: permanently delete an account.
export async function deleteUser(id) {
  const rows = await db()`DELETE FROM users WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/* -------------------------- Login throttling -------------------------- */

export async function recordLoginAttempt({ username, ip, success }) {
  await db()`
    INSERT INTO login_attempts (username, ip, success)
    VALUES (${username || null}, ${ip || null}, ${success})
  `;
  // Occasionally prune old rows so the table doesn't grow unbounded.
  if (Math.random() < 0.02) {
    try { await db()`DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`; }
    catch { /* best effort */ }
  }
}

// Count failed attempts in the last `windowMins` minutes for a username and IP.
export async function countRecentFailures({ username, ip, windowMins = 15 }) {
  const rows = await db()`
    SELECT
      count(*) FILTER (WHERE username = ${username || ''}) ::int AS by_user,
      count(*) FILTER (WHERE ip = ${ip || ''}) ::int          AS by_ip
    FROM login_attempts
    WHERE success = false
      AND created_at > now() - (${windowMins} * interval '1 minute')
  `;
  return rows[0] || { by_user: 0, by_ip: 0 };
}

/* ---------------------- Distributed lock (mutex) ---------------------- */
// Atomic acquire: insert the key, or steal it if the prior holder's lease
// expired. Returns true if acquired. One round trip, safe over the HTTP driver.
async function tryAcquire(key, ttlSec) {
  const rows = await db()`
    INSERT INTO locks (key, locked_until)
    VALUES (${key}, now() + (${ttlSec} * interval '1 second'))
    ON CONFLICT (key) DO UPDATE SET locked_until = EXCLUDED.locked_until
    WHERE locks.locked_until < now()
    RETURNING key
  `;
  return rows.length > 0;
}

// Acquire `key`, waiting up to ~waitMs with small backoff. The lease (ttlSec)
// guards against a crashed holder never releasing.
export async function acquireLock(key, { ttlSec = 15, waitMs = 8000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    if (await tryAcquire(key, ttlSec)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(250, 40 + attempt * 30)));
  }
}

export async function releaseLock(key) {
  try { await db()`DELETE FROM locks WHERE key = ${key}`; } catch { /* lease will expire */ }
}

/* ------------------------ v4: batches & items ------------------------- */

export async function createBatch(h, createdBy) {
  const rows = await db()`
    INSERT INTO batches
      (buyer_name, supplier_name, tracking_number, date_received,
       default_cost, notes, special_rules, kind, origin, status, created_by, committed_at)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.tracking || null},
       ${h.dateReceived || null}, ${h.defaultCost ?? null}, ${h.notes || null},
       ${h.specialRules || null}, ${h.kind === 'rescale' ? 'rescale' : 'receiving'},
       ${h.origin || null}, 'committed', ${createdBy || null}, now())
    RETURNING id, batch_code
  `;
  return rows[0];
}

// Bulk-insert items in one transaction; returns [{ id, vin }] in input order.
// VIN format: SBM-<YYMMDD of date received>-<6-digit sequence>, e.g.
// SBM-250615-000123. Falls back to today's date when no received date is given.
// Reserve `count` real VINs up front (atomic — each nextval is unique even
// across concurrent reservations, so two users can never get the same VIN).
// Used during receiving so the warehouse can sticker the exact VIN before
// submitting. Abandoned reservations just leave (harmless) gaps in the run.
export async function reserveVins(count, dateReceived = null) {
  const n = Math.min(2000, Math.max(1, Number(count) || 0));
  const rows = await db()`
    SELECT 'SBM-' || to_char(coalesce(${dateReceived}::date, current_date), 'YYMMDD')
           || '-' || lpad(nextval('vin_seq')::text, 6, '0') AS vin
    FROM generate_series(1, ${n})
  `;
  return rows.map((r) => r.vin);
}

export async function insertItems(batchId, items, createdBy, dateReceived = null) {
  const sql = db();
  const queries = items.map((it) => sql`
    INSERT INTO items
      (vin, batch_id, name, sku, size, upc, image_url, cost, source, status, with_box, gender, colorway, notes, created_by)
    VALUES
      (coalesce(${it.vin || null},
        'SBM-' || to_char(coalesce(${dateReceived}::date, current_date), 'YYMMDD')
              || '-' || lpad(nextval('vin_seq')::text, 6, '0')),
       ${batchId}, ${it.name || null}, ${it.sku || null}, ${it.size || null},
       ${it.upc || null}, ${it.image || null}, ${it.cost ?? null},
       ${it.source || 'manual'}, ${it.status || 'needs_shelf'}, ${it.withBox !== false},
       ${it.gender || null}, ${it.colorway || null}, ${it.notes || null}, ${createdBy || null})
    RETURNING id, vin
  `);
  const results = await sql.transaction(queries);
  return results.map((r) => r[0]);
}

// First two history events per item: "scanned" (Scanned by <user>) then the
// intake event — "received" for a shipment, "rescaled" for re-scaled stock.
// Inserted in order so the timeline reads scanned → received/rescaled.
export async function insertIntakeEvents(itemIds, createdBy, kind = 'receiving') {
  if (!itemIds.length) return;
  const sql = db();
  const intakeType = kind === 'rescale' ? 'rescaled' : 'received';
  const queries = [];
  for (const id of itemIds) {
    queries.push(sql`
      INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${id}, 'scanned', ${JSON.stringify({ by: createdBy })}::jsonb, ${createdBy || null})
    `);
    queries.push(sql`
      INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${id}, ${intakeType}, '{}'::jsonb, ${createdBy || null})
    `);
  }
  // Rescaled stock starts restock-pending so it surfaces in the Rescale worklist.
  if (kind === 'rescale') queries.push(sql`UPDATE items SET restock_pending = true WHERE id = ANY(${itemIds})`);
  await sql.transaction(queries);
}

export async function insertIssues(batchId, issues, createdBy) {
  if (!issues || !issues.length) return;
  const sql = db();
  await sql.transaction(issues.map((is) => sql`
    INSERT INTO shipment_issues
      (batch_id, type, description, expected_count, received_count, created_by)
    VALUES
      (${batchId}, ${is.type || 'other'}, ${is.description || null},
       ${is.expectedCount ?? null}, ${is.receivedCount ?? null}, ${createdBy || null})
  `));
}

export async function listBatches(limit = 50, kind = null) {
  return await db()`
    SELECT b.id, b.batch_code, b.kind, b.buyer_name, b.supplier_name, b.tracking_number,
           b.origin, b.date_received, b.created_by, b.created_at,
           (SELECT count(*)::int FROM items i WHERE i.batch_id = b.id) AS item_count,
           (SELECT coalesce(sum(i.cost), 0) FROM items i WHERE i.batch_id = b.id) AS total_cost,
           (SELECT count(*)::int FROM shipment_issues s WHERE s.batch_id = b.id) AS issue_count
    FROM batches b
    WHERE (${kind}::text IS NULL OR b.kind = ${kind})
    ORDER BY b.created_at DESC
    LIMIT ${limit}
  `;
}

export async function getBatch(id) {
  const b = await db()`SELECT * FROM batches WHERE id = ${id}`;
  if (!b[0]) return null;
  const items = await db()`
    SELECT id, vin, name, sku, size, cost, source, status, created_at, upc, colorway, gender, with_box
    FROM items WHERE batch_id = ${id} ORDER BY id
  `;
  const issues = await db()`
    SELECT id, type, description, expected_count, received_count
    FROM shipment_issues WHERE batch_id = ${id} ORDER BY id
  `;
  return { batch: b[0], items, issues };
}

// Unified inventory query — powers the merged Inventory page (browse + report).
// Any combination of: text search (q over vin/sku/name), received-date range
// (from/to), supplier, status. Nulls are ignored. Received date = the batch's
// date_received (falling back to the item's created date).
export async function queryItems({ q = null, from = null, to = null, supplier = null, status = null, kind = null, limit = 2000 }) {
  const lim = Math.min(5000, Math.max(1, Number(limit) || 2000));
  const like = q ? `%${q}%` : null;
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.cost, i.status, i.created_by, i.created_at,
           i.with_box, i.upc, i.colorway, i.gender, i.price, i.added_to_intel_inv,
           i.synced_alias, i.synced_stockx, i.synced_shopify,
           b.batch_code, b.supplier_name, b.buyer_name, b.date_received, b.kind
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE (${from}::date IS NULL OR coalesce(b.date_received, i.created_at::date) >= ${from}::date)
      AND (${to}::date   IS NULL OR coalesce(b.date_received, i.created_at::date) <= ${to}::date)
      AND (${supplier}::text IS NULL OR b.supplier_name = ${supplier})
      AND (${status}::text   IS NULL OR i.status = ${status})
      AND (${kind}::text     IS NULL OR b.kind = ${kind})
      AND (${like}::text IS NULL OR i.vin ILIKE ${like} OR i.sku ILIKE ${like} OR i.name ILIKE ${like})
    ORDER BY i.vin
    LIMIT ${lim}
  `;
}

/* ------------------------------ PH Team ------------------------------- */
// The PH Team's editable grid, filtered to a date range (from/to, NY dates).
// `kind` splits the workflow:
//   'rescale'   — restock-pending units, dated by their latest 'rescaled' event.
//   'receiving' — newly RECEIVED stock (excludes rescale batches), by scan date.
//   null        — everything scanned in range, by scan date (admin report).
export async function phListItems(from, to, kind = null) {
  if (kind === 'rescale') {
    // Date/scanned-by come from the latest 'rescaled' event so the grid columns
    // reflect the rescale (not the original receive).
    return await db()`
      SELECT i.vin, coalesce(ev.created_at, i.updated_at) AS created_at,
             coalesce(ev.created_by, i.created_by) AS created_by, i.name, i.sku, i.size, i.gender,
             i.status, i.cost, i.price,
             i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify,
             i.ph_note, i.last_edit_by, i.last_edit_at
      FROM items i
      LEFT JOIN LATERAL (
        SELECT e.created_at, e.created_by FROM item_events e
        WHERE e.item_id = i.id AND e.type = 'rescaled'
        ORDER BY e.created_at DESC LIMIT 1
      ) ev ON true
      WHERE i.restock_pending = true  -- pending worklist; cleared on "Mark restocked"
        AND i.status <> 'no_box'      -- no-box units aren't postable; PH never lists them
        AND (${from}::date IS NULL OR (coalesce(ev.created_at, i.updated_at) AT TIME ZONE 'America/New_York')::date >= ${from}::date)
        AND (${to}::date   IS NULL OR (coalesce(ev.created_at, i.updated_at) AT TIME ZONE 'America/New_York')::date <= ${to}::date)
      ORDER BY created_at DESC, i.id
      LIMIT 5000
    `;
  }
  return await db()`
    SELECT i.vin, i.created_at, i.created_by, i.name, i.sku, i.size, i.gender,
           i.status, i.cost, i.price,
           i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify,
           i.ph_note, i.last_edit_by, i.last_edit_at
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE (${from}::date IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
      AND (${kind}::text IS NULL OR b.kind = 'receiving' OR b.kind IS NULL)
      -- Hide no-box from the PH team's New Inventory page; keep it in the admin
      -- Report (kind IS NULL) for oversight.
      AND (${kind}::text IS NULL OR i.status <> 'no_box')
    ORDER BY i.created_at, i.id
    LIMIT 5000
  `;
}

// The "No Box / Not Ready" worklist: every unit still marked Bought Without Box,
// across all batches (a pending queue, not month-scoped). Shown to admin + PH;
// admin/warehouse resolve each by changing its status (then it leaves this list
// and becomes visible in the PH report).
export async function listNoBoxItems(from = null, to = null) {
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.gender, i.status, i.created_at, i.created_by,
           i.upc, i.colorway, i.with_box,
           b.batch_code, b.supplier_name
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.status = 'no_box'
      AND (${from}::date IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 2000
  `;
}

// Pending-work counts for the home-screen badges. "Listable" = a sellable unit
// (has a box, not already sold/shipped/missing/issue/no-box) — those are what PH
// still needs to push to each store.
export async function pendingCounts() {
  const rows = await db()`
    SELECT
      count(*) FILTER (WHERE listable AND NOT added_to_intel_inv)::int AS not_ii,
      count(*) FILTER (WHERE listable AND NOT synced_alias)::int       AS not_alias,
      count(*) FILTER (WHERE listable AND NOT synced_stockx)::int      AS not_stockx,
      count(*) FILTER (WHERE listable AND NOT synced_shopify)::int     AS not_shopify,
      count(*) FILTER (WHERE status = 'needs_shelf')::int              AS needs_shelf,
      count(*) FILTER (WHERE status = 'no_box')::int                   AS no_box,
      count(*) FILTER (WHERE restock_pending)::int                     AS restock_pending,
      (SELECT count(*) FROM rescale_requests WHERE status = 'open')::int     AS rescale_requests,
      (SELECT count(*) FROM rescale_requests WHERE status = 'audited')::int  AS rescale_requests_audited
    FROM (
      SELECT *, (with_box AND status NOT IN ('sold','shipped','missing','issue','no_box')) AS listable
      FROM items
    ) i
  `;
  return rows[0] || {};
}

/* --------------------- PH-requested rescales --------------------------- */

export async function createRescaleRequest({ sku, name, sizes, price, reason, note, by }) {
  const rows = await db()`
    INSERT INTO rescale_requests (sku, name, sizes, price, reason, note, requested_by)
    VALUES (${sku}, ${name || null}, ${JSON.stringify(sizes || [])}::jsonb, ${price ?? null},
            ${reason || null}, ${note || null}, ${by || null})
    RETURNING id, created_at
  `;
  return rows[0];
}

export async function listRescaleRequests(status = 'open', from = null, to = null) {
  return await db()`
    SELECT id, sku, name, sizes, actual_sizes, audit_note, price, reason, note, status,
           requested_by, resolved_by, resolved_at, created_at
    FROM rescale_requests
    WHERE (${status}::text IS NULL OR status = ${status})
      AND (${from}::date IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
    ORDER BY created_at DESC LIMIT 500
  `;
}

// Warehouse audit: record the actual qty per size counted on the shelf and close
// the request (status 'audited'). Both roles then see reported-vs-actual.
export async function auditRescaleRequest(id, actualSizes, auditNote, by) {
  const rows = await db()`
    UPDATE rescale_requests
    SET actual_sizes = ${JSON.stringify(actualSizes || [])}::jsonb, audit_note = ${auditNote || null},
        status = 'audited', resolved_by = ${by || null}, resolved_at = now()
    WHERE id = ${id} AND status = 'open' RETURNING id
  `;
  return rows.length > 0;
}

// "Box found": a no-box unit gets a box → becomes sellable. Sets with_box=true +
// status needs_shelf and logs it. (We never sell without a box.)
export async function markBoxFound(itemId, createdBy) {
  const sql = db();
  await sql.transaction([
    sql`UPDATE items SET with_box = true, status = 'needs_shelf', updated_at = now() WHERE id = ${itemId}`,
    sql`INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${itemId}, 'status_change', ${JSON.stringify({ status: 'needs_shelf', note: 'Box found — now With Box' })}::jsonb, ${createdBy || null})`,
  ]);
}

// Mark units restocked — clears restock_pending so they drop off the Rescale
// worklist into normal inventory. Logs one event per VIN. Returns count cleared.
export async function markRestocked(vins, createdBy) {
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return 0;
  const sql = db();
  const queries = list.map((vin) => sql`
    WITH up AS (
      UPDATE items SET restock_pending = false, updated_at = now()
      WHERE vin = ${vin} AND restock_pending = true RETURNING id
    )
    INSERT INTO item_events (item_id, type, details, created_by)
    SELECT id, 'note', ${JSON.stringify({ text: 'Restocked — moved to inventory' })}::jsonb, ${createdBy || null} FROM up
    RETURNING item_id
  `);
  const res = await sql.transaction(queries);
  return res.filter((r) => r.length).length;
}

// Apply a PH-Team edit to ONE OR MANY items (a consolidated grid row covers
// several VINs that share identical details). Updates the editable fields, sets
// the last-editor stamp, and appends a discrete history event for EVERY changed
// field on EVERY affected item — all in one transaction. Returns the updated
// rows (one per VIN, same shape phListItems returns).
//
// Optimistic concurrency (A): pass `baseEditedAt` = the latest last_edit_at the
// client saw for this group. If any unit has been edited since (someone else
// saved in between), throws an error tagged `.conflict` so the API can 409.
export async function phUpdateItems(vins, fields, by, baseEditedAt = undefined) {
  const list = (Array.isArray(vins) ? vins : [vins]).filter(Boolean);
  if (!list.length) return [];
  const sql = db();
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const f = fields || {};

  const curRows = await sql`
    SELECT id, vin, price, added_to_intel_inv, synced_alias, synced_stockx, synced_shopify,
           ph_note, last_edit_at, last_edit_by
    FROM items WHERE vin = ANY(${list})
  `;
  if (!curRows.length) return [];

  // Conflict check: if the group's newest last_edit_at is newer than the
  // baseline the client loaded, someone else saved first — refuse.
  if (baseEditedAt !== undefined) {
    const baseMs = baseEditedAt ? new Date(baseEditedAt).getTime() : 0;
    let curMs = 0; let by2 = null;
    for (const r of curRows) {
      const t = r.last_edit_at ? new Date(r.last_edit_at).getTime() : 0;
      if (t > curMs) { curMs = t; by2 = r.last_edit_by; }
    }
    if (curMs > baseMs) {
      const err = new Error(`This item was just updated by ${by2 || 'someone else'}. Reload to see the change, then re-apply yours.`);
      err.conflict = true;
      throw err;
    }
  }

  const queries = [];
  const ids = [];
  for (const cur of curRows) {
    ids.push(cur.id);
    const next = {
      price: 'price' in f ? num(f.price) : cur.price,
      intel: 'added_to_intel_inv' in f ? !!f.added_to_intel_inv : cur.added_to_intel_inv,
      alias: 'synced_alias' in f ? !!f.synced_alias : cur.synced_alias,
      stockx: 'synced_stockx' in f ? !!f.synced_stockx : cur.synced_stockx,
      shopify: 'synced_shopify' in f ? !!f.synced_shopify : cur.synced_shopify,
      note: 'ph_note' in f ? (String(f.ph_note || '').slice(0, 2000) || null) : cur.ph_note,
    };
    const descs = [];
    if (String(next.price) !== String(cur.price)) descs.push(next.price == null ? 'Price cleared' : `Price set to $${Number(next.price).toFixed(2)}`);
    if (next.intel !== cur.added_to_intel_inv) descs.push(next.intel ? 'Added to Intelligent Inventory' : 'Removed from Intelligent Inventory');
    if (next.alias !== cur.synced_alias) descs.push(next.alias ? 'Synced to Alias' : 'Unsynced from Alias');
    if (next.stockx !== cur.synced_stockx) descs.push(next.stockx ? 'Synced to StockX' : 'Unsynced from StockX');
    if (next.shopify !== cur.synced_shopify) descs.push(next.shopify ? 'Synced to Shopify' : 'Unsynced from Shopify');
    if ((next.note || '') !== (cur.ph_note || '')) descs.push('Note updated');

    queries.push(sql`
      UPDATE items SET price = ${next.price}, added_to_intel_inv = ${next.intel},
        synced_alias = ${next.alias}, synced_stockx = ${next.stockx}, synced_shopify = ${next.shopify},
        ph_note = ${next.note}, last_edit_by = ${by || null}, last_edit_at = now(), updated_at = now()
      WHERE id = ${cur.id}
    `);
    for (const text of descs) {
      queries.push(sql`
        INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${cur.id}, 'ph_update', ${JSON.stringify({ text })}::jsonb, ${by || null})
      `);
    }
  }
  await sql.transaction(queries);

  return await sql`
    SELECT vin, created_at, created_by, name, sku, size, gender, status, cost, price,
           added_to_intel_inv, synced_alias, synced_stockx, synced_shopify,
           ph_note, last_edit_by, last_edit_at
    FROM items WHERE id = ANY(${ids}) ORDER BY created_at, id
  `;
}

// Single-VIN convenience wrapper (kept for callers that edit one item).
export async function phUpdateItem(vin, fields, by) {
  const rows = await phUpdateItems([vin], fields, by);
  return rows[0] || null;
}

/* --------------------- PH edit locks (presence, B2) -------------------- */
// A lock is "active" while its heartbeat is within EDIT_LOCK_TTL_SEC. The
// client pings heartbeat ~every 10s; a stale lock (closed tab / crash) is
// stealable after the TTL. Locks are per-VIN; a consolidated row claims all its
// units. holder = display name, holderId = per-tab id (so one user's two tabs
// don't fight, and ownership is unambiguous).
const EDIT_LOCK_TTL_SEC = 30;

// Try to claim every vin for this holder. Succeeds for a vin if it's unlocked,
// already mine, or the prior holder's lock expired. All-or-nothing: on any
// blocker, releases what was just taken and returns the active blockers.
export async function claimEditLocks(vins, holder, holderId) {
  const sql = db();
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return { ok: true, claimed: [] };
  const claimed = [];
  for (const vin of list) {
    const rows = await sql`
      INSERT INTO edit_locks (vin, holder, holder_id, claimed_at, heartbeat_at)
      VALUES (${vin}, ${holder}, ${holderId}, now(), now())
      ON CONFLICT (vin) DO UPDATE SET holder = ${holder}, holder_id = ${holderId},
        claimed_at = now(), heartbeat_at = now()
      WHERE edit_locks.holder_id = ${holderId}
         OR edit_locks.heartbeat_at < now() - (${EDIT_LOCK_TTL_SEC} * interval '1 second')
      RETURNING vin
    `;
    if (rows.length) claimed.push(vin);
  }
  if (claimed.length === list.length) return { ok: true, claimed };
  if (claimed.length) await sql`DELETE FROM edit_locks WHERE vin = ANY(${claimed}) AND holder_id = ${holderId}`;
  const blockers = await sql`
    SELECT vin, holder FROM edit_locks
    WHERE vin = ANY(${list}) AND heartbeat_at > now() - (${EDIT_LOCK_TTL_SEC} * interval '1 second')
  `;
  return { ok: false, blockers };
}

// Refresh my locks' heartbeat; returns the vins I still hold (a vin missing
// means my lock was lost/stolen — the client should drop out of edit).
export async function heartbeatEditLocks(vins, holderId) {
  const sql = db();
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return [];
  const rows = await sql`
    UPDATE edit_locks SET heartbeat_at = now()
    WHERE vin = ANY(${list}) AND holder_id = ${holderId}
    RETURNING vin
  `;
  return rows.map((r) => r.vin);
}

export async function releaseEditLocks(vins, holderId) {
  const sql = db();
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return;
  await sql`DELETE FROM edit_locks WHERE vin = ANY(${list}) AND holder_id = ${holderId}`;
}

// All currently-active locks (for painting "being edited by X"). Opportunistically
// prunes long-dead rows so the table stays small.
export async function listActiveEditLocks() {
  const sql = db();
  if (Math.random() < 0.1) {
    try { await sql`DELETE FROM edit_locks WHERE heartbeat_at < now() - interval '5 minutes'`; } catch { /* best effort */ }
  }
  return await sql`
    SELECT vin, holder, holder_id FROM edit_locks
    WHERE heartbeat_at > now() - (${EDIT_LOCK_TTL_SEC} * interval '1 second')
  `;
}

// Selling an item removes it from Intelligent Inventory which cascades the
// delist to every store (II → stores). So marking an item 'sold' clears all
// four sync flags. This text is logged so the audit trail explains the change.
const SOLD_CASCADE_TEXT = 'Sold — removed from Intelligent Inventory & all stores';

// Bulk status change (Report page) — update each item AND log a status_change
// event, atomically per VIN, in one transaction. When the new status is 'sold',
// also clears the sync flags (II + Alias + StockX + Shopify) and logs the
// cascade. Returns the count updated.
export async function bulkSetStatus(vins, status, createdBy) {
  if (!vins.length) return 0;
  const sql = db();
  const details = JSON.stringify({ status, bulk: true });
  const cascade = JSON.stringify({ text: SOLD_CASCADE_TEXT, soldCascade: true });
  const queries = vins.map((vin) => (status === 'sold'
    ? sql`
      WITH up AS (
        UPDATE items SET status = ${status}, updated_at = now(),
          added_to_intel_inv = false, synced_alias = false,
          synced_stockx = false, synced_shopify = false
        WHERE vin = ${vin} RETURNING id
      )
      INSERT INTO item_events (item_id, type, details, created_by)
      SELECT id, 'status_change', ${details}::jsonb, ${createdBy || null} FROM up
      UNION ALL
      SELECT id, 'ph_update', ${cascade}::jsonb, ${createdBy || null} FROM up
      RETURNING item_id
    `
    : sql`
      WITH up AS (
        UPDATE items SET status = ${status}, updated_at = now() WHERE vin = ${vin} RETURNING id
      )
      INSERT INTO item_events (item_id, type, details, created_by)
      SELECT id, 'status_change', ${details}::jsonb, ${createdBy || null} FROM up
      RETURNING item_id
    `));
  const res = await sql.transaction(queries);
  return res.filter((r) => r.length).length;
}

// Look up an item by its VIN (internal barcode) with its batch + full history.
export async function getItemByVin(vin) {
  const rows = await db()`
    SELECT i.*, b.batch_code, b.buyer_name, b.supplier_name, b.tracking_number,
           b.date_received, b.kind, b.origin
    FROM items i LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.vin = ${vin} LIMIT 1
  `;
  if (!rows[0]) return null;
  const events = await db()`
    SELECT id, type, details, created_by, created_at
    FROM item_events WHERE item_id = ${rows[0].id} ORDER BY created_at, id
  `;
  return { item: rows[0], events };
}

// Re-scan an EXISTING in-hand unit (Rescale by VIN). Appends a 'rescaled' event
// and — when a new status/tag is given — a 'status_change' event, and updates
// the item's status. All in one transaction so the unit keeps a single,
// continuous history (no new VIN is minted; the physical shoe stays one record).
export async function rescaleItem({ itemId, status, note = null, reason = null, createdBy }) {
  const sql = db();
  const queries = [sql`
    INSERT INTO item_events (item_id, type, details, created_by)
    VALUES (${itemId}, 'rescaled', ${JSON.stringify({ reason, note })}::jsonb, ${createdBy || null})
  `];
  // Rescanned units are restock-pending until the team marks them restocked.
  if (status) {
    queries.push(sql`
      INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${itemId}, 'status_change', ${JSON.stringify({ status, note, rescale: true })}::jsonb, ${createdBy || null})
    `);
    queries.push(sql`UPDATE items SET status = ${status}, restock_pending = true, updated_at = now() WHERE id = ${itemId}`);
  } else {
    queries.push(sql`UPDATE items SET restock_pending = true, updated_at = now() WHERE id = ${itemId}`);
  }
  await sql.transaction(queries);
}

// Append an event to an item's history; on a status change, also update the
// item. Marking 'sold' clears the sync flags (II → stores cascade) and logs it.
export async function addItemEvent({ itemId, type, details, createdBy }) {
  const sql = db();
  const queries = [sql`
    INSERT INTO item_events (item_id, type, details, created_by)
    VALUES (${itemId}, ${type}, ${JSON.stringify(details || {})}::jsonb, ${createdBy || null})
  `];
  if (type === 'status_change' && details?.status) {
    if (details.status === 'sold') {
      queries.push(sql`
        UPDATE items SET status = ${details.status},
          added_to_intel_inv = false, synced_alias = false,
          synced_stockx = false, synced_shopify = false, updated_at = now()
        WHERE id = ${itemId}
      `);
      queries.push(sql`
        INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${itemId}, 'ph_update', ${JSON.stringify({ text: SOLD_CASCADE_TEXT, soldCascade: true })}::jsonb, ${createdBy || null})
      `);
    } else {
      queries.push(sql`UPDATE items SET status = ${details.status}, updated_at = now() WHERE id = ${itemId}`);
    }
  }
  await sql.transaction(queries);
}
