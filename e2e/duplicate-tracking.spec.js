// Duplicate tracking numbers (receiving.md, "Duplicate tracking numbers").
//
// The case: Foot Locker sent two single-pair packages under ONE tracking number instead
// of one box of two. The receive screen warned on a single-box receive and that was all —
// a multi-box receive wasn't checked at all, a number pasted with a space didn't match,
// and nothing kept the incident. What this pins:
//   · the SERVER logs a duplicate at commit time — another batch, or another box of the
//     same batch — whatever the screen did, and only once per package;
//   · spaces / case don't make a number new;
//   · the log is counted per supplier; the warehouse reads it, an admin closes an entry
//     with what was decided (a note is required);
//   · Receive New warns per box, including two boxes of one receive sharing a number.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loginAs } from './helpers/auth.js';

test.describe.configure({ mode: 'serial' });
const stamp = `${Date.now()}`.slice(-8);
const SUP = `E2E DupTrack ${stamp}`;
const T1 = `1ZDUPA${stamp}`;
const T2 = `1ZDUPB${stamp}`;
const auth = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}` });
const item = (n) => ({ name: 'Dup Track Shoe', sku: `E2E-DUP-${stamp}`, size: String(8 + n), withBox: true });
let db;
const batchIds = [];

test.beforeAll(async () => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});

test.afterAll(async () => {
  await db.query('DELETE FROM tracking_duplicates WHERE supplier_name = $1 OR prior_supplier = $1', [SUP]);
  const ids = (await db.query('SELECT id FROM batches WHERE supplier_name = $1', [SUP])).rows.map((r) => r.id);
  await db.query('DELETE FROM item_events WHERE item_id IN (SELECT id FROM items WHERE batch_id = ANY($1))', [ids]);
  await db.query('DELETE FROM items WHERE batch_id = ANY($1)', [ids]);
  await db.query('DELETE FROM batch_boxes WHERE batch_id = ANY($1)', [ids]);
  await db.query('DELETE FROM batches WHERE id = ANY($1)', [ids]);
  await db.query('DELETE FROM suppliers WHERE name = $1', [SUP]).catch(() => {});
  await db.end();
});

const commit = (request, tracking, n) => request.post('/api/batches/commit', {
  headers: auth('warehouse'),
  data: { kind: 'receiving', batch: { supplier: SUP, tracking }, items: [item(n)], issues: [] },
});

test('a second single-box receive of a number is logged against the first — spaces and case don\'t hide it', async ({ request }) => {
  const a = await commit(request, T1, 0);
  expect(a.ok(), await a.text()).toBeTruthy();
  const first = await a.json();
  expect(first.duplicateTracking).toBeNull();

  const b = await commit(request, `${T1.slice(0, 6).toLowerCase()} ${T1.slice(6)}`, 1);
  expect(b.ok(), await b.text()).toBeTruthy();
  const second = await b.json();
  expect(second.duplicateTracking).toMatchObject({ prior: first.batchCode });

  const rows = (await db.query('SELECT * FROM tracking_duplicates WHERE tracking_key = $1', [T1])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ supplier_name: SUP, batch_code: second.batchCode, prior_batch_code: first.batchCode, same_batch: false, status: 'open', detected_by: 'E2E warehouse' });
});

test('two boxes of ONE multi-box receive under the same number (the Foot Locker case) — logged once, as same batch', async ({ request }) => {
  const open = await (await request.post('/api/batches/create-open', { headers: auth('warehouse'), data: { batch: { supplier: SUP, expectedBoxes: 2, manifestReceived: false } } })).json();
  expect(open.ok, JSON.stringify(open)).toBeTruthy();
  const box = async (n) => (await (await request.post('/api/batches/add-box', { headers: auth('warehouse'), data: { batchId: open.id, trackingNumber: T2, boxNumber: n } })).json()).box;
  const b1 = await box(1);
  const c1 = await (await request.post('/api/batches/box-commit', { headers: auth('warehouse'), data: { batchId: open.id, boxId: Number(b1.id), items: [item(2)] } })).json();
  expect(c1.ok, JSON.stringify(c1)).toBeTruthy();
  expect(c1.duplicateTracking).toBeNull();
  const b2 = await box(2);
  const c2 = await (await request.post('/api/batches/box-commit', { headers: auth('warehouse'), data: { batchId: open.id, boxId: Number(b2.id), items: [item(3)] } })).json();
  expect(c2.ok, JSON.stringify(c2)).toBeTruthy();
  expect(c2.duplicateTracking).toMatchObject({ prior: open.batchCode });

  const rows = (await db.query('SELECT * FROM tracking_duplicates WHERE tracking_key = $1', [T2])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ same_batch: true, box_number: 2, prior_box_number: 1 });
});

test('the log: warehouse reads, an admin closes with a note, counted per supplier', async ({ page, request }) => {
  const list = await (await request.get(`/api/tracking-duplicates?supplier=${encodeURIComponent(SUP)}`, { headers: auth('warehouse') })).json();
  expect(list.rows).toHaveLength(2);
  expect(list.bySupplier.find((s) => s.supplier === SUP)).toMatchObject({ total: 2, open: 2 });
  const id = list.rows[0].id;
  expect((await request.post('/api/tracking-duplicates', { headers: auth('warehouse'), data: { id, handled: true, note: 'x' } })).status()).toBe(403);
  expect((await request.post('/api/tracking-duplicates', { headers: auth('admin'), data: { id, handled: true, note: ' ' } })).status()).toBe(400);

  await loginAs(page, 'admin');
  await page.goto(`/dup-tracking?supplier=${encodeURIComponent(SUP)}`);
  await expect(page.locator('.dup-sup.on')).toContainText(`${SUP} 2`);
  const rows = page.locator('.dup-table tbody tr');
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole('button', { name: 'Close…' }).click();
  await page.getByLabel('What was decided').fill('Left it — not worth chasing for one pair');
  await page.getByRole('button', { name: 'Close it' }).click();
  await expect(rows).toHaveCount(1);                       // the Open tab now holds one
  await page.getByRole('tab', { name: 'Handled' }).click();
  await expect(rows.first()).toContainText('Left it — not worth chasing for one pair');
});

test('Receive New warns per box — two boxes of one receive sharing a number', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('label:has-text("Boxes expected") input').fill('2');
  const tracks = page.locator('.box-build-track input');
  await tracks.nth(0).fill(`1ZWARN${stamp}`);
  await tracks.nth(1).fill(`1ZWARN${stamp}`);
  await expect(page.locator('.box-build-row .dup-warn').first()).toContainText('Same tracking number as box');
  // A number an earlier receive used — the server says where.
  await tracks.nth(1).fill(T1);
  await expect(page.locator('.box-build-row .dup-warn').last()).toContainText('Already received in', { timeout: 10_000 });
});
