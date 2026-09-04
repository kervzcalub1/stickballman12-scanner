// Postgres access layer (standard `pg` driver + a connection pool).
// A thin tagged-template shim keeps the Neon-style API — `` sql`… ${v} …` ``
// builds a parameterized `$1,$2…` query, so values are never interpolated into
// SQL text (injection-safe) — and `sql.transaction([…])` runs a list of those
// queries on a single client inside BEGIN/COMMIT.
//
// V5: moved off the Neon HTTP driver to plain Postgres so the app runs on a
// local database now and on any real host later (not tied to Vercel/Neon).

import pg from 'pg';
import { TERMINAL_STATUSES } from './statuses.js';
import { ROLL_VIN_RE } from './vins.js';
// The LOOSE search normaliser (strips every non-alphanumeric), shared with the PO
// search so both find one parcel the same way. Deliberately imported under another
// name: this file already has a `trackKey` further down that only strips whitespace,
// and that one is for MATCHING a label to a box — a stricter job than searching.
import { trackKey as searchTrackKey } from '../../src/lib/postatus.js';
// Registration now sends the canonical form of a number, so anything that MATCHES a
// number has to canonicalise too — see normalizeTrackingNumber for why.
import { normalizeTrackingNumber } from './tracking.js';

const { Pool } = pg;

// A Postgres DATE is a calendar day, not an instant, and node-postgres parses one into a
// JS Date at LOCAL midnight — which JSON then serialises as UTC. On a server east of UTC
// (this team runs Asia/Manila) that hands the client the day BEFORE: a purchase made on
// the 5th reads as the 4th, and an edit form that round-trips the value walks it back
// another day on every save. Hand back the string Postgres actually sent; every consumer
// already does String(d).slice(0, 10) with it. (OID 1082 = date.)
pg.types.setTypeParser(1082, (v) => v);

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

// Batch kinds the PH team must NEVER see. All three bypass PH entirely but for
// different reasons: 'instore' is listed to the stores by hand off the In-Store
// Listing page, 'existing' is old stock that was already synced to II and the
// stores long before this system existed, and 'boxes' is not stock at all — it is
// the empty shoe boxes we buy to replace crushed and missing ones, which have no
// price, no listing and no store. Kept as ONE list because the exclusion
// has to hold at every PH read/write path — phListItems (both branches),
// pendingCounts, phUpdateGroup, getItemsForGiRefresh, recomputeUnlistedPrices and
// rescaleItem. Guarding only the obvious one is how in-store leaked onto the PH
// Rescale grid before (see docs/context/in-store.md).
//
// Use as: (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))
// The IS NULL half is required — these are LEFT JOINs, and `NULL <> ALL(...)` is
// NULL, which would silently drop every batchless row.
export const PH_EXCLUDED_KINDS = ['instore', 'existing', 'boxes'];

// Batch kinds that are a real inbound SHIPMENT — a courier label, a supplier, a tracking
// number, boxes that arrive one at a time and get committed one at a time. A shipment of
// empty shoe boxes is one of these in every mechanical sense; only its contents differ.
// Used by the multi-box endpoints (add-box, sync-boxes, renumber-box, set-status,
// box-commit), which were each keyed on 'receiving' alone and so refused a boxes batch
// with "Batch not found".
export const SHIPMENT_KINDS = ['receiving', 'boxes'];

// A label that has ACTUALLY LEFT THE SUPPLIER. The same three states
// `getPoReconciliation` counts as `expected`, and the exact complement of
// `STILL_WITH_SUPPLIER` in po-manifest.js — one definition, so the reconciliation, the
// manifest-edit window and the status chip can never disagree about where a parcel is.
//
// `pre_transit` is the one that has to stay OUT and is the easiest to get wrong: tracking
// is registered when the PO is CREATED, so the carrier acknowledges the label within
// minutes and 17TRACK reports InfoReceived — the label exists, the box is still on the
// supplier's floor. Counting it as shipped made almost every order read "Shipped" from
// the moment it was raised. `packed` is out for the plainer reason that the supplier has
// closed the box but nobody has collected it.
export const LEFT_SUPPLIER_STATUSES = ['shipped', 'in_transit', 'delivered'];

// Batch kinds the COSTS page ignores. 'existing' has no cost to capture by design and
// runs to thousands of pairs; 'boxes' is not a pair at all — a box's cost is settled with
// the supplier on the purchase order, not chased pair-by-pair on a PH worklist. In-store
// buys are deliberately NOT here: they have real costs somebody has to enter.
// `pendingCounts.costable` and `listItemsMissingCost` must agree, or the badge counts
// rows the page won't show — hence one list, read by both.
export const COST_EXCLUDED_KINDS = ['existing', 'boxes'];

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
    SELECT id, name, username, pass_hash, role, status, privileges, must_change_password
    FROM users WHERE username = ${username} LIMIT 1
  `;
  return rows[0] || null;
}

// Admin views. Pending first, then most recent.
export async function listUsers() {
  return await db()`
    SELECT id, name, username, role, status, privileges, created_at, reviewed_at, reviewed_by,
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
      AND NOT items.pre_sell   -- sold before it landed; not PH's to price
    RETURNING id
  `;
  return rows.length;
}

// What WE know about a SKU, for the Payout Calculator's advisor. This is the half of
// the picture the tool we ported from cannot have: they run on external APIs alone,
// we have five months of our own buying and selling behind the same shoe.
//
// Deliberately aggregate — counts, averages, medians. No VINs, no batch codes, no
// people: this goes into a prompt sent to a third-party model, so it carries what
// informs a buy decision and nothing that identifies a person or a shipment.
//
// All batch kinds count, in-store and existing stock included: we paid for those pairs
// too, and "what did we last pay for this" is the question being answered.
export async function advisorSkuHistory(sku, size = null) {
  const s = String(sku || '').trim();
  if (!s) return null;
  const sz = String(size || '').trim() || null;
  const rows = await db()`
    WITH ours AS (
      SELECT i.id, i.size, i.cost, i.status, i.created_at
      FROM items i WHERE upper(i.sku) = upper(${s})
    ),
    gone AS (
      SELECT o.id, o.created_at,
             (SELECT max(e.created_at) FROM item_events e
               WHERE e.item_id = o.id AND e.type = 'status_change'
                 AND e.details->>'status' IN ('sold', 'shipped')) AS gone_at
      FROM ours o WHERE o.status IN ('sold', 'shipped')
    )
    SELECT
      (SELECT count(*)::int FROM ours
        WHERE status NOT IN ('sold','shipped','missing','issue')) AS on_hand,
      (SELECT count(*)::int FROM ours
        WHERE status NOT IN ('sold','shipped','missing','issue')
          AND (${sz}::text IS NULL OR size = ${sz})) AS on_hand_size,
      (SELECT count(*)::int FROM ours WHERE status IN ('sold','shipped')) AS sold_total,
      (SELECT count(*)::int FROM gone WHERE gone_at > now() - interval '90 days') AS sold_90d,
      (SELECT round(avg(cost), 2) FROM ours WHERE cost IS NOT NULL AND cost > 0) AS avg_cost,
      (SELECT cost FROM ours WHERE cost IS NOT NULL AND cost > 0
        ORDER BY created_at DESC LIMIT 1) AS last_cost,
      -- EST, like every other date this app prints.
      (SELECT (created_at AT TIME ZONE 'America/New_York')::date FROM ours
        WHERE cost IS NOT NULL AND cost > 0 ORDER BY created_at DESC LIMIT 1) AS last_cost_on,
      -- Median, not mean: one pair that sat for a year would otherwise libel the SKU.
      (SELECT round(percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (gone_at - created_at)) / 86400)::numeric, 0)
         FROM gone WHERE gone_at IS NOT NULL) AS median_days_to_sell
  `;
  return rows[0] || null;
}

// What OUR OWN records say about where a style is listed. Not the platforms' truth —
// these are the flags PH ticks as they push a pair to each store. Worth reporting
// alongside a real StockX read precisely because the two can disagree, and a
// disagreement is the interesting part: "we've marked 6 listed on Alias" next to
// "StockX says 0 active" is a question somebody should answer.
export async function ourListingFlags(sku) {
  const codes = String(sku || '').split('/').map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return null;
  const [row] = await db()`
    SELECT
      count(*) FILTER (WHERE sellable)::int                         AS on_hand,
      count(*) FILTER (WHERE sellable AND added_to_intel_inv)::int   AS on_intel_inv,
      count(*) FILTER (WHERE sellable AND synced_alias)::int         AS listed_alias,
      count(*) FILTER (WHERE sellable AND synced_stockx)::int        AS listed_stockx,
      count(*) FILTER (WHERE sellable AND synced_shopify)::int       AS listed_shopify
    FROM (
      SELECT i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify,
             (i.status NOT IN ('sold','shipped','missing','issue','no_box')) AS sellable
      FROM items i WHERE upper(i.sku) = ANY(${codes}::text[])
    ) t
  `;
  return row || null;
}

// Which of a shoe's several style codes we ALREADY hold stock under.
//
// A re-released shoe carries more than one code ("315122-111/CW2288-111"), and the
// warehouse has to pick the one printed on the box in front of them. Asking is only
// tolerable if it's asked ONCE — so before asking, look at our own stock: if we have
// received this shoe before, the code we filed it under is the answer, and the scan
// resolves silently. Same principle as the Box Labels tool, which queries our own
// stock before the catalogue.
//
// Ordered by unit count so one mis-keyed pair can't outvote a shelf of correctly
// filed ones. Returns the sku EXACTLY as stored (its own spelling), or null when
// this shoe is genuinely new to us — which is the only case that asks.
export async function knownSkuAmong(codes) {
  const want = (Array.isArray(codes) ? codes : [])
    .map((c) => String(c || '').trim().toUpperCase()).filter(Boolean);
  if (want.length < 2) return null;
  const rows = await db()`
    SELECT i.sku, count(*)::int AS n
    FROM items i
    WHERE upper(i.sku) = ANY(${want}::text[])
    GROUP BY i.sku
    ORDER BY n DESC, i.sku
    LIMIT 1
  `;
  return rows[0]?.sku || null;
}

// Per-SIZE listing breakdown for one style, in the PH grid's own buckets. This is the
// "how many do we have, listed or not?" answer, and the naive version of it — on_hand
// minus listed_alias — is wrong three ways, which is why it's a query and not a
// subtraction:
//   · **In-progress is a third bucket.** A pair with SOME of its required stores ticked
//     is neither listed nor pending; it sits in In-Progress on the grid. Counting it as
//     "not listed" would send someone to list a pair that's half done.
//   · **Which stores are REQUIRED depends on the pair.** A `goat_only` shoe lists to
//     Alias alone, so one tick finishes it; anything else needs II + Alias + StockX +
//     Shopify. (Mirrors requiredFlags/unitListingStatus in src/lib/ph.js — keep in step.)
//   · **The PH grid doesn't see everything we own.** In-store buys and existing stock
//     never enter PH's world (PH_EXCLUDED_KINDS), and no-box units are hidden from New
//     Inventory because they aren't postable. Those are counted separately rather than
//     dropped, so the buckets still add up to what's on the shelf.
// Sold and shipped are out entirely: the question is what we HAVE.
//
// NOT date-windowed, unlike the grid itself. The grid shows one date range at a time;
// a question about a style wants every pair of it we're holding, so the caller must say
// which of the two it's quoting (api/advisor/ask.js does).
export async function phListingBySizeForSku(sku) {
  const codes = String(sku || '').split('/').map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return null;
  const rows = await db()`
    WITH u AS (
      SELECT coalesce(nullif(btrim(i.size), ''), '?') AS size,
             i.status,
             (b.kind IS NOT NULL AND b.kind = ANY(${PH_EXCLUDED_KINDS})) AS off_ph,
             CASE
               WHEN coalesce(i.goat_only, false)
                 THEN CASE WHEN coalesce(i.synced_alias, false) THEN 'listed' ELSE 'pending' END
               WHEN coalesce(i.added_to_intel_inv, false) AND coalesce(i.synced_alias, false)
                AND coalesce(i.synced_stockx, false)      AND coalesce(i.synced_shopify, false)
                 THEN 'listed'
               WHEN coalesce(i.added_to_intel_inv, false) OR coalesce(i.synced_alias, false)
                 OR coalesce(i.synced_stockx, false)      OR coalesce(i.synced_shopify, false)
                 THEN 'in_progress'
               ELSE 'pending'
             END AS bucket
        FROM items i
        LEFT JOIN batches b ON b.id = i.batch_id
       WHERE upper(i.sku) = ANY(${codes}::text[])
         AND i.status NOT IN ('sold', 'shipped')
    )
    SELECT size,
           count(*) FILTER (WHERE NOT off_ph AND status <> 'no_box' AND bucket = 'pending')::int     AS pending,
           count(*) FILTER (WHERE NOT off_ph AND status <> 'no_box' AND bucket = 'in_progress')::int AS in_progress,
           count(*) FILTER (WHERE NOT off_ph AND status <> 'no_box' AND bucket = 'listed')::int      AS listed,
           count(*) FILTER (WHERE NOT off_ph AND status = 'no_box')::int                             AS no_box,
           count(*) FILTER (WHERE off_ph)::int                                                       AS in_store_or_existing
      FROM u
     GROUP BY size
  `;
  return rows;
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

// Vendor names for the receiving dropdown AND the Inventory supplier filter —
// the seeded list, any custom names staff have typed (auto-saved on commit), and
// every supplier that actually appears on a batch. That last half matters: a
// filter has to offer the names the data really carries, including batches
// received before a name was ever saved to `suppliers`.
export async function listSuppliers() {
  const rows = await db()`
    SELECT name FROM (
      SELECT name FROM suppliers
      UNION
      SELECT DISTINCT btrim(supplier_name) AS name FROM batches
       WHERE coalesce(btrim(supplier_name), '') <> ''
    ) s
    ORDER BY name`;
  return rows.map((r) => r.name);
}

/* ------------------------------------------------------------------ */
/* Merging duplicates (superadmin). Both tools are IRREVERSIBLE, so    */
/* both come in two halves: a preview that counts exactly what would   */
/* move, and an apply that does it. Nobody should confirm a merge from */
/* a name alone — "Erick" carrying 123 units is a different decision   */
/* from "Erick" carrying none.                                          */
/* ------------------------------------------------------------------ */

// One person, typed two ways. The dropdown is a UNION of the `suppliers` table and the
// distinct names on batches (see listSuppliers), so a name can be in either, both, or
// only on old stock — the preview counts all three places rather than assuming.
//
// SCOPE IS NAMES ONLY, deliberately: batches, purchase orders and the dropdown. The
// supplier's LOGIN account and their payout preset are left alone. An account is a
// credential, not a label, and presets are scoped by `supplier_user_id` — renaming one
// by name could point a cost stack at the wrong person's money.
export async function previewSupplierMerge(fromName, toName) {
  const sql = db();
  // Type first, and fail closed. `String()` turns {a:1} into "[object Object]" and — worse
  // — turns ["Erick"] into "Erick", so a malformed request would perform a REAL merge that
  // the UI could never have asked for. Caught by the pentest, 2026-08-28.
  if (typeof fromName !== 'string' || typeof toName !== 'string')
    return { error: 'Both names must be text.' };
  // Compare the names EXACTLY as the dropdown holds them. Trimming and lower-casing first
  // refused the two commonest duplicates this tool exists to fix: "Erick" vs "erick"
  // (listSuppliers UNIONs case-sensitively, so both really are separate rows) and a name
  // saved with trailing whitespace (the `suppliers` half of that UNION isn't btrim'd, so
  // "Trail Ws " is its own entry). Found by QA, 2026-08-28.
  if (fromName === toName) return { error: 'Those are the same name.' };
  const from = fromName.trim();
  const to = toName.trim();
  if (!from || !to) return { error: 'Both names are required.' };
  const [{ n: batches }] = await sql`
    SELECT count(*)::int AS n FROM batches WHERE btrim(supplier_name) = ${from}`;
  const [{ n: units }] = await sql`
    SELECT count(*)::int AS n FROM items i JOIN batches b ON b.id = i.batch_id
     WHERE btrim(b.supplier_name) = ${from}`;
  const [{ n: pos }] = await sql`
    SELECT count(*)::int AS n FROM purchase_orders WHERE btrim(supplier_name) = ${from}`;
  const inList = (await sql`SELECT id FROM suppliers WHERE name = ${fromName} OR name = ${from}`).length > 0;
  // Named for what it is: an account that happens to share the losing name is NOT part of
  // the merge, and the UI says so rather than leaving the reader to assume either way.
  const accounts = await sql`
    SELECT id, username, name FROM users WHERE role = 'supplier' AND btrim(name) = ${from}`;
  const presets = await sql`SELECT id, name FROM payout_presets WHERE btrim(name) = ${from}`;
  // `rawFrom` is the dropdown row to delete; `from` is what matches the (btrim'd) data.
  return { from, to, rawFrom: fromName, rawTo: toName, batches, units, pos, inList, accounts, presets };
}

export async function mergeSuppliers(fromName, toName, actor) {
  const sql = db();
  const pre = await previewSupplierMerge(fromName, toName);
  if (pre.error) return pre;
  const { from, to, rawFrom, rawTo } = pre;
  // The surviving name must exist in the dropdown afterwards even if it only ever lived
  // on old batches — otherwise the merge would leave staff unable to pick it again.
  await sql`INSERT INTO suppliers (name, created_by) VALUES (${rawTo}, ${actor || null})
            ON CONFLICT (name) DO NOTHING`;
  const b = await sql`
    UPDATE batches SET supplier_name = ${to} WHERE btrim(supplier_name) = ${from} RETURNING id`;
  const p = await sql`
    UPDATE purchase_orders SET supplier_name = ${to} WHERE btrim(supplier_name) = ${from} RETURNING id`;
  // Delete the row as it is actually stored — a trailing-space name is not `from`.
  await sql`DELETE FROM suppliers WHERE name = ${rawFrom}`;
  if (rawFrom !== from) await sql`DELETE FROM suppliers WHERE name = ${from} AND ${from} <> ${rawTo}`;
  // Report what MOVED, not what the preview predicted: a second, concurrent apply moves
  // nothing, and saying "123 pairs" for it would be a lie about this call. (QA, 2026-08-28)
  return { ok: true, from, to, batches: b.length, pos: p.length, units: b.length ? pre.units : 0 };
}

// Two batches that are really one inbound — the shape this was built for is a PO whose
// boxes were received as a multi-box batch while one parcel came in on its own.
//
// What moves: every box row, then every item. A source item with NO box row is the loose
// case (the ordinary receive keeps the tracking on the batch and leaves items.box_id
// NULL); if the source's tracking number matches a box already in the target, those units
// join it — otherwise they get a box of their own inside the target, carrying that
// number. Only a source with no tracking at all stays loose after the move, because
// inventing a box for it would invent a parcel.
export async function previewBatchMerge(sourceId, targetId) {
  const sql = db();
  // `Number.isInteger` is true for a 20-digit numeral, which then overflows Postgres
  // bigint inside the query and surfaces as a 500. An id we cannot represent exactly is
  // not an id — say so up front. (Pentest, 2026-08-28.)
  const src = Number(sourceId); const tgt = Number(targetId);
  const usable = (n) => Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
  if (!usable(src) || !usable(tgt)) return { error: 'Two batch ids are required.' };
  if (Number(sourceId) === Number(targetId)) return { error: 'That is the same batch.' };
  const [source] = await sql`SELECT * FROM batches WHERE id = ${sourceId}`;
  const [target] = await sql`SELECT * FROM batches WHERE id = ${targetId}`;
  if (!source || !target) return { error: 'Batch not found.' };
  if (source.merged_into_batch_id) return { error: `${source.batch_code} was already merged away.` };
  if (target.merged_into_batch_id) return { error: `${target.batch_code} is itself a merged batch — merge into the one that absorbed it.` };
  // Stock must not cross an order boundary. Two different POs is a data question, not a
  // tidy-up, and moving units between them would silently rewrite two reconciliations.
  if (source.po_id && target.po_id && String(source.po_id) !== String(target.po_id))
    return { error: 'Those batches belong to different purchase orders.' };
  if (source.kind !== target.kind)
    return { error: `Different kinds of batch (${source.kind} and ${target.kind}) — merging them would move stock into the wrong workflow.` };
  const boxes = await sql`
    SELECT id, box_number, tracking_number, status,
           (SELECT count(*)::int FROM items i WHERE i.box_id = batch_boxes.id) AS units
    FROM batch_boxes WHERE batch_id = ${sourceId} ORDER BY box_number`;
  const [{ n: loose }] = await sql`
    SELECT count(*)::int AS n FROM items WHERE batch_id = ${sourceId} AND box_id IS NULL`;
  const [{ n: units }] = await sql`
    SELECT count(*)::int AS n FROM items WHERE batch_id = ${sourceId}`;
  // Where the loose units will land, worked out here so the confirmation can say it.
  const key = trackKey(source.tracking_number);
  const [match] = key ? await sql`
    SELECT id, box_number FROM batch_boxes
     WHERE batch_id = ${targetId}
       AND upper(replace(coalesce(tracking_number, ''), ' ', '')) = ${key}` : [];
  return {
    source, target, boxes, loose, units,
    looseGoesTo: loose > 0
      ? (match ? { kind: 'existing-box', box_number: Number(match.box_number) }
        : key ? { kind: 'new-box', tracking_number: source.tracking_number }
          : { kind: 'stays-loose' })
      : null,
  };
}

export async function mergeBatches(sourceId, targetId, actor) {
  const sql = db();
  const pre = await previewBatchMerge(sourceId, targetId);
  if (pre.error) return pre;
  const { source, target } = pre;
  // Box numbers are per batch and nothing enforces uniqueness, so a straight move would
  // put two "box 1"s in one batch. Numbering on from the target's highest keeps every row
  // distinct; the TRACKING NUMBER is what identifies the parcel anyway (see
  // getPoReceivedBoxes), so a renumbered box is still matched to its label.
  const [{ n: nextNum }] = await sql`
    SELECT coalesce(max(box_number), 0) + 1 AS n FROM batch_boxes WHERE batch_id = ${targetId}`;
  // Number by ROW, not by "how many have a lower number". Nothing enforces uniqueness on
  // (batch_id, box_number) — the codebase says so itself in renumberBatchBox — so a source
  // holding two "box 1"s made the old formula give both the same new number, carrying the
  // collision into the target. row_number() gives each row its own. (QA, 2026-08-28)
  const moved = await sql`
    UPDATE batch_boxes SET batch_id = ${targetId}, box_number = r.n
      FROM (SELECT id, ${Number(nextNum)} - 1 + row_number() OVER (ORDER BY box_number, id) AS n
              FROM batch_boxes WHERE batch_id = ${sourceId}) r
     WHERE batch_boxes.id = r.id RETURNING batch_boxes.id`;
  // The loose units, placed before the items move so the box row is already in the target.
  const key = trackKey(source.tracking_number);
  let looseBoxId = null;
  if (pre.loose > 0 && key) {
    const [match] = await sql`
      SELECT id FROM batch_boxes WHERE batch_id = ${targetId}
        AND upper(replace(coalesce(tracking_number, ''), ' ', '')) = ${key}`;
    if (match) looseBoxId = match.id;
    else {
      const [{ n: freeNum }] = await sql`
        SELECT coalesce(max(box_number), 0) + 1 AS n FROM batch_boxes WHERE batch_id = ${targetId}`;
      const [made] = await sql`
        INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, received_at)
        VALUES (${targetId}, ${Number(freeNum)}, ${source.tracking_number}, 'received', now())
        RETURNING id`;
      looseBoxId = made.id;
    }
    await sql`UPDATE items SET box_id = ${looseBoxId}
               WHERE batch_id = ${sourceId} AND box_id IS NULL`;
  }
  const items = await sql`
    UPDATE items SET batch_id = ${targetId} WHERE batch_id = ${sourceId} RETURNING id`;
  // Anything else filed against the batch has to follow the stock, or it ends up
  // describing a batch that no longer holds what it is about.
  await sql`UPDATE shipment_issues SET batch_id = ${targetId} WHERE batch_id = ${sourceId}`;
  // A source that was linked to the order carries that link over when the target is not
  // yet linked — otherwise the units would leave the PO's reach entirely.
  if (source.po_id && !target.po_id) await sql`UPDATE batches SET po_id = ${source.po_id} WHERE id = ${targetId}`;
  // Emptied, not deleted: the code stays resolvable for whoever is holding the label.
  const claimed = await sql`
    UPDATE batches SET merged_into_batch_id = ${targetId}, merged_at = now(), merged_by = ${actor || null}
     WHERE id = ${sourceId} AND merged_into_batch_id IS NULL RETURNING id`;
  if (!claimed.length) {
    // Someone else merged this source while we were moving its rows. The stock is safe
    // (their move and ours were the same UPDATEs), but this call must not report the work
    // as its own — two operators would each be told they moved the pairs. (QA, 2026-08-28)
    return { error: `${source.batch_code} was merged by someone else just now — reload to see where its pairs went.` };
  }
  return {
    ok: true,
    source: source.batch_code, target: target.batch_code, targetId: Number(targetId),
    items: items.length, boxes: moved.length, looseAttached: looseBoxId ? pre.loose : 0,
  };
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
       default_cost, notes, special_rules, kind, origin, duplicate_of, po_id, pre_sell, status, created_by, committed_at)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.tracking || null}, ${h.noTracking === true},
       ${h.dateReceived || null}, ${h.defaultCost ?? null}, ${h.notes || null},
       -- 'boxes' belongs in this list: without it a single-batch commit of empty shoe
       -- boxes silently became a 'receiving' batch, which would put empty cartons in
       -- front of the PH team as sellable stock. The multi-box path (createOpenBatch)
       -- always had it, which is the only reason this hadn't bitten.
       ${h.specialRules || null}, ${['receiving', 'rescale', 'instore', 'existing', 'boxes'].includes(h.kind) ? h.kind : 'receiving'},
       ${h.origin || null}, ${h.duplicateOf ?? null}, ${h.poId ?? null}, ${h.preSell === true},
       'committed', ${createdBy || null}, now())
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
      (vin, batch_id, box_id, name, sku, size, dimensions, upc, image_url, cost, source, status, with_box, goat_only, pre_sell, gender, colorway, notes, created_by)
    VALUES
      (coalesce(${it.vin || null},
        'SBM-' || to_char(coalesce(${dateReceived}::date, current_date), 'YYMMDD')
              || '-' || lpad(nextval('vin_seq')::text, 6, '0')),
       ${batchId}, ${it.boxId ?? null}, ${it.name || null}, ${it.sku || null}, ${it.size || null},
       ${it.dimensions || null},
       ${it.upc || null}, ${it.image || null}, ${it.cost ?? null},
       ${it.source || 'manual'}, ${it.status || 'needs_shelf'}, ${it.withBox !== false}, ${it.goatOnly === true},
       ${it.preSell === true},
       ${it.gender || null}, ${it.colorway || null}, ${it.notes || null}, ${createdBy || null})
    RETURNING id, vin
  `);
  const results = await sql.transaction(queries);
  const created = results.map((r) => r[0]);
  // Pre-printed 1ID stickers: record which shoe each one landed on. Best-effort and
  // deliberately AFTER the insert — `items.vin` is UNIQUE NOT NULL, so that insert is
  // what actually makes a double-assign impossible; vin_stock is the bookkeeping that
  // lets the stock page say how many are left and stops a used sticker being handed
  // out again. Failing the whole commit because the bookkeeping hiccuped would cost
  // the warehouse a scanned box for no integrity gain.
  const rollClaims = created.filter((r) => ROLL_VIN_RE.test(r.vin)).map((r) => ({ vin: r.vin, itemId: r.id }));
  if (rollClaims.length) {
    try { await claimVinStock(rollClaims); }
    catch (e) { console.warn('[insertItems] vin_stock claim:', e.message); }
  }
  return created;
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
      AND NOT i.pre_sell                                           -- pre-sell is not listed, so not priced
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

// `phSafe` drops the kinds the PH team must never see (instore + existing). It is a
// bound boolean rather than a second copy of the query — the shim can't nest `sql`
// fragments, and two near-identical SELECTs drift.
// `count(*) OVER ()` rides along on every row: the total is computed before LIMIT, so
// one query answers both "this page" and "how many pages" — a separate count query would
// be a second round trip that can disagree with the page it labels.
// `excludeOpen` is for a page that lists OPEN batches separately (the Batch page does):
// without it the same batch appears in both cards, and dropping the duplicate on the
// client makes a page of 25 render 21 rows under a pager that says "1–25". Two cards,
// two disjoint sets, two honest counts.
// `from`/`to` filter the date the row DISPLAYS — `date_received` when it is set, else the
// day the batch was created, read in EST like every other date filter in this app (a
// created_at is an instant, and the host's clock is not the one this business runs on).
// `po`: a PO code, or the string 'none' for "not received against an order at all" —
// which is a question worth asking now that a pair can say which order it came from.
export async function listBatches(limit = 50, kind = null,
  { phSafe = false, offset = 0, excludeOpen = false, from = null, to = null, supplier = null, po = null } = {}) {
  const poCode = po && po !== 'none' ? po : null;
  const poNone = po === 'none';
  return await db()`
    SELECT b.id, b.batch_code, b.kind, b.buyer_name, b.supplier_name, b.tracking_number,
           b.no_tracking, b.batch_tag, b.status, b.pre_sell, b.merged_into_batch_id,
           (SELECT m.batch_code FROM batches m WHERE m.id = b.merged_into_batch_id) AS merged_into_code,
           b.origin, b.date_received, b.created_by, b.created_at,
           count(*) OVER ()::int AS total_count,
           (SELECT coalesce(array_agg(DISTINCT bx.tracking_number)
                      FILTER (WHERE bx.tracking_number IS NOT NULL), ARRAY[]::text[])
              FROM batch_boxes bx WHERE bx.batch_id = b.id) AS box_tracking_numbers,
           (SELECT count(*)::int FROM items i WHERE i.batch_id = b.id) AS item_count,
           (SELECT coalesce(sum(i.cost), 0) FROM items i WHERE i.batch_id = b.id) AS total_cost,
           (SELECT count(*)::int FROM shipment_issues s WHERE s.batch_id = b.id) AS issue_count
    FROM batches b
    WHERE (${kind}::text IS NULL OR b.kind = ${kind})
      AND (${phSafe} = false OR (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS})))
      AND (${excludeOpen} = false OR b.status IS DISTINCT FROM 'open')
      AND (${from}::date IS NULL OR coalesce(b.date_received,
             (b.created_at AT TIME ZONE 'America/New_York')::date) >= ${from}::date)
      AND (${to}::date IS NULL OR coalesce(b.date_received,
             (b.created_at AT TIME ZONE 'America/New_York')::date) <= ${to}::date)
      AND (${supplier}::text IS NULL OR btrim(b.supplier_name) = ${supplier})
      AND (${poNone} = false OR b.po_id IS NULL)
      AND (${poCode}::text IS NULL
           OR b.po_id = (SELECT p.id FROM purchase_orders p WHERE p.po_code = ${poCode}))
    ORDER BY b.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

// What the Batch page's filters can actually offer. Only suppliers that appear ON a
// batch and only orders that have one linked — a dropdown entry that returns an empty
// list is a dead end, and the supplier list at large is a different thing (it includes
// names nobody has shipped under yet).
export async function batchFilterOptions({ phSafe = false } = {}) {
  const sql = db();
  const suppliers = await sql`
    SELECT DISTINCT btrim(b.supplier_name) AS name FROM batches b
     WHERE coalesce(btrim(b.supplier_name), '') <> ''
       AND (${phSafe} = false OR (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS})))
     ORDER BY name`;
  const poCodes = await sql`
    SELECT DISTINCT p.po_code FROM purchase_orders p
     JOIN batches b ON b.po_id = p.id
     WHERE (${phSafe} = false OR (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS})))
     ORDER BY p.po_code DESC`;
  return { suppliers: suppliers.map((r) => r.name), poCodes: poCodes.map((r) => r.po_code) };
}

// Finding a batch by the number on the parcel.
//
// This is a SERVER search, not a filter over the list the page already has, and that
// is the whole point: the lists show one page (25 rows) and the parcel in
// someone's hand is as likely to be from March. Filtering the window would answer
// "no such batch" for a batch that exists, which is the worst answer available.
//
// It matches the same three ways the PO search does (`searchTrackKey`, imported from
// src/lib/postatus.js —
// one definition for both): substring, because people quote the last few digits;
// punctuation and spaces stripped, because a number pasted from an email is
// "1Z 999 AA1 01 2345 6784" and a scanner types it clean; and the batch code too, since
// that is the other thing printed on the carton.
//
// Stripping to A-Z0-9 also means no `%` or `_` can reach LIKE — the wildcards are ours.
export async function searchBatches(query,
  { phSafe = false, limit = 25, offset = 0, from = null, to = null, supplier = null, po = null } = {}) {
  const poCode = po && po !== 'none' ? po : null;
  const poNone = po === 'none';
  const key = searchTrackKey(query);
  if (!key) return [];              // "----" normalises to nothing: match nothing, not everything
  const like = `%${key}%`;
  return await db()`
    SELECT b.id, b.batch_code, b.kind, b.buyer_name, b.supplier_name, b.tracking_number,
           b.no_tracking, b.batch_tag, b.status, b.pre_sell, b.merged_into_batch_id,
           (SELECT m.batch_code FROM batches m WHERE m.id = b.merged_into_batch_id) AS merged_into_code,
           b.origin, b.date_received, b.created_by, b.created_at,
           count(*) OVER ()::int AS total_count,
           (SELECT coalesce(array_agg(DISTINCT bx.tracking_number)
                      FILTER (WHERE bx.tracking_number IS NOT NULL), ARRAY[]::text[])
              FROM batch_boxes bx WHERE bx.batch_id = b.id) AS box_tracking_numbers,
           (SELECT count(*)::int FROM items i WHERE i.batch_id = b.id) AS item_count,
           (SELECT coalesce(sum(i.cost), 0) FROM items i WHERE i.batch_id = b.id) AS total_cost,
           (SELECT count(*)::int FROM shipment_issues s WHERE s.batch_id = b.id) AS issue_count
    FROM batches b
    WHERE (${phSafe} = false OR (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS})))
      AND (${from}::date IS NULL OR coalesce(b.date_received,
             (b.created_at AT TIME ZONE 'America/New_York')::date) >= ${from}::date)
      AND (${to}::date IS NULL OR coalesce(b.date_received,
             (b.created_at AT TIME ZONE 'America/New_York')::date) <= ${to}::date)
      AND (${supplier}::text IS NULL OR btrim(b.supplier_name) = ${supplier})
      AND (${poNone} = false OR b.po_id IS NULL)
      AND (${poCode}::text IS NULL
           OR b.po_id = (SELECT p.id FROM purchase_orders p WHERE p.po_code = ${poCode}))
      AND (
        regexp_replace(upper(coalesce(b.batch_code, '')), '[^A-Z0-9]', '', 'g') LIKE ${like}
        OR regexp_replace(upper(coalesce(b.tracking_number, '')), '[^A-Z0-9]', '', 'g') LIKE ${like}
        OR EXISTS (
          SELECT 1 FROM batch_boxes bx
           WHERE bx.batch_id = b.id
             AND regexp_replace(upper(coalesce(bx.tracking_number, '')), '[^A-Z0-9]', '', 'g') LIKE ${like}
        )
      )
    ORDER BY b.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
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
// `kind` is 'receiving' for a shipment of shoes and 'boxes' for a shipment of EMPTY shoe
// boxes. Everything else about the batch is identical — same labels, same per-box commit,
// same PO link — so the kind is the only thing that has to be carried through.
export async function createOpenBatch(h, createdBy) {
  const rows = await db()`
    INSERT INTO batches
      (buyer_name, supplier_name, no_tracking, date_received, default_cost, notes, special_rules,
       kind, batch_tag, expected_boxes, po_id, po_link_source, po_linked_at, pre_sell, status, created_by)
    VALUES
      (${h.buyer || null}, ${h.supplier || null}, ${h.noTracking === true}, ${h.dateReceived || null},
       ${h.defaultCost ?? null}, ${h.notes || null}, ${h.specialRules || null},
       ${h.kind === 'boxes' ? 'boxes' : 'receiving'}, ${h.batchTag || null}, ${h.expectedBoxes ?? null}, ${h.poId ?? null},
       ${h.poId ? 'receiving' : null}, ${h.poId ? new Date() : null}, ${h.preSell === true},
       'open', ${createdBy || null})
    RETURNING id, batch_code
  `;
  return rows[0];
}

// Boxes of a batch with their received item counts (ordered by box number).
// Courier status rides along with every box the warehouse sees. batch_boxes has no
// tracking columns of its own -- 17TRACK is registered against po_boxes, at PO
// creation -- so the status is matched by TRACKING NUMBER, which is the only thing
// the two sides genuinely share (a box IS its tracking number; see the renumbering
// note on addBatchBox). Nothing is registered or fetched here: this reads what the
// webhook has already written, so it costs one join and no quota.
//
// A box whose number was never on a PO simply has no status, and the UI says so
// rather than implying the parcel is untracked by the courier. Roughly a third of
// historical warehouse boxes match today, rising as more inbound goes through POs.
// Registering warehouse-typed numbers too would close the rest -- that is a 17TRACK
// quota decision, deliberately not taken here.
export async function listBatchBoxes(batchId) {
  return await db()`
    SELECT bx.id, bx.box_number, bx.tracking_number, bx.status, bx.received_by, bx.received_at, bx.created_at,
           (SELECT count(*)::int FROM items i WHERE i.box_id = bx.id) AS item_count,
           tr.carrier, tr.carrier_key, tr.tracking_status, tr.tracking_sub_status,
           tr.tracking_sub_status_descr, tr.last_checkpoint, tr.checked_at, tr.tracking_events
    FROM batch_boxes bx
    LEFT JOIN LATERAL (
      -- shipment_tracking is keyed by the NUMBER, so this now covers a box whose
      -- tracking was typed in at receiving as well as one that came in on a PO. It
      -- used to reach across to po_boxes, which could only ever answer for the ~third
      -- of warehouse boxes that arrived on an order.
      SELECT st.carrier, st.carrier_key, st.tracking_status, st.tracking_sub_status,
             st.tracking_sub_status_descr, st.last_checkpoint, st.checked_at, st.tracking_events
        FROM shipment_tracking st
       WHERE coalesce(bx.tracking_number, '') <> ''
         AND regexp_replace(upper(st.tracking_number), '[^A-Z0-9]', '', 'g')
           = regexp_replace(upper(bx.tracking_number), '[^A-Z0-9]', '', 'g')
       ORDER BY st.checked_at DESC NULLS LAST
       LIMIT 1
    ) tr ON true
    WHERE bx.batch_id = ${batchId}
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

// Correct a box's number. "+ Add box" can only ever append max+1, which is right
// while boxes arrive in order and wrong the moment they don't: box 6 of 9 turning up
// a day after the rest gets recorded as "box 10", and from then on the number on the
// row doesn't match the number on the label stuck to the carton. Renumbering is that
// repair, and it stays available after the box is received — that's when the mistake
// is usually noticed.
//
// A collision is refused rather than silently allowed (there's no unique index on
// (batch_id, box_number), so nothing else would stop two box 6s). The exception is an
// EMPTY pending row: that's a slot materialized up front and never filled — exactly
// the placeholder the late box belongs in — so it's absorbed instead of blocking.
export async function renumberBatchBox(batchId, boxId, boxNumber) {
  const sql = db();
  const box = (await sql`
    SELECT id, box_number, status, tracking_number FROM batch_boxes WHERE id = ${boxId} AND batch_id = ${batchId}`)[0];
  if (!box) return { error: 'Box not found in this batch.' };
  if (Number(box.box_number) === boxNumber) return { ok: true, absorbed: false, boxes: await listBatchBoxes(batchId) };
  const clash = (await sql`
    SELECT bx.id, bx.status, bx.tracking_number, (SELECT count(*)::int FROM items i WHERE i.box_id = bx.id) AS item_count
    FROM batch_boxes bx
    WHERE bx.batch_id = ${batchId} AND bx.box_number = ${boxNumber} AND bx.id <> ${boxId}
    LIMIT 1`)[0];
  if (clash && (clash.status === 'received' || clash.item_count > 0)) {
    return { error: `Box ${boxNumber} already exists in this batch and has ${clash.item_count} item${clash.item_count === 1 ? '' : 's'} in it.` };
  }
  const queries = [];
  if (clash) queries.push(sql`DELETE FROM batch_boxes WHERE id = ${clash.id}`);
  // The absorbed slot may be the only place this box's tracking number was ever written
  // (typed up front off the PO's label, never re-entered by the person scanning). Inherit
  // it rather than deleting it — an empty tracking field is what breaks the label match.
  const tracking = String(box.tracking_number || '').trim() || (clash ? clash.tracking_number : null) || null;
  queries.push(sql`
    UPDATE batch_boxes SET box_number = ${boxNumber}, tracking_number = ${tracking}
    WHERE id = ${boxId} AND batch_id = ${batchId}`);
  await sql.transaction(queries);
  return { ok: true, absorbed: !!clash, from: Number(box.box_number), boxes: await listBatchBoxes(batchId) };
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
  // The PO facts ride along so the page can say whether this shipment came in against an
  // order — and, when we recorded it, whether it was received that way or attached later.
  const b = await db()`
    SELECT b.*,
           (SELECT p.po_code FROM purchase_orders p WHERE p.id = b.po_id) AS po_code,
           (SELECT p.status  FROM purchase_orders p WHERE p.id = b.po_id) AS po_status,
           -- The day the ORDER was placed, for the batch report's "Date order". It lives
           -- on the purchase order, not the batch, and is null for stock that arrived
           -- without one — which the report states rather than leaving blank.
           (SELECT p.date_of_purchase FROM purchase_orders p WHERE p.id = b.po_id) AS po_date_of_purchase
      FROM batches b WHERE b.id = ${id}`;
  if (!b[0]) return null;
  const boxes = await listBatchBoxes(id);
  const items = await listItemsByBatch(id);
  return { batch: b[0], boxes, items };
}

// Open (resumable) multi-box batches, newest first, with progress counts.
export async function listOpenBatches() {
  return await db()`
    SELECT b.id, b.batch_code, b.supplier_name, b.batch_tag, b.expected_boxes, b.pre_sell,
           b.tracking_number, b.no_tracking,
           b.date_received, b.created_by, b.created_at,
           (SELECT coalesce(array_agg(DISTINCT bx.tracking_number)
                      FILTER (WHERE bx.tracking_number IS NOT NULL), ARRAY[]::text[])
              FROM batch_boxes bx WHERE bx.batch_id = b.id) AS box_tracking_numbers,
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

// Free-text search, split into keywords. Typing "Kobe Air Force" has to find
// "Kobe Bryant x Nike Air Force 1 Low 'Triple Black'" — one `%kobe air force%`
// LIKE never would, because those words aren't adjacent in the name. So every
// whitespace-separated token must match SOMEWHERE (any searched column), which
// means each extra word narrows the result instead of killing it.
//
// `%`, `_` and `\` are escaped: they're legal characters in a shoe name, and an
// unescaped `_` silently matches any single character. Returns null for a blank
// query so the caller's `IS NULL` short-circuit skips the whole clause.
function searchTokens(q) {
  const toks = String(q || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
  return toks.length ? toks : null;
}

// Unified inventory query — powers the merged Inventory page (browse + report).
// Any combination of: keyword search (q over vin/sku/name/upc/colorway/shelf,
// every keyword required — see searchTokens), received-date range
// (from/to), supplier, status. Nulls are ignored. Received date = the batch's
// date_received (falling back to the item's created date).
export async function queryItems({ q = null, from = null, to = null, supplier = null, status = null, kind = null, limit = 2000 }) {
  const lim = Math.min(5000, Math.max(1, Number(limit) || 2000));
  const toks = searchTokens(q);
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.cost, i.status, i.created_by, i.created_at,
           i.with_box, i.upc, i.colorway, i.gender, i.price, i.added_to_intel_inv, i.pre_sell,
           -- items.pre_sell is the unit's CURRENT state and release clears it, so a pair
           -- that came off a pre-sell shipment becomes indistinguishable from ordinary
           -- stock the moment it is freed. batches.pre_sell is what the shipment WAS and
           -- never changes -- the only way to answer "where did this pair come from"
           -- afterwards. (No backticks in these comments: this is a JS template literal.)
           b.pre_sell AS from_pre_sell,
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
      AND (${toks}::text[] IS NULL OR NOT EXISTS (
            SELECT 1 FROM unnest(${toks}::text[]) AS s(tok)
             WHERE coalesce(i.vin, '')           NOT ILIKE tok
               AND coalesce(i.sku, '')           NOT ILIKE tok
               AND coalesce(i.name, '')          NOT ILIKE tok
               AND coalesce(i.upc, '')           NOT ILIKE tok
               AND coalesce(i.colorway, '')      NOT ILIKE tok
               AND coalesce(i.location_code, '') NOT ILIKE tok))
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
             i.pre_sell, b.pre_sell AS from_pre_sell,
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
        AND NOT i.pre_sell            -- released units clear the flag; unreleased ones stay out
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
           i.pre_sell, b.pre_sell AS from_pre_sell,
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
      -- Pre-sell: sold before it landed, so it is NOT listed to II or the stores. It
      -- leaves this world only when somebody has said which orders the arrivals cover
      -- and released the rest for rescale, which clears the flag.
      AND NOT i.pre_sell
      AND (${kind}::text IS NULL OR b.kind = 'receiving' OR b.kind IS NULL)
      -- Hide no-box from the PH team's New Inventory page; keep it in the admin
      -- Report (kind IS NULL) for oversight.
      AND (${kind}::text IS NULL OR i.status <> 'no_box')
      -- A unit on the RESCALE worklist is rescale work, not new-inventory work, and
      -- must appear in one worklist only — two lists claiming the same pair is how a
      -- pair gets listed twice or, worse, left because each side assumed the other
      -- had it. It bites hardest on released pre-sell: those units were received days
      -- ago, so they fall inside New Inventory's date window and showed up on BOTH
      -- tabs the moment the warehouse released them (pre-sell.md -- release sets
      -- restock_pending). Same shape as the no-box rule above: the admin Report
      -- (kind IS NULL) still sees everything.
      AND (${kind}::text IS NULL OR NOT i.restock_pending)
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
      -- GOAT-only pairs list to Alias ONLY, so they are not II backlog either.
      count(*) FILTER (WHERE listable AND ph_managed AND NOT goat_only AND NOT added_to_intel_inv)::int AS not_ii,
      count(*) FILTER (WHERE listable AND ph_managed AND NOT synced_alias)::int       AS not_alias,
      count(*) FILTER (WHERE listable AND ph_managed AND NOT goat_only AND NOT synced_stockx)::int  AS not_stockx,
      count(*) FILTER (WHERE listable AND ph_managed AND NOT goat_only AND NOT synced_shopify)::int AS not_shopify,
      count(*) FILTER (WHERE cost IS NULL AND costable
        AND status NOT IN ('missing','issue'))::int                    AS missing_cost,
      -- Recorded as free. Kept OUT of missing_cost (and so out of the home badge):
      -- a $0 is a claim on file, not a known gap — it's a review list, not a chore.
      count(*) FILTER (WHERE cost = 0 AND costable
        AND status NOT IN ('missing','issue'))::int                    AS zero_cost,
      -- SHOES waiting on a shelf. Empty boxes are shelved too, but they are counted
      -- separately below: a single carton of replacement boxes is a couple of hundred
      -- rows, and folding them in here would triple the warehouse's headline chore
      -- overnight with work that isn't the same work.
      count(*) FILTER (WHERE status = 'needs_shelf' AND NOT is_box)::int AS needs_shelf,
      count(*) FILTER (WHERE status = 'needs_shelf' AND is_box)::int     AS boxes_needs_shelf,
      -- Empty boxes on the shelf, ready to go onto a pair that arrived without one.
      count(*) FILTER (WHERE is_box AND status = 'in_stock')::int        AS boxes_on_hand,
      -- Pre-sell units still waiting for somebody to say which orders they cover. They
      -- are not in ANY listing backlog, so without their own count the work is invisible.
      count(*) FILTER (WHERE is_presell AND status NOT IN ('sold','shipped'))::int AS presell_pending,
      count(*) FILTER (WHERE status = 'no_box' AND NOT is_box)::int    AS no_box,
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
        WHERE p.status = 'receiving' AND b.status IS DISTINCT FROM 'committed')::int AS po_receiving,
      -- Manifest-first: a supplier has packed, declared what is in the boxes, and is
      -- waiting on us to buy the labels. Nothing moves until somebody does.
      (SELECT count(*) FROM purchase_orders p
        WHERE p.labels_requested_at IS NOT NULL
          AND p.status NOT IN ('reconciled', 'closed'))::int AS po_labels_requested,
      -- Gift-card buying. Both ends of that process stall on a person rather than on a
      -- parcel: a buyer standing in a shop waiting to be told yes, and a spend nobody
      -- has independently verified. Company money is on the wrong side of both.
      (SELECT count(*) FROM buy_carts WHERE status = 'submitted')::int AS carts_to_approve,
      (SELECT count(*) FROM buy_carts WHERE status = 'approved')::int  AS carts_to_fund,
      (SELECT count(*) FROM buy_carts WHERE status = 'funded')::int    AS carts_awaiting_receipt,
      (SELECT count(*) FROM buy_carts WHERE status IN ('receipted','audited'))::int AS carts_to_audit
    FROM (
      -- ph_managed gates the PH store-sync badges only: in-store buys and existing
      -- (old) stock bypass PH, so they must NOT inflate not_ii/alias/stockx/shopify.
      -- needs_shelf / no_box still include them — warehouse shelves & resolves those
      -- pairs. is_instore is kept separate because the In-Store Listing badge below
      -- means specifically in-store, not "everything PH ignores".
      SELECT it.*,
             (it.with_box AND it.status NOT IN ('sold','shipped','missing','issue','no_box')) AS listable,
             -- NOT pre_sell for the same reason as the kinds: a unit sold before
             -- it landed is not PH's to list, so it must not inflate the listing backlog.
             ((b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS})) AND NOT it.pre_sell) AS ph_managed,
             (b.kind = 'instore') AS is_instore,
             it.pre_sell AS is_presell,
             -- An empty shoe box: real stock, but never a pair and never sellable.
             (b.kind = 'boxes') AS is_box,
             -- Costable = the Costs page's backlog, and it must match
             -- listItemsMissingCost exactly or the badge counts rows the page
             -- won't show (COST_EXCLUDED_KINDS is the shared list). missing/issue
             -- are dead paperwork.
             (b.kind IS NULL OR b.kind <> ALL(${COST_EXCLUDED_KINDS})) AS costable
      FROM items it
      LEFT JOIN batches b ON b.id = it.batch_id
    ) i
  `;
  return rows[0] || {};
}

/* --------------------- PH-requested rescales --------------------------- */

// Link a request to the PAIRS it was raised for, by VIN. Resolving vin -> items.id
// here rather than trusting an id from the client: the grid already holds VINs, and a
// VIN is the thing the warehouse can actually read off a sticker. Unknown VINs are
// dropped silently — a link is evidence, not a gate, and a request must never fail to
// file because one pair was removed between the grid loading and the button being hit.
export async function linkRescaleRequestItems(requestId, vins) {
  const list = (Array.isArray(vins) ? vins : []).map((v) => String(v || '').trim().toUpperCase()).filter(Boolean).slice(0, 2000);
  if (!requestId || !list.length) return 0;
  const rows = await db()`
    INSERT INTO rescale_request_items (request_id, item_id)
    SELECT ${requestId}, i.id FROM items i WHERE upper(i.vin) = ANY(${list}::text[])
    ON CONFLICT DO NOTHING
    RETURNING item_id
  `;
  return rows.length;
}

export async function createRescaleRequest({ sku, skuAll, name, sizes, price, reason, note, by }) {
  const rows = await db()`
    INSERT INTO rescale_requests (sku, sku_all, name, sizes, price, reason, note, requested_by)
    VALUES (${sku}, ${skuAll || sku}, ${name || null}, ${JSON.stringify(sizes || [])}::jsonb, ${price ?? null},
            ${reason || null}, ${note || null}, ${by || null})
    RETURNING id, created_at
  `;
  return rows[0];
}

// `status` accepts one value, a LIST of them, or null for everything. The PH grid needs
// open AND audited in a single call (open = awaiting a count, audited = the work), and
// two round trips for one worklist is a race waiting to happen.
export async function listRescaleRequests(status = 'open', from = null, to = null) {
  const want = status == null ? null
    : (Array.isArray(status) ? status : [status]).map((s) => String(s)).filter(Boolean);
  const arr = want && want.length ? want : null;
  return await db()`
    SELECT r.id, r.sku, r.sku_all, r.name, r.sizes, r.actual_sizes, r.audit_note, r.cancel_note,
           r.price, r.reason, r.note, r.status,
           r.listing, r.listed_by, r.listed_at, r.edited_by, r.edited_at,
           r.requested_by, r.resolved_by, r.resolved_at, r.created_at,
           -- The pairs this request was raised for, as VINs (the grid keys on VIN).
           -- Empty for a request typed on the standalone form, which names no pairs.
           coalesce((
             SELECT array_agg(i.vin) FROM rescale_request_items l
             JOIN items i ON i.id = l.item_id WHERE l.request_id = r.id
           ), '{}') AS vins
    FROM rescale_requests r
    WHERE (${arr}::text[] IS NULL OR r.status = ANY(${arr}::text[]))
      AND (${from}::date IS NULL OR (r.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (r.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
    ORDER BY r.created_at DESC LIMIT 500
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

// PH corrects a request it already submitted: a miscounted size, one it forgot, the
// wrong reason or price — and the SKU itself.
//
// The SKU is editable by the user's explicit call (2026-08-27). It genuinely retargets
// the request: the warehouse's queue entry changes shoe, and the New Inventory
// "⟳ Rescale requested" chip moves to whichever row carries the new code. That is the
// point — a typo caught before anyone has counted is cheaper to fix than to cancel and
// re-raise. `sku_all` is rewritten alongside it, or the code picker would keep offering
// the OLD shoe's codes for the new SKU.
//
// ONLY while `open`, and the `status = 'open'` in the WHERE is the whole guard — the
// same rule (and the same reason) as cancelling. Once the warehouse has audited it,
// the reported numbers are one half of a reported-vs-actual comparison somebody made
// standing at a shelf; editing them afterwards would silently rewrite the question
// their count was the answer to. An audit landing mid-edit therefore wins, and the
// caller gets a 409 that says so. Returns `{ ok:false, status }` so the caller can
// name which of "gone" / "audited" / "cancelled" actually happened.
export async function updateRescaleRequest(id, { name, sizes, price, reason, note, sku, skuAll }, by) {
  const rows = await db()`
    UPDATE rescale_requests
    SET name = ${name || null}, sizes = ${JSON.stringify(sizes || [])}::jsonb,
        price = ${price}, reason = ${reason || null}, note = ${note || null},
        -- Both move together, or the picker offers the old shoe's codes for the new
        -- SKU. coalesce so an edit that doesn't touch the SKU leaves both alone.
        sku = coalesce(${sku || null}, sku),
        sku_all = CASE WHEN ${sku || null}::text IS NULL THEN sku_all ELSE ${skuAll || sku || null} END,
        edited_by = ${by || null}, edited_at = now()
    WHERE id = ${id} AND status = 'open' RETURNING id
  `;
  if (rows.length) return { ok: true };
  const cur = await db()`SELECT status FROM rescale_requests WHERE id = ${id}`;
  return { ok: false, status: cur[0]?.status || null };
}

// The end of the loop. `audited` is where a request used to stop, so the green
// "Audited" home badge counted up forever and the linked pairs never left the Rescale
// tab. Closing says the pairs it was raised for have been dealt with — re-listed, or
// the count settled — and both badges drop it for free, since they key on `status`.
//
// Only from `audited`: closing something nobody has counted would throw away the ask.
export async function closeRescaleRequest(id, by) {
  const rows = await db()`
    UPDATE rescale_requests
    SET status = 'closed', resolved_by = coalesce(resolved_by, ${by || null}), closed_by = ${by || null}, closed_at = now()
    WHERE id = ${id} AND status = 'audited' RETURNING id
  `;
  if (rows.length) return { ok: true };
  const cur = await db()`SELECT status FROM rescale_requests WHERE id = ${id}`;
  return { ok: false, status: cur[0]?.status || null };
}

// PH cancels a request it raised in error or no longer needs — it drops off the
// warehouse's Pending-audit queue and out of the home badge (which counts 'open').
//
// ONLY while the request is still `open`. Once the warehouse has audited it, that
// row carries a count somebody made standing at a shelf, and cancelling would throw
// it away; the `status = 'open'` in the WHERE is the whole guard, so losing a race
// against an audit fails cleanly instead of overwriting it. Returns false when the
// request is missing or has already moved on. It reports WHICH of those happened —
// `{ ok:false, status }` — so the caller can say "already audited" or "already
// cancelled" instead of one message that is wrong half the time.
export async function cancelRescaleRequest(id, note, by) {
  const rows = await db()`
    UPDATE rescale_requests
    SET status = 'cancelled', cancel_note = ${note || null},
        resolved_by = ${by || null}, resolved_at = now()
    WHERE id = ${id} AND status = 'open' RETURNING id
  `;
  if (rows.length) return { ok: true };
  const cur = await db()`SELECT status FROM rescale_requests WHERE id = ${id}`;
  return { ok: false, status: cur[0]?.status || null };
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

// Strict on purpose, unlike the reconciliation's `rcSizeNum` — that one strips a
// trailing W/Y so a supplier writing "7.5W" still matches "7.5". A UPC can't be
// that generous: a men's 10 and a women's 10 are different boxes with different
// codes, so the suffix stays part of the key. "M" is the bare men's run.
const upcSizeKey = (s) => {
  const t = String(s || '').trim().toUpperCase().replace(/\s+/g, '').replace(/^US/, '');
  const m = t.match(/^(\d+(?:\.\d+)?)([WYMC]?)$/);
  return m ? `${parseFloat(m[1])}${m[2] === 'M' ? '' : m[2]}` : t;
};

// Fill a MISSING UPC in across the stock, from a code somebody scanned on the
// Inventory or Box Labels page. The gap is real: receiving used to stamp one
// scanned code on every size in a box, and repairing that (2026-09-03) cleared
// 1,029 units' UPCs — after which nothing in the app could put one back except the
// No-Box prompt, one pair at a time.
//
// Three rules make it safe to run off a plain search:
//   • it only ever fills a BLANK. An existing UPC is never overwritten, so a scan
//     can't undo a correction somebody made by hand.
//   • the size comes from the UPC LOOKUP, never from the caller, and the match is
//     on sku + that exact size. A UPC identifies one size's box; lending it to the
//     rest of the run is the bug this whole area just came out of (`receiving.md`).
//   • sold/shipped pairs are included deliberately — the label on a box that's
//     already gone is still the record of what it was.
// How many pairs a scanned code WOULD fill in. Used to decide whether asking a
// person to check the shoe is worth their attention at all — a question whose
// answer changes nothing is a question that trains people to click through.
export async function countUnitsMissingUpc({ sku, size }) {
  const want = rcCodes(sku);
  const target = upcSizeKey(size);
  if (!want.length || !target) return 0;
  const rows = await db()`
    SELECT sku, size FROM items
     WHERE (upc IS NULL OR upc = '')
       AND upper(replace(replace(coalesce(sku, ''), ' ', ''), '-', '')) LIKE ${`%${want[0].replace(/[^A-Z0-9]/g, '')}%`}`;
  return rows.filter((r) => rcCodes(r.sku).some((c) => want.includes(c))
    && upcSizeKey(r.size) === target).length;
}

export async function backfillUpcBySkuSize({ upc, sku, size, by = null }) {
  const code = String(upc || '').replace(/\D/g, '');
  const want = rcCodes(sku);
  const target = upcSizeKey(size);
  if (!code || !want.length || !target) return [];
  const sql = db();
  // Narrow in SQL on the style code, then confirm in JS: a re-released shoe is
  // filed under BOTH its codes ("305381-007/CW2290-111"), which no equality test
  // matches, and a bare LIKE would also match a longer code that contains it.
  const like = `%${want[0].replace(/[^A-Z0-9]/g, '')}%`;
  const rows = await sql`
    SELECT id, vin, sku, size FROM items
     WHERE (upc IS NULL OR upc = '')
       AND upper(replace(replace(coalesce(sku, ''), ' ', ''), '-', '')) LIKE ${like}`;
  const ids = rows
    .filter((r) => rcCodes(r.sku).some((c) => want.includes(c)) && upcSizeKey(r.size) === target)
    .map((r) => r.id);
  if (!ids.length) return [];
  // Re-checked in the UPDATE too: the SELECT and the write are not one statement,
  // and two people scanning the same box at once must not fight over the row.
  const updated = await sql`
    UPDATE items SET upc = ${code}, updated_at = now()
    WHERE id = ANY(${ids}) AND (upc IS NULL OR upc = '')
    RETURNING id, vin, sku, size`;
  const text = `UPC ${code} filled in from a scan (size ${size})`;
  for (const r of updated) {
    await sql`INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${r.id}, 'note', ${JSON.stringify({ text })}::jsonb, ${by || null})`;
  }
  return updated;
}

/* ---------------------------- Cost backfill ---------------------------- */
// `items.cost` is written ONCE, at intake (insertItems ← intake.js: the item's own
// cost or the batch default). Suppliers routinely leave cost off a PO manifest, so
// pairs land with a NULL cost and nothing in the app could ever fill it in. These
// three power the Costs page.

// Both queries select the same column list by hand — the shim can't nest `sql`
// fragments, so a shared constant isn't an option here. Keep them in step.

// The backlog: units with no cost on file, newest first.
//
// `zero: true` switches it to the OTHER backlog — pairs recorded as costing exactly
// $0. Until toCost was fixed (intake.js), a blank cost box was stored as 0 rather
// than NULL, so an unknown cost was silently filed as "this shoe was free" and no
// "no cost on file" query could ever find it. Those rows are ambiguous — almost all
// are skipped blanks, a few may be genuine — so they get their own reviewable list
// instead of being folded into the backlog as if we knew which.
//
// `kind='existing'` is excluded deliberately. Counted-in old stock has no shipment,
// supplier, tracking or cost to capture by design, and there can be THOUSANDS of it
// (existing-stock.md) — leaving it in would bury the pairs that genuinely need a
// number under a backlog nobody will ever work. The `b.kind IS NULL` half matters:
// this is a LEFT JOIN, and a unit with no batch would otherwise fail the test.
// missing/issue units are dead paperwork, not something to cost.
export async function listItemsMissingCost(from = null, to = null, zero = false) {
  // One query, not an if/else pair: the shim can't nest `sql` fragments, and the two
  // branches are identical but for this one predicate — duplicating 15 lines of SELECT
  // to vary it is how the two drift out of step later.
  return await db()`
    SELECT i.vin, i.name, i.sku, i.size, i.gender, i.colorway, i.status,
           i.cost, i.created_at, i.created_by, i.batch_id,
           b.batch_code, b.supplier_name, b.kind, b.date_received
    FROM items i LEFT JOIN batches b ON b.id = i.batch_id
    WHERE (CASE WHEN ${zero}::boolean THEN i.cost = 0 ELSE i.cost IS NULL END)
      AND i.status NOT IN ('missing', 'issue')
      AND (b.kind IS NULL OR b.kind <> ALL(${COST_EXCLUDED_KINDS}))
      AND (${from}::date IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date   IS NULL OR (i.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
    ORDER BY i.created_at DESC, i.sku, i.id
    LIMIT 5000
  `;
}

// The search half: every unit of the SKU behind a VIN / UPC / SKU, costed or not,
// so a cost that's already there but WRONG can be corrected. Scanning one pair's VIN
// returns the whole SKU on purpose — you're pricing a shipment, not a single box.
export async function listItemCostsByCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return [];
  // Same rule as findStockByCode: a UPC only if the code is digits end to end, and
  // SKUs compared with spaces/dashes stripped so "DQ8426-109" and "DQ8426 109" match.
  const bare = raw.replace(/\s/g, '');
  const upc = /^\d{8,14}$/.test(bare) ? bare : null;
  const sku = raw.toUpperCase().replace(/[\s-]/g, '');
  const vin = raw.toUpperCase();
  return await db()`
    WITH hits AS (
      SELECT DISTINCT sku FROM items
       WHERE sku IS NOT NULL
         AND (upper(replace(replace(coalesce(sku, ''), ' ', ''), '-', '')) = ${sku}
              OR vin = ${vin}
              OR (${upc}::text IS NOT NULL AND regexp_replace(coalesce(upc, ''), '\\D', '', 'g') = ${upc}))
       LIMIT 5
    )
    SELECT i.vin, i.name, i.sku, i.size, i.gender, i.colorway, i.status,
           i.cost, i.created_at, i.created_by, i.batch_id,
           b.batch_code, b.supplier_name, b.kind, b.date_received
    FROM items i LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.sku IN (SELECT sku FROM hits)
      AND i.status NOT IN ('missing', 'issue')
    ORDER BY i.created_at DESC, i.size, i.id
    LIMIT 2000
  `;
}

// Set (or clear) the cost on a set of units. Blank writes NULL, never 0 — "I don't
// know what this cost" is not the same claim as "this was free", the same rule the
// PO lines follow (purchase-orders.md). Terminal units are editable on purpose: a
// pair that already sold still needs its cost for the margin to mean anything.
export async function setItemsCost(vins, cost, by) {
  const list = (vins || []).filter(Boolean);
  if (!list.length) return [];
  const sql = db();
  const rows = await sql`
    UPDATE items SET cost = ${cost}, updated_at = now()
    WHERE vin = ANY(${list})
    RETURNING id, vin, cost
  `;
  const text = cost == null ? 'Cost cleared' : `Cost set to $${Number(cost).toFixed(2)}`;
  for (const r of rows) {
    await sql`INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${r.id}, 'note', ${JSON.stringify({ text })}::jsonb, ${by || null})`;
  }
  return rows;
}

// Toggle "GOAT only" (list to Alias/GOAT + II only) across a set of units — used
// from Receiving (whole shoe) and the PH grid (a SKU group).
//
// Every change is LOGGED to each unit's history. This used to write nothing at all,
// which made the one flag that decides whether a pair is ever listed to StockX /
// Shopify the only field on the row with no answer to "who set this, and when" —
// and a GOAT-only unit is excluded from the StockX/Shopify pending counts
// (`pendingCounts`), so a wrong flag never surfaces as a backlog anywhere. When a
// group merged an unrelated delivery and the chip was clicked, there was no trace.
export async function setItemsGoatOnly(vins, goatOnly, by) {
  const list = (vins || []).filter(Boolean);
  if (!list.length) return [];
  const sql = db();
  // Sold/shipped are left alone: GOAT-only decides where a pair gets LISTED, and a
  // pair that's gone is past that (matches phUpdateGroup and the read-only grid row).
  const rows = await sql`
    UPDATE items SET goat_only = ${!!goatOnly}, updated_at = now()
    WHERE vin = ANY(${list}) AND status NOT IN ('sold', 'shipped')
    RETURNING id, vin, goat_only
  `;
  const text = goatOnly
    ? 'GOAT only turned ON — lists to Alias (GOAT) + Intelligent Inventory only'
    : 'GOAT only turned OFF — lists to all stores';
  for (const r of rows) {
    await sql`INSERT INTO item_events (item_id, type, details, created_by)
      VALUES (${r.id}, 'ph_update', ${JSON.stringify({ text })}::jsonb, ${by || null})`;
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Pre-printed VIN/1ID roll stock — the "VIN Project".                  */
/* ------------------------------------------------------------------ */

// Mint `count` blank stickers into vin_stock and return them in print order.
// One run_id per batch so a jammed print can be reprinted from where it stopped.
// nextval is atomic, so two people minting at once can never get the same number.
export async function mintVinStock(count, by) {
  const n = Math.min(2000, Math.max(1, Number(count) || 0));
  const sql = db();
  const [{ run_id: runId }] = await sql`SELECT coalesce(max(run_id), 0) + 1 AS run_id FROM vin_stock`;
  const rows = await sql`
    INSERT INTO vin_stock (vin, run_id, printed_by)
    SELECT 'SBM-R-' || lpad(nextval('vin_roll_seq')::text, 6, '0'), ${runId}, ${by || null}
      FROM generate_series(1, ${n})
    RETURNING vin
  `;
  return { runId, vins: rows.map((r) => r.vin) };
}

// What a scanned sticker is, for the guard at scan time.
// 'unknown' = not ours / mis-scan; 'assigned' = already on a shoe (with which one).
export async function checkVinStock(vin) {
  const v = String(vin || '').trim().toUpperCase();
  if (!v) return { state: 'unknown' };
  const rows = await db()`
    SELECT s.vin, s.status, s.run_id, s.printed_at, s.assigned_at, s.voided_at,
           i.vin AS item_vin, i.sku, i.size, i.name
      FROM vin_stock s
      LEFT JOIN items i ON i.id = s.assigned_item_id
     WHERE s.vin = ${v}
  `;
  if (!rows.length) return { state: 'unknown' };
  const r = rows[0];
  // The dates/run are for people READING a sticker's status (Inventory's lookup),
  // not for intake, which only branches on `state`.
  return {
    state: r.status,
    runId: r.run_id,
    printedAt: r.printed_at,
    assignedAt: r.assigned_at,
    voidedAt: r.voided_at,
    item: r.item_vin ? { vin: r.item_vin, sku: r.sku, size: r.size, name: r.name } : null,
  };
}

// Claim stickers for the units they were just scanned onto. **Compare-and-swap** —
// `WHERE status = 'available'` means two people who scanned the same sticker can't
// both win; the loser gets it back in `failed` and the caller 409s naming the VIN.
// Same TOCTOU pattern as commitBoxItems.
//
// A sticker NOT in vin_stock is not an error here: intake accepts a scan the server
// couldn't vet (flaky warehouse Wi-Fi must never stop intake), and `items.vin` is
// UNIQUE NOT NULL, so the real double-assign guard is the insert itself. This records
// what it can.
export async function claimVinStock(pairs) {
  const list = (pairs || []).filter((p) => p && p.vin && p.itemId != null);
  if (!list.length) return { claimed: [], failed: [] };
  const sql = db();
  const claimed = [];
  const failed = [];
  for (const p of list) {
    const vin = String(p.vin).trim().toUpperCase();
    const rows = await sql`
      UPDATE vin_stock
         SET status = 'assigned', assigned_item_id = ${p.itemId}, assigned_at = now()
       WHERE vin = ${vin} AND status = 'available'
      RETURNING vin
    `;
    if (rows.length) claimed.push(vin);
    else {
      // Either it was never ours, or someone else took it first. Tell them apart so
      // the caller can say which — "not one of ours" and "already used" are very
      // different mistakes on the warehouse floor.
      const known = await sql`SELECT status FROM vin_stock WHERE vin = ${vin}`;
      if (known.length) failed.push({ vin, reason: known[0].status === 'void' ? 'void' : 'taken' });
    }
  }
  return { claimed, failed };
}

// Void a torn/lost/misprinted sticker so it can never be assigned. Never reused —
// same rule as the dated VINs: numbering gaps are fine, a reused number is not.
export async function voidVinStock(vins, by) {
  const list = [...new Set((vins || []).map((v) => String(v).trim().toUpperCase()).filter(Boolean))];
  if (!list.length) return [];
  return await db()`
    UPDATE vin_stock SET status = 'void', voided_by = ${by || null}, voided_at = now()
     WHERE vin = ANY(${list}) AND status <> 'assigned'
    RETURNING vin
  `;
}

// The stock page: how many stickers are left, and the recent print runs.
export async function getVinStockSummary() {
  const sql = db();
  const [counts] = await sql`
    SELECT count(*) FILTER (WHERE status = 'available')::int AS available,
           count(*) FILTER (WHERE status = 'assigned')::int  AS assigned,
           count(*) FILTER (WHERE status = 'void')::int      AS void
      FROM vin_stock
  `;
  const runs = await sql`
    SELECT run_id, count(*)::int AS total,
           count(*) FILTER (WHERE status = 'available')::int AS available,
           min(vin) AS first_vin, max(vin) AS last_vin,
           min(printed_at) AS printed_at, min(printed_by) AS printed_by
      FROM vin_stock
     WHERE run_id IS NOT NULL
     GROUP BY run_id
     ORDER BY run_id DESC
     LIMIT 20
  `;
  return { counts, runs };
}

// Every sticker in one run, in print order — for reprinting a run that jammed.
export async function getVinRun(runId) {
  return await db()`
    SELECT vin, status FROM vin_stock WHERE run_id = ${Number(runId)} ORDER BY vin
  `;
}

// Delete pairs outright, archiving each one first. Used by "remove" on Inventory
// and New Inventory, where a miscount has to be corrected: every count, both pages
// and the batch's own received total have to read true afterwards, which a status
// change can't deliver.
//
// The archive is written BEFORE the delete for a reason that isn't obvious:
// item_events is `ON DELETE CASCADE`, so deleting the item silently takes its whole
// history with it. `to_jsonb(i)` freezes the entire row (not a hand-listed subset,
// which would quietly drop any column added later) and the events go with it.
//
// Sold/shipped pairs are refused — that money already happened, `sales` cascades off
// items too, and "we miscounted" is never the reason a sold pair leaves.
export async function deleteItems(vins, reason, by) {
  const list = [...new Set((vins || []).filter(Boolean))];
  if (!list.length) return { deleted: [], blocked: [] };
  const sql = db();
  const rows = await sql`
    SELECT i.id, i.vin, i.sku, i.name, i.size, i.status, i.batch_id, i.cost,
           i.created_at, i.created_by, b.batch_code, to_jsonb(i) AS item_json,
           coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at)
                       FROM item_events e WHERE e.item_id = i.id), '[]'::jsonb) AS events
      FROM items i LEFT JOIN batches b ON b.id = i.batch_id
     WHERE i.vin = ANY(${list})
  `;
  const blocked = rows.filter((r) => TERMINAL_STATUSES.includes(r.status)).map((r) => r.vin);
  const doomed = rows.filter((r) => !TERMINAL_STATUSES.includes(r.status));
  if (!doomed.length) return { deleted: [], blocked };

  // Archive every row, then delete in ONE statement so a half-archived batch can't
  // survive a mid-loop failure as live stock with a tombstone already filed.
  // JSON.stringify + ::jsonb, not the bare value: node-pg serializes a JS ARRAY as a
  // Postgres array literal (`{...}`), so passing `events` straight through writes
  // something that isn't JSON and the insert dies on "invalid input syntax for type json".
  const queries = doomed.map((r) => sql`
    INSERT INTO deleted_items
      (vin, item_id, sku, name, size, status, batch_id, batch_code, cost,
       scanned_at, scanned_by, reason, item_json, events, deleted_by)
    VALUES
      (${r.vin}, ${r.id}, ${r.sku}, ${r.name}, ${r.size}, ${r.status}, ${r.batch_id},
       ${r.batch_code}, ${r.cost}, ${r.created_at}, ${r.created_by}, ${reason || null},
       ${JSON.stringify(r.item_json)}::jsonb, ${JSON.stringify(r.events)}::jsonb, ${by || null})
  `);
  const ids = doomed.map((r) => r.id);
  queries.push(sql`DELETE FROM items WHERE id = ANY(${ids})`);
  await sql.transaction(queries);
  return { deleted: doomed.map((r) => r.vin), blocked };
}

// The Deleted page: what was removed, newest first. `q` matches SKU / VIN / name.
export async function listDeletedItems({ q = null, from = null, to = null, limit = 500 } = {}) {
  const like = q ? `%${String(q).trim()}%` : null;
  return await db()`
    SELECT id, vin, sku, name, size, status, batch_code, cost, reason,
           scanned_at, scanned_by, deleted_by, deleted_at, events
      FROM deleted_items
     WHERE (${like}::text IS NULL OR sku ILIKE ${like} OR vin ILIKE ${like} OR name ILIKE ${like})
       AND (${from}::date IS NULL OR (deleted_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
       AND (${to}::date   IS NULL OR (deleted_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
     ORDER BY deleted_at DESC, id DESC
     LIMIT ${Math.min(2000, Math.max(1, Number(limit) || 500))}
  `;
}

export async function markBoxFound(itemId, createdBy) {
  const sql = db();
  await sql.transaction([
    sql`UPDATE items SET with_box = true, status = 'needs_shelf', updated_at = now() WHERE id = ${itemId}`,
    sql`INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${itemId}, 'status_change', ${JSON.stringify({ status: 'needs_shelf', note: 'Box found — now With Box' })}::jsonb, ${createdBy || null})`,
  ]);
}

// Empty boxes ON THE SHELF that fit a given shoe, newest last so the oldest carton gets
// used first. `size` is what the person actually asks by ("I need a box for a 10.5"), and
// the SKU narrows it to the right model when we have one for it.
//
// `used` boxes are excluded by status, not by `used_on_item_id IS NULL`: a box that was
// put on a pair and then the pair was un-boxed again would have kept its link, and a
// second use of one physical carton is the exact bug this table exists to prevent.
export async function findAvailableBoxes({ sku = null, size = null, limit = 50 } = {}) {
  const sql = db();
  return await sql`
    SELECT i.id, i.vin, i.name, i.sku, i.size, i.dimensions, i.status, i.cost,
           i.location_code, i.location_id, b.batch_code
    FROM items i
    JOIN batches b ON b.id = i.batch_id
    WHERE b.kind = 'boxes'
      AND i.status IN ('needs_shelf', 'in_stock')
      AND i.used_on_item_id IS NULL
      AND (${sku}::text  IS NULL OR upper(replace(i.sku, '-', '')) = upper(replace(${sku}::text, '-', '')))
      AND (${size}::text IS NULL OR i.size = ${size}::text)
    ORDER BY i.created_at, i.id
    LIMIT ${Math.min(200, Math.max(1, limit))}
  `;
}

// How many empty boxes we hold, grouped the way somebody asks for one: by shoe and size,
// with the cartons they come in. Drives the "find a box" screen.
export async function boxStockOnHand({ sku = null, size = null } = {}) {
  const sql = db();
  return await sql`
    SELECT i.sku, max(i.name) AS name, i.size, i.dimensions,
           count(*)::int AS qty,
           count(*) FILTER (WHERE i.status = 'in_stock')::int AS shelved,
           (array_agg(DISTINCT i.location_code) FILTER (WHERE i.location_code IS NOT NULL)) AS locations
    FROM items i
    JOIN batches b ON b.id = i.batch_id
    WHERE b.kind = 'boxes'
      AND i.status IN ('needs_shelf', 'in_stock')
      AND i.used_on_item_id IS NULL
      AND (${sku}::text  IS NULL OR upper(replace(i.sku, '-', '')) = upper(replace(${sku}::text, '-', '')))
      AND (${size}::text IS NULL OR i.size = ${size}::text)
    GROUP BY i.sku, i.size, i.dimensions
    ORDER BY max(i.name), i.size, i.dimensions
  `;
}

// Put an empty box ON a pair that arrived without one: the pair becomes sellable exactly
// as "Box found" already made it, and the box row is spent.
//
// BOTH rows carry the link, and the box's status becomes terminal — otherwise one carton
// could be handed to two different shoes, which is the same class of bug as selling one
// pair twice. Done in a single transaction for that reason: a pair marked boxed with the
// carton still on the shelf is worse than neither.
export async function useBoxOnItem({ boxId, itemId, createdBy }) {
  const sql = db();
  const box = (await sql`
    SELECT i.*, b.kind FROM items i JOIN batches b ON b.id = i.batch_id WHERE i.id = ${boxId}
  `)[0];
  if (!box) return { error: 'That box was not found.' };
  if (box.kind !== 'boxes') return { error: `${box.vin} is a pair, not an empty box.` };
  if (box.used_on_item_id) return { error: `${box.vin} has already been used on another pair.` };
  if (!['needs_shelf', 'in_stock'].includes(box.status))
    return { error: `${box.vin} is ${box.status} — only a box on the shelf can be used.` };

  const pair = (await sql`SELECT * FROM items WHERE id = ${itemId}`)[0];
  if (!pair) return { error: 'That pair was not found.' };

  await sql.transaction([
    sql`UPDATE items SET with_box = true, status = 'needs_shelf', updated_at = now() WHERE id = ${itemId}`,
    sql`INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${itemId}, 'status_change',
                ${JSON.stringify({ status: 'needs_shelf', note: `Boxed from stock — empty box ${box.vin}${box.dimensions ? ` (${box.dimensions})` : ''}` })}::jsonb,
                ${createdBy || null})`,
    // The box is spent. 'used' is terminal (api/_lib/statuses.js), so it can never be
    // shelved or handed out again.
    sql`UPDATE items SET status = 'used', used_on_item_id = ${itemId}, used_at = now(),
          location_id = NULL, location_code = NULL, updated_at = now()
        WHERE id = ${boxId}`,
    sql`INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${boxId}, 'status_change',
                ${JSON.stringify({ status: 'used', note: `Used on ${pair.vin}${pair.name ? ` — ${pair.name}` : ''}${pair.size ? ` size ${pair.size}` : ''}` })}::jsonb,
                ${createdBy || null})`,
  ]);
  return { ok: true, boxVin: box.vin, pairVin: pair.vin };
}

/* ---------------------- Pre-sell (sold before it landed) ---------------- */

// The Pre-sell worklist: what arrived on pre-sell shipments, grouped the way the question
// is asked — by shipment, then shoe, then size. `sold` is how many of that row have been
// identified as covered by an order (status pre_sold); `remains` is what will be released
// for listing.
export async function listPreSellGroups({ batchId = null } = {}) {
  const sql = db();
  return await sql`
    SELECT b.id AS batch_id, b.batch_code, b.supplier_name, b.date_received,
           i.sku, max(i.name) AS name, i.size,
           count(*)::int AS arrived,
           count(*) FILTER (WHERE i.status = 'pre_sold')::int AS sold,
           count(*) FILTER (WHERE i.status <> 'pre_sold')::int AS remains
    FROM items i
    JOIN batches b ON b.id = i.batch_id
    WHERE i.pre_sell
      AND i.status NOT IN ('sold', 'shipped', 'missing', 'issue')
      AND (${batchId}::bigint IS NULL OR b.id = ${batchId}::bigint)
    GROUP BY b.id, b.batch_code, b.supplier_name, b.date_received, i.sku, i.size
    ORDER BY b.date_received DESC NULLS LAST, b.id DESC, max(i.name), i.size
  `;
}

// Set how many of one (batch, sku, size) row are spoken for.
//
// The units are interchangeable — same shoe, same size, none of them shelved yet — so
// which VIN carries which order is not a decision anybody needs to make. Taking the
// OLDEST first keeps it deterministic rather than arbitrary. Lowering the number hands
// units back, which is what happens when a pre-sale falls through.
//
// `pre_sold` and not `sold`: the pair is still on our floor and has not shipped. It
// reaches `sold`/`shipped` through the normal scan when it actually leaves — and `sold`
// is terminal here, so claiming it early would strand a unit if the order collapsed.
export async function setPreSellSold({ batchId, sku, size, qty, createdBy }) {
  const sql = db();
  const rows = await sql`
    SELECT id, status FROM items
    WHERE batch_id = ${batchId} AND sku = ${sku} AND coalesce(size, '') = coalesce(${size}, '')
      AND pre_sell AND status NOT IN ('sold', 'shipped', 'missing', 'issue')
    ORDER BY id
  `;
  const want = Math.max(0, Math.min(rows.length, Number(qty) || 0));
  const marked = rows.filter((r) => r.status === 'pre_sold');
  const free = rows.filter((r) => r.status !== 'pre_sold');
  const toMark = free.slice(0, Math.max(0, want - marked.length)).map((r) => r.id);
  const toClear = marked.slice(want).map((r) => r.id);   // only when the number came DOWN
  const q = [];
  if (toMark.length) {
    q.push(sql`UPDATE items SET status = 'pre_sold', updated_at = now() WHERE id = ANY(${toMark})`);
    q.push(sql`INSERT INTO item_events (item_id, type, details, created_by)
               SELECT unnest(${toMark}::bigint[]), 'status_change',
                      ${JSON.stringify({ status: 'pre_sold', note: 'Covered by a pre-sale' })}::jsonb, ${createdBy || null}`);
  }
  if (toClear.length) {
    q.push(sql`UPDATE items SET status = 'needs_shelf', updated_at = now() WHERE id = ANY(${toClear})`);
    q.push(sql`INSERT INTO item_events (item_id, type, details, created_by)
               SELECT unnest(${toClear}::bigint[]), 'status_change',
                      ${JSON.stringify({ status: 'needs_shelf', note: 'Pre-sale released — no longer spoken for' })}::jsonb, ${createdBy || null}`);
  }
  if (q.length) await sql.transaction(q);
  return { marked: toMark.length, cleared: toClear.length, total: rows.length };
}

// Mark ONE named unit as covered by a pre-sale. The scan path: same end state as the
// count, but it names the pair rather than letting the system choose.
export async function markPreSoldByVin(vin, createdBy) {
  const sql = db();
  const it = (await sql`SELECT id, vin, sku, size, name, status, pre_sell FROM items WHERE vin = ${String(vin).trim().toUpperCase()}`)[0];
  if (!it) return { error: `No unit found for ${vin}.` };
  if (!it.pre_sell) return { error: `${it.vin} is not on a pre-sell shipment.` };
  if (it.status === 'pre_sold') return { error: `${it.vin} is already marked as sold.` };
  if (['sold', 'shipped'].includes(it.status)) return { error: `${it.vin} is already ${it.status}.` };
  await sql.transaction([
    sql`UPDATE items SET status = 'pre_sold', updated_at = now() WHERE id = ${it.id}`,
    sql`INSERT INTO item_events (item_id, type, details, created_by)
        VALUES (${it.id}, 'status_change', ${JSON.stringify({ status: 'pre_sold', note: 'Covered by a pre-sale (scanned)' })}::jsonb, ${createdBy || null})`,
  ]);
  return { ok: true, item: it };
}

// Release what is left over for listing.
//
// Clearing `pre_sell` and setting `restock_pending` puts the units on PH's Rescale Stock
// worklist — the existing place where stock gets priced and pushed to II and the stores.
// Nothing new had to be invented for "subject for upload"; that worklist already is it.
//
// Units already marked pre_sold are LEFT ALONE: they are spoken for, and listing them
// would offer somebody else's pair for sale.
export async function releasePreSell({ batchId, createdBy }) {
  const sql = db();
  const rows = await sql`
    UPDATE items SET pre_sell = false, restock_pending = true, updated_at = now()
    WHERE batch_id = ${batchId} AND pre_sell
      AND status NOT IN ('pre_sold', 'sold', 'shipped', 'missing', 'issue')
    RETURNING id
  `;
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await sql`INSERT INTO item_events (item_id, type, details, created_by)
              SELECT unnest(${ids}::bigint[]), 'rescaled',
                     ${JSON.stringify({ note: 'Released from pre-sell — sent for rescale and listing' })}::jsonb, ${createdBy || null}`;
  }
  return { released: ids.length };
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
  // Sold/shipped are excluded the same way: the pair is gone, so it is done as far as
  // listing goes and PH must not re-price or re-flag it. The grid already hides Edit on
  // those rows (`closed` from lib/ph.js) — this is the guard for a tab that loaded
  // before the warehouse scanned it out. Same status pair as getItemsForGiRefresh.
  const curRows = await sql`
    SELECT i.id, i.vin, i.price, i.global_indicator, i.added_to_intel_inv, i.synced_alias, i.synced_stockx, i.synced_shopify, i.listed_price,
           i.goat_only, i.ph_note, i.last_edit_at, i.last_edit_by
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.vin = ANY(${allVins}) AND i.status NOT IN ('sold', 'shipped')
      AND (b.kind IS NULL OR b.kind <> ALL(${PH_EXCLUDED_KINDS}))
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
      //
      // EXCEPT on a GOAT-only pair, where II is not the master — it isn't in the
      // picture at all. "GOAT only" means Alias and nowhere else, so the grid shows
      // II as N/A, PH can't tick it, and every save sends `added_to_intel_inv:false`.
      // Cascading off that flag therefore wiped the Alias tick straight back off on
      // save: PH ticked AL, submitted, and the row came back unlisted, forever
      // (reported on prod for CU9225-100). This is the same trap the GOAT-only
      // completion rule hit on 2026-08-19 — a rule keyed on II, applied to the one
      // kind of row that is deliberately never on II. Anything else keyed on
      // `added_to_intel_inv` needs the same question asked of it.
      if (!next.intel && !cur.goat_only) { next.alias = false; next.stockx = false; next.shopify = false; }
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
      // A GOAT-only pair is "listed" when Alias is ticked — II is never involved, so
      // basing its snapshot on II would leave it permanently null.
      const listedPrice = (next.intel || (cur.goat_only && next.alias)) ? next.price : null;
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
// WHERE A PAIR CAME FROM — its batch, the parcel it arrived in, and whether that
// shipment was received against a purchase order (2026-08-28).
//
// Three things people ask of a pair and could not answer from its history: which batch,
// which tracking number, and which PO — or plainly that there ISN'T one. All derived,
// so it is true for stock received long before this existed.
//
// ⚠️ The tracking number is the pair's OWN BOX first, and only then its batch. The
// ordinary receive keeps tracking on the batch and leaves items.box_id NULL (see
// docs/context/receiving.md), while a multi-box batch has a different number per box —
// reading the batch's number for a boxed pair would name the wrong parcel.
export async function provenanceForVins(vins) {
  const list = [...new Set((vins || []).map((v) => String(v || '').trim().toUpperCase()).filter(Boolean))];
  if (!list.length) return [];
  const rows = await db()`
    SELECT i.vin,
           b.batch_code, b.tracking_number AS batch_tracking, b.no_tracking, b.kind AS batch_kind,
           b.po_id, b.po_link_source, b.po_linked_at, b.po_linked_by,
           (SELECT bx.tracking_number FROM batch_boxes bx WHERE bx.id = i.box_id) AS box_tracking,
           (SELECT bx.box_number     FROM batch_boxes bx WHERE bx.id = i.box_id) AS box_number,
           (SELECT p.po_code FROM purchase_orders p WHERE p.id = b.po_id) AS po_code,
           (SELECT p.status  FROM purchase_orders p WHERE p.id = b.po_id) AS po_status,
           -- Which of the order's LABELS this parcel is, matched the way everything else
           -- matches a parcel to a label: by tracking number, never by a typed number.
           (SELECT pb.box_number FROM po_boxes pb
             WHERE pb.po_id = b.po_id
               AND coalesce(pb.tracking_number, '') <> ''
               AND upper(replace(pb.tracking_number, ' ', '')) =
                   upper(replace(coalesce(
                     (SELECT bx.tracking_number FROM batch_boxes bx WHERE bx.id = i.box_id),
                     b.tracking_number, ''), ' ', ''))
             LIMIT 1) AS po_label_number
    FROM items i
    LEFT JOIN batches b ON b.id = i.batch_id
    WHERE i.vin = ANY(${list})`;
  return rows.map((r) => ({ vin: r.vin, ...provenanceOf(r) }));
}

// Fold the raw columns into the shape both screens render, so "received against a PO"
// is decided once rather than by each caller reading po_id and guessing.
export function provenanceOf(row) {
  if (!row) return null;
  const tracking = row.box_tracking || row.batch_tracking || null;
  return {
    batch_code: row.batch_code || null,
    batch_kind: row.batch_kind || null,
    box_number: row.box_number != null ? Number(row.box_number) : null,
    tracking,
    // A stated "no tracking number" is a fact someone recorded; a blank one is just blank.
    no_tracking: !tracking && row.no_tracking === true,
    against_po: !!row.po_id,
    po_code: row.po_code || null,
    po_status: row.po_status || null,
    po_label_number: row.po_label_number != null ? Number(row.po_label_number) : null,
    // 'receiving' = scanned in against the order · 'linked' = attached afterwards ·
    // null = it happened before we recorded which, and saying either would be a guess.
    link_source: row.po_id ? (row.po_link_source || null) : null,
    linked_at: row.po_linked_at || null,
    linked_by: row.po_linked_by || null,
  };
}

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
  const [provenance] = await provenanceForVins([vin]);
  const events = await db()`
    SELECT id, type, details, created_by, created_at
    FROM item_events WHERE item_id = ${rows[0].id} ORDER BY created_at, id
  `;
  return { item: rows[0], events, provenance: provenance || null };
}

// Combined event history for a set of VINs (a PH grid size line covers several
// identical units). Returns events newest-first with the owning VIN attached, so
// the PH/admin/warehouse History view can show who changed what, when.
// The PH grid's History covers a whole size line (several identical pairs), so it gets
// provenance PER VIN beside the events — two pairs on one line can genuinely have arrived
// in different parcels, and a single line at the top would be a claim about both.
export async function getEventsWithProvenance(vins, limit = 500) {
  const [events, provenance] = await Promise.all([
    getEventsForVins(vins, limit),
    provenanceForVins(vins),
  ]);
  return { events, provenance };
}

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
export async function createPo({ supplierName, supplierUserId, tagCode, dateOfPurchase, notes, labels, createdBy, orderKind = 'shoes', raisedBy = 'ph' }) {
  const sql = db();
  const boxNumbers = labels.map((_, i) => i + 1);
  const trackings = labels.map((l) => (String(l.trackingNumber || '').trim() || null));
  const carrierKeys = labels.map((l) => (Number.isInteger(Number(l.carrierKey)) && Number(l.carrierKey) > 0 ? Number(l.carrierKey) : null));
  const rows = await sql`
    WITH po AS (
      INSERT INTO purchase_orders
        (supplier_name, supplier_user_id, tag_code, date_of_purchase, expected_boxes, notes, created_by, order_kind, raised_by)
      VALUES (${supplierName}, ${supplierUserId || null}, ${tagCode || null}, ${dateOfPurchase || null},
              ${labels.length}, ${notes || null}, ${createdBy || null}, ${orderKind === 'boxes' ? 'boxes' : 'shoes'},
              ${raisedBy === 'supplier' ? 'supplier' : 'ph'})
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
  // `received_units` = what the WAREHOUSE actually counted into this label's box, beside
  // what the supplier declared for it. A label on an order raised after the boxes landed
  // has no manifest at all, so its declared total is legitimately 0 — and a card reading
  // "0 units" next to a box with twelve pairs already scanned out of it reads as "this
  // box is empty", which is the opposite of the truth. Same fix as the PO list's
  // "0 declared · 48 received" (staff-only there and here: a supplier must not read our
  // count off the screen before the reconciliation is settled with them).
  //
  // The join is the TRACKING NUMBER — batch_boxes has no po_box_id, so that string is the
  // only thing tying a received box to a label (the link-batch preview matches the same
  // way). The second half covers a receive that never made a box row: a single-box batch
  // keeps its tracking on the batch itself and leaves items.box_id NULL.
  const boxes = await sql`
    SELECT b.*,
      (SELECT count(*) FROM items i
         JOIN batch_boxes x ON x.id = i.box_id
         JOIN batches bt   ON bt.id = x.batch_id
        WHERE bt.po_id = ${id} AND coalesce(b.tracking_number, '') <> ''
          AND upper(replace(coalesce(x.tracking_number, ''), ' ', '')) = upper(replace(b.tracking_number, ' ', '')))::int
      +
      (SELECT count(*) FROM items i
         JOIN batches bt ON bt.id = i.batch_id
        WHERE bt.po_id = ${id} AND i.box_id IS NULL AND coalesce(b.tracking_number, '') <> ''
          AND upper(replace(coalesce(bt.tracking_number, ''), ' ', '')) = upper(replace(b.tracking_number, ' ', '')))::int
      AS received_units
    FROM po_boxes b WHERE b.po_id = ${id} ORDER BY b.box_number`;
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
// Every box still inbound, one row per box, for the Inbound feed. Answers the question
// the warehouse actually opens the day with -- what is coming, from whom, and which of
// it has stopped moving -- which until now meant opening orders one at a time.
//
// Order-level expected/received reuse the SAME expressions as listPos (replacements
// excluded from expected, or a delivered count can exceed its own denominator). Two
// answers to "how many were we promised" is worse than none.
//
// `last_move_at` is the newest CARRIER checkpoint, not checked_at: checked_at moves when
// anyone hits Refresh, so a stalled parcel would look freshly alive every time somebody
// looked at it. Falls back to checked_at only when a box has no event history at all.
// Classification of these rows lives in src/lib/inbound.js so the screen, the counts and
// any later alert all read the same rules.
// (No backticks in here: this comment lives inside a JS template literal.)
// Courier state for a tracking number, wherever that number came from. The webhook
// keeps writing po_boxes as it always did; this is the copy the WAREHOUSE side reads,
// and the only one a number typed at receiving can have.
//
// Written on every push, so `checked_at` moves whenever the carrier says anything.
// COALESCE on each field: a later push that omits a field must not blank what an
// earlier one told us.
export async function upsertShipmentTracking(trackingNumber, {
  carrier, carrierKey, trackingStatus, subStatus, subStatusDescr, lastCheckpoint, events,
} = {}) {
  // Canonical key: the same parcel typed with spaces in one field and without in
  // another must be ONE row, or the page reads the empty one.
  const num = normalizeTrackingNumber(trackingNumber);
  if (!num) return null;
  const rows = await db()`
    INSERT INTO shipment_tracking (tracking_number, carrier, carrier_key, tracking_status,
      tracking_sub_status, tracking_sub_status_descr, last_checkpoint, tracking_events, checked_at)
    VALUES (${num}, ${carrier ?? null}, ${carrierKey ?? null}, ${trackingStatus ?? null},
      ${subStatus ?? null}, ${subStatusDescr ?? null}, ${lastCheckpoint ?? null},
      ${events ? JSON.stringify(events) : null}::jsonb, now())
    ON CONFLICT (tracking_number) DO UPDATE SET
      carrier             = COALESCE(EXCLUDED.carrier, shipment_tracking.carrier),
      carrier_key         = COALESCE(EXCLUDED.carrier_key, shipment_tracking.carrier_key),
      tracking_status     = COALESCE(EXCLUDED.tracking_status, shipment_tracking.tracking_status),
      tracking_sub_status = COALESCE(EXCLUDED.tracking_sub_status, shipment_tracking.tracking_sub_status),
      tracking_sub_status_descr = COALESCE(EXCLUDED.tracking_sub_status_descr, shipment_tracking.tracking_sub_status_descr),
      last_checkpoint     = COALESCE(EXCLUDED.last_checkpoint, shipment_tracking.last_checkpoint),
      tracking_events     = COALESCE(EXCLUDED.tracking_events, shipment_tracking.tracking_events),
      checked_at          = now()
    RETURNING tracking_number`;
  return rows[0] || null;
}

// Claim numbers for registration. Inserting the row IS the claim: `registered_at` is
// stamped in the same statement, so two receives of the same parcel cannot both spend
// quota on it, and a number already known is silently skipped. Returns only the
// numbers this call is responsible for registering.
export async function claimForTracking(numbers) {
  const list = [...new Set((numbers || []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (!list.length) return [];
  const rows = await db()`
    INSERT INTO shipment_tracking (tracking_number, registered_at)
    SELECT n, now() FROM unnest(${list}::text[]) AS n
    ON CONFLICT (tracking_number) DO UPDATE
      SET registered_at = now()
      WHERE shipment_tracking.registered_at IS NULL
    RETURNING tracking_number`;
  return rows.map((r) => r.tracking_number);
}

// Numbers we hold that were never registered with the courier feed — the backlog the
// one-off backfill works through. Warehouse-typed numbers only ever reached
// batch_boxes, so that is where the gap is.
export async function listUnregisteredTracking(limit = 500) {
  const rows = await db()`
    SELECT DISTINCT bx.tracking_number
      FROM batch_boxes bx
      LEFT JOIN shipment_tracking t ON t.tracking_number = bx.tracking_number
     WHERE coalesce(bx.tracking_number, '') <> ''
       AND (t.tracking_number IS NULL OR t.registered_at IS NULL)
     LIMIT ${Math.min(2000, Math.max(1, Number(limit) || 500))}`;
  return rows.map((r) => r.tracking_number);
}

export async function listInboundBoxes() {
  return await db()`
    SELECT b.id AS box_id, b.box_number, b.tracking_number, b.carrier, b.status AS box_status,
           b.tracking_status, b.tracking_sub_status, b.tracking_sub_status_descr,
           b.last_checkpoint, b.checked_at, b.kind AS box_kind, b.shipped_at,
           coalesce((b.tracking_events -> 0 ->> 'time')::timestamptz, b.checked_at) AS last_move_at,
           (b.tracking_events -> 0 ->> 'location') AS last_location,
           p.id AS po_id, p.po_code, p.supplier_name, p.status AS po_status,
           p.created_at AS po_created_at, p.order_kind,
           (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l
              LEFT JOIN po_boxes lb ON lb.id = l.po_box_id
              WHERE l.po_id = p.id AND coalesce(lb.kind, 'original') <> 'replacement')::int AS expected_units,
           (SELECT count(*) FROM items i JOIN batches ba ON ba.id = i.batch_id
              WHERE ba.po_id = p.id)::int AS received_units,
           (SELECT count(*) FROM po_boxes x WHERE x.po_id = p.id AND x.kind <> 'replacement')::int AS box_count
      FROM po_boxes b
      JOIN purchase_orders p ON p.id = b.po_id
     WHERE p.status NOT IN ('reconciled', 'closed')
     ORDER BY p.created_at DESC, b.box_number NULLS LAST, b.id
  `;
}

export async function listPos({ uid, supplierScope }) {
  const sql = db();
  if (supplierScope) {
    return sql`
      SELECT p.*,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement')::int AS box_count,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement'
           AND b.status = ANY(${LEFT_SUPPLIER_STATUSES}))::int AS shipped_count,
        (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind = 'replacement')::int AS replacement_count,
        (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l
           LEFT JOIN po_boxes lb ON lb.id = l.po_box_id
           WHERE l.po_id = p.id AND coalesce(lb.kind, 'original') <> 'replacement')::int AS unit_count,
        -- Every label's tracking number on the order, so the PO lists can be SEARCHED by
        -- one. A tracking number is what a person has in hand when they go looking (it is
        -- on the parcel, in the courier email, in the supplier's message) and it was the
        -- one identifier none of the three lists could find an order by.
        coalesce((SELECT array_agg(b.tracking_number) FROM po_boxes b
                  WHERE b.po_id = p.id AND b.tracking_number IS NOT NULL), '{}') AS tracking_numbers
      FROM purchase_orders p
      WHERE p.supplier_user_id = ${uid}
      ORDER BY p.created_at DESC
    `;
  }
  return sql`
    SELECT p.*,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement')::int AS box_count,
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement'
         AND b.status = ANY(${LEFT_SUPPLIER_STATUSES}))::int AS shipped_count,
      -- Replacements excluded here too, or the delivered count could exceed its own
      -- denominator (box_count counts originals) and "all delivered" would fire early.
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement'
         AND b.status = 'delivered')::int AS delivered_count,
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
         WHERE b.po_id = p.id)::int AS received_units,
      -- Every label's tracking number on the order, so the PO lists can be SEARCHED by
      -- one. A tracking number is what a person has in hand when they go looking (it is
      -- on the parcel, in the courier email, in the supplier's message) and it was the
      -- one identifier none of the three lists could find an order by.
      coalesce((SELECT array_agg(b.tracking_number) FROM po_boxes b
                WHERE b.po_id = p.id AND b.tracking_number IS NOT NULL), '{}') AS tracking_numbers
    FROM purchase_orders p
    ORDER BY p.created_at DESC
  `;
}

// Add/increment an expected line under a label. Re-scanning a SKU+size in the
// same label bumps qty_expected (mirrors receiving's per-size auto-increment).
// enteredBy/enteredOnBehalf record who typed it — NULL/false for a supplier scanning
// their own manifest, the staff uid + true when PH/admin enters it on their behalf.
// Both insert and the re-scan UPDATE stamp the latest actor (last-editor semantics).
// An EMPTY-BOX line carries the size the box was MADE for plus the carton's
// `dimensions`, and dedupes on all three (partial unique index
// `po_lines_box_sku_dim_idx`). The shim can't nest sql fragments, so the two conflict
// targets are two whole queries.
export async function addPoScan({ poId, poBoxId, sku, size, dimensions = null, qty, name, upc, colorway, gender, unitCost, tip, enteredBy = null, enteredOnBehalf = false }) {
  const sql = db();
  const rows = dimensions
    ? await sql`
      INSERT INTO po_lines (po_id, po_box_id, sku, size, dimensions, name, upc, colorway, gender, qty_expected, unit_cost, tip, entered_by, entered_on_behalf)
      VALUES (${poId}, ${poBoxId}, ${sku}, ${size}, ${dimensions}, ${name || null}, ${upc || null},
              ${colorway || null}, ${gender || null}, ${qty}, ${unitCost ?? null}, ${tip ?? null},
              ${enteredBy ?? null}, ${!!enteredOnBehalf})
      ON CONFLICT (po_box_id, sku, size, dimensions) WHERE po_box_id IS NOT NULL AND dimensions IS NOT NULL DO UPDATE
        SET qty_expected      = po_lines.qty_expected + EXCLUDED.qty_expected,
            unit_cost         = COALESCE(EXCLUDED.unit_cost, po_lines.unit_cost),
            tip               = COALESCE(EXCLUDED.tip, po_lines.tip),
            name              = COALESCE(EXCLUDED.name, po_lines.name),
            entered_by        = EXCLUDED.entered_by,
            entered_on_behalf = EXCLUDED.entered_on_behalf,
            updated_at        = now()
      RETURNING *
    `
    : await sql`
      INSERT INTO po_lines (po_id, po_box_id, sku, size, name, upc, colorway, gender, qty_expected, unit_cost, tip, entered_by, entered_on_behalf)
      VALUES (${poId}, ${poBoxId}, ${sku}, ${size}, ${name || null}, ${upc || null},
              ${colorway || null}, ${gender || null}, ${qty}, ${unitCost ?? null}, ${tip ?? null},
              ${enteredBy ?? null}, ${!!enteredOnBehalf})
      -- The shoe-side index is PARTIAL now (WHERE dimensions IS NULL) so it can't
      -- collide with a box line, and ON CONFLICT infers a partial index only when the
      -- predicate is repeated here. Leave it off and every shoe scan 500s.
      ON CONFLICT (po_box_id, sku, size) WHERE dimensions IS NULL DO UPDATE
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

// How many expected lines each label of a PO already carries. Drives the manifest
// import's "only fill a label that has NOTHING declared" rule in one query rather
// than a round trip per box.
// Lines declared against the ORDER rather than a label (whole-order manifest, Path C).
// `po/ship` needs this: on such an order a box legitimately holds no lines of its own,
// and the order-level list is the declaration.
export async function countPoOrderLines(poId) {
  const rows = await db()`SELECT count(*)::int AS n FROM po_lines WHERE po_id = ${poId} AND po_box_id IS NULL`;
  return rows[0]?.n || 0;
}

export async function poBoxLineCounts(poId) {
  const rows = await db()`
    SELECT po_box_id, count(*)::int AS n
    FROM po_lines WHERE po_id = ${poId} AND po_box_id IS NOT NULL
    GROUP BY po_box_id
  `;
  return new Map(rows.map((r) => [Number(r.po_box_id), r.n]));
}

// Whole-order manifest (Path C): add/increment a line against the PO itself (no label).
// Conflict target is the partial unique index on (po_id, sku, size) WHERE po_box_id IS NULL.
export async function addPoOrderScan({ poId, sku, size, dimensions = null, qty, name, upc, colorway, gender, unitCost, tip, enteredBy = null, enteredOnBehalf = false }) {
  const sql = db();
  const rows = dimensions
    ? await sql`
      INSERT INTO po_lines (po_id, po_box_id, sku, size, dimensions, name, upc, colorway, gender, qty_expected, unit_cost, tip, entered_by, entered_on_behalf)
      VALUES (${poId}, NULL, ${sku}, ${size}, ${dimensions}, ${name || null}, ${upc || null},
              ${colorway || null}, ${gender || null}, ${qty}, ${unitCost ?? null}, ${tip ?? null},
              ${enteredBy ?? null}, ${!!enteredOnBehalf})
      ON CONFLICT (po_id, sku, size, dimensions) WHERE po_box_id IS NULL AND dimensions IS NOT NULL DO UPDATE
        SET qty_expected      = po_lines.qty_expected + EXCLUDED.qty_expected,
            unit_cost         = COALESCE(EXCLUDED.unit_cost, po_lines.unit_cost),
            tip               = COALESCE(EXCLUDED.tip, po_lines.tip),
            name              = COALESCE(EXCLUDED.name, po_lines.name),
            entered_by        = EXCLUDED.entered_by,
            entered_on_behalf = EXCLUDED.entered_on_behalf,
            updated_at        = now()
      RETURNING *
    `
    : await sql`
      INSERT INTO po_lines (po_id, po_box_id, sku, size, name, upc, colorway, gender, qty_expected, unit_cost, tip, entered_by, entered_on_behalf)
      VALUES (${poId}, NULL, ${sku}, ${size}, ${name || null}, ${upc || null},
              ${colorway || null}, ${gender || null}, ${qty}, ${unitCost ?? null}, ${tip ?? null},
              ${enteredBy ?? null}, ${!!enteredOnBehalf})
      ON CONFLICT (po_id, sku, size) WHERE po_box_id IS NULL AND dimensions IS NULL DO UPDATE
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

// "I have packed these boxes — send me labels." Set by the supplier, cleared the moment
// tracking numbers land on the boxes, so an order that grows another box afterwards can
// ask again rather than being stuck looking answered.
export async function setLabelsRequested(poId, by) {
  const sql = db();
  return (await sql`
    UPDATE purchase_orders
    SET labels_requested_at = ${by ? new Date() : null}, labels_requested_by = ${by || null}
    WHERE id = ${poId} RETURNING *`)[0] || null;
}

// Assign courier tracking numbers onto boxes the supplier already declared. This is the
// inverse of the original flow, where the box was created FROM the tracking number — so
// there is nothing to match on but the mapping PH confirmed on screen.
//
// A tracking number can only ever be on one label, checked across every order (two labels
// carrying it would both claim the same received box), so each one is verified before any
// of them is written: a half-assigned sheet is worse than a refused one.
export async function assignPoTracking(poId, assignments) {
  const sql = db();
  const norm = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');
  const boxes = await sql`SELECT id, box_number, tracking_number, status FROM po_boxes WHERE po_id = ${poId}`;
  const byId = new Map(boxes.map((b) => [Number(b.id), b]));
  const seen = new Set();
  for (const a of assignments) {
    const box = byId.get(Number(a.boxId));
    if (!box) return { error: 'One of those boxes is no longer on this order — reload and try again.' };
    if (box.status !== 'pending' && box.status !== 'packed')
      return { error: `Box ${box.box_number} has already left — its label can't be changed.` };
    const key = norm(a.trackingNumber);
    if (!key) return { error: `Box ${box.box_number} has no tracking number.` };
    if (seen.has(key)) return { error: `${a.trackingNumber} is assigned to more than one box.` };
    seen.add(key);
    const clash = (await sql`
      SELECT b.id, b.box_number, p.po_code FROM po_boxes b JOIN purchase_orders p ON p.id = b.po_id
      WHERE upper(replace(coalesce(b.tracking_number, ''), ' ', '')) = ${key} AND b.id <> ${Number(a.boxId)} LIMIT 1`)[0];
    if (clash) return { error: `${a.trackingNumber} is already on box ${clash.box_number} of ${clash.po_code}.` };
  }
  await sql.transaction(assignments.map((a) => sql`
    UPDATE po_boxes SET tracking_number = ${String(a.trackingNumber).trim()},
      carrier_key = ${Number.isInteger(Number(a.carrierKey)) && Number(a.carrierKey) > 0 ? Number(a.carrierKey) : null}
    WHERE id = ${Number(a.boxId)}`));
  return { ok: true, count: assignments.length };
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

// Edit an expected line and/or its qty (supplier fixing a scan). Every field is
// optional (undefined = leave as-is). qty <= 0 removes the line.
//
// WHAT MAKES TWO LINES DIFFERENT depends on the kind of order, and that is what the
// merge below turns on. A shoes line is identified by its SIZE. An empty-box line is
// identified by its size AND the carton's DIMENSIONS together — a real box is
// size-specific (its label carries the SKU, the size and the UPC), and the same size can
// still arrive in two different cartons. Changing either half can collide with an
// existing line of the same SKU on the same label (the partial unique indexes on
// (po_box_id, sku, size) and (po_box_id, sku, size, dimensions)) — in that case the two
// are MERGED (qtys summed) and this line is deleted. Returns { line, removed, merged }.
export async function updatePoLine(lineId, { size, dimensions, qty, unitCost, tip, enteredBy = null, enteredOnBehalf = false } = {}) {
  const sql = db();
  const line = (await sql`SELECT * FROM po_lines WHERE id = ${lineId}`)[0];
  if (!line) return { line: null, removed: false, merged: false };
  const newQty = qty === undefined ? line.qty_expected : qty;
  if (newQty <= 0) { await sql`DELETE FROM po_lines WHERE id = ${lineId}`; return { line: null, removed: true, merged: false }; }
  const newSize = size === undefined ? line.size : String(size).trim();
  const isBoxLine = !!line.dimensions || (dimensions !== undefined && !!dimensions);
  const newDims = dimensions === undefined ? line.dimensions : (dimensions || null);
  // `undefined` = not editing that field; an explicit null CLEARS it (an emptied field
  // means "I don't know what this cost", which is not the same as $0).
  const newCost = unitCost === undefined ? line.unit_cost : (unitCost ?? null);
  const newTip = tip === undefined ? line.tip : (tip ?? null);
  const keyChanged = isBoxLine
    ? (newSize !== line.size || newDims !== line.dimensions)
    : (newSize && newSize !== line.size);
  if (keyChanged && newSize) {
    // Find a sibling line that the change would collide with. Order-scoped lines have
    // no box, so match them within the PO (po_box_id IS NULL); box lines match within the
    // label. (The shim can't nest sql fragments, so branch the whole query.)
    const sib = (isBoxLine
      ? (line.po_box_id == null
        ? (await sql`
            SELECT * FROM po_lines
            WHERE po_id = ${line.po_id} AND po_box_id IS NULL AND sku = ${line.sku}
              AND size = ${newSize} AND dimensions = ${newDims} AND id <> ${lineId}
          `)
        : (await sql`
            SELECT * FROM po_lines
            WHERE po_box_id = ${line.po_box_id} AND sku = ${line.sku}
              AND size = ${newSize} AND dimensions = ${newDims} AND id <> ${lineId}
          `))
      : (line.po_box_id == null
        ? (await sql`
            SELECT * FROM po_lines
            WHERE po_id = ${line.po_id} AND po_box_id IS NULL AND sku = ${line.sku} AND size = ${newSize} AND id <> ${lineId}
          `)
        : (await sql`
            SELECT * FROM po_lines
            WHERE po_box_id = ${line.po_box_id} AND sku = ${line.sku} AND size = ${newSize} AND id <> ${lineId}
          `)))[0];
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
    UPDATE po_lines SET size = ${newSize}, dimensions = ${isBoxLine ? newDims : null},
      qty_expected = ${newQty}, unit_cost = ${newCost}, tip = ${newTip},
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
//
// A BOX IS IDENTIFIED BY ITS TRACKING NUMBER, NOT BY THE NUMBER SOMEONE TYPED. The number
// the warehouse records is a guess made at the moment the carton is opened — boxes arrive
// out of order, so box 6 of 9 turning up a day late was recorded as "box 10" and this list
// then read 1,2,3,4,5,7,8,9,10 against an order that only ever had nine labels. The
// tracking number on the carton is not a guess: it says which label that parcel is. When it
// matches one of the order's labels we report THAT number and sort by it, so the evidence
// you send a supplier lines up with the labels they printed. `recorded_box_number` keeps
// what the warehouse actually typed, for the one place worth admitting the difference.
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
  // `batch_id` rides along because a box-less unit's parcel is identified by the tracking
  // number on its BATCH — see the loose-unit handling at the end.
  const rows = await sql`
    SELECT i.box_id, i.batch_id, i.sku, i.size, max(i.name) AS name, count(*)::int AS qty
    FROM items i
    JOIN batches b ON b.id = i.batch_id
    WHERE b.po_id = ${poId}
    GROUP BY i.box_id, i.batch_id, i.sku, i.size
    ORDER BY i.sku, i.size
  `;
  const byBox = new Map();
  const looseByBatch = new Map();   // batch_id -> units received with no box row
  for (const r of rows) {
    const line = { sku: r.sku, size: r.size, name: r.name, qty: r.qty };
    if (r.box_id == null) {
      const k = String(r.batch_id);
      if (!looseByBatch.has(k)) looseByBatch.set(k, []);
      looseByBatch.get(k).push(line);
    } else {
      const k = String(r.box_id);
      if (!byBox.has(k)) byBox.set(k, []);
      byBox.get(k).push(line);
    }
  }
  const poBatches = await sql`
    SELECT id, batch_code, tracking_number FROM batches WHERE po_id = ${poId}`;
  const batchById = new Map(poBatches.map((b) => [String(b.id), b]));
  // Which label each received box actually is, read off its tracking number.
  const labels = await sql`
    SELECT id, box_number, tracking_number, kind FROM po_boxes
    WHERE po_id = ${poId} AND coalesce(tracking_number, '') <> ''`;
  const norm = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');
  const byTracking = new Map(labels.map((l) => [norm(l.tracking_number), l]));
  const out = boxes.map((b) => {
    const items = byBox.get(String(b.id)) || [];
    const label = b.tracking_number ? byTracking.get(norm(b.tracking_number)) : null;
    const recorded = b.box_number == null ? null : Number(b.box_number);
    const labelNumber = label ? Number(label.box_number) : null;
    return {
      ...b,
      // The parcel's real identity wins; the typed number is kept beside it, and only
      // reported as different when it actually is.
      box_number: labelNumber ?? recorded,
      recorded_box_number: labelNumber != null && labelNumber !== recorded ? recorded : null,
      label_kind: label ? (label.kind || 'original') : null,
      matched_label: !!label,
      items,
      units: items.reduce((n, i) => n + i.qty, 0),
    };
  });
  // BOX-LESS UNITS BELONG TO A LABEL TOO, when their batch carries that label's tracking
  // number. A parcel received on its own — the ordinary single-box receive — keeps the
  // tracking on the BATCH and leaves items.box_id NULL, so it has no box row to appear
  // under. Listing it as "not recorded against a box" while the label it plainly matches
  // sits above reading "0 units · opened, nothing in it" is two wrong statements about
  // one parcel: the box looks empty and its thirteen pairs look unattributable. It also
  // fed `getPoBoxDiffs`, so that label read as short by everything in it.
  //
  // Same rule as the box rows above, and the one this function already states: the parcel
  // is identified by its TRACKING NUMBER. Units whose batch matches a label are folded
  // into that label's row (merging with an empty placeholder box row if receiving made
  // one); only units whose batch matches nothing stay unattributed, which is the honest
  // answer for a batch that was linked without a tracking number at all.
  const unattributed = [];
  for (const [batchId, items] of looseByBatch) {
    const batch = batchById.get(batchId);
    const key = batch?.tracking_number ? norm(batch.tracking_number) : '';
    const label = key ? byTracking.get(key) : null;
    if (!label) { unattributed.push(...items); continue; }
    const existing = out.find((r) => r.tracking_number && norm(r.tracking_number) === key);
    if (existing) {
      existing.items = [...existing.items, ...items];
      existing.units = existing.items.reduce((n, i) => n + i.qty, 0);
      // The label's parcel did arrive; a placeholder box row still saying "pending"
      // would contradict the thirteen pairs now listed under it.
      existing.status = 'received';
      continue;
    }
    out.push({
      id: null, box_number: Number(label.box_number), tracking_number: batch.tracking_number,
      status: 'received', received_at: null, received_by: null,
      batch_code: batch.batch_code, batch_id: Number(batchId),
      recorded_box_number: null, label_kind: label.kind || 'original', matched_label: true,
      items, units: items.reduce((n, i) => n + i.qty, 0),
    });
  }
  // Sorted by the number the reader will see, so a late box sits where its label does
  // instead of trailing the list at the number it was typed under.
  out.sort((a, b) => (a.box_number ?? 1e9) - (b.box_number ?? 1e9) || Number(a.id ?? 0) - Number(b.id ?? 0));
  if (unattributed.length) {
    out.push({
      id: null, box_number: null, tracking_number: null, status: 'received',
      received_at: null, received_by: null, batch_code: out[0]?.batch_code || null, batch_id: null,
      recorded_box_number: null, label_kind: null, matched_label: false,
      items: unattributed, units: unattributed.reduce((n, i) => n + i.qty, 0),
    });
  }
  return out;
}

// Per-LABEL discrepancies: what each box declared vs what came out of that box.
//
// The order-level table says "one Dunk is missing"; this says "box 11". That is the
// difference between a message to the supplier and someone walking to a shelf. It uses
// the same canonical matching as `getPoReconciliation`, so a notation difference never
// reads as a missing pair here either.
//
// ONLY on a per-box manifest. On a whole-order list there is no per-box expectation and
// inventing one would be us making up a claim the supplier never made — the same reason
// the received PDF states only what we counted per box (see purchase-orders.md).
export async function getPoBoxDiffs(poId) {
  const sql = db();
  const po = (await sql`SELECT id, manifest_scope FROM purchase_orders WHERE id = ${poId}`)[0];
  if (!po || po.manifest_scope === 'po') return [];

  const expected = await sql`
    SELECT l.po_box_id, l.sku, l.size, max(l.name) AS name, sum(l.qty_expected)::int AS qty
    FROM po_lines l WHERE l.po_id = ${poId} AND l.po_box_id IS NOT NULL
    GROUP BY l.po_box_id, l.sku, l.size`;
  const labels = await sql`SELECT id, box_number, kind FROM po_boxes WHERE po_id = ${poId} ORDER BY box_number`;
  const receivedBoxes = await getPoReceivedBoxes(poId);

  // One code-group map for the whole order, so the same shoe groups identically in
  // every box (a dual code declared on one label and single on another still matches).
  const canon = rcCodeGroups([
    ...expected.map((e) => rcCodes(e.sku)),
    ...receivedBoxes.flatMap((b) => (b.items || []).map((i) => rcCodes(i.sku))),
  ]);
  const key = (x) => `${canon(rcCodes(x.sku))}|${rcSizeNum(x.size)}`;
  const roll = (list, qtyOf) => {
    const m = new Map();
    for (const x of list) {
      const k = key(x);
      const cur = m.get(k);
      if (cur) cur.qty += qtyOf(x);
      else m.set(k, { sku: x.sku, size: x.size, name: x.name, qty: qtyOf(x) });
    }
    return m;
  };

  // Received boxes carry the LABEL's number once their tracking matched one, which is
  // what ties the two halves together (`getPoReceivedBoxes` resolves that).
  const recByNumber = new Map();
  for (const b of receivedBoxes) {
    if (b.box_number == null) continue;
    const cur = recByNumber.get(Number(b.box_number)) || [];
    recByNumber.set(Number(b.box_number), cur.concat(b.items || []));
  }

  return labels.map((l) => {
    const exp = roll(expected.filter((e) => Number(e.po_box_id) === Number(l.id)), (e) => e.qty);
    const rec = roll(recByNumber.get(Number(l.box_number)) || [], (i) => i.qty);
    const diffs = [];
    for (const [k, e] of exp) {
      const got = rec.get(k)?.qty || 0;
      if (got < e.qty) diffs.push({ kind: 'missing', sku: e.sku, size: e.size, name: e.name, qty: e.qty - got });
      else if (got > e.qty) diffs.push({ kind: 'extra', sku: rec.get(k).sku, size: rec.get(k).size, name: rec.get(k).name || e.name, qty: got - e.qty });
    }
    for (const [k, r] of rec) if (!exp.has(k)) diffs.push({ kind: 'extra', sku: r.sku, size: r.size, name: r.name, qty: r.qty });
    return {
      box_number: l.box_number,
      kind: l.kind || 'original',
      expected_units: [...exp.values()].reduce((n, x) => n + x.qty, 0),
      received_units: [...rec.values()].reduce((n, x) => n + x.qty, 0),
      received: recByNumber.has(Number(l.box_number)),
      diffs,
    };
  });
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

// --- Matching two sides that write the same shoe differently -----------------
// Comparing the raw text (upper-cased, nothing more) reported a fully-correct
// 233-pair shipment as 154 pairs wrong. Two notations do it, and each one shows up
// TWICE — a phantom "short" against their spelling and a phantom "not on their
// list" against ours:
//
//   • Women's sizes. The supplier writes `7.5`; we store `7.5W`.
//   • Dual style codes. The supplier writes `CW2290-111`; we store
//     `315121-115/CW2290-111` — and sometimes `HV9918-301-/-HV9919-301`, because
//     normSku turns the spaces around the slash into hyphens on the way in.
//
// So match on: any style code in common, and the NUMERIC part of the size. The row
// still reports what each side actually wrote — this only decides what lines up.
const rcCodes = (sku) => String(sku || '').toUpperCase().split('/')
  .map((c) => c.trim().replace(/\s+/g, '-').replace(/^[-\s]+|[-\s]+$/g, ''))
  .filter(Boolean);
const rcSizeNum = (s) => String(s || '').trim().toUpperCase().replace(/[A-Z]+$/, '');

// One shoe can be written under several codes, so the codes have to be grouped
// transitively: a line listing `A/B` makes A and B the same shoe, and a later line
// listing `B/C` pulls C in too. Union-find, with the alphabetically-first code of
// each group as its stable representative.
function rcCodeGroups(rowsets) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { add(a); add(b); const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const codes of rowsets) {
    codes.forEach(add);
    for (let i = 1; i < codes.length; i++) union(codes[0], codes[i]);
  }
  // Collapse each set to its smallest member so the key is deterministic.
  const rep = new Map();
  for (const c of parent.keys()) {
    const r = find(c);
    const cur = rep.get(r);
    if (!cur || c < cur) rep.set(r, c);
  }
  return (codes) => {
    for (const c of codes) if (parent.has(c)) return rep.get(find(c));
    return codes[0] || '';
  };
}

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

  // Group both sides on (shoe, numeric size) rather than on the literal text, so a
  // difference in notation can't read as a missing pair. Aggregating BY that key also
  // folds together two spellings of the same shoe arriving on either side.
  const canon = rcCodeGroups([...expected, ...received].map((x) => rcCodes(x.sku)));
  const key = (x) => `${canon(rcCodes(x.sku))}|${rcSizeNum(x.size)}`;
  const bucket = (list) => {
    const m = new Map();
    for (const x of list) {
      const k = key(x);
      const cur = m.get(k);
      if (cur) { cur.qty += x.qty; if (!cur.name && x.name) cur.name = x.name; }
      else m.set(k, { sku: x.sku, size: x.size, name: x.name, qty: x.qty });
    }
    return m;
  };
  const expMap = bucket(expected);
  const recMap = bucket(received);
  const expShoes = new Set([...expMap.keys()].map((k) => k.split('|')[0]));

  const rows = [];
  for (const k of new Set([...expMap.keys(), ...recMap.keys()])) {
    const e = expMap.get(k); const r = recMap.get(k);
    const exp = e?.qty || 0; const rec = r?.qty || 0;
    const sku = (e || r).sku; const size = (e || r).size; const name = e?.name || r?.name || sku;
    let flag;
    if (exp > 0 && rec === exp) flag = 'match';
    else if (exp > 0 && rec < exp) flag = 'shortage';
    else if (exp > 0 && rec > exp) flag = 'overage';
    else if (exp === 0 && expShoes.has(k.split('|')[0])) flag = 'wrong_size'; // shoe expected, this size wasn't
    else flag = 'wrong_sku';                                                  // shoe not on the PO at all
    // What each side actually wrote, when they wrote it differently — so the report
    // can show "7.5 → 7.5W" instead of silently normalising the difference away.
    const skuOurs = r && e && rcSku(r.sku) !== rcSku(e.sku) ? r.sku : null;
    const sizeOurs = r && e && rcSize(r.size) !== rcSize(e.size) ? r.size : null;
    rows.push({ sku, size, name, expected: exp, received: rec, delta: rec - exp, flag, sku_ours: skuOurs, size_ours: sizeOurs });
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
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count,
      -- Every label's tracking number on the order, so the PO lists can be SEARCHED by
      -- one. A tracking number is what a person has in hand when they go looking (it is
      -- on the parcel, in the courier email, in the supplier's message) and it was the
      -- one identifier none of the three lists could find an order by.
      coalesce((SELECT array_agg(b.tracking_number) FROM po_boxes b
                WHERE b.po_id = p.id AND b.tracking_number IS NOT NULL), '{}') AS tracking_numbers
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
      WHERE regexp_replace(upper(tracking_number), '[^A-Z0-9]', '', 'g')
          = regexp_replace(upper(${trackingNumber}), '[^A-Z0-9]', '', 'g')
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
    WHERE regexp_replace(upper(tracking_number), '[^A-Z0-9]', '', 'g')
        = regexp_replace(upper(${trackingNumber}), '[^A-Z0-9]', '', 'g')
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
    // Record HOW, not just that. "Received straight against the order" and "attached
    // afterwards once someone noticed" are different facts when tracing a pair, and
    // po_id alone cannot tell them apart (2026-08-28).
    queries.push(sql`
      UPDATE batches SET po_id = ${poId}, po_link_source = 'linked', po_linked_at = now(),
             po_linked_by = ${actor?.name || actor?.username || null}
       WHERE id = ${batchId} AND po_id IS NULL`);
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

  // Clear how it was linked along with the link itself — a batch that keeps
  // `po_link_source` after being unlinked would tell a pair's history it came in against
  // an order it no longer belongs to.
  await sql`UPDATE batches SET po_id = NULL, po_link_source = NULL, po_linked_at = NULL,
                   po_linked_by = NULL WHERE id = ${batchId}`;
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

/* ---- Editing an order that already exists -----------------------------------
   An order isn't settled the moment it's raised: the supplier buys more and gets
   another label, a tracking number goes in with a typo, and a label sometimes turns
   out to belong to a different order altogether. Three rules hold across everything
   below.

   1. A **reconciled or closed** order is frozen. Its count has been settled with the
      supplier; moving the goalposts afterwards is how a settled order starts
      disagreeing with the message that settled it.
   2. A label with **stock counted into it is never deleted** — only moved. The record
      of what physically arrived outlives any tidying up of the paperwork.
   3. **Received stock follows its label.** A label is tied to what arrived only by its
      tracking number, and only within batches linked to the SAME order (see
      `getPoFull`), so moving the label alone would leave the old order carrying units
      nothing claims and the new one reading fully short — worse than not moving it. */

export const PO_FROZEN = ['reconciled', 'closed'];
const trackKey = (t) => String(t || '').trim().toUpperCase().replace(/\s+/g, '');

// Header fields. Only the keys actually present in `patch` are written, so a caller
// editing the notes can't blank the tag code by omission — `null` is a real value here
// (clearing a date), which is why this can't lean on coalesce().
export async function updatePo(poId, patch = {}) {
  const sql = db();
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const rows = await sql`
    UPDATE purchase_orders SET
      supplier_name    = CASE WHEN ${has('supplierName')} THEN ${patch.supplierName ?? null}::text ELSE supplier_name END,
      supplier_user_id = CASE WHEN ${has('supplierUserId')} THEN ${patch.supplierUserId ?? null}::bigint ELSE supplier_user_id END,
      tag_code         = CASE WHEN ${has('tagCode')} THEN ${patch.tagCode ?? null}::text ELSE tag_code END,
      date_of_purchase = CASE WHEN ${has('dateOfPurchase')} THEN ${patch.dateOfPurchase ?? null}::date ELSE date_of_purchase END,
      notes            = CASE WHEN ${has('notes')} THEN ${patch.notes ?? null}::text ELSE notes END,
      expected_boxes   = CASE WHEN ${has('expectedBoxes')} THEN ${patch.expectedBoxes ?? null}::int ELSE expected_boxes END,
      order_kind       = CASE WHEN ${has('orderKind')} THEN ${patch.orderKind ?? 'shoes'}::text ELSE order_kind END
    WHERE id = ${poId}
    RETURNING *`;
  return rows[0] || null;
}

// A tracking number identifies a parcel, so it can only ever be on ONE label: two
// labels carrying it would both claim the same received box (`getPoFull` matches on
// that string) and the labels PDF couldn't tell which page belongs to which. Checked
// across every order, not just this one — the clash is global.
export async function poBoxByTracking(tracking, { exceptBoxId = null } = {}) {
  const key = trackKey(tracking);
  if (!key) return null;
  const rows = await sql_poBoxTracking(key, exceptBoxId);
  return rows[0] || null;
}
async function sql_poBoxTracking(key, exceptBoxId) {
  const sql = db();
  if (exceptBoxId) {
    return await sql`
      SELECT b.*, p.po_code FROM po_boxes b JOIN purchase_orders p ON p.id = b.po_id
      WHERE upper(replace(coalesce(b.tracking_number, ''), ' ', '')) = ${key} AND b.id <> ${exceptBoxId} LIMIT 1`;
  }
  return await sql`
    SELECT b.*, p.po_code FROM po_boxes b JOIN purchase_orders p ON p.id = b.po_id
    WHERE upper(replace(coalesce(b.tracking_number, ''), ' ', '')) = ${key} LIMIT 1`;
}

// What the warehouse has counted into ONE label's box — the same tracking-number join
// `getPoFull` uses, but resolved to the ROWS behind the number so a move can take them
// with it. Two shapes, because receiving records a box two ways:
//   • `boxRows` — a box row inside a multi-box batch (items carry its box_id)
//   • `loose`   — a single-box batch that kept the tracking on the batch itself and
//                 left items.box_id NULL
export async function poBoxReceived(box) {
  const sql = db();
  const key = trackKey(box?.tracking_number);
  if (!key) return { units: 0, boxRows: [], loose: [] };
  const boxRows = await sql`
    SELECT x.id, x.batch_id, x.box_number, bt.batch_code,
           (SELECT count(*)::int FROM items i WHERE i.box_id = x.id) AS units
    FROM batch_boxes x JOIN batches bt ON bt.id = x.batch_id
    WHERE bt.po_id = ${box.po_id}
      AND upper(replace(coalesce(x.tracking_number, ''), ' ', '')) = ${key}`;
  const loose = await sql`
    SELECT bt.id AS batch_id, bt.batch_code,
           (SELECT count(*)::int FROM items i WHERE i.batch_id = bt.id AND i.box_id IS NULL) AS units,
           (SELECT count(*)::int FROM batch_boxes x2 WHERE x2.batch_id = bt.id) AS box_count
    FROM batches bt
    WHERE bt.po_id = ${box.po_id}
      AND upper(replace(coalesce(bt.tracking_number, ''), ' ', '')) = ${key}`;
  const units = boxRows.reduce((n, r) => n + (r.units || 0), 0)
    + loose.reduce((n, r) => n + (r.units || 0), 0);
  return { units, boxRows, loose: loose.filter((r) => r.units > 0) };
}

// Add labels to an existing order. Numbered on from the highest already there — a label
// keeps its number for life, because that number is what the warehouse writes on the
// carton and what every downstream screen calls it.
export async function addPoLabels(poId, labels, createdBy) {
  const sql = db();
  const next = (await sql`
    SELECT coalesce(max(box_number), 0) + 1 AS n FROM po_boxes WHERE po_id = ${poId}`)[0].n;
  const nums = labels.map((_, i) => Number(next) + i);
  const tracks = labels.map((l) => (String(l.trackingNumber || '').trim() || null));
  const carriers = labels.map((l) => (Number.isInteger(Number(l.carrierKey)) && Number(l.carrierKey) > 0 ? Number(l.carrierKey) : null));
  const rows = await sql`
    INSERT INTO po_boxes (po_id, box_number, tracking_number, carrier_key, status, kind, created_by)
    SELECT ${poId}, t.box_number, t.tracking_number, t.carrier_key, 'pending', 'original', ${createdBy || null}
    FROM unnest(${nums}::int[], ${tracks}::text[], ${carriers}::int[]) AS t(box_number, tracking_number, carrier_key)
    RETURNING *`;
  await syncExpectedBoxes(poId);
  return rows;
}

// The order's declared box count never reads FEWER than the labels it holds. It can read
// more on purpose — an order can be raised knowing six boxes are coming before all six
// tracking numbers exist — so this only ever raises it.
export async function syncExpectedBoxes(poId) {
  const sql = db();
  await sql`
    UPDATE purchase_orders p
    SET expected_boxes = GREATEST(
      coalesce(p.expected_boxes, 0),
      (SELECT count(*) FROM po_boxes b WHERE b.po_id = p.id AND b.kind <> 'replacement'))
    WHERE p.id = ${poId}`;
}

// Correct a label's tracking number / carrier (a typo, or a number that arrived later).
export async function updatePoBox(boxId, { trackingNumber, carrierKey }) {
  const sql = db();
  const has = (v) => v !== undefined;
  const rows = await sql`
    UPDATE po_boxes SET
      tracking_number = CASE WHEN ${has(trackingNumber)} THEN ${trackingNumber ?? null}::text ELSE tracking_number END,
      carrier_key     = CASE WHEN ${has(carrierKey)} THEN ${carrierKey ?? null}::int ELSE carrier_key END
    WHERE id = ${boxId}
    RETURNING *`;
  return rows[0] || null;
}

// Delete a label. Its manifest lines go with it (po_lines.po_box_id is ON DELETE
// CASCADE) — that list described a box that no longer exists. Refused for anything the
// caller should have to face instead of quietly losing: see the rules at the top.
export async function removePoBox(boxId) {
  const sql = db();
  const box = (await sql`SELECT * FROM po_boxes WHERE id = ${boxId}`)[0];
  if (!box) return { error: 'That label no longer exists.' };
  const po = await getPo(box.po_id);
  if (PO_FROZEN.includes(po?.status)) {
    return { error: `${po.po_code} is ${po.status} — its count is settled, so its labels can't be changed.` };
  }
  const received = await poBoxReceived(box);
  if (received.units > 0) {
    return {
      error: `${received.units} pair(s) have already been counted into this label's box. `
        + 'Move the label to another order instead — deleting it would take the record of received stock with it.',
      received: received.units,
      mustMove: true,
    };
  }
  const siblings = (await sql`
    SELECT count(*)::int AS n FROM po_boxes WHERE po_id = ${box.po_id} AND kind <> 'replacement'`)[0].n;
  if (box.kind !== 'replacement' && siblings <= 1) {
    return { error: 'An order has to keep at least one label. Delete the whole order instead if it was raised by mistake.' };
  }
  const lines = (await sql`SELECT count(*)::int AS n FROM po_lines WHERE po_box_id = ${boxId}`)[0].n;
  await sql`DELETE FROM po_boxes WHERE id = ${boxId}`;
  return { ok: true, box, linesRemoved: lines };
}

// Move a label to another order, taking everything that describes it: its manifest lines
// and — the part that makes this honest rather than cosmetic — the box the warehouse
// actually received against it. Returns { error } rather than throwing so the endpoint
// can hand the reason back verbatim.
export async function movePoBox(boxId, targetPoId, { createdBy = null } = {}) {
  const sql = db();
  const box = (await sql`SELECT * FROM po_boxes WHERE id = ${boxId}`)[0];
  if (!box) return { error: 'That label no longer exists.' };
  const from = await getPo(box.po_id);
  const to = await getPo(targetPoId);
  if (!to) return { error: 'The order to move it to no longer exists.' };
  if (Number(to.id) === Number(box.po_id)) return { error: `That label is already on ${to.po_code}.` };
  if (PO_FROZEN.includes(from?.status)) {
    return { error: `${from.po_code} is ${from.status} — its count is settled, so its labels can't be moved off it.` };
  }
  if (PO_FROZEN.includes(to.status)) {
    return { error: `${to.po_code} is ${to.status} — its count is already settled, so a label can't be added to it.` };
  }

  const received = await poBoxReceived(box);
  // A single-box batch IS the box: its tracking sits on the batch and its items have no
  // box_id, so the only way to move it is to move the whole batch — which is only true
  // to the paperwork if that batch holds nothing else.
  for (const l of received.loose) {
    if (Number(l.box_count) > 0) {
      return {
        error: `${l.batch_code} counted these pairs against the batch itself, alongside ${l.box_count} box row(s). `
          + 'Sort that batch out first (or unlink it) — moving the label would leave the count ambiguous.',
      };
    }
  }

  const nextNum = (await sql`
    SELECT coalesce(max(box_number), 0) + 1 AS n FROM po_boxes WHERE po_id = ${targetPoId}`)[0].n;

  // Where the received box lands: the order's own receiving batch. One is created when
  // the target has none, copying the source batch's header — the pairs were received on
  // that day, by that person, from that supplier, and that stays true after the move.
  let targetBatchId = null;
  let createdBatch = null;
  if (received.boxRows.length) {
    const open = await sql`
      SELECT id, batch_code FROM batches WHERE po_id = ${targetPoId} ORDER BY id DESC`;
    if (open.length > 1) {
      return {
        error: `${to.po_code} has ${open.length} receiving batches linked (${open.map((b) => b.batch_code).join(', ')}). `
          + 'Unlink the ones that don\'t belong first, so there is one place for this box to land.',
      };
    }
    if (open.length === 1) targetBatchId = Number(open[0].id);
    else {
      const src = (await sql`SELECT * FROM batches WHERE id = ${received.boxRows[0].batch_id}`)[0];
      const made = await sql`
        INSERT INTO batches (buyer_name, supplier_name, no_tracking, date_received, default_cost,
                             notes, kind, batch_tag, po_id, status, created_by)
        VALUES (${src?.buyer_name || null}, ${src?.supplier_name || to.supplier_name || null},
                ${src?.no_tracking === true}, ${src?.date_received || null}, ${src?.default_cost ?? null},
                ${`Opened by moving a label from ${from?.po_code || 'another order'}.`},
                'receiving', ${to.tag_code || null}, ${targetPoId}, 'open', ${createdBy || null})
        RETURNING id, batch_code`;
      targetBatchId = Number(made[0].id);
      createdBatch = made[0].batch_code;
    }
  }

  const queries = [
    sql`UPDATE po_boxes SET po_id = ${targetPoId}, box_number = ${nextNum} WHERE id = ${boxId}`,
    sql`UPDATE po_lines SET po_id = ${targetPoId} WHERE po_box_id = ${boxId}`,
  ];
  for (const r of received.boxRows) {
    queries.push(sql`
      UPDATE batch_boxes SET batch_id = ${targetBatchId},
        box_number = (SELECT coalesce(max(x.box_number), 0) + 1 FROM batch_boxes x WHERE x.batch_id = ${targetBatchId})
      WHERE id = ${r.id}`);
    queries.push(sql`UPDATE items SET batch_id = ${targetBatchId} WHERE box_id = ${r.id}`);
  }
  for (const l of received.loose) {
    queries.push(sql`UPDATE batches SET po_id = ${targetPoId} WHERE id = ${l.batch_id}`);
  }
  await sql.transaction(queries);
  await syncExpectedBoxes(box.po_id);
  await syncExpectedBoxes(targetPoId);
  return {
    ok: true,
    box,
    from,
    to,
    boxNumber: Number(nextNum),
    units: received.units,
    movedBatches: received.loose.map((l) => l.batch_code),
    createdBatch,
  };
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
    WHERE id = ${poId}`,
  // Every page pointer on the order is cleared before the new sheet is mapped. There is
  // ONE stored file per order, so a replacement makes every old `label_page` an index
  // into a file that no longer exists — and page 3 of the new sheet is somebody else's
  // label, which is far worse than no label at all. A label the new sheet doesn't carry
  // now has no page, and its download button hides itself.
  sql`UPDATE po_boxes SET label_page = NULL, label_page_end = NULL WHERE po_id = ${poId}`];

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
      (SELECT coalesce(sum(l.qty_expected), 0) FROM po_lines l WHERE l.po_id = p.id)::int AS unit_count,
      -- Every label's tracking number on the order, so the PO lists can be SEARCHED by
      -- one. A tracking number is what a person has in hand when they go looking (it is
      -- on the parcel, in the courier email, in the supplier's message) and it was the
      -- one identifier none of the three lists could find an order by.
      coalesce((SELECT array_agg(b.tracking_number) FROM po_boxes b
                WHERE b.po_id = p.id AND b.tracking_number IS NOT NULL), '{}') AS tracking_numbers
    FROM purchase_orders p
    WHERE p.status = 'closed'
    ORDER BY p.reconciled_at DESC NULLS LAST, p.created_at DESC
    LIMIT ${limit}`;
}

/* ------------------------ Payout supplier presets ------------------------ */
// The fixed cost stack a given supplier buys at — tip, shipping (box swap + labour),
// sales tax, gift-card discount, and the rest of the register percentages. Shared
// across the team on purpose: a supplier's tip fee is a fact about the supplier, not
// about the phone it's typed on (docs/context/payout-calculator.md).

// Numerics come back from `pg` as STRINGS. The calculator does arithmetic with these,
// so cast on the way out — '8.25' + 5 is '8.255' and nobody would spot it on screen.
const presetOut = (r) => (r ? {
  id: Number(r.id),
  name: r.name,
  tipAmt: Number(r.tip_amt),
  shippingAmt: Number(r.shipping_amt),
  taxPct: Number(r.tax_pct),
  giftPct: Number(r.gift_pct),
  storePct: Number(r.store_pct),
  promoPct: Number(r.promo_pct),
  cashbackPct: Number(r.cashback_pct),
  note: r.note || '',
  supplierUserId: r.supplier_user_id == null ? null : Number(r.supplier_user_id),
  supplierUsername: r.supplier_username || null, // only selected for the staff editor
  updatedBy: r.updated_by || null,
  updatedAt: r.updated_at || null,
} : null);

/**
 * Every preset, or — with `supplierUserId` — only the one(s) linked to that supplier
 * account. The filter is applied HERE rather than in the endpoint so there's one place
 * a supplier's scope can be got wrong, and it keys on the id, never the name.
 */
export async function listPayoutPresets({ supplierUserId = null } = {}) {
  const sql = db();
  // The shim can't nest sql fragments — branch with if/else.
  if (supplierUserId != null) {
    const rows = await sql`
      SELECT id, name, tip_amt, shipping_amt, tax_pct, gift_pct, store_pct, promo_pct,
             cashback_pct, note, supplier_user_id, updated_by, updated_at
        FROM payout_presets
       WHERE supplier_user_id = ${supplierUserId}
       ORDER BY lower(btrim(name))`;
    return rows.map(presetOut);
  }
  const rows = await sql`
    SELECT p.id, p.name, p.tip_amt, p.shipping_amt, p.tax_pct, p.gift_pct, p.store_pct,
           p.promo_pct, p.cashback_pct, p.note, p.supplier_user_id, p.updated_by, p.updated_at,
           u.username AS supplier_username
      FROM payout_presets p
      LEFT JOIN users u ON u.id = p.supplier_user_id
     ORDER BY lower(btrim(p.name))`;
  return rows.map(presetOut);
}

/**
 * Create or rename/retune one preset. `id` null = create.
 * Throws a tagged error on a duplicate name so the endpoint can answer 409 instead of
 * leaking a Postgres constraint string at someone standing in a shop.
 */
export async function savePayoutPreset(p, updatedBy) {
  const sql = db();
  const name = String(p.name || '').trim();
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const [tip, ship, tax, gift, store, promo, cash] = [
    n(p.tipAmt), n(p.shippingAmt), n(p.taxPct), n(p.giftPct),
    n(p.storePct), n(p.promoPct), n(p.cashbackPct),
  ];
  const note = String(p.note || '').trim() || null;
  // null unlinks; the endpoint has already checked the id is a real approved supplier.
  const supplierUserId = p.supplierUserId == null || p.supplierUserId === '' ? null : Number(p.supplierUserId);
  try {
    // The shim can't nest sql fragments, so insert and update are two whole statements.
    const rows = p.id
      ? await sql`
          UPDATE payout_presets
             SET name = ${name}, tip_amt = ${tip}, shipping_amt = ${ship},
                 tax_pct = ${tax}, gift_pct = ${gift}, store_pct = ${store},
                 promo_pct = ${promo}, cashback_pct = ${cash}, note = ${note},
                 supplier_user_id = ${supplierUserId},
                 updated_by = ${updatedBy || null}, updated_at = now()
           WHERE id = ${p.id}
       RETURNING id, name, tip_amt, shipping_amt, tax_pct, gift_pct, store_pct,
                 promo_pct, cashback_pct, note, supplier_user_id, updated_by, updated_at`
      : await sql`
          INSERT INTO payout_presets
            (name, tip_amt, shipping_amt, tax_pct, gift_pct, store_pct, promo_pct,
             cashback_pct, note, supplier_user_id, created_by, updated_by)
          VALUES (${name}, ${tip}, ${ship}, ${tax}, ${gift}, ${store}, ${promo},
                  ${cash}, ${note}, ${supplierUserId}, ${updatedBy || null}, ${updatedBy || null})
       RETURNING id, name, tip_amt, shipping_amt, tax_pct, gift_pct, store_pct,
                 promo_pct, cashback_pct, note, supplier_user_id, updated_by, updated_at`;
    return presetOut(rows[0]);
  } catch (e) {
    if (String(e.message || '').includes('payout_presets_name_idx')) {
      const err = new Error(`There's already a supplier called “${name}”.`);
      err.duplicate = true;
      throw err;
    }
    throw e;
  }
}

// Hard delete: a preset is a convenience, referenced by nothing — the calculator saves
// no rows at all, so there is no history to orphan.
export async function deletePayoutPreset(id) {
  const rows = await db()`DELETE FROM payout_presets WHERE id = ${id} RETURNING id, name`;
  return rows[0] || null;
}

/* ===========================================================================
   GIFT-CARD BUYING CARTS — steps 1–7 of the written process, then a handoff.
   docs/context/buy-cart.md · schema in scripts/db-setup.mjs

   The half this file owns is money moving OUT: a buyer requests, staff approve,
   an issuer releases cards, the receipt comes back and is parsed, an auditor
   reconciles. The half it hands to purchase_orders is inventory coming IN.
   `buy_carts.po_id` is the seam, and nothing here re-implements what the PO
   side already answers — "did it arrive" is getPoReconciliation's question.

   Two rules run through every function below:
   · A gift-card CODE never leaves this file in the clear. Every list and detail
     query selects `code_last4` and never `code_enc`; decryption is one endpoint,
     and it writes an event first.
   · Totals are recomputed from the rows in the same statement that changes them
     (recalcCartMoney), never patched incrementally. An approved_amount that
     drifts from its lines is a funding target nobody can trust.
   =========================================================================== */

// The buying cart's own row shape for lists: enough to draw a queue, nothing
// sensitive. Money comes back as numbers rather than the NUMERIC strings pg hands
// over, because every consumer compares them.
const cartMoney = (r) => ({
  approved_amount: r.approved_amount == null ? 0 : Number(r.approved_amount),
  gc_total: r.gc_total == null ? 0 : Number(r.gc_total),
  receipt_total: r.receipt_total == null ? null : Number(r.receipt_total),
  balance_remaining: r.balance_remaining == null ? null : Number(r.balance_remaining),
});
const cartOut = (r) => (r ? { ...r, ...cartMoney(r) } : null);

const lineOut = (r) => (r ? {
  ...r,
  qty: Number(r.qty) || 0,
  shelf_price: r.shelf_price == null ? null : Number(r.shelf_price),
  final_cost: r.final_cost == null ? null : Number(r.final_cost),
  best_payout: r.best_payout == null ? null : Number(r.best_payout),
  profit: r.profit == null ? null : Number(r.profit),
  roi: r.roi == null ? null : Number(r.roi),
  alias_price: r.alias_price == null ? null : Number(r.alias_price),
  stockx_price: r.stockx_price == null ? null : Number(r.stockx_price),
} : null);

// Recompute the cart's money and counts FROM ITS ROWS. Called by every mutation that
// can move them. The funding target is the SHELF price of every approved pair — the
// sticker, with no discount assumed — so a card is never short at the till because the
// buyer didn't get the promo they expected (docs/context/buy-cart.md).
async function recalcCartMoney(sql, cartId) {
  await sql`
    UPDATE buy_carts c SET
      line_count     = l.total,
      approved_count = l.approved,
      pending_count  = l.pending,
      approved_amount = l.approved_amount,
      gc_total        = g.total,
      balance_remaining = CASE WHEN c.receipt_total IS NULL THEN NULL
                               ELSE g.total - c.receipt_total END,
      updated_at = now()
    FROM (
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'approved')::int AS approved,
             count(*) FILTER (WHERE status = 'pending')::int  AS pending,
             coalesce(sum(coalesce(shelf_price,0) * qty) FILTER (WHERE status = 'approved'), 0) AS approved_amount
        FROM buy_cart_lines WHERE cart_id = ${cartId}
    ) l,
    (
      SELECT coalesce(sum(balance), 0) AS total
        FROM buy_cart_gift_cards WHERE cart_id = ${cartId} AND voided_at IS NULL
    ) g
    WHERE c.id = ${cartId}
  `;
}

// The actor's stable identity, the same rule as api/_lib/buycart.js `actorKey`.
// Deliberately duplicated rather than imported: buycart.js imports THIS file, so taking
// it the other way would be a cycle. Kept to two lines so the two can't drift far.
const actorKeyOf = (a) => {
  const uid = Number(a?.uid);
  if (Number.isInteger(uid) && uid > 0) return String(uid);
  const u = String(a?.username || '').trim().toLowerCase();
  return u ? `env:${u}` : null;
};

// Does this account hold a privilege right now? Read fresh on every privileged call —
// a permission over company money must stop the moment it is untinked, not at the
// account's next sign-in (api/_lib/buycart.js explains the trade).
export async function userHasPrivilege(uid, priv) {
  const rows = await db()`SELECT 1 FROM users WHERE id = ${uid} AND ${priv} = ANY(privileges) LIMIT 1`;
  return rows.length > 0;
}

export async function listUserPrivileges(uid) {
  const rows = await db()`SELECT privileges FROM users WHERE id = ${uid}`;
  return rows[0]?.privileges || [];
}

// Set the whole set at once, so unticking is as ordinary as ticking. A SUPPLIER is
// external and can hold none: a buyer with the approve privilege would sign off their
// own request, which is what the process exists to prevent.
export async function setUserPrivileges(uid, privileges) {
  const rows = await db()`
    UPDATE users SET privileges = CASE WHEN role = 'supplier' THEN '{}'::text[] ELSE ${privileges}::text[] END
     WHERE id = ${uid}
     RETURNING id, username, name, role, privileges`;
  return rows[0] || null;
}

export async function logCartEvent({ cartId, kind, lineId = null, gcId = null, body = null, actor = null }) {
  const sql = db();
  // `Number(uid) || null` — an env admin/superadmin has no row in `users`, and its uid
  // reaches here as a non-numeric. Writing that into a BIGINT column is the bug that
  // took down PO comments once already.
  const actorId = actor && Number(actor.uid) ? Number(actor.uid) : null;
  const rows = await sql`
    INSERT INTO buy_cart_events (cart_id, kind, line_id, gc_id, body, actor_id, actor_name, actor_role)
    VALUES (${cartId}, ${kind}, ${lineId}, ${gcId}, ${body},
            ${actorId}, ${actor ? (actor.name || actor.username || null) : null}, ${actor ? actor.role : null})
    RETURNING *`;
  return rows[0];
}

export async function createBuyCart({ buyerUserId, buyerName, retailer, purpose, restrictions, presetId, costStack, actor }) {
  const sql = db();
  const rows = await sql`
    INSERT INTO buy_carts (buyer_user_id, buyer_name, retailer, purpose, restrictions, preset_id, cost_stack)
    VALUES (${buyerUserId}, ${buyerName}, ${retailer || null}, ${purpose || null},
            ${restrictions || null}, ${presetId || null}, ${costStack ? JSON.stringify(costStack) : null})
    RETURNING *`;
  await logCartEvent({ cartId: rows[0].id, kind: 'created', actor });
  return cartOut(rows[0]);
}

export async function getBuyCart(id) {
  const sql = db();
  return cartOut((await sql`SELECT * FROM buy_carts WHERE id = ${id}`)[0] || null);
}

// The whole record for one screen. Gift cards come back MASKED — `code_last4` and the
// balance, never `code_enc`. This is the payload every role's cart page renders, so a
// code selected here would end up in a browser cache, a screenshot and a bug report.
export async function getBuyCartFull(id) {
  const sql = db();
  const cart = cartOut((await sql`SELECT * FROM buy_carts WHERE id = ${id}`)[0]);
  if (!cart) return null;
  const [lines, giftCards, files, receiptLines, events, po] = await Promise.all([
    sql`SELECT * FROM buy_cart_lines WHERE cart_id = ${id} ORDER BY id`,
    sql`SELECT id, cart_id, code_last4, balance, retailer, label, spent_amount, remaining,
               issued_by, issued_at, voided_at, voided_reason,
               (pin_enc IS NOT NULL) AS has_pin
          FROM buy_cart_gift_cards WHERE cart_id = ${id} ORDER BY id`,
    sql`SELECT id, cart_id, kind, name, content_type, size_bytes, uploaded_by, uploaded_at
          FROM buy_cart_files WHERE cart_id = ${id} ORDER BY kind, id`,
    sql`SELECT * FROM buy_cart_receipt_lines WHERE cart_id = ${id} ORDER BY id`,
    sql`SELECT * FROM buy_cart_events WHERE cart_id = ${id} ORDER BY id DESC LIMIT 200`,
    cart.po_id
      ? sql`SELECT id, po_code, status, resolution_state FROM purchase_orders WHERE id = ${cart.po_id}`
      : Promise.resolve([]),
  ]);
  return {
    ...cart,
    lines: lines.map(lineOut),
    giftCards: giftCards.map((g) => ({
      ...g,
      balance: Number(g.balance) || 0,
      spent_amount: g.spent_amount == null ? null : Number(g.spent_amount),
      remaining: g.remaining == null ? null : Number(g.remaining),
    })),
    files,
    receiptLines: receiptLines.map((r) => ({
      ...r,
      qty: Number(r.qty) || 0,
      unit_price: r.unit_price == null ? null : Number(r.unit_price),
      total_price: r.total_price == null ? null : Number(r.total_price),
    })),
    events,
    po: po[0] || null,
  };
}

// List for a queue screen. `buyerUserId` scopes a buyer to their own carts; staff pass
// null and get everything. Scoping on the id off the token (never a name) is the same
// rule the payout presets follow, and for the same reason.
export async function listBuyCarts({ buyerUserId = null, status = null, limit = 100 } = {}) {
  const sql = db();
  const rows = buyerUserId != null
    ? await sql`
        SELECT c.*, (SELECT po_code FROM purchase_orders p WHERE p.id = c.po_id) AS po_code
          FROM buy_carts c WHERE c.buyer_user_id = ${buyerUserId}
           AND (${status}::text IS NULL OR c.status = ${status})
         ORDER BY c.id DESC LIMIT ${limit}`
    : await sql`
        SELECT c.*, (SELECT po_code FROM purchase_orders p WHERE p.id = c.po_id) AS po_code
          FROM buy_carts c
         WHERE (${status}::text IS NULL OR c.status = ${status})
         ORDER BY c.id DESC LIMIT ${limit}`;
  return rows.map(cartOut);
}

export async function addBuyCartLine(cartId, line, actor) {
  const sql = db();
  const rows = await sql`
    INSERT INTO buy_cart_lines
      (cart_id, sku, size, qty, name, colorway, gender, upc, shelf_price, verdict,
       final_cost, best_platform, best_payout, profit, roi, alias_price, stockx_price,
       liquidity, basis, quoted_at)
    VALUES (${cartId}, ${line.sku}, ${line.size || null}, ${line.qty}, ${line.name || null},
            ${line.colorway || null}, ${line.gender || null}, ${line.upc || null},
            ${line.shelfPrice}, ${line.verdict || null}, ${line.finalCost ?? null},
            ${line.bestPlatform || null}, ${line.bestPayout ?? null}, ${line.profit ?? null},
            ${line.roi ?? null}, ${line.aliasPrice ?? null}, ${line.stockxPrice ?? null},
            ${line.liquidity || null}, ${line.basis || null}, now())
    RETURNING *`;
  await recalcCartMoney(sql, cartId);
  await logCartEvent({
    cartId, kind: 'line_added', lineId: rows[0].id, actor,
    body: `${line.sku}${line.size ? ` size ${line.size}` : ''} ×${line.qty} @ $${Number(line.shelfPrice || 0).toFixed(2)}${line.verdict ? ` — ${line.verdict}` : ''}`,
  });
  return lineOut(rows[0]);
}

export async function updateBuyCartLine(cartId, lineId, patch, actor) {
  const sql = db();
  const rows = await sql`
    UPDATE buy_cart_lines SET
      qty = coalesce(${patch.qty ?? null}::int, qty),
      shelf_price = coalesce(${patch.shelfPrice ?? null}::numeric, shelf_price),
      size = coalesce(${patch.size ?? null}::text, size),
      updated_at = now()
    WHERE id = ${lineId} AND cart_id = ${cartId}
    RETURNING *`;
  if (!rows[0]) return null;
  await recalcCartMoney(sql, cartId);
  await logCartEvent({ cartId, kind: 'line_edited', lineId, actor });
  return lineOut(rows[0]);
}

export async function removeBuyCartLine(cartId, lineId, actor) {
  const sql = db();
  const rows = await sql`DELETE FROM buy_cart_lines WHERE id = ${lineId} AND cart_id = ${cartId} RETURNING sku, size, qty`;
  if (!rows[0]) return null;
  await recalcCartMoney(sql, cartId);
  await logCartEvent({ cartId, kind: 'line_removed', actor, body: `${rows[0].sku} ${rows[0].size || ''} ×${rows[0].qty}` });
  return rows[0];
}

export async function submitBuyCart(cartId, actor) {
  const sql = db();
  const rows = await sql`
    UPDATE buy_carts SET status = 'submitted', submitted_at = now(),
           submitted_by = ${actor.name || actor.username || null}, updated_at = now()
     WHERE id = ${cartId} AND status = 'draft' RETURNING *`;
  if (!rows[0]) return null;
  await logCartEvent({ cartId, kind: 'submitted', actor });
  return cartOut(rows[0]);
}

// Back to draft while nothing has been decided. Allowed only with no approved lines —
// pulling a request somebody already said yes to would let the buyer swap the contents
// of an approval.
export async function withdrawBuyCart(cartId, actor) {
  const sql = db();
  const rows = await sql`
    UPDATE buy_carts SET status = 'draft', submitted_at = NULL, submitted_by = NULL, updated_at = now()
     WHERE id = ${cartId} AND status = 'submitted'
       AND NOT EXISTS (SELECT 1 FROM buy_cart_lines WHERE cart_id = ${cartId} AND status <> 'pending')
     RETURNING *`;
  if (!rows[0]) return null;
  await logCartEvent({ cartId, kind: 'withdrawn', actor });
  return cartOut(rows[0]);
}

/**
 * Approve or reject lines — one, several, or every pending one.
 *
 * Either staff side may decide (warehouse/admin or PH): the endpoint is the gate, and
 * what's recorded here is WHO, by id and by role, because the auditor later must not be
 * the approver and that comparison can't run on a display name.
 *
 * The cart's own status follows the lines rather than being set by hand: once nothing is
 * pending it is `approved` if anything survived, `denied` if nothing did. A status typed
 * separately from the rows it describes is a status that drifts from them.
 */
export async function decideBuyCartLines({ cartId, lineIds = null, action, reason = null, actor }) {
  const sql = db();
  const status = action === 'approve' ? 'approved' : 'rejected';
  const actorId = actor && Number(actor.uid) ? Number(actor.uid) : null;
  const ids = Array.isArray(lineIds) && lineIds.length ? lineIds.map(Number).filter(Number.isInteger) : null;
  // A decision only ever lands on a line that is still pending: re-deciding a line that
  // has already been paid for is what the funded freeze exists to prevent, and doing it
  // silently in a bulk action is how that gets missed.
  const rows = ids
    ? await sql`
        UPDATE buy_cart_lines SET status = ${status}, decided_by = ${actor.name || actor.username || null},
               decided_by_id = ${actorId}, decided_role = ${actor.role}, decided_at = now(),
               decided_reason = ${reason}, updated_at = now()
         WHERE cart_id = ${cartId} AND status = 'pending' AND id = ANY(${ids}::bigint[])
         RETURNING *`
    : await sql`
        UPDATE buy_cart_lines SET status = ${status}, decided_by = ${actor.name || actor.username || null},
               decided_by_id = ${actorId}, decided_role = ${actor.role}, decided_at = now(),
               decided_reason = ${reason}, updated_at = now()
         WHERE cart_id = ${cartId} AND status = 'pending'
         RETURNING *`;
  await recalcCartMoney(sql, cartId);
  // Now settle the cart's own status from what the lines say.
  await sql`
    UPDATE buy_carts SET
      status = CASE WHEN pending_count > 0 THEN 'submitted'
                    WHEN approved_count > 0 THEN 'approved'
                    ELSE 'denied' END,
      approved_at = CASE WHEN pending_count = 0 AND approved_count > 0 AND approved_at IS NULL
                         THEN now() ELSE approved_at END,
      approved_by = CASE WHEN pending_count = 0 AND approved_count > 0 AND approved_by IS NULL
                         THEN ${actor.name || actor.username || null} ELSE approved_by END,
      approved_by_id = CASE WHEN pending_count = 0 AND approved_count > 0 AND approved_by_id IS NULL
                            THEN ${actorId} ELSE approved_by_id END,
      approved_by_role = CASE WHEN pending_count = 0 AND approved_count > 0 AND approved_by_role IS NULL
                              THEN ${actor.role} ELSE approved_by_role END,
      -- The key the "approver can't also audit" check compares on. The id alone is NULL
      -- for the env admin/superadmin accounts, which turned that control off for exactly
      -- the two accounts it most needed to cover.
      approved_by_key = CASE WHEN pending_count = 0 AND approved_count > 0 AND approved_by_key IS NULL
                             THEN ${actorKeyOf(actor)} ELSE approved_by_key END,
      updated_at = now()
    WHERE id = ${cartId} AND status IN ('submitted','approved','denied')`;
  for (const r of rows) {
    await logCartEvent({
      cartId, kind: action === 'approve' ? 'line_approved' : 'line_rejected',
      lineId: r.id, actor, body: reason || `${r.sku} ${r.size || ''} ×${r.qty}`,
    });
  }
  return { decided: rows.length, cart: await getBuyCart(cartId) };
}

// ---- Gift cards -----------------------------------------------------------
// `codeEnc`/`pinEnc` arrive ALREADY encrypted: the endpoint holds the plaintext for the
// length of one request and this layer never sees it. Keeping the cipher call out of
// here is deliberate — it means no query in this file can accidentally round-trip a
// code, and a `SELECT *` on this table is useless to whoever runs it.
export async function addBuyCartGiftCard({ cartId, codeEnc, codeLast4, pinEnc, balance, retailer, label, actor }) {
  const sql = db();
  const rows = await sql`
    INSERT INTO buy_cart_gift_cards (cart_id, code_enc, code_last4, pin_enc, balance, retailer, label, issued_by, issued_by_id)
    VALUES (${cartId}, ${codeEnc}, ${codeLast4}, ${pinEnc}, ${balance}, ${retailer || null}, ${label || null},
            ${actor.name || actor.username || null}, ${actor && Number(actor.uid) ? Number(actor.uid) : null})
    RETURNING id, cart_id, code_last4, balance, retailer, label, issued_by, issued_at`;
  await recalcCartMoney(sql, cartId);
  await logCartEvent({ cartId, kind: 'gc_added', gcId: rows[0].id, actor, body: `•••• ${codeLast4} · $${Number(balance).toFixed(2)}` });
  return { ...rows[0], balance: Number(rows[0].balance) };
}

// Void rather than delete: a card that was issued and then withdrawn is a thing that
// happened to company money, and the trail has to keep it. Voided cards drop out of
// `gc_total`, so the funding check is unaffected.
export async function voidBuyCartGiftCard({ cartId, gcId, reason, actor }) {
  const sql = db();
  const rows = await sql`
    UPDATE buy_cart_gift_cards SET voided_at = now(), voided_reason = ${reason || null}
     WHERE id = ${gcId} AND cart_id = ${cartId} AND voided_at IS NULL
     RETURNING id, code_last4, balance`;
  if (!rows[0]) return null;
  await recalcCartMoney(sql, cartId);
  await logCartEvent({ cartId, kind: 'gc_voided', gcId, actor, body: reason || null });
  return rows[0];
}

// The ONE place a stored code comes back out, and the caller writes a `gc_revealed`
// event before handing it on. Returns the ciphertext; decrypting is the endpoint's job,
// so the key never has to be reachable from the query layer.
export async function getBuyCartGiftCardSecret(cartId, gcId) {
  const sql = db();
  return (await sql`
    SELECT id, cart_id, code_enc, pin_enc, code_last4, balance
      FROM buy_cart_gift_cards WHERE id = ${gcId} AND cart_id = ${cartId}`)[0] || null;
}

export async function fundBuyCart(cartId, actor) {
  const sql = db();
  const rows = await sql`
    UPDATE buy_carts SET status = 'funded', funded_at = now(),
           funded_by = ${actor.name || actor.username || null},
           funded_by_id = ${actor && Number(actor.uid) ? Number(actor.uid) : null}, updated_at = now()
     WHERE id = ${cartId} AND status = 'approved' RETURNING *`;
  if (!rows[0]) return null;
  await logCartEvent({ cartId, kind: 'funded', actor, body: `$${Number(rows[0].gc_total).toFixed(2)} issued against $${Number(rows[0].approved_amount).toFixed(2)} approved` });
  return cartOut(rows[0]);
}

// ---- Files ----------------------------------------------------------------
export async function addBuyCartFile({ cartId, kind, key, name, contentType, sizeBytes, actor }) {
  const sql = db();
  const rows = await sql`
    INSERT INTO buy_cart_files (cart_id, kind, r2_key, name, content_type, size_bytes, uploaded_by, uploaded_by_id)
    VALUES (${cartId}, ${kind}, ${key}, ${name || null}, ${contentType || null}, ${sizeBytes ?? null},
            ${actor.name || actor.username || null}, ${actor && Number(actor.uid) ? Number(actor.uid) : null})
    RETURNING id, cart_id, kind, name, content_type, size_bytes, uploaded_by, uploaded_at`;
  // The receipt is a step in its own right, so its arrival is stamped on the cart —
  // "receipt was received" is a closing condition and must not be inferred from a file
  // list somebody could have filtered differently.
  if (kind === 'receipt') {
    await sql`UPDATE buy_carts SET receipt_at = coalesce(receipt_at, now()),
                     receipt_by = coalesce(receipt_by, ${actor.name || actor.username || null}),
                     status = CASE WHEN status = 'funded' THEN 'receipted' ELSE status END,
                     updated_at = now()
               WHERE id = ${cartId}`;
  }
  await logCartEvent({ cartId, kind: 'file_added', actor, body: `${kind}: ${name || key}` });
  return rows[0];
}

export async function getBuyCartFile(cartId, fileId) {
  const sql = db();
  return (await sql`SELECT * FROM buy_cart_files WHERE id = ${fileId} AND cart_id = ${cartId}`)[0] || null;
}

export async function removeBuyCartFile(cartId, fileId, actor) {
  const sql = db();
  const rows = await sql`DELETE FROM buy_cart_files WHERE id = ${fileId} AND cart_id = ${cartId} RETURNING r2_key, kind, name`;
  if (!rows[0]) return null;
  await logCartEvent({ cartId, kind: 'file_removed', actor, body: `${rows[0].kind}: ${rows[0].name || ''}` });
  return rows[0];
}

// ---- Receipt --------------------------------------------------------------
// Replaces the whole parsed set in one transaction: a re-parse is a correction of the
// same receipt, and leaving the previous attempt's rows behind would double the spend.
// Each line is matched to an approved request line where SKU and size agree, which is
// what makes "bought but never approved" visible instead of silently fine.
export async function setBuyCartReceiptLines({ cartId, lines, receiptTotal, actor }) {
  const sql = db();
  await sql`DELETE FROM buy_cart_receipt_lines WHERE cart_id = ${cartId}`;
  for (const l of lines) {
    await sql`
      INSERT INTO buy_cart_receipt_lines (cart_id, sku, size, qty, name, unit_price, total_price, source, matched_line_id)
      VALUES (${cartId}, ${l.sku || null}, ${l.size || null}, ${l.qty}, ${l.name || null},
              ${l.unitPrice ?? null}, ${l.totalPrice ?? null}, ${l.source || 'manual'},
              (SELECT id FROM buy_cart_lines
                WHERE cart_id = ${cartId} AND status = 'approved'
                  AND upper(btrim(sku)) = upper(btrim(${l.sku || ''}))
                  AND coalesce(upper(btrim(size)), '') = coalesce(upper(btrim(${l.size || ''})), '')
                ORDER BY id LIMIT 1))`;
  }
  await sql`
    UPDATE buy_carts SET receipt_total = ${receiptTotal},
           balance_remaining = gc_total - ${receiptTotal},
           status = CASE WHEN status IN ('funded','receipted') THEN 'receipted' ELSE status END,
           updated_at = now()
     WHERE id = ${cartId}`;
  await logCartEvent({ cartId, kind: 'receipt_parsed', actor, body: `${lines.length} lines · $${Number(receiptTotal).toFixed(2)}` });
  return getBuyCartFull(cartId);
}

export async function linkBuyCartPo(cartId, poId, actor) {
  const sql = db();
  const rows = await sql`UPDATE buy_carts SET po_id = ${poId}, updated_at = now() WHERE id = ${cartId} RETURNING *`;
  await logCartEvent({ cartId, kind: 'po_raised', actor, body: `PO #${poId}` });
  return cartOut(rows[0]);
}

// ---- Audit + close --------------------------------------------------------
// The auditor writes what each card was actually spent and what is left on it. Those
// two numbers are what "the company can account for the funds supplied" means in
// practice — an unexplained gap is exactly what the step exists to surface.
export async function auditBuyCart({ cartId, cards, actor }) {
  const sql = db();
  for (const c of cards) {
    await sql`
      UPDATE buy_cart_gift_cards SET spent_amount = ${c.spent ?? null}, remaining = ${c.remaining ?? null}
       WHERE id = ${c.id} AND cart_id = ${cartId}`;
  }
  const rows = await sql`
    UPDATE buy_carts SET status = CASE WHEN status = 'receipted' THEN 'audited' ELSE status END,
           audited_at = now(), audited_by = ${actor.name || actor.username || null},
           audited_by_id = ${actor && Number(actor.uid) ? Number(actor.uid) : null},
           audited_by_key = ${actorKeyOf(actor)}, updated_at = now()
     WHERE id = ${cartId} RETURNING *`;
  await logCartEvent({ cartId, kind: 'audited', actor });
  return cartOut(rows[0]);
}

export async function closeBuyCart(cartId, actor) {
  const sql = db();
  const rows = await sql`
    UPDATE buy_carts SET status = 'closed', closed_at = now(),
           closed_by = ${actor.name || actor.username || null}, updated_at = now()
     WHERE id = ${cartId} RETURNING *`;
  await logCartEvent({ cartId, kind: 'closed', actor });
  return cartOut(rows[0]);
}

export async function cancelBuyCart(cartId, reason, actor) {
  const sql = db();
  const rows = await sql`
    UPDATE buy_carts SET status = 'cancelled', denied_reason = ${reason || null}, updated_at = now()
     WHERE id = ${cartId} AND status IN ('draft','submitted','denied') RETURNING *`;
  if (!rows[0]) return null;
  await logCartEvent({ cartId, kind: 'cancelled', actor, body: reason || null });
  return cartOut(rows[0]);
}

// Home-screen badges. One query, four numbers: what each desk is holding up.
export async function buyCartPendingCounts() {
  const sql = db();
  const rows = await sql`
    SELECT count(*) FILTER (WHERE status = 'submitted')::int              AS carts_to_approve,
           count(*) FILTER (WHERE status = 'approved')::int               AS carts_to_fund,
           count(*) FILTER (WHERE status = 'funded')::int                 AS carts_awaiting_receipt,
           count(*) FILTER (WHERE status IN ('receipted','audited'))::int AS carts_to_audit
      FROM buy_carts`;
  return rows[0];
}
