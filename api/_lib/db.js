// Neon Postgres access layer (HTTP driver — serverless-friendly, no pooling).
// All queries use tagged-template parameterization, so values are never
// interpolated into SQL text (injection-safe).

import { neon } from '@neondatabase/serverless';

let _sql = null;
function db() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
  _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

export function dbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/* ------------------------------- Users -------------------------------- */

// Create a pending employee. Throws { code: 'USERNAME_TAKEN' } on conflict.
export async function createUser({ name, username, passHash }) {
  const sql = db();
  try {
    const rows = await sql`
      INSERT INTO users (name, username, pass_hash, role, status)
      VALUES (${name}, ${username}, ${passHash}, 'employee', 'pending')
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
       default_cost, notes, special_rules, status, created_by, committed_at)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.tracking || null},
       ${h.dateReceived || null}, ${h.defaultCost ?? null}, ${h.notes || null},
       ${h.specialRules || null}, 'committed', ${createdBy || null}, now())
    RETURNING id, batch_code
  `;
  return rows[0];
}

// Bulk-insert items in one transaction; returns [{ id, vin }] in input order.
// VIN format: SBM-<YYMMDD of date received>-<6-digit sequence>, e.g.
// SBM-250615-000123. Falls back to today's date when no received date is given.
export async function insertItems(batchId, items, createdBy, dateReceived = null) {
  const sql = db();
  const queries = items.map((it) => sql`
    INSERT INTO items
      (vin, batch_id, name, sku, size, upc, image_url, cost, source, status, notes, created_by)
    VALUES
      ('SBM-' || to_char(coalesce(${dateReceived}::date, current_date), 'YYMMDD')
            || '-' || lpad(nextval('vin_seq')::text, 6, '0'),
       ${batchId}, ${it.name || null}, ${it.sku || null}, ${it.size || null},
       ${it.upc || null}, ${it.image || null}, ${it.cost ?? null},
       ${it.source || 'manual'}, 'in_stock', ${it.notes || null}, ${createdBy || null})
    RETURNING id, vin
  `);
  const results = await sql.transaction(queries);
  return results.map((r) => r[0]);
}

export async function insertReceivedEvents(itemIds, createdBy) {
  if (!itemIds.length) return;
  const sql = db();
  await sql.transaction(itemIds.map((id) => sql`
    INSERT INTO item_events (item_id, type, details, created_by)
    VALUES (${id}, 'received', '{}'::jsonb, ${createdBy || null})
  `));
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

export async function listBatches(limit = 50) {
  return await db()`
    SELECT b.id, b.batch_code, b.buyer_name, b.supplier_name, b.tracking_number,
           b.date_received, b.created_by, b.created_at,
           (SELECT count(*)::int FROM items i WHERE i.batch_id = b.id) AS item_count,
           (SELECT coalesce(sum(i.cost), 0) FROM items i WHERE i.batch_id = b.id) AS total_cost,
           (SELECT count(*)::int FROM shipment_issues s WHERE s.batch_id = b.id) AS issue_count
    FROM batches b
    ORDER BY b.created_at DESC
    LIMIT ${limit}
  `;
}

export async function getBatch(id) {
  const b = await db()`SELECT * FROM batches WHERE id = ${id}`;
  if (!b[0]) return null;
  const items = await db()`
    SELECT id, vin, name, sku, size, cost, source, status, created_at
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
export async function queryItems({ q = null, from = null, to = null, supplier = null, status = null, limit = 2000 }) {
  const lim = Math.min(5000, Math.max(1, Number(limit) || 2000));
  const like = q ? `%${q}%` : null;
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.cost, i.status, i.created_by, i.created_at,
           b.batch_code, b.supplier_name, b.date_received
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE (${from}::date IS NULL OR coalesce(b.date_received, i.created_at::date) >= ${from}::date)
      AND (${to}::date   IS NULL OR coalesce(b.date_received, i.created_at::date) <= ${to}::date)
      AND (${supplier}::text IS NULL OR b.supplier_name = ${supplier})
      AND (${status}::text   IS NULL OR i.status = ${status})
      AND (${like}::text IS NULL OR i.vin ILIKE ${like} OR i.sku ILIKE ${like} OR i.name ILIKE ${like})
    ORDER BY i.created_at DESC
    LIMIT ${lim}
  `;
}

// Look up an item by its VIN (internal barcode) with its batch + full history.
export async function getItemByVin(vin) {
  const rows = await db()`
    SELECT i.*, b.batch_code, b.buyer_name, b.supplier_name, b.tracking_number, b.date_received
    FROM items i LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.vin = ${vin} LIMIT 1
  `;
  if (!rows[0]) return null;
  const events = await db()`
    SELECT id, type, details, created_by, created_at
    FROM item_events WHERE item_id = ${rows[0].id} ORDER BY created_at
  `;
  return { item: rows[0], events };
}

// Append an event to an item's history; on a status change, also update the item.
export async function addItemEvent({ itemId, type, details, createdBy }) {
  await db()`
    INSERT INTO item_events (item_id, type, details, created_by)
    VALUES (${itemId}, ${type}, ${JSON.stringify(details || {})}::jsonb, ${createdBy || null})
  `;
  if (type === 'status_change' && details?.status) {
    await db()`UPDATE items SET status = ${details.status}, updated_at = now() WHERE id = ${itemId}`;
  }
}
