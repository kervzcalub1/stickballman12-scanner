// Deleting a whole batch (2026-09-16).
//
// The same archive-first rule as "Remove pairs": every pair leaves a deleted_items
// tombstone, the batch itself leaves one in deleted_batches, and the row goes. Refused
// whole while a single pair is sold or shipped — nothing is touched in that case.
import { test, expect } from '@playwright/test';
import { loadEnv } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const BATCH = `B-E2EDEL-${stamp}`;
const SKU = `E2E-BDEL-${stamp}`;
let batchId; let poId;

const auth = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}` });

test.beforeAll(async () => {
  const [po] = await q(`INSERT INTO purchase_orders (po_code, supplier_name, status) VALUES ($1, 'E2E Del Supplier', 'receiving') RETURNING id`, [`PO-E2EBDEL-${stamp}`]);
  poId = Number(po.id);
  const [b] = await q(
    `INSERT INTO batches (batch_code, supplier_name, status, kind, po_id, tracking_number, date_received)
     VALUES ($1, 'E2E Del Supplier', 'committed', 'receiving', $2, $3, current_date) RETURNING id`,
    [BATCH, poId, `BDEL${stamp}`]);
  batchId = Number(b.id);
  await q('UPDATE purchase_orders SET received_batch_id = $1 WHERE id = $2', [batchId, poId]);
  const [box] = await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'committed') RETURNING id`, [batchId, `BDEL${stamp}`]);
  await q(`INSERT INTO items (vin, batch_id, box_id, sku, size, name, status) VALUES
             ($3, $1, $2, $4, '9',  'E2E Delete Me', 'needs_shelf'),
             ($5, $1, $2, $4, '10', 'E2E Delete Me', 'listed'),
             ($6, $1, $2, $4, '11', 'E2E Delete Me', 'sold')`,
    [batchId, box.id, `SBM-E2EBD${stamp}1`, SKU, `SBM-E2EBD${stamp}2`, `SBM-E2EBD${stamp}3`]);
});

test.afterAll(async () => {
  await q('DELETE FROM deleted_items WHERE sku = $1', [SKU]);
  await q('DELETE FROM deleted_batches WHERE batch_code = $1', [BATCH]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [poId]);
  await q('DELETE FROM batches WHERE batch_code = $1', [BATCH]);
  await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  await pool.end();
});

test('a batch with a sold pair is refused whole; without one it goes, archived, and the order lets go of it', async ({ request }) => {
  // Suppliers have no batches.
  const sup = await request.post('/api/batches/delete', { headers: auth('supplier'), data: { batchId, reason: 'x' } });
  expect(sup.status()).toBe(403);

  // One sold pair: nothing happens, and the answer says how many.
  const blocked = await request.post('/api/batches/delete', { headers: auth('warehouse'), data: { batchId, reason: 'dup' } });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).error).toMatch(/1 pair in this batch is already sold/);
  expect((await q('SELECT count(*)::int AS n FROM items WHERE batch_id = $1', [batchId]))[0].n).toBe(3);

  // The sold pair moves on (as a real miscount fix would remove it separately); now it goes.
  await q(`UPDATE items SET status = 'needs_shelf' WHERE vin = $1`, [`SBM-E2EBD${stamp}3`]);
  const ok = await request.post('/api/batches/delete', { headers: auth('ph_team'), data: { batchId, reason: 'Scanned in twice' } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, batchCode: BATCH, units: 3 });

  expect((await q('SELECT 1 FROM batches WHERE id = $1', [batchId])).length).toBe(0);
  expect((await q('SELECT 1 FROM items WHERE sku = $1', [SKU])).length).toBe(0);
  // Every pair has its own tombstone, naming the batch delete as the reason…
  const pairs = await q('SELECT vin, reason, batch_code FROM deleted_items WHERE sku = $1 ORDER BY vin', [SKU]);
  expect(pairs).toHaveLength(3);
  expect(pairs[0]).toMatchObject({ reason: 'Batch deleted: Scanned in twice', batch_code: BATCH });
  // …and the batch has one carrying its boxes and its pairs' numbers.
  const [tomb] = await q('SELECT batch_json, unit_count, reason, deleted_by, po_id FROM deleted_batches WHERE batch_code = $1', [BATCH]);
  expect(tomb.unit_count).toBe(3);
  expect(tomb.deleted_by).toBe('E2E ph_team');
  expect(Number(tomb.po_id)).toBe(poId);
  expect(tomb.batch_json.boxes).toHaveLength(1);
  expect(tomb.batch_json.vins).toHaveLength(3);
  // The order no longer points at a batch that does not exist.
  expect((await q('SELECT received_batch_id FROM purchase_orders WHERE id = $1', [poId]))[0].received_batch_id).toBeNull();

  const again = await request.post('/api/batches/delete', { headers: auth('warehouse'), data: { batchId } });
  expect(again.status()).toBe(404);
});
