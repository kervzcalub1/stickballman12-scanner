// A save that fails must leave nothing behind (receiving.md → "A failed save leaves no batch").
//
// The batch row is written first and the pairs after, as one transaction. When the pairs
// failed (a 1ID sticker already on another shoe is the usual one), the row used to stay:
// an "Empty" batch on the Batches page for every retry, and a false duplicate-tracking
// alert between them. Found 2026-11-21 on a Shoe Palace package saved twice with no pairs.
import { test, expect } from '@playwright/test';
import { loadEnv } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-FAILSAVE-${stamp}`;
const TRACK = `E2EFAIL${stamp}`;
const VIN = `SBM-990101-${stamp}`;
const authHeaders = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` });

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('DELETE FROM tracking_duplicates WHERE tracking_number LIKE $1', [`${TRACK}%`]);
  await q('DELETE FROM batches WHERE tracking_number LIKE $1', [`${TRACK}%`]);
  await pool.end();
});

const commit = (request, tracking, vin) => request.post('/api/batches/commit', {
  headers: authHeaders(),
  data: {
    kind: 'receiving',
    batch: { supplier: 'E2E Supplier', buyer: 'e2e', dateReceived: '2026-09-15', tracking, manifestReceived: true },
    items: [{ vin, name: 'E2E Failed Save', sku: SKU, size: '9', withBox: true, source: 'manual' }],
  },
});

test('a save refused for a 1ID already on another shoe leaves no empty batch, and the retry works', async ({ request }) => {
  const first = await commit(request, `${TRACK}A`, VIN);
  expect(first.status(), await first.text()).toBe(200);
  expect((await first.json()).vins).toEqual([VIN]);

  // The same sticker again, on a different package: refused — twice, as someone retrying would.
  for (let i = 0; i < 2; i += 1) {
    const again = await commit(request, `${TRACK}B`, VIN);
    expect(again.status()).toBe(409);
    expect((await again.json()).error).toMatch(/already on another shoe/i);
  }
  expect(await q('SELECT batch_code FROM batches WHERE tracking_number = $1', [`${TRACK}B`])).toEqual([]);
  expect(await q('SELECT id FROM tracking_duplicates WHERE tracking_number = $1', [`${TRACK}B`])).toEqual([]);

  // A fresh sticker: saved, one batch, one pair, and no duplicate-tracking alert against a ghost.
  const ok = await commit(request, `${TRACK}B`, null);
  expect(ok.status(), await ok.text()).toBe(200);
  const body = await ok.json();
  expect(body.count).toBe(1);
  expect(body.duplicateTracking).toBeNull();
  const rows = await q(`SELECT b.batch_code, (SELECT count(*)::int FROM items i WHERE i.batch_id = b.id) AS n
                          FROM batches b WHERE b.tracking_number = $1`, [`${TRACK}B`]);
  expect(rows).toEqual([{ batch_code: body.batchCode, n: 1 }]);
});
