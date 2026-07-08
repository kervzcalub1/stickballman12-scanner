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

// Admin/superadmin: reset an account's password to a freshly-hashed value (a
// temporary password generated + shown once server-side). Returns the user row.
export async function setUserPassword(id, passHash) {
  const rows = await db()`
    UPDATE users SET pass_hash = ${passHash}
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

/* ---------------------------- App settings ---------------------------- */
// Small key/value store (app_settings). Reads of the price markup are cached
// briefly so per-item price math doesn't hit the DB each call; writes bust it.

export async function getSetting(key) {
  const rows = await db()`SELECT value FROM app_settings WHERE key = ${key} LIMIT 1`;
  return rows[0]?.value ?? null;
}

export async function setSetting(key, value, updatedBy) {
  const rows = await db()`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (${key}, ${String(value)}, ${updatedBy || null}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
    RETURNING key, value
  `;
  if (key === 'price_markup_pct') markupCache = { pct: null, expires: 0 }; // bust
  return rows[0] || null;
}

// Price markup percent (GI → Final). Default 20 (= +20%). Cached ~30s.
const DEFAULT_MARKUP_PCT = 20;
let markupCache = { pct: null, expires: 0 };
export async function getPriceMarkupPct() {
  if (markupCache.pct != null && Date.now() < markupCache.expires) return markupCache.pct;
  let pct = DEFAULT_MARKUP_PCT;
  try {
    const raw = await getSetting('price_markup_pct');
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= 0) pct = n;
  } catch { /* fall back to default */ }
  markupCache = { pct, expires: Date.now() + 30_000 };
  return pct;
}
// Multiplier form: 1 + pct/100 (e.g. 20 → 1.2).
export async function getPriceMarkupMult() {
  return 1 + (await getPriceMarkupPct()) / 100;
}

// When the price margin changes, recompute Final = GI × newMult for items that are
// NOT yet listed — off Intelligent Inventory AND off every store (Alias/StockX/
// Shopify). Preserves manual price overrides: only rows whose price is null or still
// equals the auto GI × oldMult are re-priced (rows a PH person hand-typed differ, so
// they're left alone). Skips in-store units and sold/shipped. Returns the row count.
export async function recomputeUnlistedPrices(oldMult, newMult) {
  const om = Number(oldMult); const nm = Number(newMult);
  if (!Number.isFinite(om) || !Number.isFinite(nm) || Math.abs(om - nm) < 1e-9) return 0;
  const rows = await db()`
    UPDATE items SET price = round(global_indicator * ${nm}), updated_at = now()
    WHERE global_indicator IS NOT NULL
      AND added_to_intel_inv = false
      AND synced_alias = false AND synced_stockx = false AND synced_shopify = false
      AND status NOT IN ('sold', 'shipped')
      AND (price IS NULL OR abs(price - round(global_indicator * ${om})) < 0.51)
      AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.id = items.batch_id AND b.kind = 'instore')
    RETURNING id
  `;
  return rows.length;
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
  return db()`SELECT angle, url, source, created_by, created_at FROM product_photos WHERE sku = ${s} ORDER BY source, created_at`;
}

// Upsert one angle's photo for a SKU + source (re-capturing an angle for the SAME
// source replaces it). `source` ∈ 'warehouse' | 'ph_edited' — the two coexist, so a
// PH upload never overwrites the warehouse original (in-store.md/ph-report.md).
export async function setProductPhoto({ sku, angle, url, source = 'warehouse', createdBy }) {
  const src = source === 'ph_edited' ? 'ph_edited' : 'warehouse';
  await db()`
    INSERT INTO product_photos (sku, angle, url, source, created_by)
    VALUES (${sku}, ${angle}, ${url}, ${src}, ${createdBy || null})
    ON CONFLICT (sku, angle, source) DO UPDATE SET url = EXCLUDED.url, created_by = EXCLUDED.created_by, created_at = now()
  `;
}

export async function removeProductPhoto(sku, angle, source = 'warehouse') {
  const src = source === 'ph_edited' ? 'ph_edited' : 'warehouse';
  await db()`DELETE FROM product_photos WHERE sku = ${sku} AND angle = ${angle} AND source = ${src}`;
}

/* ------------------------ v4: batches & items ------------------------- */

export async function createBatch(h, createdBy) {
  const rows = await db()`
    INSERT INTO batches
      (buyer_name, supplier_name, tracking_number, date_received,
       default_cost, notes, special_rules, kind, origin, duplicate_of, po_id, status, created_by, committed_at)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.tracking || null},
       ${h.dateReceived || null}, ${h.defaultCost ?? null}, ${h.notes || null},
       ${h.specialRules || null}, ${['receiving', 'rescale', 'instore'].includes(h.kind) ? h.kind : 'receiving'},
       ${h.origin || null}, ${h.duplicateOf ?? null}, ${h.poId ?? null}, 'committed', ${createdBy || null}, now())
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
      UPDATE items SET global_indicator = ${u.global_indicator}, price = ${u.price ?? null},
             gi_basis = ${u.gi_basis ?? null}, updated_at = now()
      WHERE id = ${u.id}
    `);
    const text = `Global indicator $${Number(u.global_indicator).toFixed(2)}`
      + (u.price != null ? ` · Final price $${Number(u.price).toFixed(2)}` : '')
      + (u.gi_basis === 'with_you' ? ' (With You)' : '')
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
      UPDATE items SET global_indicator = ${u.global_indicator}, price = ${u.price ?? null},
             gi_basis = ${u.gi_basis ?? null},
             updated_at = now(), last_edit_at = now(), last_edit_by = 'Alias refresh'
      WHERE id = ${u.id}
    `);
    // Bump last_edit_at above so this refresh is visible to the optimistic-concurrency
    // check — else a PH draft opened before the refresh silently reverts the fresh price.
    const text = `Global indicator $${Number(u.global_indicator).toFixed(2)}`
      + (u.price != null
        ? (u.keptOverride
          ? ` · Final price kept at $${Number(u.price).toFixed(2)} (manual override)`
          : ` · Final price $${Number(u.price).toFixed(2)}`)
        : '')
      + (u.gi_basis === 'with_you' ? ' (With You)' : '')
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
    SELECT i.id, i.upc, i.sku, i.size, i.global_indicator, i.price,
           i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.vin = ANY(${list}) AND i.status NOT IN ('sold', 'shipped')
      AND (b.kind IS DISTINCT FROM 'instore')  -- in-store bypasses PH/GI pricing
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
       kind, batch_tag, expected_boxes, po_id, status, created_by)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.dateReceived || null},
       ${h.defaultCost ?? null}, ${h.notes || null}, ${h.specialRules || null},
       'receiving', ${h.batchTag || null}, ${h.expectedBoxes ?? null}, ${h.poId ?? null}, 'open', ${createdBy || null})
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
  // Atomically CLAIM the box (compare-and-swap) BEFORE inserting items. Two
  // concurrent commits for the same box would otherwise both pass the handler's
  // status pre-check and both insert → duplicate items (TOCTOU). Only the request
  // that flips status pending→received proceeds; the loser gets 0 rows and aborts.
  const claim = await db()`
    UPDATE batch_boxes SET status = 'received', received_by = ${createdBy || null}, received_at = now()
    WHERE id = ${boxId} AND batch_id = ${batchId} AND status <> 'received'
    RETURNING id
  `;
  if (!claim.length) { const e = new Error('This box was already submitted.'); e.conflict = true; throw e; }
  const withBox = items.map((it) => ({ ...it, boxId }));
  const created = await insertItems(batchId, withBox, createdBy, dateReceived);
  await insertIntakeEvents(created.map((r) => r.id), createdBy, 'receiving');
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
           i.synced_alias, i.synced_stockx, i.synced_shopify, i.location_code,
           (SELECT count(*)::int FROM product_photos p WHERE p.sku = i.sku) AS photo_count,
           (SELECT p.url FROM product_photos p WHERE p.sku = i.sku AND p.angle IN ('side','diagonal','outsole','top','rear')
              ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, (p.source = 'ph_edited') DESC, p.created_at LIMIT 1) AS photo_url,
           b.batch_code, b.supplier_name, b.buyer_name, b.date_received, b.kind
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE (${from}::date IS NULL OR coalesce(b.date_received, i.created_at::date) >= ${from}::date)
      AND (${to}::date   IS NULL OR coalesce(b.date_received, i.created_at::date) <= ${to}::date)
      AND (${supplier}::text IS NULL OR b.supplier_name = ${supplier})
      AND (${status}::text   IS NULL OR i.status = ${status})
      AND (${kind}::text     IS NULL OR b.kind = ${kind})
      AND (${like}::text IS NULL OR i.vin ILIKE ${like} OR i.sku ILIKE ${like} OR i.name ILIKE ${like} OR i.upc ILIKE ${like} OR i.location_code ILIKE ${like})
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
             i.status, i.cost, i.price, i.global_indicator, i.gi_basis,
             i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify, i.listed_price,
             i.ph_note, i.first_edit_by, i.first_edit_at, i.last_edit_by, i.last_edit_at,
             (SELECT count(*)::int FROM product_photos p WHERE p.sku = i.sku) AS photo_count,
             (SELECT p.url FROM product_photos p WHERE p.sku = i.sku AND p.angle IN ('side','diagonal','outsole','top','rear')
                ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, (p.source = 'ph_edited') DESC, p.created_at LIMIT 1) AS photo_url
      FROM items i
      LEFT JOIN batches b ON b.id = i.batch_id
      LEFT JOIN LATERAL (
        SELECT e.created_at, e.created_by FROM item_events e
        WHERE e.item_id = i.id AND e.type = 'rescaled'
        ORDER BY e.created_at DESC LIMIT 1
      ) ev ON true
      WHERE i.restock_pending = true  -- pending worklist; cleared on "Mark restocked"
        AND i.status <> 'no_box'      -- no-box units aren't postable; PH never lists them
        AND (b.kind IS DISTINCT FROM 'instore')  -- in-store bypasses PH entirely
        AND (${from}::date IS NULL OR (coalesce(ev.created_at, i.updated_at) AT TIME ZONE 'America/New_York')::date >= ${from}::date)
        AND (${to}::date   IS NULL OR (coalesce(ev.created_at, i.updated_at) AT TIME ZONE 'America/New_York')::date <= ${to}::date)
      ORDER BY created_at DESC, i.id
      LIMIT 5000
    `;
  }
  return await db()`
    SELECT i.vin, i.created_at, i.created_by, i.name, i.sku, i.size, i.gender,
           i.status, i.cost, i.price, i.global_indicator, i.gi_basis,
           i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify, i.listed_price,
           i.ph_note, i.first_edit_by, i.first_edit_at, i.last_edit_by, i.last_edit_at,
           (SELECT count(*)::int FROM product_photos p WHERE p.sku = i.sku) AS photo_count,
           (SELECT p.url FROM product_photos p WHERE p.sku = i.sku AND p.angle IN ('side','diagonal','outsole','top','rear')
              ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, (p.source = 'ph_edited') DESC, p.created_at LIMIT 1) AS photo_url
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE (${from}::date IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
      -- In-store buys never enter the PH team's world (New Inventory OR the admin
      -- Report): they're listed to Alias by hand off the In-Store Listing page.
      AND (b.kind IS DISTINCT FROM 'instore')
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

// The In-Store Listing worklist: sellable in-store pairs with their per-store
// listing flags (Alias/StockX/Shopify), so admin/warehouse can track which have
// been listed BY HAND (in-store bypasses the PH team / II cascade). Excludes gone
// units (sold/shipped/missing/issue) and no-box (not sellable yet).
export async function listInstoreItems(from = null, to = null) {
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.gender, i.status, i.created_at, i.created_by, i.cost,
           i.instore_listed_alias, i.instore_listed_stockx, i.instore_listed_shopify,
           i.instore_listed_at, i.instore_listed_by,
           b.origin, b.batch_code,
           (SELECT p.url FROM product_photos p WHERE p.sku = i.sku AND p.angle IN ('side','diagonal','outsole','top','rear')
              ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, (p.source = 'ph_edited') DESC, p.created_at LIMIT 1) AS photo_url
    FROM items i
    JOIN batches b ON b.id = i.batch_id
    WHERE b.kind = 'instore'
      AND i.status NOT IN ('sold', 'shipped', 'missing', 'issue', 'no_box')
      AND (${from}::date IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT 5000
  `;
}

// Set the per-store listing flags on in-store units (the whole desired triple is
// sent, so a toggle is race-free). Guarded to kind='instore' so these flags can
// never land on receiving/rescale stock. Records who/when + a history event.
export async function setInstoreListed(vins, flags, by) {
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return [];
  const sql = db();
  const alias = !!flags.alias; const stockx = !!flags.stockx; const shopify = !!flags.shopify;
  const rows = await sql`
    UPDATE items SET
      instore_listed_alias   = ${alias},
      instore_listed_stockx  = ${stockx},
      instore_listed_shopify = ${shopify},
      instore_listed_at = now(),
      instore_listed_by = ${by || null}
    WHERE vin = ANY(${list})
      AND batch_id IN (SELECT id FROM batches WHERE kind = 'instore')
    RETURNING id, vin, instore_listed_alias, instore_listed_stockx, instore_listed_shopify
  `;
  // Audit: one history event per updated unit describing the resulting state.
  const label = [alias && 'Alias', stockx && 'StockX', shopify && 'Shopify'].filter(Boolean).join(', ') || 'none';
  for (const r of rows) {
    await sql`INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${r.id}, 'note', ${JSON.stringify({ text: `In-store listing → ${label}` })}::jsonb, ${by || null})`;
  }
  return rows;
}

// Pending-work counts for the home-screen badges. "Listable" = a sellable unit
// (has a box, not already sold/shipped/missing/issue/no-box) — those are what PH
// still needs to push to each store.
export async function pendingCounts() {
  const rows = await db()`
    SELECT
      count(*) FILTER (WHERE listable AND not_instore AND NOT added_to_intel_inv)::int AS not_ii,
      count(*) FILTER (WHERE listable AND not_instore AND NOT synced_alias)::int       AS not_alias,
      count(*) FILTER (WHERE listable AND not_instore AND NOT synced_stockx)::int      AS not_stockx,
      count(*) FILTER (WHERE listable AND not_instore AND NOT synced_shopify)::int     AS not_shopify,
      count(*) FILTER (WHERE status = 'needs_shelf')::int              AS needs_shelf,
      count(*) FILTER (WHERE status = 'no_box')::int                   AS no_box,
      count(*) FILTER (WHERE restock_pending)::int                     AS restock_pending,
      -- In-store pairs still needing manual store listing (sellable, not fully ticked).
      count(*) FILTER (WHERE NOT not_instore AND status NOT IN ('sold','shipped','missing','issue','no_box')
        AND NOT (instore_listed_alias AND instore_listed_stockx AND instore_listed_shopify))::int AS instore_unlisted,
      (SELECT count(*) FROM rescale_requests WHERE status = 'open')::int     AS rescale_requests,
      (SELECT count(*) FROM rescale_requests WHERE status = 'audited')::int  AS rescale_requests_audited
    FROM (
      -- not_instore gates the PH store-sync badges only: in-store buys bypass
      -- PH, so they must NOT inflate not_ii/alias/stockx/shopify. needs_shelf /
      -- no_box still include them — warehouse shelves & resolves in-store pairs.
      SELECT it.*,
             (it.with_box AND it.status NOT IN ('sold','shipped','missing','issue','no_box')) AS listable,
             (b.kind IS DISTINCT FROM 'instore') AS not_instore
      FROM items it
      LEFT JOIN batches b ON b.id = it.batch_id
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
// structural fields (code/bay/shelf) are fixed at create. Only the keys PRESENT
// in `patch` change — so `label: null` explicitly CLEARS the label (whereas a
// missing key leaves it as-is; a plain coalesce couldn't tell those apart).
export async function updateLocation(id, patch) {
  const hasLabel = Object.prototype.hasOwnProperty.call(patch, 'label');
  const hasActive = Object.prototype.hasOwnProperty.call(patch, 'active');
  const rows = await db()`
    UPDATE locations SET
      label      = CASE WHEN ${hasLabel}::bool  THEN ${hasLabel ? (patch.label ?? null) : null}     ELSE label  END,
      active     = CASE WHEN ${hasActive}::bool THEN ${hasActive ? !!patch.active : null}::bool      ELSE active END,
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
    // Anti double-sell: never reactivate a finalized unit by shelving it. Mirrors
    // TERMINAL_STATUSES (_lib/statuses.js) — shelving would otherwise flip it to
    // in_stock. This backstops every caller (ShelvePage + Inventory put-away).
    if (item.status === 'sold' || item.status === 'shipped') {
      results.push({ vin: u.vin, ok: false, reason: 'terminal', status: item.status });
      continue;
    }
    const wasNoBox = item.with_box === false;
    // A no-box shoe must NOT go on a shelf until it has a box — it isn't sellable.
    // Block it unless the caller confirmed a box was found now (nowHasBox); the
    // client then routes them to resolve the box (No-Box queue) first.
    if (wasNoBox && !u.nowHasBox) {
      results.push({ vin: u.vin, ok: false, reason: 'no_box' });
      continue;
    }
    const nowHasBox = wasNoBox; // reached here only if it now has a box
    const withBox = true;
    const newStatus = 'in_stock';
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
  // photo_url: prefer the team's own listing photo (real pair, 'side' angle first),
  // fall back to the catalog/API image (near-universal coverage) for a thumbnail.
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.status, i.with_box, i.location_code,
           COALESCE(
             (SELECT p.url FROM product_photos p WHERE p.sku = i.sku AND p.angle IN ('side','diagonal','outsole','top','rear')
                ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2
                                      WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, (p.source = 'ph_edited') DESC, p.created_at LIMIT 1),
             NULLIF(i.image_url, '')
           ) AS photo_url
    FROM items i
    WHERE i.location_id = ${locationId} AND i.status NOT IN ('sold','shipped')
    ORDER BY i.name, i.size, i.vin
  `;
}

// PH listing decision on an AUDITED rescale request: per-size GI + Final price and
// the II/AL/SX/SH sync flags, stored on the request itself (requests aren't tied
// to specific VINs). Only allowed once the warehouse has audited it.
export async function updateRescaleRequestListing(id, listing, by, baseListedAt = undefined) {
  // Optimistic concurrency: refuse if someone saved a newer listing since the
  // client loaded it (was a blind full-array overwrite → silent clobber).
  const cur = await db()`SELECT status, listed_at FROM rescale_requests WHERE id = ${id}`;
  if (!cur.length || cur[0].status !== 'audited') return null; // not found / not audited yet
  if (baseListedAt !== undefined) {
    const curMs = cur[0].listed_at ? new Date(cur[0].listed_at).getTime() : 0;
    const baseMs = baseListedAt ? new Date(baseListedAt).getTime() : 0;
    if (curMs !== baseMs) {
      const e = new Error('This listing was just updated by someone else. Reload and re-apply your changes.');
      e.conflict = true;
      throw e;
    }
  }
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
  return phUpdateGroup([{ vins: list, fields }], by, baseEditedAt);
}

// Atomic multi-size save (P1 fix): a PH grid group's "Submit" touches several
// SIZES at once, each with its OWN fields (GI/price/flags/note can differ per
// size). `sizeUpdates = [{ vins:[...], fields:{...} }, ...]` — one entry per
// size. Historically this ran as one `phUpdateItems` call PER SIZE in
// parallel; if one size's optimistic-concurrency check 409'd, the others could
// still commit, leaving the group half-saved. Here the whole group is ONE
// transaction: the conflict check runs ONCE across every vin in every size
// (using the single worst-case last_edit_at), and if it passes, every size's
// UPDATE + history INSERT run together in one `sql.transaction(...)` — either
// the whole group commits or none of it does. Field sanitize/validation stays
// in the API layer (api/ph/update.js) same as before; this function only
// trusts already-sanitized `fields` per size.
export async function phUpdateGroup(sizeUpdates, by, baseEditedAt = undefined) {
  const groups = (Array.isArray(sizeUpdates) ? sizeUpdates : [])
    .map((g) => ({ vins: (Array.isArray(g?.vins) ? g.vins : []).filter(Boolean), fields: g?.fields || {} }))
    .filter((g) => g.vins.length);
  if (!groups.length) return [];
  const sql = db();
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const markupMult = await getPriceMarkupMult(); // GI → Final multiplier (configurable)

  const allVins = [...new Set(groups.flatMap((g) => g.vins))];
  // Exclude in-store units: they bypass the PH team, so a PH write must never
  // land on one (they're skipped below since they won't be in curByVin).
  const curRows = await sql`
    SELECT i.id, i.vin, i.price, i.global_indicator, i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify, i.listed_price,
           i.ph_note, i.last_edit_at, i.last_edit_by
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.vin = ANY(${allVins}) AND (b.kind IS DISTINCT FROM 'instore')
  `;
  if (!curRows.length) return [];
  const curByVin = new Map(curRows.map((r) => [r.vin, r]));

  // Conflict check ONCE for the whole group (every size, every vin): if the
  // group's newest last_edit_at is newer than the baseline the client loaded,
  // someone else saved first — refuse and apply NOTHING (all-or-nothing).
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

  const queries = [];
  const ids = [];
  for (const grp of groups) {
    const f = grp.fields;
    for (const vin of grp.vins) {
      const cur = curByVin.get(vin);
      if (!cur) continue; // vin not found (deleted/renamed since load) — skip, don't fail the group
      ids.push(cur.id);
      const next = {
        price: 'price' in f ? num(f.price) : cur.price,
        global: 'global_indicator' in f ? num(f.global_indicator) : cur.global_indicator,
        // Pricing basis: 'consigned' | 'with_you' | null (manual/unknown). Follows the
        // GI — a hand-typed GI has no basis (client sends null); cleared GI clears it.
        giBasis: 'gi_basis' in f ? (f.gi_basis || null) : cur.gi_basis,
        intel: 'added_to_intel_inv' in f ? !!f.added_to_intel_inv : cur.added_to_intel_inv,
        alias: 'synced_alias' in f ? !!f.synced_alias : cur.synced_alias,
        stockx: 'synced_stockx' in f ? !!f.synced_stockx : cur.synced_stockx,
        shopify: 'synced_shopify' in f ? !!f.synced_shopify : cur.synced_shopify,
        note: 'ph_note' in f ? (String(f.ph_note || '').slice(0, 2000) || null) : cur.ph_note,
      };
      // Intelligent Inventory (II) is the MASTER listing: a store can only be
      // synced if the item is on II. Turning II off clears the store flags — this
      // prevents the impossible "II off / Alias on" state. (II on + store off is
      // still valid: the store just hasn't synced yet.)
      if (!next.intel) { next.alias = false; next.stockx = false; next.shopify = false; }
      if (next.global == null) next.giBasis = null; // no GI → no basis
      // Final price is auto = GI × markup (the configurable price margin). It only
      // counts as a human change (gets a name) when the user OVERRIDES that
      // calculated value; otherwise it's the system-derived figure. `descs`
      // carries { text, system } per change.
      const calcPrice = next.global == null ? null : Math.round(Number(next.global) * markupMult); // nearest whole dollar
      const priceIsCalc = (next.price == null && calcPrice == null)
        || (next.price != null && calcPrice != null && Math.abs(Number(next.price) - calcPrice) < 0.005);
      const descs = [];
      if (!numEq(next.global, cur.global_indicator)) descs.push({ text: next.global == null ? 'Global indicator cleared' : `Global indicator set to $${Number(next.global).toFixed(2)}`, system: false });
      if (!numEq(next.price, cur.price)) descs.push({ text: next.price == null ? 'Final price cleared' : `Final price set to $${Number(next.price).toFixed(2)}`, system: priceIsCalc });
      if (next.intel !== cur.added_to_intel_inv) descs.push({ text: next.intel ? 'Added to Intelligent Inventory' : 'Removed from Intelligent Inventory', system: false });
      if (next.alias !== cur.synced_alias) descs.push({ text: next.alias ? 'Synced to Alias' : 'Unsynced from Alias', system: false });
      if (next.stockx !== cur.synced_stockx) descs.push({ text: next.stockx ? 'Synced to StockX' : 'Unsynced from StockX', system: false });
      if (next.shopify !== cur.synced_shopify) descs.push({ text: next.shopify ? 'Synced to Shopify' : 'Unsynced from Shopify', system: false });
      if ((next.note || '') !== (cur.ph_note || '')) descs.push({ text: 'Note updated', system: false });

      // Re-baseline the listed-price snapshot on a manual PH save: when the item is
      // on II, it's now "listed at" this price (clears any prior drift); when II is
      // off it isn't listed, so no baseline. A GI refresh (refreshItemGi) deliberately
      // does NOT touch listed_price — that's what surfaces the ⚠ "Price changed" chip.
      const listedPrice = next.intel ? next.price : null;
      queries.push(sql`
        UPDATE items SET price = ${next.price}, global_indicator = ${next.global}, gi_basis = ${next.giBasis}, added_to_intel_inv = ${next.intel},
          synced_alias = ${next.alias}, synced_stockx = ${next.stockx}, synced_shopify = ${next.shopify},
          ph_note = ${next.note}, listed_price = ${listedPrice},
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
  }
  if (!queries.length) return [];
  // ALL sizes' updates + history events commit in ONE transaction — atomic
  // across the whole group, not just within a size.
  await sql.transaction(queries);

  return await sql`
    SELECT vin, created_at, created_by, name, sku, size, gender, status, cost, price, global_indicator, gi_basis, listed_price,
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
const SHIPPED_CASCADE_TEXT = 'Shipped — removed from Intelligent Inventory & all stores';
// A terminal status (sold/shipped) has left inventory → clear all four sync flags.
const cascadeTextFor = (status) => (status === 'shipped' ? SHIPPED_CASCADE_TEXT : SOLD_CASCADE_TEXT);
const clearsSyncFlags = (status) => status === 'sold' || status === 'shipped';

// Current status for each VIN → { vin: status }. Used to guard status changes
// (e.g. block reactivating a sold/shipped unit).
// Returns each unit's current status + whether it's on a shelf, keyed by VIN.
// Drives the anti-double-sell terminal guard AND the invariant
// "in_stock ⟺ has a location" (see api/items/bulk-status.js).
export async function getItemStatesByVins(vins) {
  if (!vins?.length) return {};
  const rows = await db()`SELECT vin, status, location_id FROM items WHERE vin = ANY(${vins})`;
  return Object.fromEntries(rows.map((r) => [r.vin, { status: r.status, locationId: r.location_id }]));
}

// Bulk status change (Report page) — update each item AND log a status_change
// event, atomically per VIN, in one transaction. When the new status is 'sold',
// also clears the sync flags (II + Alias + StockX + Shopify) and logs the
// cascade. Returns the count updated.
export async function bulkSetStatus(vins, status, createdBy) {
  if (!vins.length) return 0;
  const sql = db();
  const details = JSON.stringify({ status, bulk: true });
  const cascade = JSON.stringify({ text: cascadeTextFor(status), soldCascade: true });
  const queries = vins.map((vin) => (clearsSyncFlags(status)
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
           b.date_received, b.kind, b.origin,
           l.label AS location_label, l.warehouse AS location_warehouse, l.area AS location_area
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    LEFT JOIN locations l ON l.id = i.location_id
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
    if (clearsSyncFlags(details.status)) {
      queries.push(sql`
        UPDATE items SET status = ${details.status},
          added_to_intel_inv = false, synced_alias = false,
          synced_stockx = false, synced_shopify = false, updated_at = now()
        WHERE id = ${itemId}
      `);
      queries.push(sql`
        INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${itemId}, 'ph_update', ${JSON.stringify({ text: cascadeTextFor(details.status), soldCascade: true })}::jsonb, ${createdBy || null})
      `);
    } else {
      queries.push(sql`UPDATE items SET status = ${details.status}, updated_at = now() WHERE id = ${itemId}`);
    }
  }
  await sql.transaction(queries);
}

/* -------------------- Purchase Orders (supplier scan-out) --------------------
   PH creates a PO (the "batch" form) with one po_boxes row per shipping label;
   the supplier fills po_lines by scanning under each label; the PO ships only
   when every label is shipped. See docs/context/purchase-orders.md.
   NOTE: none of these touch the receiving commit path — no VIN mint / items
   insert (supplier scan-out must never create phantom stock). */

// Approved supplier accounts — for the PH "create PO" supplier picker.
export async function listSupplierUsers() {
  const sql = db();
  return sql`
    SELECT id, name, username FROM users
    WHERE role = 'supplier' AND status = 'approved'
    ORDER BY name
  `;
}

// Create a PO shell + one po_boxes row per label, atomically (CTE + unnest).
export async function createPo({ supplierName, supplierUserId, tagCode, dateOfPurchase, notes, labels, createdBy }) {
  const sql = db();
  const boxNumbers = labels.map((_, i) => i + 1);
  const trackings = labels.map((l) => (String(l.trackingNumber || '').trim() || null));
  const rows = await sql`
    WITH po AS (
      INSERT INTO purchase_orders
        (supplier_name, supplier_user_id, tag_code, date_of_purchase, expected_boxes, notes, created_by)
      VALUES (${supplierName}, ${supplierUserId || null}, ${tagCode || null}, ${dateOfPurchase || null},
              ${labels.length}, ${notes || null}, ${createdBy || null})
      RETURNING id
    )
    INSERT INTO po_boxes (po_id, box_number, tracking_number, status, created_by)
    SELECT po.id, t.box_number, t.tracking_number, 'pending', ${createdBy || null}
    FROM po, unnest(${boxNumbers}::int[], ${trackings}::text[]) AS t(box_number, tracking_number)
    RETURNING po_id
  `;
  return getPoFull(rows[0].po_id);
}

export async function getPo(id) {
  const sql = db();
  return (await sql`SELECT * FROM purchase_orders WHERE id = ${id}`)[0] || null;
}

export async function getPoBox(id) {
  const sql = db();
  return (await sql`SELECT * FROM po_boxes WHERE id = ${id}`)[0] || null;
}

// Full PO: header + labels (boxes) + expected lines.
export async function getPoFull(id) {
  const sql = db();
  const po = (await sql`SELECT * FROM purchase_orders WHERE id = ${id}`)[0];
  if (!po) return null;
  const boxes = await sql`SELECT * FROM po_boxes WHERE po_id = ${id} ORDER BY box_number`;
  const lines = await sql`SELECT * FROM po_lines WHERE po_id = ${id} ORDER BY po_box_id, sku, size`;
  return { po, boxes, lines };
}

// List POs with roll-up counts. Supplier sees only their own; everyone else all.
// (The shim can't nest sql fragments, so branch the whole statement.)
export async function listPos({ uid, supplierScope }) {
  const sql = db();
  if (supplierScope) {
    return sql`
      SELECT p.*,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id)::int AS box_count,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.status <> 'pending')::int AS shipped_count,
        (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count
      FROM purchase_orders p
      WHERE p.supplier_user_id = ${uid}
      ORDER BY p.created_at DESC
    `;
  }
  return sql`
    SELECT p.*,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id)::int AS box_count,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.status <> 'pending')::int AS shipped_count,
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count
    FROM purchase_orders p
    ORDER BY p.created_at DESC
  `;
}

// Add/increment an expected line under a label. Re-scanning a SKU+size in the
// same label bumps qty_expected (mirrors receiving's per-size auto-increment).
export async function addPoScan({ poId, poBoxId, sku, size, qty, name, upc, colorway, gender, unitCost }) {
  const sql = db();
  const rows = await sql`
    INSERT INTO po_lines (po_id, po_box_id, sku, size, name, upc, colorway, gender, qty_expected, unit_cost)
    VALUES (${poId}, ${poBoxId}, ${sku}, ${size}, ${name || null}, ${upc || null},
            ${colorway || null}, ${gender || null}, ${qty}, ${unitCost ?? null})
    ON CONFLICT (po_box_id, sku, size) DO UPDATE
      SET qty_expected = po_lines.qty_expected + EXCLUDED.qty_expected,
          unit_cost    = COALESCE(EXCLUDED.unit_cost, po_lines.unit_cost),
          name         = COALESCE(EXCLUDED.name, po_lines.name),
          updated_at   = now()
    RETURNING *
  `;
  return rows[0];
}

export async function setPoLineQty(lineId, qtyExpected) {
  const sql = db();
  if (qtyExpected <= 0) { await sql`DELETE FROM po_lines WHERE id = ${lineId}`; return null; }
  return (await sql`
    UPDATE po_lines SET qty_expected = ${qtyExpected}, updated_at = now()
    WHERE id = ${lineId} RETURNING *
  `)[0] || null;
}

export async function deletePoLine(lineId) {
  const sql = db();
  await sql`DELETE FROM po_lines WHERE id = ${lineId}`;
}

// Mark one label shipped; if every label on the PO is now shipped, flip the PO
// to 'shipped'. Returns the updated box (or null if it wasn't pending).
export async function shipPoBox(poBoxId) {
  const sql = db();
  const box = (await sql`
    UPDATE po_boxes SET status = 'shipped', shipped_at = now()
    WHERE id = ${poBoxId} AND status = 'pending'
    RETURNING *
  `)[0];
  if (!box) return null;
  await sql`
    UPDATE purchase_orders SET status = 'shipped', shipped_at = now()
    WHERE id = ${box.po_id} AND status = 'draft'
      AND NOT EXISTS (SELECT 1 FROM po_boxes WHERE po_id = ${box.po_id} AND status = 'pending')
  `;
  return box;
}

export async function getPoLine(id) {
  const sql = db();
  return (await sql`SELECT * FROM po_lines WHERE id = ${id}`)[0] || null;
}

export async function countPoBoxLines(poBoxId) {
  const sql = db();
  const r = await sql`SELECT coalesce(sum(qty_expected), 0)::int AS n FROM po_lines WHERE po_box_id = ${poBoxId}`;
  return r[0].n;
}

/* ---- Phase 2: receive a shipment against a PO -------------------------------
   The warehouse creates a normal receiving `batch` linked to the PO via
   batches.po_id; the PO flips 'shipped' → 'receiving' on the first link. */

// Open POs available to receive against (shipped or already being received).
export async function listOpenPos() {
  const sql = db();
  return sql`
    SELECT p.*,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id)::int AS box_count,
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count
    FROM purchase_orders p
    WHERE p.status IN ('shipped', 'receiving')
    ORDER BY p.shipped_at DESC NULLS LAST, p.created_at DESC
  `;
}

// Find a PO by its code (PO-xxxxx) or by any of its labels' tracking numbers —
// so the warehouse can scan a shipping label to pull up the order.
export async function lookupPoByCodeOrTracking(q) {
  const sql = db();
  const term = String(q || '').trim();
  if (!term) return null;
  const rows = await sql`
    SELECT DISTINCT p.id FROM purchase_orders p
    LEFT JOIN po_boxes b ON b.po_id = p.id
    WHERE upper(p.po_code) = upper(${term})
       OR upper(b.tracking_number) = upper(${term})
    ORDER BY p.id DESC
    LIMIT 1
  `;
  return rows[0] ? getPoFull(Number(rows[0].id)) : null;
}

// Link a batch to its PO and move the PO into 'receiving' on the first link.
// Idempotent: keeps the first received_batch_id; only 'shipped' advances.
export async function markPoReceiving(poId, batchId) {
  const sql = db();
  await sql`
    UPDATE purchase_orders
    SET status = CASE WHEN status = 'shipped' THEN 'receiving' ELSE status END,
        received_batch_id = COALESCE(received_batch_id, ${batchId})
    WHERE id = ${poId}
  `;
}

// The still-open receiving batch already linked to a PO (if any) — so a second
// "start receiving" against the same PO reuses it instead of creating a duplicate.
export async function getOpenBatchForPo(poId) {
  const sql = db();
  const rows = await sql`SELECT id, batch_code FROM batches WHERE po_id = ${poId} AND status = 'open' ORDER BY id LIMIT 1`;
  return rows[0] || null;
}

/* ---- Phase 3: reconciliation (received-vs-expected) -------------------------
   Compares the supplier's declared manifest (po_lines, expected) against what the
   warehouse actually received (items under the PO's received_batch_id), grouped by
   (sku, size), and flags each: match / shortage / overage / wrong-size / wrong-sku. */

const rcSku = (s) => String(s || '').trim().toUpperCase();
const rcSize = (s) => String(s || '').trim();

// Compute the reconciliation table + summary on demand (does not persist).
export async function getPoReconciliation(poId) {
  const sql = db();
  const po = (await sql`SELECT * FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po) return null;
  const expected = await sql`
    SELECT sku, size, sum(qty_expected)::int AS qty, max(name) AS name
    FROM po_lines WHERE po_id = ${poId} GROUP BY sku, size`;
  const received = po.received_batch_id
    ? await sql`
        SELECT sku, size, count(*)::int AS qty, max(name) AS name
        FROM items WHERE batch_id = ${po.received_batch_id} GROUP BY sku, size`
    : [];

  const key = (s, z) => `${rcSku(s)}|${rcSize(z)}`;
  const expMap = new Map(); const expSkus = new Set();
  for (const e of expected) { expMap.set(key(e.sku, e.size), e); expSkus.add(rcSku(e.sku)); }
  const recMap = new Map();
  for (const r of received) recMap.set(key(r.sku, r.size), r);

  const rows = [];
  for (const k of new Set([...expMap.keys(), ...recMap.keys()])) {
    const e = expMap.get(k); const r = recMap.get(k);
    const exp = e?.qty || 0; const rec = r?.qty || 0;
    const sku = (e || r).sku; const size = (e || r).size; const name = e?.name || r?.name || sku;
    let flag;
    if (exp > 0 && rec === exp) flag = 'match';
    else if (exp > 0 && rec < exp) flag = 'shortage';
    else if (exp > 0 && rec > exp) flag = 'overage';
    else if (exp === 0 && expSkus.has(rcSku(sku))) flag = 'wrong_size'; // SKU expected, this size wasn't
    else flag = 'wrong_sku';                                            // SKU not on the PO at all
    rows.push({ sku, size, name, expected: exp, received: rec, delta: rec - exp, flag });
  }
  rows.sort((a, b) => (a.sku || '').localeCompare(b.sku || '') || rcSize(a.size).localeCompare(rcSize(b.size)));

  const summary = {
    expected_units: rows.reduce((n, x) => n + x.expected, 0),
    received_units: rows.reduce((n, x) => n + x.received, 0),
    match: rows.filter((x) => x.flag === 'match').length,
    shortage: rows.filter((x) => x.flag === 'shortage').length,
    overage: rows.filter((x) => x.flag === 'overage').length,
    wrong_size: rows.filter((x) => x.flag === 'wrong_size').length,
    wrong_sku: rows.filter((x) => x.flag === 'wrong_sku').length,
  };
  summary.clean = summary.shortage + summary.overage + summary.wrong_size + summary.wrong_sku === 0;
  return { po, rows, summary };
}

// Freeze the current reconciliation onto the PO + close it out.
export async function snapshotReconciliation(poId) {
  const data = await getPoReconciliation(poId);
  if (!data) return null;
  const sql = db();
  const snap = { rows: data.rows, summary: data.summary, at: new Date().toISOString() };
  await sql`
    UPDATE purchase_orders
    SET reconciliation = ${JSON.stringify(snap)}::jsonb, reconciled_at = now(), status = 'reconciled'
    WHERE id = ${poId}`;
  return { ...data, po: { ...data.po, status: 'reconciled' } };
}

// POs that have been received and are awaiting / have a reconciliation.
export async function listReconcilePos() {
  const sql = db();
  return sql`
    SELECT p.*,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id)::int AS box_count,
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count
    FROM purchase_orders p
    WHERE p.status IN ('receiving', 'reconciled')
    ORDER BY (p.status = 'receiving') DESC, p.reconciled_at DESC NULLS LAST, p.created_at DESC`;
}
