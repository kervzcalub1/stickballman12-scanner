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

/* ------------------------ v6: suppliers ------------------------------- */

// Vendor names for the receiving dropdown — seeded list + any custom names
// staff have typed (auto-saved on commit). Returned alphabetically.
export async function listSuppliers() {
  const rows = await db()`SELECT name FROM suppliers ORDER BY name`;
  return rows.map((r) => r.name);
}

// Auto-save a typed supplier name for reuse (no-op if blank or already known).
export async function addSupplier(name, createdBy) {
  const n = String(name || '').trim();
  if (!n) return;
  await db()`
    INSERT INTO suppliers (name, created_by) VALUES (${n}, ${createdBy || null})
    ON CONFLICT (name) DO NOTHING
  `;
}

// Has this tracking number already been received (on a batch OR one of its
// boxes)? Returns the first matching batch or null — drives the duplicate alert.
export async function findBatchByTracking(tracking) {
  const t = String(tracking || '').trim();
  if (!t) return null;
  const rows = await db()`
    SELECT b.id, b.batch_code
    FROM batches b
    WHERE b.tracking_number = ${t}
       OR EXISTS (SELECT 1 FROM batch_boxes bx WHERE bx.batch_id = b.id AND bx.tracking_number = ${t})
    ORDER BY b.id
    LIMIT 1
  `;
  return rows[0] || null;
}

/* ------------------------ v6: listing photos ------------------------- */

// Listing photos for a SKU (shared across same-SKU units). Returned in capture
// order. Drives the dedupe check (skip the photo prompt when a SKU already has
// them) and the angle slots in the receiving scan modal.
export async function listProductPhotos(sku) {
  const s = String(sku || '').trim();
  if (!s) return [];
  return db()`SELECT angle, url, created_by, created_at FROM product_photos WHERE sku = ${s} ORDER BY created_at`;
}

// Upsert one angle's photo for a SKU (re-capturing an angle replaces it).
export async function setProductPhoto({ sku, angle, url, createdBy }) {
  await db()`
    INSERT INTO product_photos (sku, angle, url, created_by)
    VALUES (${sku}, ${angle}, ${url}, ${createdBy || null})
    ON CONFLICT (sku, angle) DO UPDATE SET url = EXCLUDED.url, created_by = EXCLUDED.created_by, created_at = now()
  `;
}

export async function removeProductPhoto(sku, angle) {
  await db()`DELETE FROM product_photos WHERE sku = ${sku} AND angle = ${angle}`;
}

/* ------------------------ v4: batches & items ------------------------- */

export async function createBatch(h, createdBy) {
  const rows = await db()`
    INSERT INTO batches
      (buyer_name, supplier_name, tracking_number, date_received,
       default_cost, notes, special_rules, kind, origin, duplicate_of, status, created_by, committed_at)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.tracking || null},
       ${h.dateReceived || null}, ${h.defaultCost ?? null}, ${h.notes || null},
       ${h.specialRules || null}, ${h.kind === 'rescale' ? 'rescale' : 'receiving'},
       ${h.origin || null}, ${h.duplicateOf ?? null}, 'committed', ${createdBy || null}, now())
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
      (vin, batch_id, box_id, name, sku, size, upc, image_url, cost, source, status, with_box, gender, colorway, notes, created_by)
    VALUES
      (coalesce(${it.vin || null},
        'SBM-' || to_char(coalesce(${dateReceived}::date, current_date), 'YYMMDD')
              || '-' || lpad(nextval('vin_seq')::text, 6, '0')),
       ${batchId}, ${it.boxId ?? null}, ${it.name || null}, ${it.sku || null}, ${it.size || null},
       ${it.upc || null}, ${it.image || null}, ${it.cost ?? null},
       ${it.source || 'manual'}, ${it.status || 'needs_shelf'}, ${it.withBox !== false},
       ${it.gender || null}, ${it.colorway || null}, ${it.notes || null}, ${createdBy || null})
    RETURNING id, vin
  `);
  const results = await sql.transaction(queries);
  return results.map((r) => r[0]);
}

// Store the Alias-fetched global indicator on freshly received items, and seed
// the final price (= GI + 20%). Best-effort enrichment at intake; `updates` is
// [{ id, global_indicator, price }]. Skips rows with a null GI. Logs a
// SYSTEM-GENERATED ph_update event per item so the history shows the auto-fetched
// GI as "system-generated" (not a person) — a later manual change is attributed
// to the editor by name.
export async function setItemGlobalIndicators(updates) {
  const list = (updates || []).filter((u) => u && u.id != null && u.global_indicator != null);
  if (!list.length) return 0;
  const sql = db();
  const queries = [];
  for (const u of list) {
    queries.push(sql`
      UPDATE items SET global_indicator = ${u.global_indicator}, price = ${u.price ?? null}, updated_at = now()
      WHERE id = ${u.id}
    `);
    const text = `Global indicator $${Number(u.global_indicator).toFixed(2)}`
      + (u.price != null ? ` · Final price $${Number(u.price).toFixed(2)}` : '')
      + ' (auto from Alias)';
    queries.push(sql`
      INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${u.id}, 'ph_update', ${JSON.stringify({ text, system: true })}::jsonb, NULL)
    `);
  }
  await sql.transaction(queries);
  return list.length;
}

// Apply a re-fetched Alias global indicator to existing items (the PH "Refresh
// prices" action). Each update = { id, global_indicator, price, keptOverride }.
// keptOverride = the GI moved but the row keeps a PH-typed price override; the
// logged event says so. Logged system-generated (no editor name).
export async function refreshItemGi(updates) {
  const list = (updates || []).filter((u) => u && u.id != null && u.global_indicator != null);
  if (!list.length) return 0;
  const sql = db();
  const queries = [];
  for (const u of list) {
    queries.push(sql`
      UPDATE items SET global_indicator = ${u.global_indicator}, price = ${u.price ?? null}, updated_at = now()
      WHERE id = ${u.id}
    `);
    const text = `Global indicator $${Number(u.global_indicator).toFixed(2)}`
      + (u.price != null
        ? (u.keptOverride
          ? ` · Final price kept at $${Number(u.price).toFixed(2)} (manual override)`
          : ` · Final price $${Number(u.price).toFixed(2)}`)
        : '')
      + ' (re-fetched from Alias)';
    queries.push(sql`
      INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${u.id}, 'ph_update', ${JSON.stringify({ text, system: true })}::jsonb, NULL)
    `);
  }
  await sql.transaction(queries);
  return list.length;
}

// Fetch the fields needed to re-fetch GI for a set of VINs (Refresh prices).
// Excludes sold/shipped units (no point re-pricing a closed sale).
export async function getItemsForGiRefresh(vins) {
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return [];
  return await db()`
    SELECT id, upc, sku, size, global_indicator, price
    FROM items
    WHERE vin = ANY(${list}) AND status NOT IN ('sold', 'shipped')
  `;
}

/* --------------------------- Product catalog --------------------------- */
// Cache of shoe details keyed by UPC (box-label barcode). Stores the Alias
// catalog_id used for Global Indicator pricing. Upsert keeps existing non-null
// values when the new payload omits a field (coalesce), so a later, richer
// lookup fills gaps without wiping good data.
export async function upsertProduct(p) {
  if (!p || (!p.upc && !p.sku)) return null;
  const sql = db();
  // UPC-keyed (box-label variant): one row per UPC.
  if (p.upc) {
    const rows = await sql`
      INSERT INTO products (upc, sku, size, name, colorway, gender, brand, image_url, catalog_id, source)
      VALUES (${p.upc}, ${p.sku || null}, ${p.size || null}, ${p.name || null}, ${p.colorway || null},
              ${p.gender || null}, ${p.brand || null}, ${p.image || null}, ${p.catalogId || null}, ${p.source || null})
      ON CONFLICT (upc) DO UPDATE SET
        sku        = coalesce(EXCLUDED.sku, products.sku),
        size       = coalesce(EXCLUDED.size, products.size),
        name       = coalesce(EXCLUDED.name, products.name),
        colorway   = coalesce(EXCLUDED.colorway, products.colorway),
        gender     = coalesce(EXCLUDED.gender, products.gender),
        brand      = coalesce(EXCLUDED.brand, products.brand),
        image_url  = coalesce(EXCLUDED.image_url, products.image_url),
        catalog_id = coalesce(EXCLUDED.catalog_id, products.catalog_id),
        source     = coalesce(EXCLUDED.source, products.source),
        updated_at = now()
      RETURNING id, upc, sku, size, name, colorway, gender, brand, image_url, catalog_id, source
    `;
    return rows[0] || null;
  }
  // SKU-only (no box-label UPC, e.g. a SKU scan): ONE catalog row per SKU
  // (upc IS NULL), enforced by the partial unique index products_sku_nullupc_idx
  // so concurrent upserts can't duplicate. coalesce keeps existing non-null values.
  const rows = await sql`
    INSERT INTO products (upc, sku, size, name, colorway, gender, brand, image_url, catalog_id, source)
    VALUES (NULL, ${p.sku}, ${p.size || null}, ${p.name || null}, ${p.colorway || null},
            ${p.gender || null}, ${p.brand || null}, ${p.image || null}, ${p.catalogId || null}, ${p.source || null})
    ON CONFLICT (sku) WHERE upc IS NULL DO UPDATE SET
      size       = coalesce(EXCLUDED.size, products.size),
      name       = coalesce(EXCLUDED.name, products.name),
      colorway   = coalesce(EXCLUDED.colorway, products.colorway),
      gender     = coalesce(EXCLUDED.gender, products.gender),
      brand      = coalesce(EXCLUDED.brand, products.brand),
      image_url  = coalesce(EXCLUDED.image_url, products.image_url),
      catalog_id = coalesce(EXCLUDED.catalog_id, products.catalog_id),
      source     = coalesce(EXCLUDED.source, products.source),
      updated_at = now()
    RETURNING id, upc, sku, size, name, colorway, gender, brand, image_url, catalog_id, source
  `;
  return rows[0] || null;
}

export async function getProductByUpc(upc) {
  if (!upc) return null;
  const rows = await db()`SELECT * FROM products WHERE upc = ${upc} LIMIT 1`;
  return rows[0] || null;
}

// The Alias catalog_id for a SKU (shared across its sizes) — first known row.
export async function getCatalogIdBySku(sku) {
  if (!sku) return null;
  const rows = await db()`SELECT catalog_id FROM products WHERE sku = ${sku} AND catalog_id IS NOT NULL LIMIT 1`;
  return rows[0]?.catalog_id || null;
}

// First two history events per item: "scanned" (Scanned by <user>) then the
// intake event — "received" for a shipment, "rescaled" for re-scaled stock.
// Inserted in order so the timeline reads scanned → received/rescaled.
// Per-unit defect issues flagged on the review screen (V6 Feature 4). One
// 'issue' event per unit, carrying the note + R2 photo URLs in details.
export async function insertIssueEvents(entries, createdBy) {
  if (!entries.length) return;
  const sql = db();
  const queries = entries.map((e) => sql`
    INSERT INTO item_events (item_id, type, details, created_by)
    VALUES (${e.itemId}, 'issue',
      ${JSON.stringify({ defectType: e.type || 'other', note: e.note || '', photos: Array.isArray(e.photos) ? e.photos : [] })}::jsonb,
      ${createdBy || null})
  `);
  await sql.transaction(queries);
}

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

/* ------------------ v6: multi-box batches (Feature 7) ------------------ */

// Create an OPEN multi-box receiving batch (no items yet). status='open' until
// all boxes are received (auto) or staff finish it manually.
export async function createOpenBatch(h, createdBy) {
  const rows = await db()`
    INSERT INTO batches
      (buyer_name, supplier_name, date_received, default_cost, notes, special_rules,
       kind, batch_tag, expected_boxes, status, created_by)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.dateReceived || null},
       ${h.defaultCost ?? null}, ${h.notes || null}, ${h.specialRules || null},
       'receiving', ${h.batchTag || null}, ${h.expectedBoxes ?? null}, 'open', ${createdBy || null})
    RETURNING id, batch_code
  `;
  return rows[0];
}

// Boxes of a batch with their received item counts (ordered by box number).
export async function listBatchBoxes(batchId) {
  return await db()`
    SELECT bx.id, bx.box_number, bx.tracking_number, bx.status, bx.received_by, bx.received_at, bx.created_at,
           (SELECT count(*)::int FROM items i WHERE i.box_id = bx.id) AS item_count
    FROM batch_boxes bx WHERE bx.batch_id = ${batchId}
    ORDER BY bx.box_number NULLS LAST, bx.id
  `;
}

// Find a batch's box by its slot number (or null if that slot isn't materialized).
async function findBatchBoxByNumber(batchId, boxNumber) {
  const rows = await db()`
    SELECT id, box_number, tracking_number, status
    FROM batch_boxes WHERE batch_id = ${batchId} AND box_number = ${boxNumber} LIMIT 1
  `;
  return rows[0] || null;
}

// Add a box (its own tracking #). With an explicit boxNumber, this is
// find-or-create on that slot: box slots are now materialized up-front (see
// syncBatchBoxes) so committing a box re-uses its existing pending row instead of
// creating a duplicate (fills in tracking if newly provided). Without a boxNumber
// (the "Add box" flow on the Batch page) it appends next = max+1.
export async function addBatchBox(batchId, { trackingNumber, boxNumber }, createdBy) {
  // The shim can't nest sql fragments — branch on whether a box number is given.
  let rows;
  if (Number.isInteger(boxNumber) && boxNumber > 0) {
    const existing = await findBatchBoxByNumber(batchId, boxNumber);
    if (existing) {
      if (trackingNumber && trackingNumber !== existing.tracking_number) {
        const upd = await db()`
          UPDATE batch_boxes SET tracking_number = ${trackingNumber}
          WHERE id = ${existing.id}
          RETURNING id, box_number, tracking_number, status
        `;
        return upd[0];
      }
      return existing;
    }
    rows = await db()`
      INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, created_by)
      VALUES (${batchId}, ${boxNumber}, ${trackingNumber || null}, 'pending', ${createdBy || null})
      RETURNING id, box_number, tracking_number, status
    `;
  } else {
    rows = await db()`
      INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, created_by)
      VALUES (
        ${batchId},
        (SELECT coalesce(max(box_number), 0) + 1 FROM batch_boxes WHERE batch_id = ${batchId}),
        ${trackingNumber || null}, 'pending', ${createdBy || null})
      RETURNING id, box_number, tracking_number, status
    `;
  }
  return rows[0];
}

// Materialize / update a batch's box slots (box_number + tracking) WITHOUT
// committing items. Called as staff enter box tracking numbers so every expected
// box — including empty ones and ones with only a tracking # scanned — is
// persisted and shows on the Batch page. Never disturbs a box already 'received'.
export async function syncBatchBoxes(batchId, slots, createdBy) {
  const list = Array.isArray(slots) ? slots : [];
  for (const s of list) {
    const n = Number(s?.boxNumber);
    if (!Number.isInteger(n) || n < 1) continue;
    const tracking = String(s?.trackingNumber ?? '').trim().slice(0, 120) || null;
    const existing = await findBatchBoxByNumber(batchId, n);
    if (existing) {
      // Leave received boxes alone; otherwise sync the (possibly cleared) tracking.
      if (existing.status !== 'received' && tracking !== (existing.tracking_number || null)) {
        await db()`UPDATE batch_boxes SET tracking_number = ${tracking} WHERE id = ${existing.id}`;
      }
    } else {
      await db()`
        INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, created_by)
        VALUES (${batchId}, ${n}, ${tracking}, 'pending', ${createdBy || null})
      `;
    }
  }
  return listBatchBoxes(batchId);
}

// Every unit in a batch with its owning box, so the Batch page can list a box's
// shoes (VIN → history) under each box row.
export async function listItemsByBatch(batchId) {
  return await db()`
    SELECT id, vin, box_id, name, sku, size, status, with_box, cost
    FROM items WHERE batch_id = ${batchId} ORDER BY box_id NULLS LAST, id
  `;
}

// Full batch view for the Batch Page: batch row + boxes (+counts) + items.
export async function getBatchWithBoxes(id) {
  const b = await db()`SELECT * FROM batches WHERE id = ${id}`;
  if (!b[0]) return null;
  const boxes = await listBatchBoxes(id);
  const items = await listItemsByBatch(id);
  return { batch: b[0], boxes, items };
}

// Open (resumable) multi-box batches, newest first, with progress counts.
export async function listOpenBatches() {
  return await db()`
    SELECT b.id, b.batch_code, b.supplier_name, b.batch_tag, b.expected_boxes,
           b.date_received, b.created_by, b.created_at,
           (SELECT count(*)::int FROM batch_boxes bx WHERE bx.batch_id = b.id AND bx.status = 'received') AS received_boxes,
           (SELECT count(*)::int FROM batch_boxes bx WHERE bx.batch_id = b.id) AS total_boxes,
           (SELECT count(*)::int FROM items i WHERE i.batch_id = b.id) AS item_count
    FROM batches b
    WHERE b.kind = 'receiving' AND b.status = 'open'
    ORDER BY b.created_at DESC
  `;
}

// Commit one box's items: insert them (with box_id + intake events), mark the
// box received, then auto-complete the batch when received == expected.
// Returns { vins, created, autoCompleted }.
export async function commitBoxItems({ batchId, boxId, items, createdBy, dateReceived }) {
  const withBox = items.map((it) => ({ ...it, boxId }));
  const created = await insertItems(batchId, withBox, createdBy, dateReceived);
  await insertIntakeEvents(created.map((r) => r.id), createdBy, 'receiving');
  await db()`
    UPDATE batch_boxes SET status = 'received', received_by = ${createdBy || null}, received_at = now()
    WHERE id = ${boxId} AND batch_id = ${batchId}
  `;
  // Auto-complete: every box received AND we've reached the expected count.
  const rows = await db()`
    SELECT b.expected_boxes,
           (SELECT count(*)::int FROM batch_boxes bx WHERE bx.batch_id = b.id) AS total_boxes,
           (SELECT count(*)::int FROM batch_boxes bx WHERE bx.batch_id = b.id AND bx.status = 'received') AS received_boxes
    FROM batches b WHERE b.id = ${batchId}
  `;
  const r = rows[0] || {};
  const autoCompleted = r.expected_boxes != null && r.received_boxes >= r.expected_boxes && r.received_boxes === r.total_boxes;
  if (autoCompleted) await db()`UPDATE batches SET status = 'committed', committed_at = now() WHERE id = ${batchId} AND status = 'open'`;
  return { created, vins: created.map((c) => c.vin), autoCompleted };
}

// Manually finish or reopen a batch (staff override of auto-complete).
export async function setBatchStatus(id, status) {
  if (status === 'open') {
    await db()`UPDATE batches SET status = 'open', committed_at = NULL WHERE id = ${id}`;
  } else {
    await db()`UPDATE batches SET status = 'committed', committed_at = now() WHERE id = ${id}`;
  }
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
           (SELECT count(*)::int FROM product_photos p WHERE p.sku = i.sku) AS photo_count,
           (SELECT p.url FROM product_photos p WHERE p.sku = i.sku
              ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, p.created_at LIMIT 1) AS photo_url,
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
             i.status, i.cost, i.price, i.global_indicator,
             i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify,
             i.ph_note, i.first_edit_by, i.first_edit_at, i.last_edit_by, i.last_edit_at,
             (SELECT count(*)::int FROM product_photos p WHERE p.sku = i.sku) AS photo_count,
             (SELECT p.url FROM product_photos p WHERE p.sku = i.sku
                ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, p.created_at LIMIT 1) AS photo_url
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
           i.status, i.cost, i.price, i.global_indicator,
           i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify,
           i.ph_note, i.first_edit_by, i.first_edit_at, i.last_edit_by, i.last_edit_at,
           (SELECT count(*)::int FROM product_photos p WHERE p.sku = i.sku) AS photo_count,
           (SELECT p.url FROM product_photos p WHERE p.sku = i.sku
              ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, p.created_at LIMIT 1) AS photo_url
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
           listing, listed_by, listed_at,
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

/* --------------------------- Shelf locations --------------------------- */
// Physical put-away spots. `code` is the scannable barcode value (unique). Each
// row carries a live item_count (units currently stored there, excl. sold/shipped).
export async function listLocations({ warehouse = null, area = null, active = null, q = null, limit = 5000 } = {}) {
  const lim = Math.min(10000, Math.max(1, Number(limit) || 5000));
  const like = q ? `%${q}%` : null;
  return await db()`
    SELECT l.id, l.code, l.warehouse, l.area, l.bay, l.shelf, l.label, l.active, l.sort_order,
           (SELECT count(*)::int FROM items i WHERE i.location_id = l.id AND i.status NOT IN ('sold','shipped')) AS item_count
    FROM locations l
    WHERE (${warehouse}::text IS NULL OR l.warehouse = ${warehouse})
      AND (${area}::text IS NULL OR l.area = ${area})
      AND (${active}::bool IS NULL OR l.active = ${active})
      AND (${like}::text IS NULL OR l.code ILIKE ${like} OR l.label ILIKE ${like} OR l.bay ILIKE ${like})
    ORDER BY l.warehouse, l.sort_order NULLS LAST, l.code
    LIMIT ${lim}
  `;
}

export async function getLocationByCode(code) {
  const rows = await db()`SELECT * FROM locations WHERE code = ${code} LIMIT 1`;
  return rows[0] || null;
}

// Create one location. Returns the row, or null if the code already existed.
export async function createLocation(loc, createdBy) {
  const rows = await db()`
    INSERT INTO locations (code, warehouse, area, bay, shelf, label, active, sort_order, created_by)
    VALUES (${loc.code}, ${loc.warehouse}, ${loc.area || null}, ${loc.bay}, ${loc.shelf ?? null},
            ${loc.label || null}, ${loc.active ?? true}, ${loc.sort_order ?? null}, ${createdBy || null})
    ON CONFLICT (code) DO NOTHING
    RETURNING *
  `;
  return rows[0] || null;
}

// Bulk insert (manual multi-add + the Manheim seed). Idempotent — existing codes
// are skipped. Returns { inserted, total }.
export async function bulkCreateLocations(list, createdBy) {
  const rows = Array.isArray(list) ? list : [];
  if (!rows.length) return { inserted: 0, total: 0 };
  const sql = db();
  const queries = rows.map((loc) => sql`
    INSERT INTO locations (code, warehouse, area, bay, shelf, label, active, sort_order, created_by)
    VALUES (${loc.code}, ${loc.warehouse}, ${loc.area || null}, ${loc.bay}, ${loc.shelf ?? null},
            ${loc.label || null}, ${loc.active ?? true}, ${loc.sort_order ?? null}, ${createdBy || null})
    ON CONFLICT (code) DO NOTHING
    RETURNING id
  `);
  const res = await sql.transaction(queries);
  return { inserted: res.filter((r) => r.length).length, total: rows.length };
}

// Edit the mutable bits (rename the display label, activate/deactivate). The
// structural fields (code/bay/shelf) are fixed at create. Pass null to leave a
// field unchanged.
export async function updateLocation(id, patch) {
  const rows = await db()`
    UPDATE locations SET
      label      = coalesce(${patch.label ?? null}, label),
      active     = coalesce(${patch.active ?? null}::bool, active),
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] || null;
}

// Put-away / transfer: place a set of units on a shelf. Each unit → its
// location_id/location_code set. Status: a boxed unit (or one that now has a box)
// becomes `in_stock`; a unit still without a box keeps `no_box` (locatable but not
// sellable). Logs a `shelved` event per unit. `units`: [{ vin, nowHasBox }].
export async function shelveItems({ location, units, createdBy }) {
  const list = (units || []).filter((u) => u && u.vin);
  if (!list.length) return { updated: 0, gotBox: 0, results: [] };
  const vins = [...new Set(list.map((u) => u.vin))];
  const cur = await db()`SELECT id, vin, status, with_box FROM items WHERE vin = ANY(${vins})`;
  const byVin = new Map(cur.map((r) => [r.vin, r]));
  const sql = db();
  const queries = [];
  const results = [];
  let gotBox = 0;
  for (const u of list) {
    const item = byVin.get(u.vin);
    if (!item) { results.push({ vin: u.vin, ok: false, reason: 'not_found' }); continue; }
    const wasNoBox = item.with_box === false;
    const nowHasBox = wasNoBox && !!u.nowHasBox;
    const withBox = wasNoBox ? !!u.nowHasBox : true;
    const newStatus = (wasNoBox && !u.nowHasBox) ? 'no_box' : 'in_stock';
    if (nowHasBox) gotBox++;
    const details = JSON.stringify({ locationCode: location.code, label: location.label, from: item.status, gotBox: nowHasBox, shelved: true });
    queries.push(sql`
      WITH up AS (
        UPDATE items SET location_id = ${location.id}, location_code = ${location.code},
          with_box = ${withBox}, status = ${newStatus}, updated_at = now()
        WHERE id = ${item.id} RETURNING id
      )
      INSERT INTO item_events (item_id, type, details, created_by)
      SELECT id, 'shelved', ${details}::jsonb, ${createdBy || null} FROM up
    `);
    results.push({ vin: u.vin, ok: true, status: newStatus, with_box: withBox });
  }
  if (queries.length) await sql.transaction(queries);
  return { updated: results.filter((r) => r.ok).length, gotBox, results };
}

// Units currently stored at a location (excl. sold/shipped) — the shelf-contents view.
export async function listItemsAtLocation(locationId) {
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.status, i.with_box, i.location_code
    FROM items i
    WHERE i.location_id = ${locationId} AND i.status NOT IN ('sold','shipped')
    ORDER BY i.name, i.size, i.vin
  `;
}

// PH listing decision on an AUDITED rescale request: per-size GI + Final price and
// the II/AL/SX/SH sync flags, stored on the request itself (requests aren't tied
// to specific VINs). Only allowed once the warehouse has audited it.
export async function updateRescaleRequestListing(id, listing, by) {
  const rows = await db()`
    UPDATE rescale_requests
    SET listing = ${JSON.stringify(listing || [])}::jsonb, listed_by = ${by || null}, listed_at = now()
    WHERE id = ${id} AND status = 'audited'
    RETURNING id, sku, name, sizes, actual_sizes, audit_note, price, reason, note, status,
              listing, listed_by, listed_at, requested_by, resolved_by, resolved_at, created_at
  `;
  return rows[0] || null;
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
    SELECT id, vin, price, global_indicator, added_to_intel_inv, synced_alias, synced_stockx, synced_shopify,
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
      global: 'global_indicator' in f ? num(f.global_indicator) : cur.global_indicator,
      intel: 'added_to_intel_inv' in f ? !!f.added_to_intel_inv : cur.added_to_intel_inv,
      alias: 'synced_alias' in f ? !!f.synced_alias : cur.synced_alias,
      stockx: 'synced_stockx' in f ? !!f.synced_stockx : cur.synced_stockx,
      shopify: 'synced_shopify' in f ? !!f.synced_shopify : cur.synced_shopify,
      note: 'ph_note' in f ? (String(f.ph_note || '').slice(0, 2000) || null) : cur.ph_note,
    };
    // Final price is auto = GI + 20%. It only counts as a human change (gets a
    // name) when the user OVERRIDES that calculated value; otherwise it's the
    // system-derived figure. `descs` carries { text, system } per change.
    const calcPrice = next.global == null ? null : Math.round(Number(next.global) * 1.2 * 100) / 100;
    const priceIsCalc = (next.price == null && calcPrice == null)
      || (next.price != null && calcPrice != null && Math.abs(Number(next.price) - calcPrice) < 0.005);
    // Compare money numerically — pg returns NUMERIC as a string ("80.00"), so a
    // raw String() compare would treat an unchanged 80 vs "80.00" as a change and
    // spuriously re-log on every submit.
    const numEq = (a, b) => {
      const x = a == null || a === '' ? null : Number(a);
      const y = b == null || b === '' ? null : Number(b);
      if (x == null && y == null) return true;
      if (x == null || y == null) return false;
      return Math.abs(x - y) < 0.005;
    };
    const descs = [];
    if (!numEq(next.global, cur.global_indicator)) descs.push({ text: next.global == null ? 'Global indicator cleared' : `Global indicator set to $${Number(next.global).toFixed(2)}`, system: false });
    if (!numEq(next.price, cur.price)) descs.push({ text: next.price == null ? 'Final price cleared' : `Final price set to $${Number(next.price).toFixed(2)}`, system: priceIsCalc });
    if (next.intel !== cur.added_to_intel_inv) descs.push({ text: next.intel ? 'Added to Intelligent Inventory' : 'Removed from Intelligent Inventory', system: false });
    if (next.alias !== cur.synced_alias) descs.push({ text: next.alias ? 'Synced to Alias' : 'Unsynced from Alias', system: false });
    if (next.stockx !== cur.synced_stockx) descs.push({ text: next.stockx ? 'Synced to StockX' : 'Unsynced from StockX', system: false });
    if (next.shopify !== cur.synced_shopify) descs.push({ text: next.shopify ? 'Synced to Shopify' : 'Unsynced from Shopify', system: false });
    if ((next.note || '') !== (cur.ph_note || '')) descs.push({ text: 'Note updated', system: false });

    queries.push(sql`
      UPDATE items SET price = ${next.price}, global_indicator = ${next.global}, added_to_intel_inv = ${next.intel},
        synced_alias = ${next.alias}, synced_stockx = ${next.stockx}, synced_shopify = ${next.shopify},
        ph_note = ${next.note},
        first_edit_by = coalesce(first_edit_by, ${by || null}), first_edit_at = coalesce(first_edit_at, now()),
        last_edit_by = ${by || null}, last_edit_at = now(), updated_at = now()
      WHERE id = ${cur.id}
    `);
    for (const d of descs) {
      queries.push(sql`
        INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${cur.id}, 'ph_update', ${JSON.stringify(d.system ? { text: d.text, system: true } : { text: d.text })}::jsonb, ${d.system ? null : (by || null)})
      `);
    }
  }
  await sql.transaction(queries);

  return await sql`
    SELECT vin, created_at, created_by, name, sku, size, gender, status, cost, price, global_indicator,
           added_to_intel_inv, synced_alias, synced_stockx, synced_shopify,
           ph_note, first_edit_by, first_edit_at, last_edit_by, last_edit_at
    FROM items WHERE id = ANY(${ids}) ORDER BY created_at, id
  `;
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

// Combined event history for a set of VINs (a PH grid size line covers several
// identical units). Returns events newest-first with the owning VIN attached, so
// the PH/admin/warehouse History view can show who changed what, when.
export async function getEventsForVins(vins, limit = 500) {
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return [];
  const lim = Math.min(2000, Math.max(1, Number(limit) || 500));
  return await db()`
    SELECT e.id, e.type, e.details, e.created_by, e.created_at, i.vin, i.size
    FROM item_events e JOIN items i ON i.id = e.item_id
    WHERE i.vin = ANY(${list})
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${lim}
  `;
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
