// Deleted POs (docs/context/purchase-orders.md, 2026-11-03). Deleting an order used to
// ERASE it — labels, manifest, comments and all, with no record of who did it. Now the
// delete archives the whole order first (deleted_pos), the Deleted POs page shows it, and
// Restore puts it back with the same number and ids.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const auth = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}` });
const SUPPLIER = 'E2E Deleted PO Supplier';
const TAG = `DELPO${Date.now() % 100000}`;
const made = [];

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  for (const code of made) {
    await q('DELETE FROM purchase_orders WHERE po_code = $1', [code]);
    await q('DELETE FROM deleted_pos WHERE po_code = $1', [code]);
  }
  await pool.end();
});

async function raise(request) {
  const tracking = `1ZE2E${Date.now()}`.slice(0, 18);
  const r = await request.post('/api/po/create', { headers: auth('ph_team'), data: { supplierName: SUPPLIER, tagCode: TAG, notes: 'keep me', labels: [{ trackingNumber: tracking }, { trackingNumber: `${tracking}2` }] } });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { po } = await r.json();
  made.push(po.po_code);
  const full = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('ph_team') })).json();
  await request.post('/api/po/scan', { headers: auth('ph_team'), data: { poId: po.id, poBoxId: full.boxes[0].id, sku: 'E2E-DELPO-1', size: '9', qty: 2, name: 'E2E Deleted Runner' } });
  await request.post('/api/po/comment', { headers: auth('ph_team'), data: { poId: po.id, body: 'supplier says two boxes' } });
  return { po, tracking };
}

test('delete archives the whole order with who and why; restore puts it back as it was', async ({ request }) => {
  const { po, tracking } = await raise(request);
  const before = await q('SELECT id FROM po_boxes WHERE po_id = $1 ORDER BY id', [po.id]);

  const del = await request.post('/api/po/delete', { headers: auth('ph_team'), data: { poId: po.id, confirm: po.po_code, reason: 'Duplicate of another order' } });
  expect(del.ok(), await del.text()).toBeTruthy();
  expect(await q('SELECT 1 FROM purchase_orders WHERE id = $1', [po.id])).toHaveLength(0);

  const [row] = await q('SELECT * FROM deleted_pos WHERE po_code = $1', [po.po_code]);
  expect(row).toMatchObject({ po_id: String(po.id), supplier_name: SUPPLIER, tag_code: TAG, box_count: 2, unit_count: 2,
    po_created_by: 'E2E ph_team', deleted_by: 'E2E ph_team', deleted_by_role: 'ph_team', reason: 'Duplicate of another order' });
  expect(row.po_json.notes).toBe('keep me');
  expect(row.children.po_boxes.map((b) => b.tracking_number)).toEqual([tracking, `${tracking}2`]);
  expect(row.children.po_lines[0]).toMatchObject({ sku: 'E2E-DELPO-1', size: '9', qty_expected: 2 });
  expect(row.children.po_comments.map((c) => c.body)).toContain('supplier says two boxes');

  // The list and the one-order read.
  const list = await (await request.get('/api/po/deleted', { headers: auth('warehouse') })).json();
  const mine = list.rows.find((r) => r.po_code === po.po_code);
  expect(mine).toMatchObject({ deleted_by: 'E2E ph_team', is_recovered: false });
  // Warehouse reads, but only PH / admin restore.
  expect((await request.post('/api/po/deleted', { headers: auth('warehouse'), data: { id: Number(mine.id), restore: true } })).status()).toBe(403);

  const back = await request.post('/api/po/deleted', { headers: auth('ph_team'), data: { id: Number(mine.id), restore: true } });
  expect(back.ok(), await back.text()).toBeTruthy();
  const full = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('ph_team') })).json();
  expect(full.po).toMatchObject({ po_code: po.po_code, notes: 'keep me', tag_code: TAG });
  expect(full.boxes.map((b) => b.id)).toEqual(before.map((b) => b.id));          // same ids
  expect(full.lines[0]).toMatchObject({ sku: 'E2E-DELPO-1', qty_expected: 2 });
  expect((await q('SELECT body FROM po_comments WHERE po_id = $1', [po.id])).map((c) => c.body)).toContain('supplier says two boxes');
  const [after] = await q('SELECT restored_by FROM deleted_pos WHERE id = $1', [mine.id]);
  expect(after.restored_by).toBe('E2E ph_team');
  // Twice is refused.
  expect((await request.post('/api/po/deleted', { headers: auth('ph_team'), data: { id: Number(mine.id), restore: true } })).status()).toBe(409);
});

test('the Deleted POs page lists it, opens it, and restores it', async ({ page, request }) => {
  page.on('pageerror', (err) => { throw err; });
  const { po, tracking } = await raise(request);
  await request.post('/api/po/delete', { headers: auth('ph_team'), data: { poId: po.id, confirm: po.po_code, reason: 'raised twice' } });

  await loginAs(page, 'ph_team');
  await page.goto('/ph/po-status');
  await page.getByRole('button', { name: '🗑 Deleted POs' }).click();
  await page.getByLabel('Search deleted purchase orders').fill(po.po_code);
  const row = page.locator('.dpo-row', { hasText: po.po_code });
  await expect(row).toContainText('Reason: raised twice');
  await expect(row).toContainText('Deleted by E2E ph_team (ph_team)');
  await row.locator('.dpo-head').click();
  await expect(row).toContainText(tracking);
  await expect(row).toContainText('E2E-DELPO-1');
  await expect(row).toContainText('supplier says two boxes');
  await row.getByRole('button', { name: '↩ Restore' }).click();
  await page.getByRole('dialog', { name: `Restore ${po.po_code}` }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(`${po.po_code} is back on Purchase Orders.`)).toBeVisible();
  await expect(row.locator('.dpo-chip.ok')).toHaveText('Restored');
  expect(await q('SELECT 1 FROM purchase_orders WHERE id = $1', [po.id])).toHaveLength(1);
});
