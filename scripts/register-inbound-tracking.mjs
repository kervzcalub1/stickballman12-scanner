#!/usr/bin/env node
// One-off: register every inbound tracking number we already hold with 17TRACK.
//
// Numbers that arrived on a purchase order have been registered since PO creation.
// Numbers typed in at receiving never were — so those boxes had no courier feed
// behind them and read "No courier updates" forever. New numbers are registered at
// their write points from now on (batches/commit, add-box, sync-boxes); this clears
// the backlog that predates that.
//
// SPENDS 17TRACK QUOTA — one registration per number, permanently on the account.
// Dry run by default, and it prints exactly what it would send.
//
//   node scripts/register-inbound-tracking.mjs            # dry run
//   node scripts/register-inbound-tracking.mjs --apply    # register
//   node scripts/register-inbound-tracking.mjs --apply --limit 50
//
// Registration is CLAIMED in the database first (`registered_at`), so re-running is
// safe: a number already claimed is skipped and costs nothing. Run db:setup first —
// this needs the shipment_tracking table.
import fs from 'node:fs';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const LOCAL = process.argv.includes('--local');
const li = process.argv.indexOf('--limit');
const LIMIT = li > -1 ? Math.max(1, Number(process.argv[li + 1]) || 0) : 2000;

function env() {
  const raw = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const get = (k) => (raw.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] || '').trim().replace(/^["']|["']$/g, '');
  return { url: get(LOCAL ? 'DATABASE_URL' : 'PROD_DATABASE_URL'), key: get('TRACKING_API_KEY') };
}
const { url, key } = env();
if (!url) throw new Error('No database URL in .env');
if (APPLY && !key) throw new Error('TRACKING_API_KEY is not set — nothing to register with.');

const c = new pg.Client({ connectionString: url, ssl: LOCAL ? false : { rejectUnauthorized: false } });
await c.connect();

// Everything the warehouse holds that the courier feed has never been told about.
// batch_boxes is where typed-in numbers live; batches.tracking_number covers the
// ordinary single-box receive, which has no box row at all.
const { rows } = await c.query(`
  SELECT DISTINCT n FROM (
    SELECT bx.tracking_number AS n FROM batch_boxes bx WHERE coalesce(bx.tracking_number,'') <> ''
    UNION
    SELECT b.tracking_number  AS n FROM batches b     WHERE coalesce(b.tracking_number,'')  <> ''
  ) s
  WHERE NOT EXISTS (
    SELECT 1 FROM shipment_tracking t
     WHERE t.tracking_number = s.n AND t.registered_at IS NOT NULL)
  LIMIT $1`, [LIMIT]);
// A SHAPE check, not a prefix blocklist. The runtime guard against registering junk
// is APP_ENV (see registerTracking) and blocklisting prefixes there would be fragile.
// This is different: a one-off human-run backfill over data typed by hand over months,
// where "NA" and a 60-character run of concatenated UPCs from a mis-scan are both
// sitting in the column. Registration is permanent and metered, so those are worth
// refusing — and they are listed in full rather than silently dropped.
const looksLikeTracking = (n) => /^[A-Z0-9]{8,35}$/i.test(String(n).replace(/[\s-]/g, ''));

// Send the number the way a courier expects it, not the way somebody typed it.
// 17TRACK rejected "1Z 3YY 408 13 2795 1235" outright for format, and a UPS Mail
// Innovations label carries a 420+ZIP routing prefix in front of the real 1Z — both
// are perfectly good parcels behind a presentation problem.
function normalizeNumber(raw) {
  let n = String(raw || '').trim();
  const m = n.replace(/[\s-]/g, '').match(/^420\d{4,9}(1Z[A-Z0-9]{16})$/i);
  if (m) return m[1].toUpperCase();
  if (/^1Z[\s-]/i.test(n) || /^1Z[A-Z0-9\s-]{16,}$/i.test(n)) n = n.replace(/[\s-]/g, '');
  return n;
}
const all = rows.map((r) => r.n);
const numbers = process.argv.includes('--all') ? all : all.filter(looksLikeTracking);
const skipped = all.filter((n) => !looksLikeTracking(n));

console.log(`${numbers.length} number(s) not yet registered with the courier feed.`);
console.log(numbers.slice(0, 12).map((n) => `  ${n}`).join('\n') + (numbers.length > 12 ? `\n  … and ${numbers.length - 12} more` : ''));
if (skipped.length) {
  console.log(`\n${skipped.length} skipped — these do not look like tracking numbers (pass --all to include them):`);
  for (const n of skipped.slice(0, 20)) console.log(`  ${String(n).slice(0, 70)}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing sent, nothing written. Re-run with --apply to register ${numbers.length}.`);
  await c.end();
  process.exit(0);
}

// Claim first so a crash mid-run cannot double-charge us — then RELEASE anything
// 17TRACK refused. The first version of this script only claimed, which meant a
// number rejected for a fixable reason (a UPS number typed with spaces) was marked
// registered forever and could never be retried once the fix landed.
//
// "Already registered" is NOT a rejection for our purposes: the number is on the
// account, which is the whole point, so it stays claimed.
const isAlreadyRegistered = (msg) => /has been registered/i.test(String(msg || ''));
let sent = 0; let kept = 0; const released = [];
for (let i = 0; i < numbers.length; i += 40) {
  const chunk = numbers.slice(i, i + 40);
  const { rows: claimed } = await c.query(`
    INSERT INTO shipment_tracking (tracking_number, registered_at)
    SELECT n, now() FROM unnest($1::text[]) AS n
    ON CONFLICT (tracking_number) DO UPDATE SET registered_at = now()
      WHERE shipment_tracking.registered_at IS NULL
    RETURNING tracking_number`, [chunk]);
  if (!claimed.length) continue;
  // Map what we SEND back to what we claimed, since normalisation can change it.
  const bySent = new Map(claimed.map((r) => [normalizeNumber(r.tracking_number), r.tracking_number]));
  const list = [...bySent.keys()].map((number) => ({ number }));
  const res = await fetch('https://api.17track.net/track/v2.2/register', {
    method: 'POST',
    headers: { '17token': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  });
  const json = await res.json().catch(() => null);
  const ok = json?.data?.accepted?.length ?? 0;
  const rejected = json?.data?.rejected || [];
  sent += ok;
  for (const r of rejected) {
    const original = bySent.get(String(r.number)) ?? String(r.number);
    if (isAlreadyRegistered(r.error?.message)) { kept += 1; continue; }
    released.push({ number: original, why: r.error?.message || JSON.stringify(r.error) });
  }
  console.log(`  chunk ${i / 40 + 1}: sent ${list.length}, accepted ${ok}, rejected ${rejected.length}`);
  for (const r of rejected.slice(0, 4)) console.log(`     ! ${r.number}: ${r.error?.message || JSON.stringify(r.error)}`);
}
if (released.length) {
  await c.query(`UPDATE shipment_tracking SET registered_at = NULL WHERE tracking_number = ANY($1::text[])`,
    [released.map((r) => r.number)]);
}
console.log(`\nRegistered ${sent}. Already on the account: ${kept}. Released for retry: ${released.length}.`);
for (const r of released.slice(0, 15)) console.log(`  ↩ ${String(r.number).slice(0, 48)} — ${r.why}`);
console.log('\nStatus arrives by webhook as the carriers report it.');
await c.end();
