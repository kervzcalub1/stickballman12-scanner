// Merging duplicates — superadmin only (2026-08-28).
//
// Both tools are irreversible and rewrite records other people rely on, so what is
// checked here is: who can reach them, that the preview tells the truth BEFORE anything
// moves, and that the refusals hold (different orders, different kinds, already merged).
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const FROM = `ZZ Erick ${stamp}`;
const TO = `ZZ Erick Lujano ${stamp}`;
const TRACK = `1ZMERGE${stamp}`;
let batchFrom = null; let poId = null; let srcId = null; let tgtId = null; let otherKind = null;

const tokenFor = (role) => signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role });

test.beforeAll(async () => {
  await q('INSERT INTO suppliers (name) VALUES ($1),($2) ON CONFLICT DO NOTHING', [FROM, TO]);
  batchFrom = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'committed','receiving',$2) RETURNING id`,
    [`B-MSA-${stamp}`, FROM]))[0].id);
  await q(`INSERT INTO items (vin, batch_id, name, sku, size, status)
           VALUES ($1,$2,'x','MS-1','9','needs_shelf'),($3,$2,'x','MS-1','10','needs_shelf')`,
    [`VMS1-${stamp}`, batchFrom, `VMS2-${stamp}`]);
  await q(`INSERT INTO purchase_orders (po_code, status, supplier_name) VALUES ($1,'draft',$2)`,
    [`PO-MS-${stamp}`, FROM]);

  // The batch pair: a multi-box target with an empty placeholder for TRACK, and the
  // parcel received on its own carrying TRACK with items that have no box.
  poId = Number((await q(
    `INSERT INTO purchase_orders (po_code, status, supplier_name) VALUES ($1,'receiving','E2E Merge') RETURNING id`,
    [`PO-MB-${stamp}`]))[0].id);
  tgtId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, po_id) VALUES ($1,'open','receiving',$2) RETURNING id`,
    [`B-TGT-${stamp}`, poId]))[0].id);
  await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1,1,$2,'pending')`,
    [tgtId, TRACK]);
  srcId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, po_id, tracking_number) VALUES ($1,'committed','receiving',$2,$3) RETURNING id`,
    [`B-SRC-${stamp}`, poId, TRACK]))[0].id);
  for (const size of ['10', '10.5']) {
    await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
             VALUES ($1,$2,NULL,'loose','MB-2',$3,'needs_shelf')`, [`VMB-${stamp}-${size}`, srcId, size]);
  }
  // A batch of a DIFFERENT kind, to prove the refusal.
  otherKind = Number((await q(
    `INSERT INTO batches (batch_code, status, kind) VALUES ($1,'committed','instore') RETURNING id`,
    [`B-INS-${stamp}`]))[0].id);
});

test.afterAll(async () => {
  for (const id of [batchFrom, srcId, tgtId, otherKind]) {
    if (!id) continue;
    const items = await q('SELECT id FROM items WHERE batch_id = $1', [id]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q('DELETE FROM items WHERE batch_id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
  }
  await q('UPDATE batches SET merged_into_batch_id = NULL WHERE id = ANY($1)', [[batchFrom, srcId, tgtId, otherKind]]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [[batchFrom, srcId, tgtId, otherKind]]);
  await q('DELETE FROM purchase_orders WHERE po_code = ANY($1)', [[`PO-MS-${stamp}`, `PO-MB-${stamp}`]]);
  await q('DELETE FROM suppliers WHERE name = ANY($1)', [[FROM, TO]]);
  await pool.end();
});

test('only superadmin reaches the merge endpoints — an ADMIN is refused too', async ({ request }) => {
  const url = `/api/admin/merge-suppliers?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
  for (const role of ['warehouse', 'ph_team', 'supplier', 'admin']) {
    const r = await request.get(url, { headers: { Authorization: `Bearer ${tokenFor(role)}` } });
    expect(r.status(), `${role} should not reach the merge tool`).toBe(403);
  }
  const ok = await request.get(url, { headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  expect(ok.status()).toBe(200);
});

test('the supplier preview counts what would move, and names what will not', async ({ request }) => {
  const r = await request.get(`/api/admin/merge-suppliers?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
    { headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  const { preview } = await r.json();
  expect(preview.batches).toBe(1);
  expect(preview.units).toBe(2);   // the pairs riding along, which is the real stake
  expect(preview.pos).toBe(1);
  expect(preview.inList).toBe(true);
});

test('merging a supplier rewrites batches and POs and clears the old name', async ({ request }) => {
  const r = await request.post('/api/admin/merge-suppliers', {
    data: { from: FROM, to: TO }, headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  expect(r.status()).toBe(200);
  expect((await q('SELECT id FROM batches WHERE btrim(supplier_name) = $1', [FROM]))).toHaveLength(0);
  expect((await q('SELECT id FROM batches WHERE btrim(supplier_name) = $1', [TO]))).toHaveLength(1);
  expect((await q('SELECT id FROM purchase_orders WHERE btrim(supplier_name) = $1', [TO]))).toHaveLength(1);
  expect((await q('SELECT id FROM suppliers WHERE name = $1', [FROM]))).toHaveLength(0);
  // The surviving name is still pickable.
  expect((await q('SELECT id FROM suppliers WHERE name = $1', [TO]))).toHaveLength(1);
});

test('merging into itself, or a name that is blank, is refused', async ({ request }) => {
  const h = { Authorization: `Bearer ${tokenFor('superadmin')}` };
  const same = await request.get(`/api/admin/merge-suppliers?from=${encodeURIComponent(TO)}&to=${encodeURIComponent(TO)}`, { headers: h });
  expect(same.status()).toBe(400);
  const blank = await request.get(`/api/admin/merge-suppliers?from=&to=${encodeURIComponent(TO)}`, { headers: h });
  expect(blank.status()).toBe(400);
});

test('the batch preview says where the loose pairs land before anything moves', async ({ request }) => {
  const r = await request.get(`/api/admin/merge-batches?source=${srcId}&target=${tgtId}`,
    { headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  const { preview } = await r.json();
  expect(preview.units).toBe(2);
  expect(preview.loose).toBe(2);
  // Matched to the placeholder box by TRACKING NUMBER, which is the whole point.
  expect(preview.looseGoesTo).toMatchObject({ kind: 'existing-box', box_number: 1 });
  // Nothing has moved yet.
  expect((await q('SELECT id FROM items WHERE batch_id = $1', [srcId]))).toHaveLength(2);
});

test('batches of different kinds are refused — that would move stock into another workflow', async ({ request }) => {
  const r = await request.get(`/api/admin/merge-batches?source=${otherKind}&target=${tgtId}`,
    { headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/different kinds/i);
});

test('merging batches moves the pairs, attaches them by tracking, and leaves a tombstone', async ({ request }) => {
  const r = await request.post('/api/admin/merge-batches', {
    data: { source: srcId, target: tgtId }, headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  expect(r.status()).toBe(200);
  const { result } = await r.json();
  expect(result.items).toBe(2);
  expect(result.looseAttached).toBe(2);

  // The pairs are in the target, inside the box whose tracking number they matched.
  const moved = await q(`SELECT i.id FROM items i JOIN batch_boxes x ON x.id = i.box_id
                         WHERE i.batch_id = $1 AND x.tracking_number = $2`, [tgtId, TRACK]);
  expect(moved).toHaveLength(2);
  // The losing batch keeps its code and points at the survivor — not deleted.
  const [src] = await q('SELECT batch_code, merged_into_batch_id FROM batches WHERE id = $1', [srcId]);
  expect(src.batch_code).toBe(`B-SRC-${stamp}`);
  expect(Number(src.merged_into_batch_id)).toBe(tgtId);
  expect((await q('SELECT id FROM items WHERE batch_id = $1', [srcId]))).toHaveLength(0);
});

test('a batch already merged away cannot be merged again', async ({ request }) => {
  const r = await request.get(`/api/admin/merge-batches?source=${srcId}&target=${tgtId}`,
    { headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  expect(r.status()).toBe(400);
  expect((await r.json()).error).toMatch(/already merged/i);
});

test('the tool is on the superadmin home and reachable; an admin typing /merge is not shown it', async ({ page }) => {
  await loginAs(page, 'superadmin');
  await page.goto('/');
  await page.getByText('Merge duplicates', { exact: true }).click();
  await expect(page).toHaveURL(/\/merge/);
  await expect(page.getByRole('heading', { name: 'Merge suppliers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Merge batches' })).toBeVisible();

  await page.context().clearCookies();
  await loginAs(page, 'admin');
  await page.goto('/merge');
  await expect(page.getByRole('heading', { name: 'Merge suppliers' })).toHaveCount(0);
});

test('opening the merged-away batch lands you on the one that absorbed it', async ({ page }) => {
  // Its code is on a printed label, so someone WILL look it up after the merge. Landing
  // on an empty page is the confusion the "no boxes" bug caused; it must point onward.
  await loginAs(page, 'superadmin');
  await page.goto(`/batches?b=${srcId}`);
  await expect(page.locator('.batch-page-code')).toContainText(`B-TGT-${stamp}`);
  await expect(page.locator('.merge-note')).toContainText(`B-SRC-${stamp}`);
  // The pairs it carried are here — inside the box their tracking number matched, so
  // the box row is what carries the count until you open it.
  const box = page.locator('.box-row').first();
  await expect(box).toContainText('2 items');
  await box.click();
  await expect(page.locator('.batch-detail-row')).toHaveCount(2);
});

test('the list marks a merged batch instead of showing it as empty', async ({ page }) => {
  await loginAs(page, 'superadmin');
  await page.goto(`/batches?q=B-SRC-${stamp}`);
  const row = page.locator('.batch-nav-row').first();
  await expect(row).toContainText(`merged into B-TGT-${stamp}`);
  await expect(row).not.toContainText('Empty');
});

// Both found by the pentest (2026-08-28). Neither was exploitable, but both let a
// malformed request past the point where it should have been refused.
test('a non-string name is refused, not coerced into one', async ({ request }) => {
  const h = { Authorization: `Bearer ${tokenFor('superadmin')}` };
  for (const bad of [{ a: 1 }, ['Erick'], 42, null]) {
    const r = await request.post('/api/admin/merge-suppliers', { data: { from: bad, to: TO }, headers: h });
    expect(r.status(), `${JSON.stringify(bad)} should not merge`).toBe(400);
  }
  // ["Erick"] is the dangerous one: String() turns it into a name that really exists, so
  // a malformed request would have performed a merge the UI could never have asked for.
  const arr = await request.post('/api/admin/merge-suppliers', { data: { from: [TO], to: 'anything' }, headers: h });
  expect(arr.status()).toBe(400);
});

test('an id too large to be one is a 400, not a 500', async ({ request }) => {
  const r = await request.get(`/api/admin/merge-batches?source=99999999999999999999&target=${tgtId}`,
    { headers: { Authorization: `Bearer ${tokenFor('superadmin')}` } });
  expect(r.status()).toBe(400);   // it used to overflow Postgres bigint inside the query
});

// The two duplicate shapes this tool exists to fix, both of which it used to REFUSE.
// (QA, 2026-08-28)
test('a case-only duplicate can be merged — it really is two dropdown rows', async ({ request }) => {
  const h = { Authorization: `Bearer ${tokenFor('superadmin')}` };
  const A = `ZZ Case ${stamp}`; const B = A.toLowerCase();
  await q('INSERT INTO suppliers (name) VALUES ($1),($2) ON CONFLICT DO NOTHING', [A, B]);
  const bid = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'committed','receiving',$2) RETURNING id`,
    [`B-CASE-${stamp}`, A]))[0].id);
  const r = await request.post('/api/admin/merge-suppliers', { data: { from: A, to: B }, headers: h });
  expect(r.status(), 'case-only duplicates must be mergeable').toBe(200);
  expect((await q('SELECT id FROM batches WHERE supplier_name = $1', [B]))).toHaveLength(1);
  expect((await q('SELECT id FROM suppliers WHERE name = $1', [A]))).toHaveLength(0);
  await q('DELETE FROM batches WHERE id = $1', [bid]);
  await q('DELETE FROM suppliers WHERE name = ANY($1)', [[A, B]]);
});

test('a name saved with trailing whitespace can be tidied away', async ({ request }) => {
  const h = { Authorization: `Bearer ${tokenFor('superadmin')}` };
  const CLEAN = `ZZ Ws ${stamp}`; const MESSY = `${CLEAN} `;
  await q('INSERT INTO suppliers (name) VALUES ($1),($2) ON CONFLICT DO NOTHING', [CLEAN, MESSY]);
  const r = await request.post('/api/admin/merge-suppliers', { data: { from: MESSY, to: CLEAN }, headers: h });
  expect(r.status()).toBe(200);
  // The row deleted is the one as STORED — trimming first would have deleted the wrong one.
  expect((await q('SELECT name FROM suppliers WHERE name = $1', [MESSY]))).toHaveLength(0);
  expect((await q('SELECT name FROM suppliers WHERE name = $1', [CLEAN]))).toHaveLength(1);
  await q('DELETE FROM suppliers WHERE name = ANY($1)', [[CLEAN, MESSY]]);
});

test('two source boxes sharing a number do not collide again in the target', async () => {
  const { mergeBatches } = await import('../api/_lib/db.js');
  const tgt = Number((await q(`INSERT INTO batches (batch_code, status, kind) VALUES ($1,'open','receiving') RETURNING id`, [`B-CT-${stamp}`]))[0].id);
  await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1,1,$2,'received')`, [tgt, `CT-T1-${stamp}`]);
  const src = Number((await q(`INSERT INTO batches (batch_code, status, kind) VALUES ($1,'committed','receiving') RETURNING id`, [`B-CS-${stamp}`]))[0].id);
  // Nothing enforces uniqueness on (batch_id, box_number), so this state is reachable.
  await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status)
           VALUES ($1,1,$2,'received'), ($1,1,$3,'received')`, [src, `CT-S1-${stamp}`, `CT-S2-${stamp}`]);
  await mergeBatches(src, tgt, 'e2e');
  const nums = (await q('SELECT box_number FROM batch_boxes WHERE batch_id = $1 ORDER BY box_number', [tgt])).map((r) => Number(r.box_number));
  expect(nums).toHaveLength(3);
  expect(new Set(nums).size, `box numbers collided: ${nums}`).toBe(3);
  for (const id of [src, tgt]) { await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]); }
  await q('UPDATE batches SET merged_into_batch_id = NULL WHERE id = $1', [src]);
  await q('DELETE FROM batches WHERE id = ANY($1)', [[src, tgt]]);
});
