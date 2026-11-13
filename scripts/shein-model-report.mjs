// READ-ONLY: which shoes went to SHEIN with a Setup-default Product Model that isn't theirs (2026-11-14).
//
// Setup → SHEIN details used to save a TYPED detail (Product Model) as a default for every shoe of a SHEIN product
// type, so e.g. a LeBron 23 was published as "ACG Air Max". This lists every shoe whose latest successful publish
// carried such a default AND whose own model (typed on the shoe, else read from its title when sure) differs —
// the candidates for a correction edit. It never writes to the database and never calls SHEIN; correcting live
// shoes is the owner's decision.
//
//   node scripts/shein-model-report.mjs           # a table
//   node scripts/shein-model-report.mjs --csv     # CSV on stdout
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { setupModelReport } from '../api/_lib/shein-model-report.js';

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
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required.'); process.exit(1); }
const DB_URL = process.env.DATABASE_URL;
const loose = /\bsslmode=require\b|\.neon\.tech|\brlwy\.net\b|\.railway\.app\b/.test(DB_URL);
const pool = new pg.Pool({ connectionString: DB_URL, ssl: loose ? { rejectUnauthorized: false } : undefined });

try {
  const { rows, setup, checked } = await setupModelReport(pool);
  if (process.argv.includes('--csv')) {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    console.log(['shopify_product_id', 'spu', 'title', 'product_type_id', 'sent_model', 'should_be', 'from', 'title_guess', 'reason', 'sent_at'].join(','));
    for (const r of rows) console.log([r.productId, r.spu, r.title, r.ptid, r.sent, r.should, r.from, r.guess, r.reason, r.sentAt ? new Date(r.sentAt).toISOString() : ''].map(q).join(','));
  } else {
    console.log(`Setup Product Model defaults: ${setup.map((s) => `${s.ptid} = ${s.values.map((v) => `"${v}"`).join(', ')}`).join(' · ') || 'none'}`);
    console.log(`Published shoes checked: ${checked} · sent a Setup default that isn't theirs: ${rows.length}\n`);
    for (const r of rows) console.log(`${r.spu || '—'} | ${r.title} | sent "${r.sent}" → ${r.should ? `"${r.should}" (${r.from === 'title' ? 'from the title' : 'typed for the shoe'})` : `needs a person (title guess "${r.guess || ''}")`}`);
  }
} finally { await pool.end(); }
