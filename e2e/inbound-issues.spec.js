// Inbound Issues (docs/context/inbound-issues.md).
//
// The owner's ask: a damaged parcel or a wrong pair recorded at receiving sat on a shelf
// until the owner visited. Now each recorded problem is a CASE: PH is told, one person
// takes it, works it with the supplier, and resolves it — and a flagged pair is HELD off
// listing until then. These tests drive the whole loop through the API, then check the
// page renders a case with the facts a refund claim needs.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-7);
const SKU = `E2E-II-${stamp}`;
const SUPPLIER = `E2E II Supplier ${stamp}`;
const TRACK = `E2EII${stamp}`;
// Numeric uids: a case is owned by a users row id (the env logins can't own one).
const WH_USER = { uid: 990101, username: 'e2e_ii_wh', name: 'E2E II Brent', role: 'warehouse' };
const PH_USER = { uid: 990102, username: 'e2e_ii_ph', name: 'E2E II Ruby', role: 'ph_team' };
const PH2_USER = { uid: 990103, username: 'e2e_ii_ph2', name: 'E2E II Quincy', role: 'ph_team' };
const auth = (u) => ({ Authorization: `Bearer ${signToken(u)}` });
const WH = auth(WH_USER); const PH = auth(PH_USER); const PH2 = auth(PH2_USER);

test.afterAll(async () => {
  const batches = await q('SELECT id FROM batches WHERE supplier_name = $1', [SUPPLIER]);
  for (const { id } of batches) {
    await q('DELETE FROM inbound_issues WHERE batch_id = $1', [id]);
    const items = await q('SELECT id FROM items WHERE batch_id = $1', [id]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q('DELETE FROM items WHERE batch_id = $1', [id]);
    await q('DELETE FROM shipment_issues WHERE batch_id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await q(`DELETE FROM inbound_issues WHERE supplier = $1`, [SUPPLIER]);
  await q(`DELETE FROM deleted_items WHERE sku = $1`, [SKU]).catch(() => {});
  await q(`DELETE FROM suppliers WHERE name = $1`, [SUPPLIER]);
  await pool.end();
});

const action = (request, id, act, extra = {}, headers = PH) =>
  request.post('/api/inbound-issues/action', { headers, data: { id, action: act, ...extra } });

test('receiving issues open cases, hold the flagged pairs, and PH works them to resolved', async ({ request, page }) => {
  // Two pairs, each flagged; one shipment issue; one key note (not a case); one no-box defect (not a case).
  const { vins } = await (await request.post('/api/vins/reserve', { headers: WH, data: { count: 3 } })).json();
  expect(vins).toHaveLength(3);
  const [vKeep, vBack, vNoBox] = vins;
  const commit = await request.post('/api/batches/commit', {
    headers: WH,
    data: {
      batch: { supplier: SUPPLIER, tracking: TRACK, manifestReceived: true },
      items: [vKeep, vBack, vNoBox].map((vin, i) => ({ name: 'E2E II Runner', sku: SKU, size: String(9 + i), vin, cost: 100 + i, withBox: true })),
      issues: [
        { type: 'shortfall', description: 'two pairs missing', expectedCount: 5, receivedCount: 3, photos: ['https://example.com/parcel.jpg'] },
        { type: 'note', description: 'carton re-taped' },
      ],
      unitIssues: [
        { vin: vKeep, type: 'crease', note: 'light toe crease', photos: ['https://example.com/crease.jpg'] },
        { vin: vBack, type: 'wrong_item', note: 'left shoe is a 10' },
        { vin: vNoBox, type: 'no_box', note: '' },
      ],
    },
  });
  expect(commit.status()).toBe(200);
  const res = await commit.json();
  expect(res.inboundIssues).toHaveLength(3); // shortfall + crease + wrong item — never the note or the no-box

  const cases = await q('SELECT * FROM inbound_issues WHERE id = ANY($1::bigint[]) ORDER BY id', [res.inboundIssues]);
  const ship = cases.find((c) => c.scope === 'shipment');
  const keep = cases.find((c) => c.vin === vKeep);
  const back = cases.find((c) => c.vin === vBack);
  expect(ship).toMatchObject({ type: 'shortfall', supplier: SUPPLIER, tracking_number: TRACK, expected_count: 5, received_count: 3, status: 'open', reported_by: WH_USER.name });
  expect(ship.photos).toEqual(['https://example.com/parcel.jpg']);
  expect(keep).toMatchObject({ scope: 'pair', type: 'crease', sku: SKU, size: '9', held_from_status: 'needs_shelf' });
  expect(Number(keep.cost)).toBe(100);

  // Flagged pairs are held; the no-box pair follows the No Box rules, not a case.
  const status = async (vin) => (await q('SELECT status FROM items WHERE vin = $1', [vin]))[0]?.status;
  expect(await status(vKeep)).toBe('issue');
  expect(await status(vBack)).toBe('issue');
  expect(await status(vNoBox)).toBe('no_box');

  // The floor can't own a case.
  expect((await action(request, ship.id, 'claim', {}, WH)).status()).toBe(403);

  // One owner: the first to take it gets it; the second is told who has it.
  expect((await action(request, ship.id, 'claim')).status()).toBe(200);
  const second = await action(request, ship.id, 'claim', {}, PH2);
  expect(second.status()).toBe(409);
  expect((await second.json()).error).toContain(PH_USER.name);

  // Waiting on the supplier with their reference, then a job for the warehouse, done by the floor.
  expect((await action(request, ship.id, 'waiting', { supplierRef: 'RMA-77', note: 'emailed for refund' })).status()).toBe(200);
  expect((await action(request, ship.id, 'ask_warehouse', { task: 'keep the carton for the claim' })).status()).toBe(200);
  const listWh = await (await request.get('/api/inbound-issues/list?view=warehouse', { headers: WH })).json();
  expect(listWh.rows.some((r) => r.id === Number(ship.id))).toBe(true);
  expect(listWh.canWork).toBe(false);
  expect((await action(request, ship.id, 'warehouse_done', { note: 'carton kept' }, WH)).status()).toBe(200);

  // Resolve: a refund needs its amount.
  expect((await action(request, ship.id, 'resolve', { outcome: 'refund' })).status()).toBe(400);
  const r1 = await (await action(request, ship.id, 'resolve', { outcome: 'refund', refundAmount: '210.50', note: 'refunded to card' })).json();
  expect(r1.row).toMatchObject({ status: 'resolved', outcome: 'refund', refund_amount: 210.5, supplier_ref: 'RMA-77', owner: PH_USER.name });

  // A pair case must say what becomes of the pair. Keep → back to needs_shelf.
  expect((await action(request, keep.id, 'claim', {}, PH2)).status()).toBe(200);
  expect((await action(request, keep.id, 'resolve', { outcome: 'partial_refund', refundAmount: 20 }, PH2)).status()).toBe(400);
  const r2 = await (await action(request, keep.id, 'resolve', { outcome: 'partial_refund', refundAmount: 20, disposition: 'keep' }, PH2)).json();
  expect(r2.pair).toMatchObject({ released: vKeep, status: 'needs_shelf' });
  expect(await status(vKeep)).toBe('needs_shelf');

  // Returned → the pair leaves the inventory through the Deleted archive.
  const r3 = await (await action(request, back.id, 'resolve', { outcome: 'replacement', disposition: 'returned', note: 'shipped back' })).json();
  expect(r3.pair).toMatchObject({ removed: vBack });
  expect(await status(vBack)).toBeUndefined();
  expect(r3.row.item_id).toBeNull();
  expect(r3.row.vin).toBe(vBack); // the record keeps what it was about

  // The trail says who did what.
  const got = await (await request.get(`/api/inbound-issues/get?id=${ship.id}`, { headers: PH })).json();
  expect(got.row.events.map((e) => e.action)).toEqual(['reported', 'claim', 'waiting', 'warehouse_task', 'warehouse_done', 'resolved']);

  // The page shows a case with the claim facts.
  const t = signToken(PH_USER);
  await page.addInitScript((tok) => {
    sessionStorage.setItem('sb_session_token', tok);
    sessionStorage.setItem('sb_user', JSON.stringify({ username: 'e2e_ii_ph', name: 'E2E II Ruby', role: 'ph_team' }));
  }, t);
  await page.goto(`/ph/inbound-issues?id=${ship.id}`);
  const card = page.locator(`#case-${ship.id}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Short count');
  await expect(card).toContainText(SUPPLIER);
  await expect(card).toContainText(TRACK);
  await expect(card).toContainText('Refunded');
  await expect(card).toContainText('$210.50');
});

test('a problem found after receiving is reported by VIN and opens a held case', async ({ request }) => {
  const { vins: [vin] } = await (await request.post('/api/vins/reserve', { headers: WH, data: { count: 1 } })).json();
  const c = await request.post('/api/batches/commit', {
    headers: WH,
    data: { batch: { supplier: SUPPLIER, tracking: `${TRACK}B`, manifestReceived: true }, items: [{ name: 'E2E II Runner', sku: SKU, size: '12', vin, withBox: true }] },
  });
  expect((await c.json()).inboundIssues).toEqual([]);

  expect((await request.post('/api/inbound-issues/report', { headers: WH, data: { scope: 'pair', vin: 'NOT-A-VIN', type: 'crease' } })).status()).toBe(400);
  const rep = await request.post('/api/inbound-issues/report', { headers: WH, data: { scope: 'pair', vin, type: 'glue', description: 'glue stains on the heel' } });
  expect(rep.status()).toBe(200);
  const { row } = await rep.json();
  expect(row).toMatchObject({ scope: 'pair', vin, type: 'glue', status: 'open', supplier: SUPPLIER, tracking_number: `${TRACK}B` });
  expect((await q('SELECT status FROM items WHERE vin = $1', [vin]))[0].status).toBe('issue');
  // …and the pair's own history carries the defect, as if it had been flagged at receiving.
  const ev = await q(`SELECT e.type FROM item_events e JOIN items i ON i.id = e.item_id WHERE i.vin = $1 ORDER BY e.id`, [vin]);
  expect(ev.map((e) => e.type)).toContain('issue');

  // A shipment report finds the delivery by its tracking number.
  const rs = await request.post('/api/inbound-issues/report', { headers: WH, data: { scope: 'shipment', code: `${TRACK}B`.toLowerCase(), type: 'damaged_package' } });
  expect(rs.status()).toBe(200);
  expect((await rs.json()).row).toMatchObject({ scope: 'shipment', type: 'damaged_package', supplier: SUPPLIER });
});
