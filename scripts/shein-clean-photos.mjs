// SHEIN Listings → CLEAN PHOTOS backfill (docs/context/shein-listings.md → "Clean photos").
//
// Since 2026-11-14 the brand tool records the transparent cutout behind every branded angle
// (product_cutouts). Every shoe branded BEFORE that still has its cutouts on R2
// (listings/<sku>/_cut/<ms>-<rand>.png) but nothing says which angle each one is. This finds them:
// list the folder, then match each cutout to the uploaded branded photo of each angle by its
// picture (how 'checked'), with the staging order as a fallback only when it agrees with every
// picture match (how 'timestamp'). A cutout that matches nothing is left alone.
//
//   node scripts/shein-clean-photos.mjs                       # DRY RUN: the styles on SHEIN Listings
//   node scripts/shein-clean-photos.mjs --all                 # … every style with PH edited photos
//   node scripts/shein-clean-photos.mjs --sku HF2886-001      # one style (repeatable)
//   node scripts/shein-clean-photos.mjs --apply               # record them (product_cutouts only)
//   --limit 50   stop after 50 styles      --redo   look again at styles that already have clean photos
//   --concurrency 3   styles at a time (1–8)
//
// Reads R2 (list + the photos) and the DB; with --apply writes product_cutouts ONLY. Never writes or
// deletes anything on R2. Each cutout's outline is recorded too (`shape` → side view / sole / pair): SHEIN's
// photo 1 must be a side view, and PH's brand-tool slot often isn't the view (docs → "The main photo").
// Idempotent: a re-run skips styles already done (unless --redo) and never
// replaces a cutout the brand tool itself recorded. ~10 MB of photos per style (5 cutouts + 5 branded).
import fs from 'node:fs';
import path from 'node:path';

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
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set (add it to .env).'); process.exit(1); }
{
  const u = process.env.DATABASE_URL;
  if (/\.railway\.app|\.rlwy\.net|\.rds\.amazonaws\.com/.test(u) && !/sslmode=/.test(u)) process.env.DATABASE_URL = u + (u.includes('?') ? '&' : '?') + 'sslmode=require';
}

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const vals = (f) => args.flatMap((a, i) => (a === f && args[i + 1] ? [args[i + 1]] : []));
const apply = flag('--apply'); const all = flag('--all'); const redo = flag('--redo');
const limit = Number(vals('--limit')[0]) || Infinity;

const { cleanBackfillStyles, stylesWithCutouts } = await import('../api/_lib/db.js');
const { findCleanPhotos } = await import('../api/_lib/shein-clean-photos.js');
const { cleanOrder } = await import('../src/lib/sheinCleanPhotos.js');
const { r2Configured } = await import('../api/_lib/r2.js');
if (!r2Configured()) { console.error('R2 is not configured (R2_* in .env) — nothing to list.'); process.exit(1); }

let styles = vals('--sku');
if (!styles.length) styles = await cleanBackfillStyles({ all });
if (!redo && !vals('--sku').length) {
  const done = await stylesWithCutouts();
  styles = styles.filter((s) => !done.has(String(s).toUpperCase()));
}
styles = styles.slice(0, limit);
console.log(`${apply ? 'APPLY' : 'DRY RUN'} · ${styles.length} style${styles.length === 1 ? '' : 's'}${all ? ' (every style with PH edited photos)' : ' (on SHEIN Listings)'}`);

const tally = { checked: 0, mixed: 0, none: 0, photos: 0, recorded: 0, failed: 0 };
const misses = [];
// three styles at a time (each is ~10 photos to download + decode)
const conc = Math.max(1, Math.min(8, Number(vals('--concurrency')[0]) || 3));
let i = 0; let next = 0;
async function worker() {
  while (next < styles.length) {
    const sku = styles[next++];
    try {
      const r = await findCleanPhotos(sku, { write: apply, by: 'clean-photos backfill' });
      i += 1;
      tally[r.confidence] = (tally[r.confidence] || 0) + 1; tally.photos += r.found.length; tally.recorded += r.recorded;
      if (r.found.length < (r.angles || 0)) misses.push(`${sku} ${r.found.length}/${r.angles} (${r.cutouts} cutouts)`);
      // + what each shows (side view = S, sole = o, pair = p) and photo 1 for SHEIN (MAIN? = none confirmed: the shoe is held)
      const o = cleanOrder(r.found);
      if (r.found.length && o.unsure) tally.mainUnsure = (tally.mainUnsure || 0) + 1;
      console.log(`${String(i).padStart(4)}/${styles.length} ${sku.padEnd(22)} ${r.confidence.padEnd(8)} ${r.found.map((f) => `${f.angle}${f.how === 'timestamp' ? '~' : ''}${({ side: '[S]', sole: '[o]', pair: '[p]' })[f.view] || ''}`).join(' ') || `— (${r.why})`}${r.found.length ? (o.unsure ? '  MAIN?' : `  main=${o.main.angle}`) : ''}`);
    } catch (e) {
      i += 1; tally.failed += 1; console.log(`${String(i).padStart(4)}/${styles.length} ${sku.padEnd(22)} FAILED ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: conc }, worker));
console.log('\n', tally);
if (misses.length) console.log(`\nAngles not matched (PH moved / resized the shoe, or no cutout): ${misses.length}\n  ${misses.slice(0, 40).join('\n  ')}`);
console.log(apply ? '\nRecorded in product_cutouts.' : '\nNothing written — add --apply to record them.');
process.exit(0);
