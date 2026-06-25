// V6 backfill — fold pre-V6 receiving batches into the new multi-box model so
// historical data is consistent with Feature 7. Idempotent: only fills gaps
// (boxes/box_id/expected_boxes that are still null/missing), so it's safe to
// re-run. Reads DATABASE_URL from .env (or the process env).
//   node scripts/db-backfill-v6.mjs
//
// What it does (receiving batches only — rescale carries no shipment/boxes):
//   1. expected_boxes := 1 where null (each old batch was a single drop).
//   2. Create one box #1 per batch that has none, carrying the batch's tracking
//      number and marking it received (using the batch's commit time/author).
//   3. Link each unit to its batch's box (items.box_id where null).
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

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

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\bsslmode=require\b|\.neon\.tech/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : undefined,
});
const sql = (text) => pool.query(text);

console.log('Backfilling V6 box model…');

// 1. Default each existing receiving batch to one expected box.
const r1 = await sql(`
  UPDATE batches SET expected_boxes = 1
  WHERE expected_boxes IS NULL AND kind = 'receiving'
`);

// 2. One box per receiving batch that has none — carries its tracking number,
//    marked received with the batch's commit author/time.
const r2 = await sql(`
  INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status, received_by, received_at)
  SELECT b.id, 1, b.tracking_number, 'received', b.created_by, COALESCE(b.committed_at, b.created_at)
  FROM batches b
  WHERE b.kind = 'receiving'
    AND NOT EXISTS (SELECT 1 FROM batch_boxes bx WHERE bx.batch_id = b.id)
`);

// 3. Link units to their batch's box (only where unset).
const r3 = await sql(`
  UPDATE items i
  SET box_id = bx.id
  FROM batch_boxes bx
  WHERE bx.batch_id = i.batch_id
    AND bx.box_number = 1
    AND i.box_id IS NULL
`);

const { rows: [c] } = await sql(`
  SELECT
    (SELECT count(*)::int FROM batch_boxes)                  AS boxes,
    (SELECT count(*)::int FROM items WHERE box_id IS NOT NULL) AS linked,
    (SELECT count(*)::int FROM items WHERE box_id IS NULL)   AS unlinked
`);

console.log(`✓ Backfill done.`);
console.log(`  expected_boxes set : ${r1.rowCount}`);
console.log(`  boxes created      : ${r2.rowCount}`);
console.log(`  items linked       : ${r3.rowCount}`);
console.log(`  totals → boxes: ${c.boxes}, items linked: ${c.linked}, items still unlinked: ${c.unlinked} (rescale units expected here)`);
await pool.end();
