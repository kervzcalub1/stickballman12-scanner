// A rescale request must survive the next delivery of the same SKU.
//
// `groupPhSized` rule 2 merges UNTOUCHED pairs of one SKU across scan days on purpose —
// PH wants one worklist line per pending SKU, not the same SKU listed twice. But
// `rescaleRequestFor` is all-or-nothing, so before rule 4 the first unlinked pair to
// merge in took the whole row out of the request's hands: no chip, no ⟳ Rescale tab,
// and no "✓ Rescale done" button, which is the ONLY way to close a request from the
// grid. An audited count then sat on prod where nobody could see or finish it.
//
// Rule 4 puts the request id in the group key, so the pairs a request was raised for
// keep their own row and the late arrival gets its own. That is what this drives:
// scan → request → audit → SECOND SCAN → both rows are still right.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const whAuth = { Authorization: `Bearer ${signToken({ uid: '424244', username: 'e2e_wh2', name: 'E2E Warehouse', role: 'warehouse' })}` };

const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-MERGE-${stamp}`;
// A request with no pairs behind it — the shape the grid's row button can never reach.
const ORPHAN_SKU = `E2E-ORPHAN-${stamp}`;
let batchA = null;
let batchB = null;

test.beforeEach(async ({ page }) => { page.on('pageerror', (err) => { throw err; }); });

const mkBatch = async (suffix) => Number((await q(
  `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'closed','receiving','E2E Merge Supplier') RETURNING id`,
  [`B-MERGE-${stamp}-${suffix}`]))[0].id);
const addItem = (batch, size, n) => q(
  `INSERT INTO items (vin, batch_id, name, sku, size, status, price) VALUES ($1,$2,'E2E Merge Shoe',$3,$4,'needs_shelf',180)`,
  [`SBM-MRG-${stamp}-${n}`, batch, SKU, size]);

test.beforeAll(async () => {
  // The first scan: two pairs, which is what the request gets raised against.
  batchA = await mkBatch('A');
  await addItem(batchA, '9', 1); await addItem(batchA, '9', 2);
});

test.afterAll(async () => {
  const skus = [SKU, ORPHAN_SKU];
  const reqs = await q('SELECT id FROM rescale_requests WHERE sku = ANY($1::text[])', [skus]);
  for (const r of reqs) await q('DELETE FROM rescale_request_items WHERE request_id = $1', [r.id]);
  await q('DELETE FROM rescale_requests WHERE sku = ANY($1::text[])', [skus]);
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  for (const b of [batchA, batchB]) if (b) await q('DELETE FROM batches WHERE id = $1', [b]);
  await pool.end();
});

const rowFor = (page) => page.locator('.ph-trow', { hasText: SKU });

test('a later delivery of the same SKU cannot merge into — or disarm — an audited request', async ({ page, request, baseURL }) => {
  // 1. PH raises the request off the row, which is what writes rescale_request_items.
  await loginAs(page, 'ph_team');
  await page.goto('/ph/new-inventory?st=pending');
  await rowFor(page).first().waitFor();
  await rowFor(page).first().getByRole('button', { name: '⟳ Rescale…' }).click();
  await page.locator('.modal.rescale-ask').getByRole('button', { name: 'Send for rescale' }).click();
  await expect(page.locator('.modal.rescale-ask')).toHaveCount(0);

  const [req] = await q('SELECT * FROM rescale_requests WHERE sku = $1', [SKU]);
  expect(req.status).toBe('open');
  // Both pairs are linked — a row-raised request is all-linked by construction.
  const linked = await q('SELECT item_id FROM rescale_request_items WHERE request_id = $1', [req.id]);
  expect(linked).toHaveLength(2);

  // 2. The warehouse counts the shelf and finds a third pair.
  const res = await request.post(`${baseURL}/api/rescale-requests/audit`, {
    headers: whAuth,
    data: { id: Number(req.id), actualSizes: [{ size: '9', qty: 3 }], note: 'E2E counted' },
  });
  expect(res.ok()).toBeTruthy();

  // 3. THE SECOND SCAN — three more pairs of the same SKU, untouched, same status.
  //    Rule 2 would merge these straight into the row above.
  batchB = await mkBatch('B');
  await addItem(batchB, '10', 3); await addItem(batchB, '10', 4); await addItem(batchB, '11', 5);

  // `st` is the tab filter and it takes a comma list — ask for both buckets at once, so
  // one screen shows where each half of the SKU went.
  await page.goto('/ph/new-inventory?st=pending,rescale');
  await expect(rowFor(page)).toHaveCount(2); // NOT one row of five

  // The request's own pairs: still two, still counted, still closeable.
  const audited = rowFor(page).filter({ has: page.locator('.ph-rescale-chip.ready') });
  await expect(audited).toHaveCount(1);
  await expect(audited).toContainText('✓ Counted');
  await expect(audited.locator('.szq-chip')).toHaveText(['9×2']);
  await audited.click();
  await expect(page.getByRole('button', { name: '✓ Rescale done' })).toBeVisible();

  // …and the new delivery is its own Pending row, carrying none of the request.
  const fresh = rowFor(page).filter({ hasNot: page.locator('.ph-rescale-chip') });
  await expect(fresh).toHaveCount(1);
  await expect(fresh.locator('.szq-chip')).toHaveText(['10×2', '11×1']);
});

test('an audited request can be closed from the Rescale Requests page, without a row', async ({ page }) => {
  // The grid's "✓ Rescale done" rides on a ROW. A request whose pairs have been merged,
  // sold, shelved or removed has no row left to ride on — so this one is seeded with NO
  // linked pairs at all, which is exactly the shape that was uncloseable. Seeded here
  // rather than inherited from the test above, so each test owns what it asserts on.
  const [req] = await q(
    `INSERT INTO rescale_requests (sku, sku_all, name, sizes, actual_sizes, reason, status, requested_by, resolved_by, resolved_at, audit_note)
     VALUES ($1, $1, 'E2E Orphan Shoe', '[{"size":"9","qty":2}]'::jsonb, '[{"size":"9","qty":3}]'::jsonb,
             'recount', 'audited', 'E2E PH', 'E2E Warehouse', now(), 'E2E orphan count')
     RETURNING id, status`, [ORPHAN_SKU]);
  expect(req.status).toBe('audited');

  await loginAs(page, 'ph_team');
  await page.goto('/ph/request');
  await page.getByRole('button', { name: 'Audited' }).click();
  const card = page.locator('.rc-item', { hasText: ORPHAN_SKU }).first();
  await card.waitFor();
  await card.getByRole('button', { name: '✓ Rescale done' }).click();

  await expect(page.locator('.rc-item', { hasText: ORPHAN_SKU })).toHaveCount(0); // gone from Audited
  const [after] = await q('SELECT status, closed_by FROM rescale_requests WHERE id = $1', [req.id]);
  expect(after.status).toBe('closed');
  expect(after.closed_by).toBeTruthy();

  // It names itself on the Closed tab — `closed` used to fall through to "Open".
  await page.getByRole('button', { name: 'Closed' }).click();
  const closed = page.locator('.rc-item', { hasText: ORPHAN_SKU }).first();
  await expect(closed.locator('.rc-pill')).toHaveText('Closed');
  await expect(closed).toContainText(/closed by .+ on \d\d\/\d\d, \d{1,2}:\d\d [AP]M EST/);
});
