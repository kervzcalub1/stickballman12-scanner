// "Did this package come with a manifest?" — Step 1 of every shipment receive.
//
// A shipment received WITHOUT one is a shipment nobody has checked against anything, so
// it is flagged for an audit: it counts on Home, it filters on the Batches page, and it
// stays flagged until a named person signs off that everything expected arrived.
// Rescale / in-store are never asked — there is no manifest to have come with.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-MANIFEST-${stamp}`;
const TRACK = `E2EMAN${stamp}`;

test.afterAll(async () => {
  const items = await q('SELECT id, batch_id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  for (const id of [...new Set(items.map((i) => i.batch_id))]) {
    await q('DELETE FROM shipment_issues WHERE batch_id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await pool.end();
});

const authHeaders = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` });

test('the question is required, "No" flags the batch, and the audit is signed off on the Batch page', async ({ page, request }) => {
  await loginAs(page, 'warehouse');
  await page.route('**/api/sku-search', (route) => route.fulfill({ json: { ok: true, product: { name: 'E2E Manifest Runner', sku: SKU, image: '', source: 'manual', scannedSize: '9', sizes: ['9'] } } }));
  await page.goto('/receiving');
  await page.locator('label:has-text("Supplier") select').selectOption({ index: 1 });
  await page.locator('.track-field input').first().fill(TRACK);

  // Unanswered, Step 1 refuses to move on.
  await page.getByRole('button', { name: 'Next →' }).click();
  await expect(page.locator('.error')).toContainText('came with a manifest');
  await expect(page.getByText('Shipment details')).toBeVisible();

  // No → the consequence is said right there, and again on the commit confirm.
  const qBlock = page.locator('.manifest-q');
  await qBlock.getByRole('button', { name: 'No' }).click();
  await expect(qBlock).toContainText('flagged for an audit');
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.locator('.scanbar input').first().fill(SKU);
  await page.locator('.scanbar').getByRole('button', { name: 'Add' }).click();
  await expect(page.locator(`.recv-item[data-sku="${SKU}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Review →' }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  await page.getByRole('button', { name: 'Finish batch' }).click();
  await expect(page.locator('.confirm-summary .warn-line', { hasText: 'manifest' })).toContainText(`Received without a manifest — flagged for audit against tracking ${TRACK}`);
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.getByText(/^Batch .* saved$/)).toBeVisible({ timeout: 15_000 });

  const [{ batch_id }] = await q('SELECT batch_id FROM items WHERE sku = $1 LIMIT 1', [SKU]);
  const [row] = await q('SELECT manifest_received, audited_at FROM batches WHERE id = $1', [batch_id]);
  expect(row).toEqual({ manifest_received: false, audited_at: null });

  // It counts, it filters, and it is marked on the row.
  const counts = await (await request.get('/api/items/pending-counts', { headers: authHeaders() })).json();
  expect(counts.counts.batches_to_audit).toBeGreaterThanOrEqual(1);
  await page.goto('/batches?audit=pending');
  const listed = page.locator('.batch-nav-row').filter({ hasText: TRACK }).first();
  await expect(listed).toBeVisible();
  await expect(listed.locator('.audit-chip')).toHaveText('No manifest · audit pending');

  // Sign it off. No order carries this tracking number, so the pointer is the supplier.
  await page.goto(`/batches?b=${batch_id}`);
  const block = page.locator('.batch-audit');
  await expect(block).toContainText('audit pending');
  await expect(block).toContainText('confirm the contents with the supplier');
  await block.getByRole('button', { name: 'Mark audited' }).click();
  await page.locator('.batch-audit-note').fill('Counted against the supplier’s email — all 1 pair present.');
  await page.getByRole('button', { name: 'Sign off the audit' }).click();
  await expect(block).toContainText('Signed off by');
  await expect(block).toContainText('E2E Warehouse');
  await expect(block).toContainText('all 1 pair present');
  await expect(page.locator('.batch-page-code .audit-chip')).toHaveText('No manifest · audited');

  // Signed once. A second signature is refused rather than overwriting the first name.
  const again = await request.post('/api/batches/audit', { headers: authHeaders(), data: { batchId: batch_id } });
  expect(again.status()).toBe(409);
  // …and it has left the audit list.
  const after = await (await request.get('/api/batches/list?kind=receiving&audit=pending', { headers: authHeaders() })).json();
  expect(after.batches.some((b) => Number(b.id) === Number(batch_id))).toBe(false);
});

test('a batch received WITH a manifest has no audit to sign', async ({ request }) => {
  const res = await request.post('/api/batches/commit', {
    headers: authHeaders(),
    data: {
      kind: 'receiving',
      batch: { supplier: 'E2E Supplier', buyer: 'e2e', dateReceived: '2026-09-15', tracking: `${TRACK}B`, manifestReceived: true },
      items: [{ name: 'E2E Manifest Runner', sku: SKU, size: '10', withBox: true, source: 'manual' }],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const { batchCode } = await res.json();
  const [{ id: batchId, ...row }] = await q('SELECT id, manifest_received FROM batches WHERE batch_code = $1', [batchCode]);
  expect(row.manifest_received).toBe(true);
  const r = await request.post('/api/batches/audit', { headers: authHeaders(), data: { batchId } });
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toMatch(/received with a manifest/i);
});
