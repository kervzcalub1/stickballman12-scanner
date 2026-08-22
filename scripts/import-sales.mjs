// Import a Sales Report CSV (Style ID, Sale Date) into `sales_history`.
//
//   node scripts/import-sales.mjs ~/Downloads/SalesReport-….csv
//   node scripts/import-sales.mjs <file> --dry          # parse and report, write nothing
//   node scripts/import-sales.mjs <file> --prod         # against PROD_DATABASE_URL
//
// **Re-importing is safe.** Exports overlap — next month's file will contain this
// month's sales again — so the import REPLACES everything already stored inside the
// file's own date range before inserting. Appending blindly would silently double a
// style's velocity, and a doubled velocity is a buy decision made on a lie.
//
// Rows with no Style ID are skipped and counted (the first export had 35). Dual SKUs
// ("315115-112/DD8959-100") stay whole in `style_id` and are split into `codes`, so a
// lookup for either half finds the sale exactly once.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const DRY = args.includes('--dry');
const PROD = args.includes('--prod');

if (!file) {
  console.log('\nUsage: node scripts/import-sales.mjs <SalesReport.csv> [--dry] [--prod]\n');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.log(`\nNo such file: ${file}\n`); process.exit(1); }

const url = PROD ? process.env.PROD_DATABASE_URL : process.env.DATABASE_URL;
if (!url) { console.log(`\n${PROD ? 'PROD_DATABASE_URL' : 'DATABASE_URL'} is not set.\n`); process.exit(1); }

/* --------------------------------- parse --------------------------------- */

// Minimal CSV read: this export is two plain columns with no quoting or embedded
// commas. If that ever changes, this is the thing to replace — not to patch.
const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const header = lines.shift() || '';
if (!/style\s*id/i.test(header) || !/sale\s*date/i.test(header)) {
  console.log(`\nUnexpected header: ${header}\nExpected "Style ID,Sale Date".\n`);
  process.exit(1);
}

// M/D/YYYY in the export. Parsed by hand rather than with `new Date(...)`: that would
// read the string in the machine's timezone and can roll a sale back a day — and this
// business runs on EST, never the host's clock.
function parseDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

const rows = [];
let blankStyle = 0; let badDate = 0;
for (const line of lines) {
  const i = line.lastIndexOf(',');            // date is the last field
  const style = line.slice(0, i).trim();
  const date = parseDate(line.slice(i + 1));
  if (!style) { blankStyle += 1; continue; }
  if (!date) { badDate += 1; continue; }
  const codes = style.split('/').map((c) => c.trim().toUpperCase()).filter(Boolean);
  rows.push({ style, codes, date });
}

if (!rows.length) { console.log('\nNothing to import.\n'); process.exit(1); }
const dates = rows.map((r) => r.date).sort();
const from = dates[0]; const to = dates[dates.length - 1];
const styles = new Set(rows.map((r) => r.style));

console.log(`\n${path.basename(file)}`);
console.log(`  ${rows.length} sales · ${styles.size} styles · ${from} → ${to}`);
if (blankStyle) console.log(`  ${blankStyle} rows skipped: no Style ID`);
if (badDate) console.log(`  ${badDate} rows skipped: unreadable Sale Date`);
console.log(`  ${rows.filter((r) => r.codes.length > 1).length} rows carry a dual SKU`);
if (DRY) { console.log('\n--dry: nothing written.\n'); process.exit(0); }

/* --------------------------------- write --------------------------------- */

const pool = new pg.Pool({
  connectionString: url,
  ssl: /sslmode=require/.test(url) || PROD ? { rejectUnauthorized: false } : undefined,
});
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [{ n: had }] } = await client.query(
    'SELECT count(*)::int AS n FROM sales_history WHERE sale_date BETWEEN $1 AND $2', [from, to],
  );
  if (had) console.log(`  replacing ${had} rows already stored in ${from} → ${to}`);
  await client.query('DELETE FROM sales_history WHERE sale_date BETWEEN $1 AND $2', [from, to]);

  // One multi-row INSERT per chunk — 18k single inserts is a minute of round trips.
  const CHUNK = 1000;
  const src = path.basename(file);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    slice.forEach((r, j) => {
      const b = j * 4;
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`);
      params.push(r.style, r.codes, r.date, src);
    });
    await client.query(
      `INSERT INTO sales_history (style_id, codes, sale_date, source_file) VALUES ${values.join(',')}`,
      params,
    );
    process.stdout.write(`\r  inserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  await client.query('COMMIT');
  const { rows: [{ n: total }] } = await client.query('SELECT count(*)::int AS n FROM sales_history');
  console.log(`\n\n✓ Imported. sales_history now holds ${total} rows.\n`);
} catch (e) {
  await client.query('ROLLBACK');
  console.log(`\n\nFailed, nothing written: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
