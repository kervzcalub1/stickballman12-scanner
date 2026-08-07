// GO-LIVE RESET — wipe every scanned unit and every order, keep everything the
// team built up. Run once when beta ends and production starts.
//
//   node scripts/db-go-live.mjs              # asks you to type GO LIVE
//   node scripts/db-go-live.mjs --dry-run    # show what would go, change nothing
//   node scripts/db-go-live.mjs --yes        # no prompt (CI / Railway one-off)
//   node scripts/db-go-live.mjs --catalog    # ALSO drop the cached UPC catalogue
//   node scripts/db-go-live.mjs --photos     # ALSO drop the team's photo rows
//
// WIPED: items + their events/issues/sales, batches + boxes, rescale requests,
//        PH edit locks, and the whole Purchase Order side (orders, labels,
//        manifest lines, resolutions, comments). VIN / batch / PO counters rewind.
// KEPT:  user accounts, product photos (the team's shots + PH edits), the shelf
//        locations tree, supplier names, app settings, login throttle.
//
// DESTRUCTIVE and irreversible. Take a DB snapshot first.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pg from 'pg';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DRY = has('--dry-run');
const SKIP_PROMPT = has('--yes') || has('-y');
const WIPE_CATALOG = has('--catalog');
const WIPE_PHOTOS = has('--photos');

if (!process.env.DATABASE_URL) {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (add it to .env).');
  process.exit(1);
}

// Transactional data — everything a scan, a receive, or an order created.
const WIPE = [
  'item_events',
  'shipment_issues',
  'sales',
  'items',
  'batch_boxes',
  'rescale_requests',
  'edit_locks',
  'po_comments',
  'po_resolutions',
  'po_lines',
  'po_boxes',
  'batches',          // after po_* : purchase_orders.received_batch_id points here
  'purchase_orders',
];
if (WIPE_CATALOG) WIPE.push('products');
if (WIPE_PHOTOS) WIPE.push('product_photos');

const KEEP_NOTE = [
  ['users', 'accounts + roles'],
  ['product_photos', "the team's photos (warehouse + PH edited)"],
  ['locations', 'shelf tree + barcodes'],
  ['suppliers', 'supplier names'],
  ['products', 'cached UPC/SKU catalogue (saves metered lookups)'],
  ['app_settings', 'margin, business name, …'],
].filter(([t]) => !WIPE.includes(t));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\bsslmode=require\b|\.neon\.tech|\.railway\.app|\.rlwy\.net/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});
const sql = (text, params) => pool.query(text, params);

const host = (() => {
  try { const u = new URL(process.env.DATABASE_URL); return `${u.hostname}${u.pathname}`; }
  catch { return '(unparseable DATABASE_URL)'; }
})();
const isLocal = /^(localhost|127\.0\.0\.1)/.test(host);

// Only count tables that actually exist (older DBs may predate a table).
const { rows: present } = await sql(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
);
const existing = new Set(present.map((r) => r.table_name));
const targets = WIPE.filter((t) => existing.has(t));
const missing = WIPE.filter((t) => !existing.has(t));

// Safety net: TRUNCATE … CASCADE silently empties any table that references a
// target. Refuse to run if that would reach something we promised to keep.
const { rows: fks } = await sql(
  `SELECT DISTINCT src.relname AS from_table, tgt.relname AS to_table
     FROM pg_constraint c
     JOIN pg_class src ON src.oid = c.conrelid
     JOIN pg_class tgt ON tgt.oid = c.confrelid
    WHERE c.contype = 'f' AND tgt.relname = ANY($1) AND NOT (src.relname = ANY($1))`,
  [targets],
);
if (fks.length) {
  console.error('Refusing to run — these KEPT tables reference tables being wiped,');
  console.error('so a CASCADE would empty them too:');
  for (const f of fks) console.error(`  • ${f.from_table} → ${f.to_table}`);
  console.error('Add them to WIPE (if they are transactional) or clear the FK first.');
  await pool.end();
  process.exit(1);
}

const counts = {};
for (const t of [...targets, ...KEEP_NOTE.map(([t]) => t)]) {
  if (!existing.has(t)) continue;
  counts[t] = (await sql(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
}

console.log('');
console.log(`  Target DB : ${host}${isLocal ? '' : '   ← NOT localhost'}`);
console.log(`  Mode      : ${DRY ? 'DRY RUN (no writes)' : 'DESTRUCTIVE'}`);
console.log('');
console.log('  Will DELETE');
for (const t of targets) console.log(`    ${String(counts[t]).padStart(7)}  ${t}`);
if (missing.length) console.log(`    (not in this DB: ${missing.join(', ')})`);
console.log('    counters   VIN → 1,  batch → 100001,  PO → 100001');
console.log('');
console.log('  Will KEEP');
for (const [t, why] of KEEP_NOTE) {
  if (!existing.has(t)) continue;
  console.log(`    ${String(counts[t]).padStart(7)}  ${t}  — ${why}`);
}
console.log('');

if (DRY) {
  console.log('Dry run — nothing changed.');
  await pool.end();
  process.exit(0);
}

if (!SKIP_PROMPT) {
  if (!process.stdin.isTTY) {
    console.error('Not a TTY and --yes was not passed. Aborting.');
    await pool.end();
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question('  Type GO LIVE to wipe, anything else to abort: ', res));
  rl.close();
  if (answer.trim().toUpperCase() !== 'GO LIVE') {
    console.log('Aborted — nothing changed.');
    await pool.end();
    process.exit(1);
  }
}

// All-or-nothing: a mid-way failure must not leave half-wiped stock behind.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(`TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`);
  // Standalone sequences aren't owned by a column, so RESTART IDENTITY misses them.
  await client.query(`ALTER SEQUENCE batch_seq RESTART WITH 100001`);
  await client.query(`ALTER SEQUENCE vin_seq   RESTART WITH 1`);
  await client.query(`ALTER SEQUENCE po_seq    RESTART WITH 100001`);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nFailed — rolled back, nothing was deleted.');
  console.error(err.message);
  client.release();
  await pool.end();
  process.exit(1);
} finally {
  client.release();
}

const deleted = targets.reduce((n, t) => n + counts[t], 0);
console.log(`✓ Wiped ${deleted} row(s) across ${targets.length} table(s). Counters rewound.`);
console.log(`✓ Kept ${counts.users ?? 0} account(s)` +
  (existing.has('product_photos') && !WIPE_PHOTOS ? `, ${counts.product_photos} photo(s)` : '') +
  (existing.has('locations') ? `, ${counts.locations} location(s)` : '') + '.');
console.log('  Production phase — first VIN of the day will be SBM-<YYMMDD>-000001.');
await pool.end();
