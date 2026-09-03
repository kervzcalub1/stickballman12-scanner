// Pre-sell: shipments sold before they landed.
//
// Those units must NOT be listed to II or the stores — they are already spoken for, and
// offering one again would sell somebody else's pair. So a pre-sell shipment sits out of
// the PH listing world entirely and surfaces only on the Pre-sell page, where somebody
// says how many of each size an order covers. What is left over is released for listing.
//
// The invariants:
//   1. The flag is declared once, for the SHIPMENT, and lands on every unit.
//   2. Pre-sell is invisible to PH's listing world — the grid AND the badge counts, which
//      is the half that gets forgotten.
//   3. Sold units become `pre_sold`, never `sold`: the pair hasn't shipped, and `sold` is
//      terminal, so claiming it early would strand it if the pre-sale fell through.
//   4. Release puts the REMAINDER on the Rescale Stock worklist and leaves the spoken-for
//      units alone.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const wh = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E WH', role: 'warehouse' })}` });
const ph = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` });
// The WAREHOUSE declares which pairs an order covers — they hold the shipment. PH's part
// starts after release, on Rescale Stock. Marking sold from a PH account must be refused.
const SUPPLIER = 'E2E PreSell Supplier';
let skuN = 0;
const nextSku = () => `E2E-PS-${Date.now().toString(36)}-${++skuN}`;

test.afterAll(async () => {
  await q(`DELETE FROM items WHERE batch_id IN (SELECT id FROM batches WHERE supplier_name = $1)`, [SUPPLIER]);
  await q(`DELETE FROM batches WHERE supplier_name = $1`, [SUPPLIER]);
  await pool.end();
});

// Receive a shipment through the real commit endpoint, pre-sell or not.
async function receive(request, { preSell, sku, sizes }) {
  const items = sizes.flatMap(({ size, n }) =>
    Array.from({ length: n }, () => ({ name: 'E2E PreSell Runner', sku, size, cost: 90, withBox: true })));
  const r = await request.post('/api/batches/commit', {
    headers: wh(),
    data: { kind: 'receiving', batch: { supplier: SUPPLIER, tracking: `E2E-PS-${Date.now()}-${Math.random()}`, preSell }, items, issues: [] },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { batchCode } = await r.json();
  const [b] = await q('SELECT * FROM batches WHERE batch_code = $1', [batchCode]);
  return b;
}

// The multi-box path takes a DIFFERENT route to the same flag: the batch is created open
// up front and each box commits separately, so box-commit reads `pre_sell` off the batch
// row rather than off its own request body. A shipment ticked pre-sell whose boxes then
// arrived unflagged would be listed for sale while already sold.
test('multi-box: every box of a pre-sell shipment inherits the flag', async ({ request }) => {
  const sku = nextSku();
  const open = await request.post('/api/batches/create-open', {
    headers: wh(),
    data: { batch: { supplier: SUPPLIER, tracking: `E2E-PS-MB-${Date.now()}`, expectedBoxes: 2, preSell: true } },
  });
  test.skip(open.status() === 429, 'rate-limited');
  expect(open.ok(), await open.text()).toBeTruthy();
  const { id: batchId } = await open.json();
  const [b] = await q('SELECT pre_sell FROM batches WHERE id = $1', [batchId]);
  expect(b.pre_sell).toBe(true);

  for (const boxNumber of [1, 2]) {
    const box = await request.post('/api/batches/add-box', {
      headers: wh(),
      data: { batchId, trackingNumber: `E2E-PS-MB-${Date.now()}-${boxNumber}`, boxNumber },
    });
    expect(box.ok(), await box.text()).toBeTruthy();
    const commit = await request.post('/api/batches/box-commit', {
      headers: wh(),
      data: { batchId, boxId: (await box.json()).box.id,
              items: [{ name: 'E2E PreSell Runner', sku, size: String(8 + boxNumber), cost: 90, withBox: true }] },
    });
    expect(commit.ok(), await commit.text()).toBeTruthy();
  }

  const rows = await q('SELECT pre_sell FROM items WHERE batch_id = $1', [batchId]);
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.pre_sell)).toBe(true);
});

test('the flag is declared for the shipment and lands on every unit', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 6 }, { size: '10', n: 4 }] });
  expect(b.pre_sell).toBe(true);
  const rows = await q('SELECT pre_sell FROM items WHERE batch_id = $1', [b.id]);
  expect(rows).toHaveLength(10);
  expect(rows.every((r) => r.pre_sell)).toBe(true);

  // A normal shipment is untouched.
  const plain = await receive(request, { preSell: false, sku: nextSku(), sizes: [{ size: '9', n: 2 }] });
  expect(plain.pre_sell).toBe(false);
  expect((await q('SELECT pre_sell FROM items WHERE batch_id = $1', [plain.id])).every((r) => r.pre_sell)).toBe(false);
});

// Who OWNS the answer. The warehouse holds the shipment and knows which pairs an order
// covers; PH's part starts after release. PH reading the pre-sell list is not the point —
// PH being able to declare a pair sold, or release a shipment, is what must not happen.
test('PH cannot declare pre-sell units sold or release them', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 3 }] });

  const marked = await request.post('/api/presell/mark-sold', {
    headers: ph(), data: { batchId: Number(b.id), sku, size: '9', qty: 2 },
  });
  expect(marked.status()).toBe(403);

  const released = await request.post('/api/presell/release', { headers: ph(), data: { batchId: Number(b.id) } });
  expect(released.status()).toBe(403);

  // …and nothing moved.
  const rows = await q('SELECT status, pre_sell FROM items WHERE batch_id = $1', [b.id]);
  expect(rows.every((r) => r.pre_sell && r.status !== 'pre_sold')).toBe(true);
});

test('pre-sell is invisible to PH — the grid AND the badge counts', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 6 }] });

  const grid = await (await request.get('/api/ph/list?from=2020-01-01&to=2035-01-01', { headers: ph() })).json();
  expect((grid.rows || []).filter((r) => r.sku === sku)).toHaveLength(0);

  // The half that gets forgotten: a count is a query too. They must not inflate the
  // listing backlog, and they DO get a count of their own so the work isn't invisible.
  const counts = (await (await request.get('/api/items/pending-counts', { headers: ph() })).json()).counts;
  expect(counts.presell_pending).toBeGreaterThanOrEqual(6);
  const ph_managed = await q(
    `SELECT count(*)::int AS n FROM items i JOIN batches b ON b.id = i.batch_id
     WHERE b.id = $1 AND i.pre_sell`, [b.id]);
  expect(ph_managed[0].n).toBe(6);
});

test('a count and a scan both mark units pre_sold, never sold', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 6 }, { size: '10', n: 4 }] });

  const byCount = await request.post('/api/presell/mark-sold', {
    headers: wh(), data: { batchId: Number(b.id), sku, size: '9', qty: 4 },
  });
  expect(byCount.ok(), await byCount.text()).toBeTruthy();

  const [one] = await q(`SELECT vin FROM items WHERE batch_id = $1 AND size = '10' LIMIT 1`, [b.id]);
  const byScan = await request.post('/api/presell/mark-sold', { headers: wh(), data: { vin: one.vin } });
  expect(byScan.ok(), await byScan.text()).toBeTruthy();

  // `pre_sold`, not `sold` — the pair is still on the floor.
  const st = await q('SELECT status, count(*)::int AS n FROM items WHERE batch_id = $1 GROUP BY status', [b.id]);
  const map = Object.fromEntries(st.map((r) => [r.status, r.n]));
  expect(map.pre_sold).toBe(5);
  expect(map.sold).toBeUndefined();

  // Scanning the same one again is refused rather than silently double-counting.
  const again = await request.post('/api/presell/mark-sold', { headers: wh(), data: { vin: one.vin } });
  expect(again.status()).toBe(409);
  expect(await again.text()).toContain('already marked');
});

test('lowering the count hands units back — a pre-sale can fall through', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 6 }] });
  await request.post('/api/presell/mark-sold', { headers: wh(), data: { batchId: Number(b.id), sku, size: '9', qty: 4 } });
  await request.post('/api/presell/mark-sold', { headers: wh(), data: { batchId: Number(b.id), sku, size: '9', qty: 2 } });
  const [row] = await q(`SELECT count(*) FILTER (WHERE status='pre_sold')::int AS sold FROM items WHERE batch_id = $1`, [b.id]);
  expect(row.sold).toBe(2);
});

test('release sends the remainder to Rescale Stock and leaves the spoken-for alone', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 6 }, { size: '10', n: 4 }] });
  await request.post('/api/presell/mark-sold', { headers: wh(), data: { batchId: Number(b.id), sku, size: '9', qty: 3 } });

  const rel = await request.post('/api/presell/release', { headers: wh(), data: { batchId: Number(b.id) } });
  expect(rel.ok(), await rel.text()).toBeTruthy();
  expect((await rel.json()).released).toBe(7);

  const rows = await q('SELECT status, pre_sell, restock_pending FROM items WHERE batch_id = $1', [b.id]);
  const spoken = rows.filter((r) => r.status === 'pre_sold');
  const freed = rows.filter((r) => r.status !== 'pre_sold');
  expect(spoken).toHaveLength(3);
  // Left alone: still pre-sell, never queued for listing. Listing one would sell
  // somebody else's pair.
  expect(spoken.every((r) => r.pre_sell && !r.restock_pending)).toBe(true);
  expect(freed.every((r) => !r.pre_sell && r.restock_pending)).toBe(true);

  // And they are now on the worklist where PH prices and lists — which is what
  // "subject for upload" means here; no new mechanism was needed.
  const resc = await (await request.get('/api/ph/list?kind=rescale&from=2020-01-01&to=2035-01-01', { headers: ph() })).json();
  expect((resc.rows || []).filter((r) => r.sku === sku).length).toBe(7);

  // ONE worklist, not two. Releasing clears `pre_sell`, which is what used to let
  // these units back onto New Inventory — and they were received days ago, so they
  // sit inside its date window and appeared on both tabs at once. Two lists claiming
  // the same pair is how it gets listed twice, or left because each side assumed the
  // other had it.
  const fresh = await (await request.get('/api/ph/list?kind=receiving&from=2020-01-01&to=2035-01-01', { headers: ph() })).json();
  expect((fresh.rows || []).filter((r) => r.sku === sku)).toHaveLength(0);

  // The admin Report is oversight, not a worklist, so being on Rescale doesn't hide a
  // unit from it — same carve-out no-box already has. All 7 released pairs are there.
  // The 3 still spoken for are NOT: pre-sell hides a pair from every PH surface until
  // it is released, the Report included, and that rule is older than this one.
  const report = await (await request.get('/api/ph/list?from=2020-01-01&to=2035-01-01', { headers: ph() })).json();
  expect((report.rows || []).filter((r) => r.sku === sku).length).toBe(7);

  // The released pairs still SAY where they came from. items.pre_sell is cleared by
  // release, so without the shipment's own flag riding along a freed pair is
  // indistinguishable from ordinary restock — and the reason half the shipment never
  // shows up is unfindable. The held ones keep the live flag.
  expect((resc.rows || []).filter((r) => r.sku === sku).every((r) => r.from_pre_sell && !r.pre_sell)).toBe(true);

  // Releasing again has nothing left to do.
  const twice = await request.post('/api/presell/release', { headers: wh(), data: { batchId: Number(b.id) } });
  expect(twice.status()).toBe(409);
});
