// Pre-sell: shipments sold before they landed.
//
// Those units must NOT be listed to II or the stores — they are already spoken for, and
// offering one again would sell somebody else's pair. So a pre-sell shipment sits out of
// the PH listing world entirely and surfaces only on the Pre-sell page, where somebody
// says how many of each size an order covers. What is left over is released for listing.
//
// The invariants:
//   1. The flag is declared for the SHIPMENT ('all') or per SHOE ('some'), and a 'some'
//      shipment never stamps itself onto pairs nobody marked — including in boxes 2..9,
//      which is where it actually went wrong: nine boxes, fifteen SKUs, one pre-sold.
//   2. Pre-sell is invisible to PH's listing world — the grid AND the badge counts, which
//      is the half that gets forgotten.
//   3. Sold units become `pre_sold`, never `sold`: the pair hasn't shipped, and `sold` is
//      terminal, so claiming it early would strand it if the pre-sale fell through.
//   4. Freeing puts the remainder on NEW INVENTORY, dated by the day it was freed so an
//      older shipment's pairs can't land outside the window PH is looking at, and leaves
//      the spoken-for units alone.
//   5. Both corrections work: one shoe out of the hold, and one shoe back into it.
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
async function receive(request, { preSell, preSellScope, sku, sizes, extra = [] }) {
  const items = sizes.flatMap(({ size, n }) =>
    Array.from({ length: n }, () => ({ name: 'E2E PreSell Runner', sku, size, cost: 90, withBox: true, preSell: preSellScope === 'some' ? true : undefined })))
    .concat(extra);
  const r = await request.post('/api/batches/commit', {
    headers: wh(),
    data: { kind: 'receiving', batch: { supplier: SUPPLIER, tracking: `E2E-PS-${Date.now()}-${Math.random()}`, preSell, preSellScope }, items, issues: [] },
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
  // Ticked with no scope given is 'all' — which is the only thing the old checkbox could
  // mean, so every batch received before the question existed keeps behaving as received.
  expect(b.pre_sell_scope).toBe('all');
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

test('freeing sends the remainder to New Inventory and leaves the spoken-for alone', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 6 }, { size: '10', n: 4 }] });
  await request.post('/api/presell/mark-sold', { headers: wh(), data: { batchId: Number(b.id), sku, size: '9', qty: 3 } });

  const rel = await request.post('/api/presell/release', { headers: wh(), data: { batchId: Number(b.id) } });
  expect(rel.ok(), await rel.text()).toBeTruthy();
  expect((await rel.json()).released).toBe(7);

  const rows = await q('SELECT status, pre_sell, restock_pending, presell_freed_at FROM items WHERE batch_id = $1', [b.id]);
  const spoken = rows.filter((r) => r.status === 'pre_sold');
  const freed = rows.filter((r) => r.status !== 'pre_sold');
  expect(spoken).toHaveLength(3);
  // Left alone: still pre-sell, never queued for listing. Listing one would sell
  // somebody else's pair.
  expect(spoken.every((r) => r.pre_sell && !r.restock_pending)).toBe(true);
  // Freed pairs are ordinary arrivals again — NOT queued as rescale work. They were
  // routed through Rescale Stock until 2026-09-23 for one reason only: New Inventory is
  // date-filtered and a pair freed weeks after it arrived fell outside the window. That
  // is fixed at the source now (presell_freed_at), so they go where they belong.
  expect(freed.every((r) => !r.pre_sell && !r.restock_pending && r.presell_freed_at)).toBe(true);

  const fresh = await (await request.get('/api/ph/list?kind=receiving&from=2020-01-01&to=2035-01-01', { headers: ph() })).json();
  expect((fresh.rows || []).filter((r) => r.sku === sku).length).toBe(7);

  // ONE worklist, not two: they are new-inventory work, so the rescale tab must not
  // also claim them. Two lists claiming the same pair is how it gets listed twice, or
  // left because each side assumed the other had it.
  const resc = await (await request.get('/api/ph/list?kind=rescale&from=2020-01-01&to=2035-01-01', { headers: ph() })).json();
  expect((resc.rows || []).filter((r) => r.sku === sku)).toHaveLength(0);

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
  expect((fresh.rows || []).filter((r) => r.sku === sku).every((r) => r.from_pre_sell && !r.pre_sell)).toBe(true);

  // Releasing again has nothing left to do.
  const twice = await request.post('/api/presell/release', { headers: wh(), data: { batchId: Number(b.id) } });
  expect(twice.status()).toBe(409);
});

// ---------------------------------------------------------------------------
// Part of a shipment (2026-09-23). The case that prompted it: nine boxes, fifteen
// SKUs, ONE of them actually sold before it landed — and all fifteen came out held,
// because the only question anyone was asked was about the shipment.
// ---------------------------------------------------------------------------

test('"only some" with nothing marked is refused, not filed as ordinary stock', async ({ request }) => {
  const r = await request.post('/api/batches/commit', {
    headers: wh(),
    data: {
      kind: 'receiving',
      batch: { supplier: SUPPLIER, tracking: `E2E-PS-NONE-${Date.now()}`, preSell: true, preSellScope: 'some' },
      items: [{ name: 'E2E PreSell Runner', sku: nextSku(), size: '9', cost: 90, withBox: true }],
      issues: [],
    },
  });
  expect(r.status()).toBe(400);
  expect(await r.text()).toContain('mark which shoes');
});

// THE NINE-BOX BUG. A later box must not stamp the flag onto everything in it just
// because the shipment is a pre-sell one — that is how fifteen SKUs got held.
test('multi-box: a part pre-sell shipment does not hold whatever lands in box 2', async ({ request }) => {
  const sold = nextSku();
  const ordinary = nextSku();
  const open = await request.post('/api/batches/create-open', {
    headers: wh(),
    data: { batch: { supplier: SUPPLIER, tracking: `E2E-PS-SOME-${Date.now()}`, expectedBoxes: 2, preSell: true, preSellScope: 'some' } },
  });
  test.skip(open.status() === 429, 'rate-limited');
  expect(open.ok(), await open.text()).toBeTruthy();
  const { id: batchId } = await open.json();

  const commitBox = async (boxNumber, items) => {
    const box = await request.post('/api/batches/add-box', {
      headers: wh(), data: { batchId, trackingNumber: `E2E-PS-SOME-${Date.now()}-${boxNumber}`, boxNumber },
    });
    expect(box.ok(), await box.text()).toBeTruthy();
    const commit = await request.post('/api/batches/box-commit', {
      headers: wh(), data: { batchId, boxId: (await box.json()).box.id, items },
    });
    expect(commit.ok(), await commit.text()).toBeTruthy();
  };
  // Box 1 carries the one shoe that really was sold before it landed.
  await commitBox(1, [{ name: 'E2E PreSell Runner', sku: sold, size: '9', cost: 90, withBox: true, preSell: true }]);
  // Box 2 is ordinary stock. Nothing in it was marked.
  await commitBox(2, [{ name: 'E2E Ordinary', sku: ordinary, size: '10', cost: 90, withBox: true }]);

  const rows = await q('SELECT sku, pre_sell FROM items WHERE batch_id = $1', [batchId]);
  expect(rows.find((r) => r.sku === sold).pre_sell).toBe(true);
  expect(rows.find((r) => r.sku === ordinary).pre_sell).toBe(false);
});

test('only the marked shoes are held, one can be freed on its own, and one can be put back', async ({ request }) => {
  const wrong = nextSku();     // marked in error — the fourteen of fifteen
  const real = nextSku();      // genuinely spoken for
  const ordinary = nextSku();  // never marked at all
  const b = await receive(request, {
    preSell: true, preSellScope: 'some', sku: real, sizes: [{ size: '9', n: 2 }],
    extra: [
      ...Array.from({ length: 3 }, (_, i) => ({ name: 'E2E Wrongly Held', sku: wrong, size: String(9 + i), cost: 90, withBox: true, preSell: true })),
      ...Array.from({ length: 4 }, (_, i) => ({ name: 'E2E Ordinary', sku: ordinary, size: String(8 + i), cost: 90, withBox: true })),
    ],
  });
  // The BATCH still says it was a pre-sell shipment — that is what it was, and the chips
  // and the Pre-sell page are keyed on it.
  expect(b.pre_sell).toBe(true);
  expect(b.pre_sell_scope).toBe('some');

  // Only the marked shoes are held. The unmarked four are PH's work straight away, as
  // they always should have been — this is the whole bug.
  const heldRows = await q('SELECT sku, pre_sell FROM items WHERE batch_id = $1', [b.id]);
  expect(heldRows.filter((r) => r.sku === ordinary).some((r) => r.pre_sell)).toBe(false);
  expect(heldRows.filter((r) => r.sku !== ordinary).every((r) => r.pre_sell)).toBe(true);
  const fresh0 = await (await request.get('/api/ph/list?kind=receiving&from=2020-01-01&to=2035-01-01', { headers: ph() })).json();
  expect((fresh0.rows || []).filter((r) => r.sku === ordinary).length).toBe(4);
  expect((fresh0.rows || []).filter((r) => r.sku === real)).toHaveLength(0);

  // "Not pre-sell" — the fix for the reported batch, and the thing whole-batch release
  // could never do: free those three WITHOUT freeing the two that are really sold.
  const freed = await request.post('/api/presell/release', {
    headers: wh(), data: { batchId: Number(b.id), sku: wrong, reason: 'not_presell' },
  });
  expect(freed.ok(), await freed.text()).toBeTruthy();
  expect((await freed.json()).released).toBe(3);

  const after = await q('SELECT sku, pre_sell FROM items WHERE batch_id = $1', [b.id]);
  expect(after.filter((r) => r.sku === wrong).every((r) => !r.pre_sell)).toBe(true);
  expect(after.filter((r) => r.sku === real).every((r) => r.pre_sell)).toBe(true);
  // It says WHY on each unit — "marked in error" and "the order was fulfilled" are
  // different stories about the same pair.
  const ev = await q(
    `SELECT e.details->>'text' AS text FROM item_events e JOIN items i ON i.id = e.item_id
      WHERE i.batch_id = $1 AND i.sku = $2 AND e.type = 'note'`, [b.id, wrong]);
  expect(ev.every((r) => /Not pre-sell after all/.test(r.text))).toBe(true);

  // The way back, which has to exist because a missed shoe is the expensive direction:
  // it reaches PH, gets listed, and can be sold to a second buyer.
  const shoes = await (await request.get(`/api/presell/hold?batchId=${b.id}`, { headers: wh() })).json();
  expect(shoes.shoes.find((x) => x.sku === wrong).free).toBe(3);
  const held = await request.post('/api/presell/hold', { headers: wh(), data: { batchId: Number(b.id), sku: wrong } });
  expect(held.ok(), await held.text()).toBeTruthy();
  expect((await held.json()).held).toBe(3);
  const back = await q('SELECT pre_sell, presell_freed_at FROM items WHERE batch_id = $1 AND sku = $2', [b.id, wrong]);
  expect(back.every((r) => r.pre_sell && r.presell_freed_at === null)).toBe(true);

  // PH is warehouse work here, as everywhere else on this page.
  expect((await request.post('/api/presell/hold', { headers: ph(), data: { batchId: Number(b.id), sku: wrong } })).status()).toBe(403);
});

// The reason freed pairs can go to New Inventory at all. That list is filtered by date,
// so a pair freed today off a three-week-old shipment would land outside the window PH
// is looking at and be seen by nobody — which is why release used to divert everything
// through Rescale Stock instead.
test('a freed pair is dated by the day it was freed, not the day it arrived', async ({ request }) => {
  const sku = nextSku();
  const b = await receive(request, { preSell: true, sku, sizes: [{ size: '9', n: 2 }] });
  await q(`UPDATE items SET created_at = now() - interval '30 days' WHERE batch_id = $1`, [b.id]);

  const today = (await q(`SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS d`))[0].d;
  // Before freeing: held, so invisible whatever the window.
  const before = await (await request.get(`/api/ph/list?kind=receiving&from=${today}&to=${today}`, { headers: ph() })).json();
  expect((before.rows || []).filter((r) => r.sku === sku)).toHaveLength(0);

  const rel = await request.post('/api/presell/release', { headers: wh(), data: { batchId: Number(b.id) } });
  expect(rel.ok(), await rel.text()).toBeTruthy();

  // After: on TODAY's New Inventory, though the pairs arrived a month ago.
  const after = await (await request.get(`/api/ph/list?kind=receiving&from=${today}&to=${today}`, { headers: ph() })).json();
  expect((after.rows || []).filter((r) => r.sku === sku).length).toBe(2);

  // And they are NOT hiding back on the day they arrived, which is the window nobody
  // is looking at any more.
  const old = (await q(`SELECT ((now() - interval '30 days') AT TIME ZONE 'America/New_York')::date::text AS d`))[0].d;
  const thirtyDaysAgo = await (await request.get(`/api/ph/list?kind=receiving&from=${old}&to=${old}`, { headers: ph() })).json();
  expect((thirtyDaysAgo.rows || []).filter((r) => r.sku === sku)).toHaveLength(0);
});
