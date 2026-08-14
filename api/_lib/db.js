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

// Batch kinds the PH team must NEVER see. Both bypass PH entirely but for
// different reasons: 'instore' is listed to the stores by hand off the In-Store
// Listing page, and 'existing' is old stock that was already synced to II and the
// stores long before this system existed. Kept as ONE list because the exclusion
// has to hold at every PH read/write path — phListItems (both branches),
// pendingCounts, phUpdateGroup, getItemsForGiRefresh, recomputeUnlistedPrices and
// rescaleItem. Guarding only the obvious one is how in-store leaked onto the PH
// Rescale grid before (see docs/context/in-store.md).
//
// Use as: (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))
// The IS NULL half is required — these are LEFT JOINs, and `NULL <> ALL(...)` is
// NULL, which would silently drop every batchless row.
export const PH_EXCLUDED_KINDS = ['instore', 'existing'];

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
    SELECT id, name, username, pass_hash, role, status, must_change_password
    FROM users WHERE username = ${username} LIMIT 1
  `;
  return rows[0] || null;
}

// Admin views. Pending first, then most recent.
export async function listUsers() {
  return await db()`
    SELECT id, name, username, role, status, created_at, reviewed_at, reviewed_by,
           must_change_password, reset_requested_at
    FROM users
    ORDER BY (reset_requested_at IS NOT NULL) DESC, (status = 'pending') DESC, created_at DESC
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
// Admin-issued reset: set the temp hash, FORCE a change on next sign-in, and clear any
// pending self-request (it's been handled). See api/admin/reset-password.js.
export async function adminResetPassword(id, passHash) {
  const rows = await db()`
    UPDATE users
    SET pass_hash = ${passHash}, must_change_password = true, reset_requested_at = NULL
    WHERE id = ${id}
    RETURNING id, name, username, role, status
  `;
  return rows[0] || null;
}
// User picks their own new password (clears the forced-change flag). Used by the
// forced-change screen after signing in with a temp password.
export async function changeOwnPassword(id, passHash) {
  const rows = await db()`
    UPDATE users
    SET pass_hash = ${passHash}, must_change_password = false, reset_requested_at = NULL
    WHERE id = ${id}
    RETURNING id, name, username, role, status
  `;
  return rows[0] || null;
}
// Self-service reset request from the sign-in screen. Only approved DB accounts can
// request. Returns the row if one matched — the HTTP layer answers generically regardless
// (no username enumeration).
export async function requestPasswordReset(username) {
  const rows = await db()`
    UPDATE users SET reset_requested_at = now()
    WHERE username = ${username} AND status = 'approved'
    RETURNING id
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

// Supplier-facing business name for on-behalf attribution ("<name>'s Staff").
// Configurable via app_settings.business_display_name; defaults when unset/blank.
const DEFAULT_BUSINESS_NAME = 'Stickballman12 LLC';
export async function getBusinessName() {
  try {
    const raw = await getSetting('business_display_name');
    const s = String(raw ?? '').trim();
    return s || DEFAULT_BUSINESS_NAME;
  } catch { return DEFAULT_BUSINESS_NAME; }
}

// Ship-to: where suppliers send their boxes. Shown in the supplier portal and printed
// as the SHIP TO block on the manifest, so a box separated from its paperwork can still
// be addressed. Stored as app_settings keys (admin-editable in Settings); the defaults
// below are the live address, so it's correct with nothing configured.
const DEFAULT_SHIP_TO = {
  name: 'Alex Tornabe',
  street: '1828 Shumaker Rd',
  city: 'Manheim',
  state: 'PA',
  zip: '17545',
  phone: '(717) 368-3333',
  email: 'alext@stickballman12llc.com',
};
export const SHIP_TO_FIELDS = Object.keys(DEFAULT_SHIP_TO);
export async function getShipTo() {
  const out = { ...DEFAULT_SHIP_TO };
  try {
    for (const f of SHIP_TO_FIELDS) {
      const raw = await getSetting(`ship_to_${f}`);
      // An explicitly BLANK saved value means "leave this line off" — only a missing key
      // falls back to the default, or clearing a line you don't want would keep undoing
      // itself on every read.
      if (raw != null) out[f] = String(raw).trim();
    }
  } catch { /* settings unreadable — the defaults are still a usable address */ }
  return out;
}
export async function setShipTo(patch, updatedBy) {
  for (const f of SHIP_TO_FIELDS) {
    if (patch[f] === undefined) continue;
    await setSetting(`ship_to_${f}`, String(patch[f] ?? '').trim().slice(0, 120), updatedBy);
  }
  return getShipTo();
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
      AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.id = items.batch_id AND b.kind = ANY(${PH_EXCLUDED_KINDS}))
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
      (buyer_name, supplier_name, tracking_number, no_tracking, date_received,
       default_cost, notes, special_rules, kind, origin, duplicate_of, po_id, status, created_by, committed_at)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.tracking || null}, ${h.noTracking === true},
       ${h.dateReceived || null}, ${h.defaultCost ?? null}, ${h.notes || null},
       ${h.specialRules || null}, ${['receiving', 'rescale', 'instore', 'existing'].includes(h.kind) ? h.kind : 'receiving'},
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
      (vin, batch_id, box_id, name, sku, size, upc, image_url, cost, source, status, with_box, goat_only, gender, colorway, notes, created_by)
    VALUES
      (coalesce(${it.vin || null},
        'SBM-' || to_char(coalesce(${dateReceived}::date, current_date), 'YYMMDD')
              || '-' || lpad(nextval('vin_seq')::text, 6, '0')),
       ${batchId}, ${it.boxId ?? null}, ${it.name || null}, ${it.sku || null}, ${it.size || null},
       ${it.upc || null}, ${it.image || null}, ${it.cost ?? null},
       ${it.source || 'manual'}, ${it.status || 'needs_shelf'}, ${it.withBox !== false}, ${it.goatOnly === true},
       ${it.gender || null}, ${it.colorway || null}, ${it.notes || null}, ${createdBy || null})
    RETURNING id, vin
  `);
  const results = await sql.transaction(queries);
  return results.map((r) => r[0]);
}

// Store the Alias-resolved indicator on freshly received items, and seed the
// final price (= value + 20%). Best-effort enrichment at intake; `updates` is
// [{ id, global_indicator, price, gi_basis, basis_label }] — `gi_basis` is the
// PRICE_HIERARCHY level that priced it and `basis_label` its human name, blank
// for the rank-1 consigned GI (`pricing.js`). Skips rows with a null value. Logs a
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
      + (u.basis_label ? ` (${u.basis_label})` : '')
      + ' (auto from Alias)';
    // INSERT … SELECT … WHERE EXISTS, not VALUES: enrichment is fire-and-forget
    // AFTER the commit responds, so a unit can be deleted (batch scrapped after a
    // mis-scan) while Alias is still answering. A plain VALUES insert then raises a
    // FK violation, and because every item shares ONE transaction that rolled back
    // the whole batch's GI — the other units silently lost their price with only a
    // console.warn to show for it. The guard makes a vanished unit a no-op, which
    // matches the UPDATE above (it already no-ops on a missing id).
    queries.push(sql`
      INSERT INTO item_events (item_id, type, details, created_by)
      SELECT ${u.id}::bigint, 'ph_update', ${JSON.stringify({ text, system: true })}::jsonb, NULL
      WHERE EXISTS (SELECT 1 FROM items WHERE id = ${u.id})
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
      + (u.basis_label ? ` (${u.basis_label})` : '')
      + ' (re-fetched from Alias)';
    // Guarded insert for the same reason as setItemGlobalIndicators: a unit deleted
    // between getItemsForGiRefresh and this write would FK-violate and roll back the
    // ENTIRE refresh, so one stale VIN could silently undo a whole range's re-pricing.
    queries.push(sql`
      INSERT INTO item_events (item_id, type, details, created_by)
      SELECT ${u.id}::bigint, 'ph_update', ${JSON.stringify({ text, system: true })}::jsonb, NULL
      WHERE EXISTS (SELECT 1 FROM items WHERE id = ${u.id})
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
      AND (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))  -- in-store/existing bypass PH/GI pricing
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
  // 'existing' stock was never received — it was already on the shelves and already
  // listed. Give it its own event so the history doesn't claim a delivery that never
  // happened ("Counted into existing stock" vs "Received into inventory").
  const intakeType = kind === 'rescale' ? 'rescaled' : kind === 'existing' ? 'counted' : 'received';
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
  // Existing (old) stock is already live on II and the stores — that's the whole
  // premise of counting it in. Recording that up front keeps Inventory honest, and
  // doubles as a backstop: even if a PH query were ever to miss PH_EXCLUDED_KINDS,
  // these units read as fully synced and so can't inflate the pending badges.
  if (kind === 'existing') {
    queries.push(sql`
      UPDATE items SET added_to_intel_inv = true, synced_alias = true,
             synced_stockx = true, synced_shopify = true, updated_at = now()
      WHERE id = ANY(${itemIds})
    `);
  }
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
      (buyer_name, supplier_name, no_tracking, date_received, default_cost, notes, special_rules,
       kind, batch_tag, expected_boxes, po_id, status, created_by)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.noTracking === true}, ${h.dateReceived || null},
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

// Exact UPC / SKU lookup against OUR OWN stock — the Box Labels tool asks this
// before any third-party catalogue, because a pair we've already handled is the
// authoritative record (and the one the catalogue is least likely to know about:
// old stock, in-store buys, anything hand-entered). Newest first, and never more
// than a screenful. Returns the raw units; the caller folds them into a product.
export async function findStockByCode(code, limit = 25) {
  const raw = String(code || '').trim();
  if (!raw) return [];
  const lim = Math.min(100, Math.max(1, Number(limit) || 25));
  // UPC only if the code is digits END TO END — deriving it from "digits found
  // anywhere" would read a SKU like "MQA-NOBOX-1785906559725" as a 13-digit UPC.
  const bare = raw.replace(/\s/g, '');
  const upc = /^\d{8,14}$/.test(bare) ? bare : null;
  // A SKU is written both "DQ8426-109" and "DQ8426 109" depending on the source;
  // compare with spaces and dashes stripped so either form matches either form.
  const sku = upc ? null : raw.toUpperCase().replace(/[\s-]/g, '');
  if (upc) {
    return await db()`
      SELECT i.vin, i.name, i.sku, i.size, i.upc, i.colorway, i.gender, i.status,
             i.with_box, i.location_code, i.created_at
        FROM items i
       WHERE regexp_replace(coalesce(i.upc, ''), '\\D', '', 'g') = ${upc}
       ORDER BY i.created_at DESC, i.vin DESC
       LIMIT ${lim}`;
  }
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.upc, i.colorway, i.gender, i.status,
           i.with_box, i.location_code, i.created_at
      FROM items i
     WHERE upper(replace(replace(coalesce(i.sku, ''), ' ', ''), '-', '')) = ${sku}
     ORDER BY i.created_at DESC, i.vin DESC
     LIMIT ${lim}`;
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
             i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify, i.goat_only, i.listed_price,
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
        AND (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))  -- in-store/existing bypass PH entirely
        AND (${from}::date IS NULL OR (coalesce(ev.created_at, i.updated_at) AT TIME ZONE 'America/New_York')::date >= ${from}::date)
        AND (${to}::date   IS NULL OR (coalesce(ev.created_at, i.updated_at) AT TIME ZONE 'America/New_York')::date <= ${to}::date)
      ORDER BY created_at DESC, i.id
      LIMIT 5000
    `;
  }
  return await db()`
    SELECT i.vin, i.created_at, i.created_by, i.name, i.sku, i.size, i.gender,
           i.status, i.cost, i.price, i.global_indicator, i.gi_basis,
           i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify, i.goat_only, i.listed_price,
           i.ph_note, i.first_edit_by, i.first_edit_at, i.last_edit_by, i.last_edit_at,
           (SELECT count(*)::int FROM product_photos p WHERE p.sku = i.sku) AS photo_count,
           (SELECT p.url FROM product_photos p WHERE p.sku = i.sku AND p.angle IN ('side','diagonal','outsole','top','rear')
              ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2 WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, (p.source = 'ph_edited') DESC, p.created_at LIMIT 1) AS photo_url
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE (${from}::date IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
      -- In-store buys and existing (old) stock never enter the PH team's world
      -- (New Inventory OR the admin Report): in-store is listed to Alias by hand
      -- off the In-Store Listing page, and existing stock was already synced to II
      -- and the stores before this system existed.
      AND (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))
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
      count(*) FILTER (WHERE listable AND ph_managed AND NOT added_to_intel_inv)::int AS not_ii,
      count(*) FILTER (WHERE listable AND ph_managed AND NOT synced_alias)::int       AS not_alias,
      count(*) FILTER (WHERE listable AND ph_managed AND NOT goat_only AND NOT synced_stockx)::int  AS not_stockx,
      count(*) FILTER (WHERE listable AND ph_managed AND NOT goat_only AND NOT synced_shopify)::int AS not_shopify,
      count(*) FILTER (WHERE status = 'needs_shelf')::int              AS needs_shelf,
      count(*) FILTER (WHERE status = 'no_box')::int                   AS no_box,
      count(*) FILTER (WHERE restock_pending)::int                     AS restock_pending,
      -- Sold but not yet handed to the carrier — the scan-out backlog. This is the
      -- only real "still to ship" queue we have: sold and shipped are both terminal,
      -- and sold→shipped is the one transition Mark Shipped performs.
      count(*) FILTER (WHERE status = 'sold')::int                     AS awaiting_shipment,
      -- In-store pairs still needing manual store listing (sellable, not fully ticked).
      -- Keyed on is_instore, NOT on "NOT ph_managed": that flag now also covers
      -- existing (old) stock, which would otherwise pour into Brent's In-Store
      -- Listing worklist for pairs that were listed years ago.
      count(*) FILTER (WHERE is_instore AND status NOT IN ('sold','shipped','missing','issue','no_box')
        AND NOT (instore_listed_alias AND instore_listed_stockx AND instore_listed_shopify))::int AS instore_unlisted,
      (SELECT count(*) FROM rescale_requests WHERE status = 'open')::int     AS rescale_requests,
      (SELECT count(*) FROM rescale_requests WHERE status = 'audited')::int  AS rescale_requests_audited,
      -- POs that genuinely need a human on the reconcile screen. Intake must be FINISHED
      -- (batch committed) — a PO still being scanned in isn't a chore yet, and counting it
      -- lit the badge for orders nobody could act on. Clean+finished POs auto-reconcile
      -- themselves (autoReconcileIfClean), so what's left here really is discrepancies,
      -- blind receipts, and orders with labels still out.
      (SELECT count(*) FROM purchase_orders p
         JOIN batches b ON b.id = p.received_batch_id
        WHERE p.status = 'receiving' AND b.status = 'committed')::int  AS po_to_reconcile,
      -- The other half: arrived but intake is still open, so it's in-flight rather than a
      -- chore. Counted separately (neutral badge) instead of folded into the amber one —
      -- Home still shows that something is happening, without crying wolf.
      (SELECT count(*) FROM purchase_orders p
         LEFT JOIN batches b ON b.id = p.received_batch_id
        WHERE p.status = 'receiving' AND b.status IS DISTINCT FROM 'committed')::int AS po_receiving
    FROM (
      -- ph_managed gates the PH store-sync badges only: in-store buys and existing
      -- (old) stock bypass PH, so they must NOT inflate not_ii/alias/stockx/shopify.
      -- needs_shelf / no_box still include them — warehouse shelves & resolves those
      -- pairs. is_instore is kept separate because the In-Store Listing badge below
      -- means specifically in-store, not "everything PH ignores".
      SELECT it.*,
             (it.with_box AND it.status NOT IN ('sold','shipped','missing','issue','no_box')) AS listable,
             (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS})) AS ph_managed,
             (b.kind = 'instore') AS is_instore
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

export async function getLocationById(id) {
  const rows = await db()`SELECT * FROM locations WHERE id = ${id} LIMIT 1`;
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

// Structural edit — move/renumber a shelf (site, area, bay, shelf #) and/or rename it.
// The scannable `code` is DERIVED from those parts, so the caller rebuilds it and passes
// it in. Two things have to move with it in one transaction:
//   • `items.location_code` — a denormalized snapshot with no FK. Leave it behind and
//     every unit on the shelf points at a barcode that no longer resolves.
//   • nothing else references a location by code (put-away looks it up live).
// The printed shelf label carries the OLD code, so the caller warns to reprint.
// Throws on a code collision (locations.code is UNIQUE) — the endpoint maps that to 409.
export async function moveLocation(id, next) {
  const sql = db();
  const res = await sql.transaction([
    sql`
      UPDATE locations SET
        code = ${next.code}, warehouse = ${next.warehouse}, area = ${next.area ?? null},
        bay = ${next.bay}, shelf = ${next.shelf ?? null}, label = ${next.label ?? null},
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `,
    sql`UPDATE items SET location_code = ${next.code} WHERE location_id = ${id}`,
  ]);
  return res[0]?.[0] || null;
}

// Every shelf under ONE node of the Locations tree — a site, an area, a derived row, or a
// bay — selected by however much of the path is pinned. `area` is nullable and NULL is a real
// folder ("(no area)"), not "any area", so it's matched through coalesce rather than `=`.
// `bayPrefix` mirrors the UI's derived Row level (bayRowKey); the SQL repeats that rule
// rather than importing it, so keep the two in step.
export async function listLocationGroup({ warehouse, area, bay, bayPrefix } = {}) {
  const hasArea = area !== undefined;
  const hasBay = bay !== undefined;
  const hasPrefix = bayPrefix !== undefined;
  return await db()`
    SELECT * FROM locations
    WHERE warehouse = ${warehouse}
      AND (${!hasArea}::bool   OR coalesce(area, '') = coalesce(${hasArea ? (area ?? null) : null}, ''))
      AND (${!hasBay}::bool    OR bay = ${hasBay ? bay : null})
      AND (${!hasPrefix}::bool OR upper(coalesce(substring(bay from '^[A-Za-z]+'), bay)) = upper(${hasPrefix ? bayPrefix : null}))
    ORDER BY sort_order NULLS LAST, code
  `;
}

// Shelves OUTSIDE the group whose code one of the new codes would collide with. Checked up
// front so a bulk rename fails with "B2-04 is already taken" instead of a raw unique-violation
// halfway through.
export async function findLocationCodeConflicts(codes, excludeIds = []) {
  if (!codes.length) return [];
  return await db()`
    SELECT id, code, label FROM locations
    WHERE code = ANY(${codes}::text[]) AND NOT (id = ANY(${excludeIds.map(Number)}::bigint[]))
  `;
}

// Live (unsold) pairs sitting anywhere in a set of shelves — the "this will need relabelling"
// number on the confirm.
export async function countLiveItemsAt(ids = []) {
  if (!ids.length) return 0;
  const rows = await db()`
    SELECT count(*)::int AS n FROM items
    WHERE location_id = ANY(${ids.map(Number)}::bigint[]) AND status NOT IN ('sold','shipped')`;
  return rows[0]?.n || 0;
}

// Apply a computed set of moves — a whole subtree's new identity — in ONE transaction.
// `moves`: [{ id, warehouse, area, bay, code, label }].
//
// Codes are written in TWO passes, and that isn't defensive padding: `locations.code` is a
// plain (non-deferrable) UNIQUE, so Postgres checks it per statement. Any rename that shifts
// or swaps within the group — bay A1→A2 while A2→A3, the single most likely renumbering —
// would collide against a row that is itself about to move. Parking every affected row on a
// throwaway code first removes the ordering problem entirely. `~` can't occur in a real code
// (normalizeLocationCode allows only A-Z 0-9 and dashes), so the temporaries can't clash with
// a shelf that isn't moving.
export async function applyLocationMoves(moves = []) {
  if (!moves.length) return 0;
  const sql = db();
  const queries = [
    ...moves.map((m) => sql`UPDATE locations SET code = ${`~mv~${m.id}`} WHERE id = ${m.id}`),
    ...moves.flatMap((m) => [
      sql`
        UPDATE locations SET
          code = ${m.code}, warehouse = ${m.warehouse}, area = ${m.area ?? null},
          bay = ${m.bay}, label = ${m.label ?? null}, updated_at = now()
        WHERE id = ${m.id}`,
      // The denormalized snapshot has no FK — leave it behind and every unit on the shelf
      // points at a barcode that no longer resolves.
      sql`UPDATE items SET location_code = ${m.code} WHERE location_id = ${m.id}`,
    ]),
  ];
  await sql.transaction(queries);
  return moves.length;
}

// Hard-delete a shelf. `items.location_id` is a real FK with no ON DELETE rule, so
// Postgres would raise a constraint error on any referencing row — this checks first and
// hands back a usable reason instead of a 500. Live stock BLOCKS the delete (move it or
// just deactivate the shelf); sold/shipped units are detached, because holding a closed
// unit's FK hostage would make an old shelf permanently undeletable. Their
// `location_code` text is kept as a historical breadcrumb, and the `shelved` item_event
// records where the pair sat regardless.
export async function deleteLocation(id) {
  const sql = db();
  const loc = (await sql`SELECT * FROM locations WHERE id = ${id}`)[0];
  if (!loc) return { deleted: false, notFound: true };
  const counts = (await sql`
    SELECT (count(*) FILTER (WHERE status NOT IN ('sold','shipped')))::int AS live,
           count(*)::int AS total
    FROM items WHERE location_id = ${id}
  `)[0] || { live: 0, total: 0 };
  if (counts.live > 0) return { deleted: false, live: counts.live, location: loc };
  await sql.transaction([
    sql`UPDATE items SET location_id = NULL WHERE location_id = ${id}`,
    sql`DELETE FROM locations WHERE id = ${id}`,
  ]);
  return { deleted: true, location: loc, detached: counts.total };
}

// Hard-delete a WHOLE NODE of the tree — every shelf under a site / area / row / bay — in
// one transaction. Same rule as the single-shelf delete, applied to the set: live stock
// ANYWHERE beneath BLOCKS the whole thing (nothing is deleted — a half-deleted rack is worse
// than a refusal), while sold/shipped units are detached so an old, long-closed rack isn't
// permanently undeletable. `dryRun` runs the counts only, so the confirm can state exactly
// what it's about to do.
export async function deleteLocationGroup(ids = [], { dryRun = false } = {}) {
  const list = [...new Set(ids.map(Number).filter(Boolean))];
  if (!list.length) return { deleted: 0, live: 0, detached: 0 };
  const sql = db();
  const counts = (await sql`
    SELECT (count(*) FILTER (WHERE status NOT IN ('sold','shipped')))::int AS live,
           count(*)::int AS total
    FROM items WHERE location_id = ANY(${list}::bigint[])
  `)[0] || { live: 0, total: 0 };
  const detached = counts.total - counts.live;
  if (counts.live > 0) return { deleted: 0, live: counts.live, detached, blocked: true };
  if (dryRun) return { deleted: 0, live: 0, detached, dryRun: true };
  await sql.transaction([
    sql`UPDATE items SET location_id = NULL WHERE location_id = ANY(${list}::bigint[])`,
    sql`DELETE FROM locations WHERE id = ANY(${list}::bigint[])`,
  ]);
  return { deleted: list.length, live: 0, detached };
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
           b.kind,  -- so the shelf view can flag existing/in-store stock as it's pulled
           COALESCE(
             (SELECT p.url FROM product_photos p WHERE p.sku = i.sku AND p.angle IN ('side','diagonal','outsole','top','rear')
                ORDER BY CASE p.angle WHEN 'side' THEN 0 WHEN 'diagonal' THEN 1 WHEN 'top' THEN 2
                                      WHEN 'outsole' THEN 3 WHEN 'rear' THEN 4 ELSE 5 END, (p.source = 'ph_edited') DESC, p.created_at LIMIT 1),
             NULLIF(i.image_url, '')
           ) AS photo_url
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
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
// Set a unit's UPC (from the No Box box-label flow, when a warehouse finds/enters
// the missing UPC). Applies to the single VIN so its box label scans normally.
export async function setItemUpc(itemId, upc) {
  const sql = db();
  await sql`UPDATE items SET upc = ${upc}, updated_at = now() WHERE id = ${itemId}`;
}

// Toggle "GOAT only" (list to Alias/GOAT + II only) across a set of units — used
// from Receiving (whole shoe) and the PH grid (a SKU group).
export async function setItemsGoatOnly(vins, goatOnly) {
  const list = (vins || []).filter(Boolean);
  if (!list.length) return [];
  return await db()`UPDATE items SET goat_only = ${!!goatOnly}, updated_at = now() WHERE vin = ANY(${list}) RETURNING vin, goat_only`;
}

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
    WHERE i.vin = ANY(${allVins}) AND (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))
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
  const carrierKeys = labels.map((l) => (Number.isInteger(Number(l.carrierKey)) && Number(l.carrierKey) > 0 ? Number(l.carrierKey) : null));
  const rows = await sql`
    WITH po AS (
      INSERT INTO purchase_orders
        (supplier_name, supplier_user_id, tag_code, date_of_purchase, expected_boxes, notes, created_by)
      VALUES (${supplierName}, ${supplierUserId || null}, ${tagCode || null}, ${dateOfPurchase || null},
              ${labels.length}, ${notes || null}, ${createdBy || null})
      RETURNING id
    )
    INSERT INTO po_boxes (po_id, box_number, tracking_number, carrier_key, status, created_by)
    SELECT po.id, t.box_number, t.tracking_number, t.carrier_key, 'pending', ${createdBy || null}
    FROM po, unnest(${boxNumbers}::int[], ${trackings}::text[], ${carrierKeys}::int[]) AS t(box_number, tracking_number, carrier_key)
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
  // entered_by_name = the staff member who entered/last-edited an on-behalf line, for
  // the INTERNAL views (warehouse/PH). get.js strips it before responding to a supplier.
  const lines = await sql`
    SELECT l.*, u.name AS entered_by_name, u.username AS entered_by_username
    FROM po_lines l
    LEFT JOIN users u ON u.id = l.entered_by
    WHERE l.po_id = ${id}
    ORDER BY l.po_box_id, l.sku, l.size
  `;
  // Receiving batches attached to this order (usually exactly one). The PO screen shows
  // what the order is actually counting, and can unlink one attached in error.
  const batches = await sql`
    SELECT b.id, b.batch_code, b.status, b.created_at, b.supplier_name, b.date_received,
           (SELECT count(*) FROM items i WHERE i.batch_id = b.id)::int AS units
    FROM batches b WHERE b.po_id = ${id} ORDER BY b.id`;
  return { po, boxes, lines, batches };
}

// List POs with roll-up counts. Supplier sees only their own; everyone else all.
// (The shim can't nest sql fragments, so branch the whole statement.)
// "x of y labels shipped" describes the SUPPLIER'S packing job, so a replacement label —
// which the warehouse created, not them — must not land in these counts. Otherwise a
// supplier who shipped everything they were asked to suddenly reads "2 of 3".
export async function listPos({ uid, supplierScope }) {
  const sql = db();
  if (supplierScope) {
    return sql`
      SELECT p.*,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement')::int AS box_count,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement' AND b.status <> 'pending')::int AS shipped_count,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind = 'replacement')::int AS replacement_count,
        (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l
           LEFT JOIN po_boxes lb ON lb.id = l.po_box_id
           WHERE l.po_id = p.id AND coalesce(lb.kind, 'original') <> 'replacement')::int AS unit_count
      FROM purchase_orders p
      WHERE p.supplier_user_id = ${uid}
      ORDER BY p.created_at DESC
    `;
  }
  return sql`
    SELECT p.*,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement')::int AS box_count,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement' AND b.status <> 'pending')::int AS shipped_count,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.status = 'delivered')::int AS delivered_count,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind = 'replacement')::int AS replacement_count,
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l
         LEFT JOIN po_boxes lb ON lb.id = l.po_box_id
         WHERE l.po_id = p.id AND coalesce(lb.kind, 'original') <> 'replacement')::int AS unit_count,
      -- What WE counted, across every batch linked to the order. unit_count above is
      -- what the SUPPLIER declared, and on an order received with no manifest that is
      -- legitimately 0 - a row reading "0 units" beside 48 pairs on the shelf reads as
      -- "nothing here" instead of "nothing declared". Staff-only: a supplier must not
      -- read our count off a list before the reconciliation is settled with them.
      -- (No backticks in here: this comment lives inside a JS template literal.)
      (SELECT count(*) FROM items i JOIN batches b ON b.id = i.batch_id
         WHERE b.po_id = p.id)::int AS received_units
    FROM purchase_orders p
    ORDER BY p.created_at DESC
  `;
}

// Add/increment an expected line under a label. Re-scanning a SKU+size in the
// same label bumps qty_expected (mirrors receiving's per-size auto-increment).
// enteredBy/enteredOnBehalf record who typed it — NULL/false for a supplier scanning
// their own manifest, the staff uid + true when PH/admin enters it on their behalf.
// Both insert and the re-scan UPDATE stamp the latest actor (last-editor semantics).
export async function addPoScan({ poId, poBoxId, sku, size, qty, name, upc, colorway, gender, unitCost, tip, enteredBy = null, enteredOnBehalf = false }) {
  const sql = db();
  const rows = await sql`
    INSERT INTO po_lines (po_id, po_box_id, sku, size, name, upc, colorway, gender, qty_expected, unit_cost, tip, entered_by, entered_on_behalf)
    VALUES (${poId}, ${poBoxId}, ${sku}, ${size}, ${name || null}, ${upc || null},
            ${colorway || null}, ${gender || null}, ${qty}, ${unitCost ?? null}, ${tip ?? null},
            ${enteredBy ?? null}, ${!!enteredOnBehalf})
    ON CONFLICT (po_box_id, sku, size) DO UPDATE
      SET qty_expected      = po_lines.qty_expected + EXCLUDED.qty_expected,
          -- A re-scan that carries no money must never wipe money already declared.
          unit_cost         = COALESCE(EXCLUDED.unit_cost, po_lines.unit_cost),
          tip               = COALESCE(EXCLUDED.tip, po_lines.tip),
          name              = COALESCE(EXCLUDED.name, po_lines.name),
          entered_by        = EXCLUDED.entered_by,
          entered_on_behalf = EXCLUDED.entered_on_behalf,
          updated_at        = now()
    RETURNING *
  `;
  return rows[0];
}

// Whole-order manifest (Path C): add/increment a line against the PO itself (no label).
// Conflict target is the partial unique index on (po_id, sku, size) WHERE po_box_id IS NULL.
export async function addPoOrderScan({ poId, sku, size, qty, name, upc, colorway, gender, unitCost, tip, enteredBy = null, enteredOnBehalf = false }) {
  const sql = db();
  const rows = await sql`
    INSERT INTO po_lines (po_id, po_box_id, sku, size, name, upc, colorway, gender, qty_expected, unit_cost, tip, entered_by, entered_on_behalf)
    VALUES (${poId}, NULL, ${sku}, ${size}, ${name || null}, ${upc || null},
            ${colorway || null}, ${gender || null}, ${qty}, ${unitCost ?? null}, ${tip ?? null},
            ${enteredBy ?? null}, ${!!enteredOnBehalf})
    ON CONFLICT (po_id, sku, size) WHERE po_box_id IS NULL DO UPDATE
      SET qty_expected      = po_lines.qty_expected + EXCLUDED.qty_expected,
          unit_cost         = COALESCE(EXCLUDED.unit_cost, po_lines.unit_cost),
          tip               = COALESCE(EXCLUDED.tip, po_lines.tip),
          name              = COALESCE(EXCLUDED.name, po_lines.name),
          entered_by        = EXCLUDED.entered_by,
          entered_on_behalf = EXCLUDED.entered_on_behalf,
          updated_at        = now()
    RETURNING *
  `;
  return rows[0];
}

// Does this PO already have any per-box manifest lines? Used to keep a PO to a single
// manifest scope — you can't mix a per-box manifest and a whole-order one.
export async function poHasBoxLines(poId) {
  const sql = db();
  const r = await sql`SELECT 1 FROM po_lines WHERE po_id = ${poId} AND po_box_id IS NOT NULL LIMIT 1`;
  return r.length > 0;
}

export async function setPoManifestScope(poId, scope) {
  const sql = db();
  await sql`UPDATE purchase_orders SET manifest_scope = ${scope} WHERE id = ${poId}`;
}

export async function setPoLineQty(lineId, qtyExpected) {
  const sql = db();
  if (qtyExpected <= 0) { await sql`DELETE FROM po_lines WHERE id = ${lineId}`; return null; }
  return (await sql`
    UPDATE po_lines SET qty_expected = ${qtyExpected}, updated_at = now()
    WHERE id = ${lineId} RETURNING *
  `)[0] || null;
}

// Edit an expected line's size and/or qty (supplier fixing a scan). `size`/`qty`
// are each optional (undefined = leave as-is). qty <= 0 removes the line. Changing
// the size can collide with an existing line of the same SKU+size on the label
// (unique po_box_id,sku,size) — in that case the two are MERGED (qtys summed) and
// this line is deleted. Returns { line, removed, merged }.
export async function updatePoLine(lineId, { size, qty, unitCost, tip, enteredBy = null, enteredOnBehalf = false } = {}) {
  const sql = db();
  const line = (await sql`SELECT * FROM po_lines WHERE id = ${lineId}`)[0];
  if (!line) return { line: null, removed: false, merged: false };
  const newQty = qty === undefined ? line.qty_expected : qty;
  if (newQty <= 0) { await sql`DELETE FROM po_lines WHERE id = ${lineId}`; return { line: null, removed: true, merged: false }; }
  const newSize = size === undefined ? line.size : String(size).trim();
  // `undefined` = not editing that field; an explicit null CLEARS it (an emptied field
  // means "I don't know what this cost", which is not the same as $0).
  const newCost = unitCost === undefined ? line.unit_cost : (unitCost ?? null);
  const newTip = tip === undefined ? line.tip : (tip ?? null);
  if (newSize && newSize !== line.size) {
    // Find a sibling line that a size change would collide with. Order-scoped lines have
    // no box, so match them within the PO (po_box_id IS NULL); box lines match within the
    // label. (The shim can't nest sql fragments, so branch the whole query.)
    const sib = (line.po_box_id == null
      ? (await sql`
          SELECT * FROM po_lines
          WHERE po_id = ${line.po_id} AND po_box_id IS NULL AND sku = ${line.sku} AND size = ${newSize} AND id <> ${lineId}
        `)
      : (await sql`
          SELECT * FROM po_lines
          WHERE po_box_id = ${line.po_box_id} AND sku = ${line.sku} AND size = ${newSize} AND id <> ${lineId}
        `))[0];
    if (sib) {
      const mergedQty = Math.min(999, sib.qty_expected + newQty); // same 999 cap as a direct edit
      // The surviving row keeps money either way: the edited line's if it has any,
      // else the sibling's — merging must never silently blank a declared cost or tip.
      const mergedCost = newCost ?? sib.unit_cost ?? null;
      const mergedTip = newTip ?? sib.tip ?? null;
      const merged = (await sql`
        UPDATE po_lines SET qty_expected = ${mergedQty}, unit_cost = ${mergedCost}, tip = ${mergedTip},
          entered_by = ${enteredBy ?? null},
          entered_on_behalf = ${!!enteredOnBehalf}, updated_at = now()
        WHERE id = ${sib.id} RETURNING *
      `)[0];
      await sql`DELETE FROM po_lines WHERE id = ${lineId}`;
      return { line: merged, removed: false, merged: true };
    }
  }
  const updated = (await sql`
    UPDATE po_lines SET size = ${newSize}, qty_expected = ${newQty}, unit_cost = ${newCost}, tip = ${newTip},
      entered_by = ${enteredBy ?? null},
      entered_on_behalf = ${!!enteredOnBehalf}, updated_at = now()
    WHERE id = ${lineId} RETURNING *
  `)[0] || null;
  return { line: updated, removed: false, merged: false };
}

export async function deletePoLine(lineId) {
  const sql = db();
  await sql`DELETE FROM po_lines WHERE id = ${lineId}`;
}

// Mark one label shipped; if every label on the PO is now shipped, flip the PO
// to 'shipped'. Returns the updated box (or null if it wasn't pending).
// Close a box for shipment: 'pending' (filling) → 'packed' (reviewed, ready to ship).
export async function closePoBox(poBoxId) {
  const sql = db();
  return (await sql`
    UPDATE po_boxes SET status = 'packed', packed_at = now()
    WHERE id = ${poBoxId} AND status IN ('pending', 'pre_transit')
    RETURNING *
  `)[0] || null;
}

// Reopen a packed box to keep editing: 'packed' → 'pending'.
export async function reopenPoBox(poBoxId) {
  const sql = db();
  return (await sql`
    UPDATE po_boxes SET status = 'pending', packed_at = NULL
    WHERE id = ${poBoxId} AND status = 'packed'
    RETURNING *
  `)[0] || null;
}

export async function shipPoBox(poBoxId) {
  const sql = db();
  const box = (await sql`
    UPDATE po_boxes SET status = 'shipped', shipped_at = now()
    WHERE id = ${poBoxId} AND status = 'packed'
    RETURNING *
  `)[0];
  if (!box) return null;
  // The PO ships once no label is still open (pending) or merely packed — i.e. all shipped.
  await sql`
    UPDATE purchase_orders SET status = 'shipped', shipped_at = now()
    WHERE id = ${box.po_id} AND status = 'draft'
      AND NOT EXISTS (SELECT 1 FROM po_boxes WHERE po_id = ${box.po_id} AND status IN ('pending','packed'))
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
// Idempotent: keeps the first received_batch_id. Advances a draft/shipped PO to
// 'receiving' (a box can arrive before every label is marked shipped); never
// downgrades a reconciled/closed PO.
// WHAT WE ACTUALLY RECEIVED, BOX BY BOX — our own count, the mirror of the supplier's
// manifest. It's the evidence in a shortage conversation: "here is each box we opened,
// its tracking number, and what came out of it." Built from `items.box_id`, which
// receiving already sets per box, across EVERY batch linked to the PO (an order can be
// received in more than one — most obviously a replacement weeks later).
//
// Units with no box_id are real and must not vanish from the count: a single-box or
// pre-multi-box receive never set one. They're returned as a box-less group so the
// totals still add up, the same discipline the whole-order manifest page uses.
export async function getPoReceivedBoxes(poId) {
  const sql = db();
  const boxes = await sql`
    SELECT bx.id, bx.box_number, bx.tracking_number, bx.status, bx.received_at, bx.received_by,
           b.batch_code, b.id AS batch_id
    FROM batch_boxes bx
    JOIN batches b ON b.id = bx.batch_id
    WHERE b.po_id = ${poId}
    ORDER BY b.id, bx.box_number
  `;
  const rows = await sql`
    SELECT i.box_id, i.sku, i.size, max(i.name) AS name, count(*)::int AS qty
    FROM items i
    JOIN batches b ON b.id = i.batch_id
    WHERE b.po_id = ${poId}
    GROUP BY i.box_id, i.sku, i.size
    ORDER BY i.sku, i.size
  `;
  const byBox = new Map();
  for (const r of rows) {
    const k = r.box_id == null ? 'none' : String(r.box_id);
    if (!byBox.has(k)) byBox.set(k, []);
    byBox.get(k).push({ sku: r.sku, size: r.size, name: r.name, qty: r.qty });
  }
  const out = boxes.map((b) => {
    const items = byBox.get(String(b.id)) || [];
    return { ...b, items, units: items.reduce((n, i) => n + i.qty, 0) };
  });
  const loose = byBox.get('none') || [];
  if (loose.length) {
    out.push({
      id: null, box_number: null, tracking_number: null, status: 'received',
      received_at: null, received_by: null, batch_code: out[0]?.batch_code || null, batch_id: null,
      items: loose, units: loose.reduce((n, i) => n + i.qty, 0),
    });
  }
  return out;
}

export async function markPoReceiving(poId, batchId) {
  const sql = db();
  await sql`
    UPDATE purchase_orders
    SET status = CASE WHEN status IN ('draft', 'shipped') THEN 'receiving' ELSE status END,
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
  // "Expected" depends on the manifest scope:
  // - 'po' (whole-order manifest, Path C): count the ENTIRE order-level list. Those lines
  //   have no label, so there's no per-box "already shipped?" filter to apply — hence the
  //   explicit `po_box_id IS NULL`, which also keeps a replacement label's lines out.
  // - 'box' (per-box manifest, Paths A/B): count only the lines on labels that actually
  //   SHIPPED — a label still filling/packed hasn't left the supplier, so its contents
  //   aren't due yet and must NOT read as shortages against what arrived.
  //
  // EITHER WAY, a REPLACEMENT label's lines are excluded. A reship re-declares units that
  // the ORIGINAL manifest already expected and that are already counted short; counting
  // them again would inflate `expected` by exactly the shortage, so the order would read
  // short by that amount forever — even after the reship landed and `received` caught up.
  // The reship's manifest exists to tell the warehouse what to check off (and both sides
  // what was promised), never to move this arithmetic. See `docs/context/purchase-orders.md`.
  const expected = po.manifest_scope === 'po'
    ? await sql`
        SELECT l.sku, l.size, sum(l.qty_expected)::int AS qty, max(l.name) AS name
        FROM po_lines l
        WHERE l.po_id = ${poId} AND l.po_box_id IS NULL
        GROUP BY l.sku, l.size`
    : await sql`
        SELECT l.sku, l.size, sum(l.qty_expected)::int AS qty, max(l.name) AS name
        FROM po_lines l
        JOIN po_boxes b ON b.id = l.po_box_id
        WHERE l.po_id = ${poId} AND b.kind <> 'replacement'
          AND b.status IN ('shipped', 'in_transit', 'delivered')
        GROUP BY l.sku, l.size`;
  // Counted across EVERY batch linked to this PO, not just `received_batch_id`. An order
  // can be received in more than one batch — most obviously a replacement shipment that
  // arrives weeks later — and keying off the first batch alone silently undercounts the
  // later ones, which would read as a shortage that never clears.
  const received = await sql`
    SELECT i.sku, i.size, count(*)::int AS qty, max(i.name) AS name
    FROM items i
    JOIN batches b ON b.id = i.batch_id
    WHERE b.po_id = ${poId}
    GROUP BY i.sku, i.size`;

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
  // "No manifest" (Option 2): the PO was received but nothing was ever declared for the
  // shipped labels — the supplier didn't scan out and no one entered a manifest on their
  // behalf. Every received unit then reads as wrong_sku; flag it so the report says
  // "received blind" instead of presenting a wall of overages as discrepancies.
  summary.no_manifest = summary.expected_units === 0 && summary.received_units > 0;
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
  // `data` was read before the UPDATE, so patch both status AND reconciled_at onto
  // the returned PO — otherwise the immediate response's "Reconciled <date>" is blank.
  return { ...data, po: { ...data.po, status: 'reconciled', reconciled_at: snap.at } };
}

// Auto-close a PO whose intake came out perfectly clean, so a no-discrepancy order
// doesn't sit in the reconcile queue forever waiting on a button tap (PH can see that
// queue but can't clear it, and the supplier reads 'receiving' as still-outstanding).
// Deliberately conservative — anything ambiguous is left for a human:
//   • the PO is still 'receiving' (never touches draft/shipped/reconciled/closed)
//   • its receiving batch is committed — a multi-box batch mid-intake isn't done
//   • no label is still pending/packed at the supplier (more units are coming)
//   • a manifest existed, every expected unit arrived, and every line matched
// Returns the frozen snapshot when it closed the PO, else null. Callers fire-and-forget:
// a failure here just leaves the PO in the manual queue, which is the old behaviour.
// Where a received PO actually stands: the live comparison plus the two "is more
// still coming?" facts. Shared by the auto-close guard AND the list's status chip, so
// the badge can never claim something the auto-close logic disagrees with.
export async function getPoReconcileState(poId) {
  const sql = db();
  const data = await getPoReconciliation(poId);
  if (!data) return null;
  const { po } = data;
  // Intake is finished when the PO has at least one batch and NONE is still open. Keyed
  // off every linked batch, not just `received_batch_id`, for the same reason the received
  // count is — a later replacement batch must hold the order open until it's committed.
  const batches = await sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'open')::int AS open
    FROM batches WHERE po_id = ${poId}`;
  const unshipped = await sql`
    SELECT 1 FROM po_boxes WHERE po_id = ${poId} AND status IN ('pending', 'packed') LIMIT 1`;
  const b = batches[0] || { total: 0, open: 0 };
  return {
    ...data,                                     // { po, rows, summary }
    intakeDone: b.total > 0 && b.open === 0,     // receiving finished, not mid multi-box
    awaitingBoxes: unshipped.length > 0,         // a label is still sitting at the supplier
  };
}

export async function autoReconcileIfClean(poId) {
  const st = await getPoReconcileState(poId);
  if (!st || st.po.status !== 'receiving' || !st.po.received_batch_id) return null;
  if (!st.intakeDone || st.awaitingBoxes) return null;
  const s = st.summary;
  if (!s || !s.clean || s.no_manifest || s.expected_units === 0 || s.received_units !== s.expected_units) return null;
  const snap = await snapshotReconciliation(poId);
  if (snap) {
    console.log(`[auto-reconcile] PO ${poId} closed clean — ${s.received_units}/${s.expected_units} units, ${s.match} lines matched.`);
    // A reship that's been scanned in makes the order add up again, which IS the proof it
    // arrived — so the last resolution step ticks itself rather than asking someone to
    // confirm what the count already shows. Only for replacements: a refund's money
    // landing has nothing to do with the unit count.
    await settleReplacementIfArrived(poId).catch((e) =>
      console.warn('[auto-reconcile] replacement settle:', e.message));
  }
  return snap;
}

// Tick "Replacement received" once the order reconciles clean again. No-op unless the
// outcome is a replacement that's still outstanding.
async function settleReplacementIfArrived(poId) {
  const r = await getPoResolution(poId);
  if (!r || r.outcome !== 'replacement' || r.settled_at) return null;
  const fresh = await setResolutionStep({
    poId, step: 'settled', author: { name: null, id: null, role: 'system' },
  });
  await addPoComment({
    poId, kind: 'system',
    body: 'Replacement received — the order reconciles clean again.',
    author: { name: null, id: null, role: 'system' },
  }).catch(() => {});
  return fresh;
}

// Auto-close if we can; otherwise describe what's wrong so the caller can tell whoever
// just finished receiving, right there on the "batch saved" screen. That's the one moment
// the warehouse is guaranteed to be looking — a Home badge only works if they go back and
// notice, and a shortage needs someone to message the supplier today.
// Returns null when there's nothing to say (auto-closed, or intake isn't finished yet).
export async function reconcileOutcomeForIntake(poId) {
  if (await autoReconcileIfClean(poId)) return null;
  const st = await getPoReconcileState(poId);
  if (!st || st.po.status !== 'receiving' || !st.intakeDone) return null;
  const s = st.summary;
  if (!s) return null;
  const issues = s.shortage + s.overage + s.wrong_size + s.wrong_sku;
  if (!issues && !s.no_manifest) return null;   // clean but a label is still out — not news
  return {
    poId: Number(st.po.id), poCode: st.po.po_code, supplierName: st.po.supplier_name,
    issues, shortage: s.shortage, overage: s.overage, wrongSize: s.wrong_size,
    wrongSku: s.wrong_sku, noManifest: s.no_manifest,
    expectedUnits: s.expected_units, receivedUnits: s.received_units,
  };
}

// POs that have been received and are awaiting / have a reconciliation. Explicit column
// list on purpose: `p.*` dragged the whole `reconciliation` snapshot (every row of every
// closed PO) into a list that only needs its summary.
export async function listReconcilePos() {
  const sql = db();
  return sql`
    SELECT p.id, p.po_code, p.status, p.supplier_name, p.tag_code, p.manifest_scope,
      p.reconciled_at, p.created_at, p.reconciliation->'summary' AS snapshot_summary,
      p.reconcile_note, p.reconcile_note_by, p.reconcile_note_at,
      p.resolution_state, p.comment_count,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id)::int AS box_count,
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count
    FROM purchase_orders p
    WHERE p.status IN ('receiving', 'reconciled')
    ORDER BY (p.status = 'receiving') DESC, p.reconciled_at DESC NULLS LAST, p.created_at DESC`;
}

/* ---- Phase 4: shipment tracking (17TRACK) ---------------------------------- */

// Tracking numbers for a PO's labels (to register / poll with the aggregator).
// Tracked items for a PO — { number, carrier } (carrier = the chosen 17TRACK key) so a
// refresh can query each label against the correct courier.
export async function listPoTrackingItems(poId) {
  const sql = db();
  const rows = await sql`SELECT tracking_number, carrier_key FROM po_boxes WHERE po_id = ${poId} AND tracking_number IS NOT NULL`;
  return rows.map((r) => ({ number: r.tracking_number, carrier: r.carrier_key }));
}

// Apply an aggregator status update to the label with this tracking number.
// Advances box status only when the mapper gave one, and only FORWARD — a lower-ranked
// push (e.g. a late "InfoReceived" arriving after the box already moved, or once a
// supplier has marked it shipped) never moves the box backwards. Never downgrades to null.
// Returns the affected { id, po_id } rows.
const BOX_STATUS_RANK = { pending: 0, packed: 1, pre_transit: 2, shipped: 3, in_transit: 4, delivered: 5 };
export async function setPoBoxTracking(trackingNumber, { carrier, trackingStatus, subStatus, subStatusDescr, lastCheckpoint, boxStatus, events }) {
  const sql = db();
  const eventsJson = Array.isArray(events) && events.length ? JSON.stringify(events) : null;
  const newRank = boxStatus != null ? BOX_STATUS_RANK[boxStatus] : undefined;
  // Sub-status is tied to the status it came with, NOT COALESCEd like the other fields.
  // It describes the CURRENT state, so a parcel that clears customs and goes back to plain
  // "InTransit" must lose its old sub-status — COALESCE would leave "Held — security"
  // showing on a box that's moving fine. `hasStatus` gates the whole pair: an update that
  // carries no status at all (a bare checkpoint ping) leaves both alone.
  const hasStatus = trackingStatus != null;
  if (boxStatus && newRank != null) {
    return sql`
      UPDATE po_boxes
      SET carrier = COALESCE(${carrier ?? null}, carrier),
          tracking_status = COALESCE(${trackingStatus ?? null}, tracking_status),
          tracking_sub_status = CASE WHEN ${hasStatus} THEN ${subStatus ?? null} ELSE tracking_sub_status END,
          tracking_sub_status_descr = CASE WHEN ${hasStatus} THEN ${subStatusDescr ?? null} ELSE tracking_sub_status_descr END,
          last_checkpoint = COALESCE(${lastCheckpoint ?? null}, last_checkpoint),
          tracking_events = COALESCE(${eventsJson}::jsonb, tracking_events),
          checked_at = now(),
          status = CASE WHEN (CASE status
              WHEN 'pending' THEN 0 WHEN 'packed' THEN 1 WHEN 'pre_transit' THEN 2
              WHEN 'shipped' THEN 3 WHEN 'in_transit' THEN 4 WHEN 'delivered' THEN 5 ELSE 0 END) < ${newRank}
            THEN ${boxStatus} ELSE status END
      WHERE upper(tracking_number) = upper(${trackingNumber})
      RETURNING id, po_id`;
  }
  return sql`
    UPDATE po_boxes
    SET carrier = COALESCE(${carrier ?? null}, carrier),
        tracking_status = COALESCE(${trackingStatus ?? null}, tracking_status),
        tracking_sub_status = CASE WHEN ${hasStatus} THEN ${subStatus ?? null} ELSE tracking_sub_status END,
        tracking_sub_status_descr = CASE WHEN ${hasStatus} THEN ${subStatusDescr ?? null} ELSE tracking_sub_status_descr END,
        last_checkpoint = COALESCE(${lastCheckpoint ?? null}, last_checkpoint),
        tracking_events = COALESCE(${eventsJson}::jsonb, tracking_events),
        checked_at = now()
    WHERE upper(tracking_number) = upper(${trackingNumber})
    RETURNING id, po_id`;
}

// Roll the PO forward off 'draft' (Filling) once tracking shows every label has LEFT the
// supplier (shipped / in transit / delivered). Mirrors shipPoBox's rollup, but driven by
// tracking instead of the in-app "ship" tap — a supplier who just drops the boxes at UPS
// never taps ship, so without this the PO sat on "Filling" even after all labels delivered.
// Only advances when there IS at least one box and NONE is still pending/packed/pre_transit.
export async function rollupPoShippedFromTracking(poId) {
  const rows = await db()`
    UPDATE purchase_orders
    SET status = 'shipped', shipped_at = COALESCE(shipped_at, now())
    WHERE id = ${poId} AND status = 'draft'
      AND EXISTS (SELECT 1 FROM po_boxes WHERE po_id = ${poId})
      AND NOT EXISTS (
        SELECT 1 FROM po_boxes
        WHERE po_id = ${poId} AND status NOT IN ('shipped','in_transit','delivered')
      )
    RETURNING id, status`;
  return rows[0] || null;
}

// The reconciliation note — one editable free-text field per PO ("supplier says the short
// pair ships Thursday", "credited on the next invoice"). Writable at any status, including
// after the PO is reconciled or archived: the outcome often lands days after the count did.
// Empty/blank clears it (note + byline + timestamp all go NULL together).
export const RECONCILE_NOTE_MAX = 2000;
export async function setPoReconcileNote(poId, note, byName) {
  const sql = db();
  const text = String(note ?? '').trim().slice(0, RECONCILE_NOTE_MAX) || null;
  const rows = await sql`
    UPDATE purchase_orders
    SET reconcile_note = ${text},
        reconcile_note_by = ${text ? (byName || null) : null},
        reconcile_note_at = ${text ? new Date().toISOString() : null}
    WHERE id = ${poId}
    RETURNING id, po_code, reconcile_note, reconcile_note_by, reconcile_note_at`;
  return rows[0] || null;
}

/* ---- Discrepancy resolution: the four steps + the internal thread ------------
   State (po_resolutions, one row) and log (po_comments, append-only) are separate on
   purpose — see scripts/db-setup.mjs. Every step write also posts a system comment, so
   the thread doubles as the audit trail and there's no third table to keep in step. */

export const COMMENT_MAX = 2000;
export const RESOLUTION_STEPS = ['contacted', 'outcome', 'reference', 'settled'];
export const RESOLUTION_OUTCOMES = ['refund', 'replacement', 'writeoff'];

// Which steps are actually live for an outcome. A write-off has nothing to chase, so it
// skips the reference step entirely — the UI must not show a box that can never be ticked.
export function stepsFor(outcome) {
  if (outcome === 'writeoff') return ['contacted', 'outcome', 'settled'];
  return RESOLUTION_STEPS;
}

const stepDone = (r, step) => {
  if (!r) return false;
  if (step === 'contacted') return !!r.contacted_at;
  if (step === 'outcome') return !!r.outcome_at && !!r.outcome;
  if (step === 'reference') return !!r.ref_at;
  if (step === 'settled') return !!r.settled_at;
  return false;
};

// 'none' (nothing started) | 'open' (started, not settled) | 'settled'. Mirrored onto
// purchase_orders so the list can chip an order without touching this table.
function resolutionStateOf(r) {
  if (!r) return 'none';
  if (r.settled_at) return 'settled';
  if (r.contacted_at || r.outcome_at || r.ref_at) return 'open';
  return 'none';
}

export async function getPoResolution(poId) {
  const sql = db();
  return (await sql`SELECT * FROM po_resolutions WHERE po_id = ${poId}`)[0] || null;
}

// Latest-first, capped. The thread is read only when an order is opened, never in a list.
export async function listPoComments(poId, { limit = 50, before = null } = {}) {
  const sql = db();
  const rows = before
    ? await sql`
        SELECT * FROM po_comments
        WHERE po_id = ${poId} AND created_at < ${before}
        ORDER BY created_at DESC LIMIT ${limit}`
    : await sql`
        SELECT * FROM po_comments
        WHERE po_id = ${poId}
        ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.reverse(); // hand back oldest-first for rendering
}

// Append one entry and keep the PO's denormalised counters in step, in the same request.
export async function addPoComment({ poId, body, kind = 'note', audience = 'internal', author }) {
  const sql = db();
  const text = String(body ?? '').trim().slice(0, COMMENT_MAX);
  if (!text) return null;
  const rows = await sql`
    INSERT INTO po_comments (po_id, kind, audience, body, author_id, author_name, author_role)
    VALUES (${poId}, ${kind}, ${audience}, ${text},
            ${author?.id ?? null}, ${author?.name || null}, ${author?.role || null})
    RETURNING *`;
  await sql`
    UPDATE purchase_orders
    SET comment_count = comment_count + 1, last_comment_at = now()
    WHERE id = ${poId}`;
  return rows[0];
}

// Tick, untick, or fill in one step. Returns the fresh resolution row.
// `undo` is first-class: a refund that never lands has to be re-openable, so nothing here
// is write-once. Each call posts its own system line to the thread.
export async function setResolutionStep({ poId, step, undo = false, outcome = null, value = null, amount = null, boxId = null, author }) {
  const sql = db();
  const who = author?.name || null;
  await sql`INSERT INTO po_resolutions (po_id) VALUES (${poId}) ON CONFLICT (po_id) DO NOTHING`;

  // The shim can't nest sql fragments, so each step gets its own statement.
  if (step === 'contacted') {
    if (undo) await sql`UPDATE po_resolutions SET contacted_by = NULL, contacted_at = NULL, updated_at = now() WHERE po_id = ${poId}`;
    else await sql`UPDATE po_resolutions SET contacted_by = ${who}, contacted_at = now(), updated_at = now() WHERE po_id = ${poId}`;
  } else if (step === 'outcome') {
    if (undo || !outcome) {
      // Clearing the outcome clears what depended on it — a credit reference makes no
      // sense once you've switched to a reship.
      await sql`
        UPDATE po_resolutions
        SET outcome = NULL, outcome_by = NULL, outcome_at = NULL,
            ref_value = NULL, ref_amount = NULL, ref_box_id = NULL, ref_by = NULL, ref_at = NULL,
            settled_amount = NULL, settled_by = NULL, settled_at = NULL, updated_at = now()
        WHERE po_id = ${poId}`;
    } else {
      await sql`UPDATE po_resolutions SET outcome = ${outcome}, outcome_by = ${who}, outcome_at = now(), updated_at = now() WHERE po_id = ${poId}`;
    }
  } else if (step === 'reference') {
    if (undo) await sql`UPDATE po_resolutions SET ref_value = NULL, ref_amount = NULL, ref_box_id = NULL, ref_by = NULL, ref_at = NULL, updated_at = now() WHERE po_id = ${poId}`;
    else await sql`
      UPDATE po_resolutions
      SET ref_value = ${value}, ref_amount = ${amount}, ref_box_id = ${boxId},
          ref_by = ${who}, ref_at = now(), updated_at = now()
      WHERE po_id = ${poId}`;
  } else if (step === 'settled') {
    if (undo) await sql`UPDATE po_resolutions SET settled_amount = NULL, settled_by = NULL, settled_at = NULL, updated_at = now() WHERE po_id = ${poId}`;
    else await sql`UPDATE po_resolutions SET settled_amount = ${amount}, settled_by = ${who}, settled_at = now(), updated_at = now() WHERE po_id = ${poId}`;
  } else {
    throw new Error(`Unknown resolution step: ${step}`);
  }

  const fresh = await getPoResolution(poId);
  await sql`UPDATE purchase_orders SET resolution_state = ${resolutionStateOf(fresh)} WHERE id = ${poId}`;
  return fresh;
}

// The reship as a real label on the ORIGINAL order: same PO, next box number, tracked
// like any other. Created EMPTY — the supplier (or PH on their behalf) can then declare
// what's actually in it, so the warehouse checks the reship off a manifest instead of
// re-scanning it blind. Those lines are deliberately kept out of the reconciliation
// `expected` count and the PO list's unit_count: the units were already declared on the
// original manifest and already counted short, so counting them twice would leave the
// order reading short forever. The box is still only a vehicle for the arithmetic — when
// it lands, `received` climbs and the order goes clean on its own.
export async function addReplacementBox(poId, { trackingNumber, carrierKey, createdBy }) {
  const sql = db();
  const next = (await sql`
    SELECT coalesce(max(box_number), 0) + 1 AS n FROM po_boxes WHERE po_id = ${poId}`)[0].n;
  const rows = await sql`
    INSERT INTO po_boxes (po_id, box_number, tracking_number, carrier_key, status, kind, shipped_at, created_by)
    VALUES (${poId}, ${next}, ${trackingNumber || null},
            ${Number.isInteger(carrierKey) && carrierKey > 0 ? carrierKey : null},
            'shipped', 'replacement', now(), ${createdBy || null})
    RETURNING *`;
  return rows[0];
}

// Receiving against a reconciled or archived PO is blocked, deliberately — so an inbound
// reship has to put the order back in play. Lands on 'receiving' (not 'draft'): the
// manifest is settled, only the intake reopens. Returns the new status, or null if the
// order was already open.
export async function reopenPoForReceiving(poId) {
  const sql = db();
  const rows = await sql`
    UPDATE purchase_orders SET status = 'receiving'
    WHERE id = ${poId} AND status IN ('reconciled', 'closed')
    RETURNING id, po_code, status`;
  return rows[0] || null;
}

// A refund that came in under what was agreed. Surfaced rather than quietly closed —
// this is the whole reason both amounts are recorded.
export function refundShortfall(r) {
  if (!r || r.outcome !== 'refund' || r.ref_amount == null || r.settled_amount == null) return 0;
  const diff = Number(r.ref_amount) - Number(r.settled_amount);
  return diff > 0.004 ? Number(diff.toFixed(2)) : 0;
}

// Compact view for the UI: which steps exist, which are done, and what's outstanding.
export function resolutionView(r) {
  const steps = stepsFor(r?.outcome);
  const done = steps.filter((s) => stepDone(r, s));
  return {
    ...(r || {}),
    steps,
    done_count: done.length,
    step_count: steps.length,
    state: resolutionStateOf(r),
    shortfall: refundShortfall(r),
  };
}

// Archive a reconciled PO → status 'closed' (drops off the active reconcile list).
/* ---- Linking an already-received batch to its PO ----------------------------
   "Receive against a purchase order" is a step-1 choice, so when the order is opened
   AFTER the warehouse has started scanning the box — it arrived before the paperwork —
   there was no way to join the two afterwards. The order read as outstanding forever
   while its stock sat on the shelf. These three functions are that repair, in-app. */

// Batches that plausibly ARE this order's shipment: same supplier, or carrying a
// tracking number that matches one of its labels. Already-linked batches are included
// (flagged) so the screen can show what's attached rather than hiding it.
export async function listPoLinkCandidates(poId) {
  const sql = db();
  const po = (await sql`SELECT id, supplier_name FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po) return [];
  const trackings = (await sql`
    SELECT upper(replace(coalesce(tracking_number, ''), ' ', '')) AS t
    FROM po_boxes WHERE po_id = ${poId} AND coalesce(tracking_number, '') <> ''`).map((r) => r.t);
  return sql`
    SELECT b.id, b.batch_code, b.supplier_name, b.tracking_number, b.status, b.created_at,
           b.po_id, b.date_received,
           (SELECT count(*) FROM items i       WHERE i.batch_id = b.id)::int AS units,
           (SELECT count(*) FROM batch_boxes x WHERE x.batch_id = b.id)::int AS box_count
    FROM batches b
    WHERE (b.kind IS NULL OR b.kind = 'receiving')
      AND (b.po_id IS NULL OR b.po_id = ${poId})
      AND b.created_at > now() - interval '120 days'
      AND (
        (coalesce(${po.supplier_name}, '') <> '' AND b.supplier_name ILIKE ${`%${po.supplier_name || ''}%`})
        OR upper(replace(coalesce(b.tracking_number, ''), ' ', '')) = ANY(${trackings})
        OR EXISTS (SELECT 1 FROM batch_boxes x WHERE x.batch_id = b.id
                     AND upper(replace(coalesce(x.tracking_number, ''), ' ', '')) = ANY(${trackings}))
      )
    ORDER BY b.created_at DESC
    LIMIT 25`;
}

// The boxes of a candidate batch, each pre-matched to the PO label with the same
// tracking number — that match is what the caller confirms or corrects by hand.
export async function getPoLinkPreview(poId, batchId) {
  const sql = db();
  const batch = (await sql`SELECT * FROM batches WHERE id = ${batchId}`)[0];
  if (!batch) return null;
  const labels = await sql`SELECT * FROM po_boxes WHERE po_id = ${poId} ORDER BY box_number`;
  const boxes = await sql`
    SELECT x.id, x.box_number, x.tracking_number, x.status,
           (SELECT count(*) FROM items i WHERE i.box_id = x.id)::int AS units
    FROM batch_boxes x WHERE x.batch_id = ${batchId} ORDER BY x.box_number`;
  const [{ n: units }] = await sql`SELECT count(*)::int AS n FROM items WHERE batch_id = ${batchId}`;
  const norm = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');
  const byTracking = new Map(labels.filter((l) => l.tracking_number).map((l) => [norm(l.tracking_number), l]));
  // A single-box batch keeps its tracking on the batch itself, not in a box row — it
  // still has to be matchable, so present it as one box.
  const rows = (boxes.length ? boxes : [{ id: null, box_number: 1, tracking_number: batch.tracking_number, status: batch.status, units }])
    .map((b) => {
      const m = byTracking.get(norm(b.tracking_number));
      return { ...b, matchedPoBoxId: m ? Number(m.id) : null };
    });
  return { batch, units, boxes: rows, labels };
}

// Attach the batch to the order and move the order into 'receiving' — the same two
// facts receiving itself would have written, so everything downstream (reconciliation,
// the received-boxes evidence, auto-close) behaves as if it had been received against
// the PO in the first place.
//
// `boxMap` fills in a tracking number the warehouse never entered, by pointing a
// received box at one of THIS order's labels. Only that order's own tracking numbers
// are accepted and an already-scanned one is never overwritten — a wrong value here
// would invent a shipment.
//
// `shipLabels` exists for a trap that would otherwise make this repair look broken: a
// per-label manifest counts only lines on labels marked shipped, so labels the supplier
// never scanned out leave `expected` at 0 and a fully delivered order reads "received
// blind" with every pair an overage.
export async function linkBatchToPo({ poId, batchId, boxMap = [], shipLabels = false, actor = null }) {
  const sql = db();
  const po = (await sql`SELECT * FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po) return { error: 'Purchase order not found.' };
  if (['reconciled', 'closed'].includes(po.status)) {
    return { error: `${po.po_code} is already ${po.status} — reopen it before linking a shipment.` };
  }
  const batch = (await sql`SELECT * FROM batches WHERE id = ${batchId}`)[0];
  if (!batch) return { error: 'Batch not found.' };
  if (batch.po_id != null && Number(batch.po_id) !== Number(poId)) {
    return { error: `${batch.batch_code} is already linked to another purchase order.` };
  }

  const labels = await sql`SELECT * FROM po_boxes WHERE po_id = ${poId}`;
  const labelById = new Map(labels.map((l) => [Number(l.id), l]));
  const queries = [];
  if (batch.po_id == null) {
    queries.push(sql`UPDATE batches SET po_id = ${poId} WHERE id = ${batchId} AND po_id IS NULL`);
  }
  for (const m of boxMap) {
    const label = labelById.get(Number(m.poBoxId));
    if (!label || !label.tracking_number) continue;   // only this order's own labels
    if (m.boxId) {
      queries.push(sql`
        UPDATE batch_boxes SET tracking_number = ${label.tracking_number}
        WHERE id = ${Number(m.boxId)} AND batch_id = ${batchId} AND coalesce(tracking_number, '') = ''`);
    } else {
      queries.push(sql`
        UPDATE batches SET tracking_number = ${label.tracking_number}
        WHERE id = ${batchId} AND coalesce(tracking_number, '') = ''`);
    }
  }
  if (shipLabels) {
    const ids = boxMap.map((m) => Number(m.poBoxId)).filter((id) => labelById.has(id));
    if (ids.length) {
      queries.push(sql`
        UPDATE po_boxes SET status = 'shipped', shipped_at = COALESCE(shipped_at, now())
        WHERE id = ANY(${ids}) AND po_id = ${poId} AND status IN ('pending', 'packed')`);
    }
  }
  if (queries.length) await sql.transaction(queries);
  await markPoReceiving(poId, batchId);

  // Leave the trail: otherwise someone opens this order later and can't work out how an
  // order raised after the fact has a fully-received batch against it.
  await addPoComment({
    poId, kind: 'system', audience: 'internal',
    body: `Linked receiving batch ${batch.batch_code} to this order — it was already being scanned when the order was opened.`,
    author: actor || { id: null, name: null, role: 'system' },
  }).catch(() => { /* the link matters, the note doesn't */ });

  return { ok: true, po: (await sql`SELECT * FROM purchase_orders WHERE id = ${poId}`)[0], batch };
}

// Undo a link (wrong batch, or clearing the way to delete the order). The batch and its
// stock are untouched — only the join is removed. `received_batch_id` moves to whatever
// batch is still linked, and an order left with none drops back to where it was before:
// 'shipped' if any label has left the supplier, else 'draft'.
export async function unlinkBatchFromPo({ poId, batchId, actor = null }) {
  const sql = db();
  const po = (await sql`SELECT * FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po) return { error: 'Purchase order not found.' };
  if (['reconciled', 'closed'].includes(po.status)) {
    return { error: `${po.po_code} is ${po.status} — its count is frozen. Reopen it first.` };
  }
  const batch = (await sql`SELECT * FROM batches WHERE id = ${batchId} AND po_id = ${poId}`)[0];
  if (!batch) return { error: 'That batch is not linked to this order.' };

  await sql`UPDATE batches SET po_id = NULL WHERE id = ${batchId}`;
  const rest = await sql`SELECT id FROM batches WHERE po_id = ${poId} ORDER BY id LIMIT 1`;
  const shipped = await sql`
    SELECT 1 FROM po_boxes WHERE po_id = ${poId} AND status NOT IN ('pending', 'packed') LIMIT 1`;
  await sql`
    UPDATE purchase_orders
    SET received_batch_id = ${rest[0] ? Number(rest[0].id) : null},
        status = CASE WHEN ${rest.length} > 0 THEN status
                      WHEN ${shipped.length} > 0 THEN 'shipped' ELSE 'draft' END
    WHERE id = ${poId}`;
  await addPoComment({
    poId, kind: 'system', audience: 'internal',
    body: `Unlinked receiving batch ${batch.batch_code} from this order. The batch and its stock are unchanged.`,
    author: actor || { id: null, name: null, role: 'system' },
  }).catch(() => { /* non-blocking */ });
  return { ok: true, batch };
}

// Delete a purchase order outright — for one raised by mistake or a duplicate.
// Refused while a receiving batch is linked: `batches.po_id` has no ON DELETE rule, so
// the database would reject it anyway, and a clear message beats a constraint error.
// Labels, manifest lines, the resolution and the comment thread go with it (all
// ON DELETE CASCADE); the supplier's own scans live in po_lines, so they go too.
export async function deletePo(poId) {
  const sql = db();
  const po = (await sql`SELECT * FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po) return { error: 'Purchase order not found.' };
  const linked = await sql`SELECT batch_code FROM batches WHERE po_id = ${poId} ORDER BY id`;
  if (linked.length) {
    return {
      error: `${po.po_code} still has ${linked.length} receiving batch(es) linked `
        + `(${linked.map((b) => b.batch_code).join(', ')}). Unlink them first — deleting the order `
        + 'must never take the record of received stock with it.',
    };
  }
  await sql`DELETE FROM purchase_orders WHERE id = ${poId}`;
  return { ok: true, po };
}

/* ---- The courier's labels PDF (R2) ------------------------------------------
   Kept so the supplier can print the label for the box they're packing rather than
   hunting for the email it arrived in. ONE object per order, exactly as uploaded; the
   page↔label mapping lives on po_boxes.label_page, so a per-box download extracts a page
   instead of us storing N files that could drift from the original. */

// Record an uploaded PDF against the order and map its pages to labels.
// The mapping is keyed on the TRACKING NUMBER read off each page, never on page order:
// the labels a page maps to may have been reordered, edited or typed in by hand before
// the order was created, and a label pointing at someone else's page is worse than none.
export async function attachPoLabels({ poId, key, name, pages, pageMap = [], uploadedBy = null }) {
  const sql = db();
  const norm = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');
  const boxes = await sql`SELECT id, tracking_number FROM po_boxes WHERE po_id = ${poId}`;
  const byTracking = new Map(boxes.filter((b) => b.tracking_number).map((b) => [norm(b.tracking_number), Number(b.id)]));

  const queries = [sql`
    UPDATE purchase_orders
    SET labels_key = ${key}, labels_name = ${name || null}, labels_pages = ${pages || null},
        labels_uploaded_at = now(), labels_uploaded_by = ${uploadedBy}
    WHERE id = ${poId}`];

  // A label owns every page up to the NEXT label. The sheets bought from UPS CampusShip
  // interleave a packing slip after each label, and that slip goes in that box — so the
  // per-box download is a range, and the last label runs to the end of the file.
  const wanted = pageMap
    .map((m) => ({ boxId: byTracking.get(norm(m.tracking)), page: Number(m.page) }))
    .filter((m) => m.boxId && Number.isInteger(m.page) && m.page > 0)
    .sort((a, b) => a.page - b.page);
  const total = Number(pages) || (wanted.length ? wanted[wanted.length - 1].page : 0);
  const matched = [];
  for (let i = 0; i < wanted.length; i++) {
    const { boxId, page } = wanted[i];
    const next = wanted[i + 1]?.page;
    // Guard the arithmetic rather than trusting the caller's page count: an end before
    // the start would hand someone an empty or backwards PDF.
    const end = Math.max(page, (next ? next - 1 : total) || page);
    matched.push({ boxId, page, end });
    queries.push(sql`
      UPDATE po_boxes SET label_page = ${page}, label_page_end = ${end}
      WHERE id = ${boxId} AND po_id = ${poId}`);
  }
  await sql.transaction(queries);
  return { matched: matched.length, pages: pages || 0 };
}

// The stored file + the page for one label (when poBoxId is given).
export async function getPoLabelFile(poId, poBoxId = null) {
  const sql = db();
  const po = (await sql`
    SELECT id, po_code, supplier_user_id, labels_key, labels_name, labels_pages
    FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po || !po.labels_key) return null;
  let box = null;
  if (poBoxId != null) {
    box = (await sql`SELECT id, box_number, label_page, label_page_end, tracking_number
                     FROM po_boxes WHERE id = ${poBoxId} AND po_id = ${poId}`)[0] || null;
    if (!box) return null;
  }
  return { po, box };
}

// Forget the file: clear the mapping and hand the key back so the caller can delete the
// object. Returns null when there was nothing stored.
export async function clearPoLabels(poId) {
  const sql = db();
  const po = (await sql`SELECT labels_key FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po?.labels_key) return null;
  await sql.transaction([
    sql`UPDATE po_boxes SET label_page = NULL, label_page_end = NULL WHERE po_id = ${poId}`,
    sql`UPDATE purchase_orders
        SET labels_key = NULL, labels_name = NULL, labels_pages = NULL,
            labels_uploaded_at = NULL, labels_uploaded_by = NULL
        WHERE id = ${poId}`,
  ]);
  return po.labels_key;
}

export async function closePo(poId) {
  const sql = db();
  const rows = await sql`
    UPDATE purchase_orders SET status = 'closed'
    WHERE id = ${poId} AND status = 'reconciled'
    RETURNING id, po_code, status`;
  return rows[0] || null;
}

// Undo an archive → back to 'reconciled', where it's visible and actionable again.
// Archiving used to be a one-way door: nothing moved a PO out of 'closed', and receiving
// against it is blocked, so a late box or a mis-tap meant a hand-edit in the database.
// Deliberately lands on 'reconciled', not 'receiving' — the frozen count still stands;
// this only puts the order back where someone can see and work with it.
export async function unarchivePo(poId) {
  const sql = db();
  const rows = await sql`
    UPDATE purchase_orders SET status = 'reconciled'
    WHERE id = ${poId} AND status = 'closed'
    RETURNING id, po_code, status`;
  return rows[0] || null;
}

// Archived orders, newest first. Its own query rather than a flag on listReconcilePos:
// the active queue must not pay for a list that grows forever and is opened rarely.
export async function listArchivedPos({ limit = 100 } = {}) {
  const sql = db();
  return sql`
    SELECT p.id, p.po_code, p.status, p.supplier_name, p.tag_code,
      p.reconciled_at, p.created_at, p.reconciliation->'summary' AS snapshot_summary,
      p.reconcile_note, p.reconcile_note_by, p.reconcile_note_at,
      p.resolution_state, p.comment_count,
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count
    FROM purchase_orders p
    WHERE p.status = 'closed'
    ORDER BY p.reconciled_at DESC NULLS LAST, p.created_at DESC
    LIMIT ${limit}`;
}
