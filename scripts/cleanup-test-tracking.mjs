// One-off: take invented TEST tracking numbers off the 17TRACK account.
//
// `e2e/po-edit.spec.js` builds numbers like `EDIT<timestamp>A` and `1ZEDIT<...>A1`, and
// PO creation registers every tracking number it is handed (po/create, label-add,
// label-update). On a developer machine the dev server loads .env, so those invented
// numbers were registered against the REAL account: they sit in the dashboard as
// "Not found · Other issues", and they stay on auto-tracking, which is the part that
// keeps costing. Test teardown deletes the po_boxes rows; the registration is
// account-wide and outlives them, which is why none of them exist in any database.
//
// The leak itself is fixed in playwright.config.js (the suite now runs with a blank
// TRACKING_API_KEY). This only cleans up what already landed.
//
//   node scripts/cleanup-test-tracking.mjs                    # dry run
//   node scripts/cleanup-test-tracking.mjs --apply            # stop tracking them
//   node scripts/cleanup-test-tracking.mjs --apply --delete   # and clear the dashboard
//
// The list is pulled from 17TRACK itself, so nothing is typed or guessed.
import fs from 'node:fs';

const BASE = 'https://api.17track.net/track/v2.2';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const del = args.includes('--delete');

// A courier does not issue a number containing "EDIT" or "E2E". Matching on the marker
// rather than on a date range means this cannot reach a real parcel, even one this
// script has never seen before.
const TEST_MARKER = /(EDIT|E2E|SCNTRK|TESTTRK)/i;

for (const l of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const token = process.env.TRACKING_API_KEY;
if (!token) { console.error('No TRACKING_API_KEY in .env — nothing to do.'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 17TRACK rate-limits these endpoints hard (paging 23 pages back to back returns 429).
// Back off and retry rather than dying half way through a cleanup — a partial run leaves
// the account in a state nobody can reason about.
const call = async (path, body, attempt = 0) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { '17token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt < 6) {
    const wait = 2000 * (attempt + 1);
    console.log(`  rate limited, waiting ${wait / 1000}s…`);
    await sleep(wait);
    return call(path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`17TRACK ${path} → HTTP ${res.status}`);
  return res.json();
};

const all = [];
for (let page = 1; page <= 200; page += 1) {
  const r = await call('/gettracklist', { page_no: page, order_by: 'RegisterTimeDesc' });
  all.push(...(r?.data?.accepted || []));
  process.stdout.write(`\rreading page ${page}… ${all.length} numbers`);
  if (!r?.page?.has_next) break;
  await sleep(1200);
}
console.log('');

const fixtures = all.filter((x) => TEST_MARKER.test(x.number || ''));
const stillTracking = fixtures.filter((x) => x.tracking_status === 'Tracking').length;
console.log(`${all.length} registered · ${fixtures.length} carry a test marker · ${all.length - fixtures.length} left alone`);
console.log(`${stillTracking} of those are still on auto-tracking (that is what keeps costing).`);
if (fixtures.length) {
  const days = [...new Set(fixtures.map((x) => String(x.register_time || '').slice(0, 10)))].sort();
  console.log(`registered on: ${days.join(', ')}`);
}
if (!fixtures.length) { console.log('Nothing to clean.'); process.exit(0); }

const numbers = [...new Set(fixtures.map((x) => x.number))];
if (!apply) {
  console.log('\nDRY RUN — would stop tracking:');
  for (const n of numbers.slice(0, 10)) console.log('  ', n);
  if (numbers.length > 10) console.log(`   … and ${numbers.length - 10} more`);
  console.log('\nRe-run with --apply (add --delete to also clear them from the dashboard).');
  process.exit(0);
}

// 40 per call is the aggregator's batch cap, same as registerTracking/stopTracking.
let stopped = 0; let deleted = 0;
for (let i = 0; i < numbers.length; i += 40) {
  const batch = numbers.slice(i, i + 40).map((number) => ({ number }));
  await sleep(1200);
  const stop = await call('/stoptrack', batch);
  stopped += stop?.data?.accepted?.length || 0;
  if (stop?.data?.rejected?.length) console.log('  stoptrack rejected:', JSON.stringify(stop.data.rejected.slice(0, 3)));
  if (del) {
    const gone = await call('/deletetrack', batch);
    deleted += gone?.data?.accepted?.length || 0;
    if (gone?.data?.rejected?.length) console.log('  deletetrack rejected:', JSON.stringify(gone.data.rejected.slice(0, 3)));
  }
  console.log(`batch ${Math.floor(i / 40) + 1}: ${i + batch.length}/${numbers.length}`);
}
console.log(`\nStopped tracking: ${stopped}${del ? ` · deleted: ${deleted}` : ''}`);
