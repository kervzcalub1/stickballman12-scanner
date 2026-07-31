// Copy production DATA into a local database, for recording tutorials against real
// inventory without ever writing to prod.
//
//   node --env-file=.env scripts/clone-prod-local.mjs
//
// Why not pg_dump: prod runs PostgreSQL 18 and this machine has client 16, which refuses
// to dump a newer server; and the local server is 16, so an 18 dump could not be restored
// into it either. Both problems vanish if the SCHEMA comes from the app's own migration
// (`npm run db:setup` against the target) and this script copies only ROWS.
//
// That has a second benefit: prod may be behind on migrations, so the two schemas are not
// guaranteed identical. Columns are intersected per table — anything prod lacks is simply
// left at the local default rather than exploding mid-copy.
//
// Prod is opened READ ONLY. The only writes go to the target.
import pg from 'pg';

const { Client } = pg;
const SRC = process.env.PROD_DATABASE_URL;
const DST = process.env.CLONE_TARGET_URL || 'postgresql://localhost/stickballman_prod';

// Parent-first, so foreign keys resolve as we go. Anything not listed is copied
// afterwards in whatever order the catalogue reports.
const ORDER = [
  'users', 'suppliers', 'app_settings', 'locations', 'purchase_orders', 'po_boxes',
  'po_lines', 'po_labels', 'batches', 'boxes', 'items', 'item_events', 'product_photos',
  'rescale_requests', 'rescale_request_sizes', 'ph_size_rows', 'po_notes', 'po_threads',
];

const cols = async (c, t) => (await c.query(
  `select column_name from information_schema.columns
   where table_schema='public' and table_name=$1 order by ordinal_position`, [t],
)).rows.map((r) => r.column_name);

// `id` columns are GENERATED ALWAYS AS IDENTITY, which rejects an explicit value outright.
// Copying rows means keeping their original ids — every foreign key in the dump depends on
// them — so those inserts need OVERRIDING SYSTEM VALUE. The clause is only legal on a table
// that actually has such a column, hence the check rather than applying it blindly.
const hasAlwaysIdentity = async (c, t) => (await c.query(
  `select 1 from information_schema.columns
   where table_schema='public' and table_name=$1
     and is_identity='YES' and identity_generation='ALWAYS' limit 1`, [t],
)).rowCount > 0;

// node-postgres PARSES json/jsonb on the way out, so a details column arrives as a JS
// object and does not survive being handed straight back as a parameter. Those columns are
// re-serialized and the placeholder is cast explicitly. A value that is already a string is
// left alone — prod stores some of these as text, and stringifying again would double-encode.
const jsonCols = async (c, t) => new Set((await c.query(
  `select column_name from information_schema.columns
   where table_schema='public' and table_name=$1 and data_type in ('json','jsonb')`, [t],
)).rows.map((r) => r.column_name));

const forJson = (v) => (v === null || v === undefined || typeof v === 'string' ? v : JSON.stringify(v));

async function main() {
  if (!SRC) { console.error('PROD_DATABASE_URL is not set.'); process.exit(1); }
  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 20000 });
  const dst = new Client({ connectionString: DST });
  await src.connect();
  await dst.connect();
  // Belt and braces: this session cannot write to prod even if a bug tried to.
  await src.query('set default_transaction_read_only = on');

  const tables = (await src.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_type='BASE TABLE'`,
  )).rows.map((r) => r.table_name);
  const ordered = [...ORDER.filter((t) => tables.includes(t)),
    ...tables.filter((t) => !ORDER.includes(t))];

  // FKs are checked per statement, and the catalogue order is not dependency order for
  // self-referencing tables. Replica mode defers the lot; we are the owner locally.
  await dst.query("set session_replication_role = 'replica'");

  // Empty EVERYTHING first, in one statement.
  //
  // Truncating per-table inside the copy loop silently destroys work already done:
  // TRUNCATE ... CASCADE also truncates every table that REFERENCES the target, so
  // clearing `products` late in the run wiped the 152 `items` rows copied earlier —
  // the log said they were inserted, and the table was empty afterwards. One truncate
  // of the whole set, before any insert, is the only ordering that is safe.
  await dst.query(`truncate ${ordered.map((t) => `"${t}"`).join(',')} cascade`);

  let total = 0;
  for (const t of ordered) {
    const [sc, dc] = await Promise.all([cols(src, t), cols(dst, t)]);
    const shared = sc.filter((c) => dc.includes(c));
    if (!shared.length) { console.log(`  · ${t} — no shared columns, skipped`); continue; }
    const missing = sc.filter((c) => !dc.includes(c));
    const rows = (await src.query(`select ${shared.map((c) => `"${c}"`).join(',')} from "${t}"`)).rows;
    const override = (await hasAlwaysIdentity(dst, t)) ? ' overriding system value' : '';
    const jcols = await jsonCols(dst, t);
    if (rows.length) {
      // One multi-row INSERT per 500 — a round trip per row would take minutes.
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const params = [];
        const tuples = chunk.map((r) => `(${shared.map((c) => {
          const isJson = jcols.has(c);
          params.push(isJson ? forJson(r[c]) : r[c]);
          return isJson ? `$${params.length}::jsonb` : `$${params.length}`;
        }).join(',')})`);
        await dst.query(
          `insert into "${t}" (${shared.map((c) => `"${c}"`).join(',')})${override} values ${tuples.join(',')}`,
          params,
        );
      }
    }
    total += rows.length;
    console.log(`  ✓ ${t.padEnd(22)} ${String(rows.length).padStart(6)} rows`
      + (missing.length ? `   (prod-only cols ignored: ${missing.join(', ')})` : ''));
  }

  await dst.query("set session_replication_role = 'origin'");

  // Sequences restart at 1 after a truncate, so the next insert would collide with
  // copied rows. Realign every serial to its column's high-water mark.
  const seqs = (await dst.query(`
    select s.relname seq, t.relname tbl, a.attname col
    from pg_class s
    join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass
    join pg_class t on t.oid = d.refobjid
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where s.relkind = 'S'`)).rows;
  for (const s of seqs) {
    await dst.query(
      `select setval($1, coalesce((select max("${s.col}") from "${s.tbl}"), 0) + 1, false)`,
      [s.seq],
    );
  }

  console.log(`\n${total} rows copied into ${DST.split('/').pop()} · ${seqs.length} sequences realigned`);
  await src.end();
  await dst.end();
}

main().catch((e) => { console.error('clone failed:', e.message); process.exit(1); });
