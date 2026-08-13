// Linking an already-received batch to its purchase order, and deleting a PO.
//
// The situation: the box arrives, the warehouse scans it in as a plain receiving batch,
// and PH opens the purchase order for it *afterwards*. "Receive against a purchase order"
// is a step-1 choice, so nothing in the app could join the two — the order read as
// outstanding forever while its stock sat on the shelf.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const auth = (role) => ({
  Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role })}`,
});

const SUPPLIER = 'E2E Link Supplier';
const SKU = 'E2E-LINK-1';

// One shipment: scanned in blind by the warehouse, then an order raised for it after.
async function fixture(request, { tracking = `E2E-LINK-${Date.now()}-${Math.floor(performance.now())}` } = {}) {
  const r1 = await request.post('/api/batches/commit', {
    headers: auth('warehouse'),
    data: {
      batch: { buyer: 'stickballman12', supplier: SUPPLIER, tracking, dateReceived: new Date().toISOString().slice(0, 10) },
      items: [
        { name: 'E2E Link Runner', sku: SKU, size: '9', cost: 50, withBox: true },
        { name: 'E2E Link Runner', sku: SKU, size: '9', cost: 50, withBox: true },
      ],
    },
  });
  expect(r1.ok(), await r1.text()).toBeTruthy();
  const batch = await r1.json();

  const r2 = await request.post('/api/po/create', {
    headers: auth('ph_team'),
    data: { supplierName: SUPPLIER, tagCode: `LNK${Date.now() % 100000}`, labels: [{ trackingNumber: tracking }] },
  });
  expect(r2.ok(), await r2.text()).toBeTruthy();
  const po = (await r2.json()).po;

  // The supplier's declared manifest — two pairs on that one label.
  const full = await (await request.get(`/api/po/get?id=${po.id}`, { headers: auth('ph_team') })).json();
  await request.post('/api/po/scan', {
    headers: auth('ph_team'),
    data: { poId: po.id, poBoxId: full.boxes[0].id, sku: SKU, size: '9', qty: 2, name: 'E2E Link Runner' },
  });

  const batchRow = await q('SELECT id, batch_code FROM batches WHERE batch_code = $1', [batch.batchCode]);
  return { po, poBoxId: full.boxes[0].id, batchId: Number(batchRow[0].id), batchCode: batch.batchCode, tracking };
}

test.afterAll(async () => {
  const rows = await q('SELECT id, batch_id FROM items WHERE sku = $1', [SKU]);
  for (const r of rows) await q('DELETE FROM item_events WHERE item_id = $1', [r.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  const batchIds = [...new Set(rows.map((r) => r.batch_id).filter(Boolean))];
  await q('UPDATE batches SET po_id = NULL WHERE supplier_name = $1', [SUPPLIER]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  for (const id of batchIds) {
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM shipment_issues WHERE batch_id = $1', [id]).catch(() => {});
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await q('DELETE FROM batches WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

test.describe('PO ← batch linking (API)', () => {
  test('links the shipment, moves the order to receiving, and the units now count', async ({ request }) => {
    const f = await fixture(request);
    // Before: the order knows nothing arrived.
    const before = await (await request.get(`/api/po/reconciliation?poId=${f.po.id}`, { headers: auth('ph_team') })).json();
    expect(before.summary.received_units).toBe(0);

    // The candidate list finds the batch by supplier / matching tracking number.
    const cand = await (await request.get(`/api/po/link-candidates?poId=${f.po.id}&batchId=${f.batchId}`, { headers: auth('ph_team') })).json();
    expect(cand.batches.some((b) => Number(b.id) === f.batchId)).toBe(true);
    // Its box is pre-matched to the label they share a tracking number with.
    expect(cand.preview.boxes[0].matchedPoBoxId).toBe(Number(f.poBoxId));

    const res = await request.post('/api/po/link-batch', {
      headers: auth('ph_team'),
      data: { poId: f.po.id, batchId: f.batchId, boxMap: [{ boxId: cand.preview.boxes[0].id, poBoxId: f.poBoxId }], shipLabels: true },
    });
    expect(res.status(), await res.text()).toBe(200);

    const [b] = await q('SELECT po_id FROM batches WHERE id = $1', [f.batchId]);
    expect(Number(b.po_id)).toBe(Number(f.po.id));
    const [p] = await q('SELECT status, received_batch_id FROM purchase_orders WHERE id = $1', [f.po.id]);
    expect(Number(p.received_batch_id)).toBe(f.batchId);

    // The order now reads exactly as if it had been received against in the first place.
    // shipLabels matters here: a per-label manifest counts only SHIPPED labels, so without
    // it the expected side stays 0 and a delivered order reads "received blind".
    const after = await (await request.get(`/api/po/reconciliation?poId=${f.po.id}`, { headers: auth('ph_team') })).json();
    expect(after.summary.received_units).toBe(2);
    expect(after.summary.expected_units).toBe(2);
    expect(after.summary.clean).toBe(true);
    expect(after.summary.no_manifest).toBe(false);

    // And it left a trail explaining why a late order has a received batch against it.
    const notes = await q("SELECT body FROM po_comments WHERE po_id = $1 AND kind = 'system'", [f.po.id]);
    expect(notes.some((n) => n.body.includes(f.batchCode))).toBe(true);
  });

  test('without shipping the labels, the order would read "received blind"', async ({ request }) => {
    const f = await fixture(request);
    await request.post('/api/po/link-batch', {
      headers: auth('ph_team'), data: { poId: f.po.id, batchId: f.batchId, shipLabels: false },
    });
    const rc = await (await request.get(`/api/po/reconciliation?poId=${f.po.id}`, { headers: auth('ph_team') })).json();
    expect(rc.summary.received_units).toBe(2);
    expect(rc.summary.expected_units).toBe(0);   // the label never left 'pending'
    expect(rc.summary.no_manifest).toBe(true);   // which is exactly what the UI warns about
  });

  test('a batch already linked elsewhere is refused', async ({ request }) => {
    const a = await fixture(request);
    const b = await fixture(request);
    await request.post('/api/po/link-batch', { headers: auth('ph_team'), data: { poId: a.po.id, batchId: a.batchId } });
    const res = await request.post('/api/po/link-batch', {
      headers: auth('ph_team'), data: { poId: b.po.id, batchId: a.batchId },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/already linked/i);
  });

  test('unlink removes the join and leaves every unit alone', async ({ request }) => {
    const f = await fixture(request);
    // shipLabels only ever touches the labels named in boxMap — it can't mark a label
    // shipped that nobody claimed was part of this shipment.
    const cand = await (await request.get(`/api/po/link-candidates?poId=${f.po.id}&batchId=${f.batchId}`, { headers: auth('ph_team') })).json();
    await request.post('/api/po/link-batch', {
      headers: auth('ph_team'),
      data: { poId: f.po.id, batchId: f.batchId, boxMap: [{ boxId: cand.preview.boxes[0].id, poBoxId: f.poBoxId }], shipLabels: true },
    });
    const res = await request.post('/api/po/unlink-batch', { headers: auth('ph_team'), data: { poId: f.po.id, batchId: f.batchId } });
    expect(res.status(), await res.text()).toBe(200);

    const [b] = await q('SELECT po_id FROM batches WHERE id = $1', [f.batchId]);
    expect(b.po_id).toBeNull();
    const units = await q('SELECT count(*)::int AS n FROM items WHERE batch_id = $1', [f.batchId]);
    expect(units[0].n).toBe(2);                    // the stock is untouched
    const [p] = await q('SELECT status, received_batch_id FROM purchase_orders WHERE id = $1', [f.po.id]);
    expect(p.received_batch_id).toBeNull();
    expect(p.status).toBe('shipped');              // a label had shipped, so not back to draft
  });
});

test.describe('PO delete', () => {
  test('is refused while a batch is linked — the record of received stock must survive', async ({ request }) => {
    const f = await fixture(request);
    await request.post('/api/po/link-batch', { headers: auth('ph_team'), data: { poId: f.po.id, batchId: f.batchId } });
    const res = await request.post('/api/po/delete', {
      headers: auth('ph_team'), data: { poId: f.po.id, confirm: f.po.po_code },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toMatch(/unlink/i);
    expect((await q('SELECT 1 FROM purchase_orders WHERE id = $1', [f.po.id])).length).toBe(1);
  });

  test('needs the PO code typed back exactly, then removes the order and its labels', async ({ request }) => {
    const f = await fixture(request);
    const wrong = await request.post('/api/po/delete', { headers: auth('ph_team'), data: { poId: f.po.id, confirm: 'PO-NOPE' } });
    expect(wrong.status()).toBe(400);
    expect((await q('SELECT 1 FROM purchase_orders WHERE id = $1', [f.po.id])).length).toBe(1);

    const res = await request.post('/api/po/delete', { headers: auth('ph_team'), data: { poId: f.po.id, confirm: f.po.po_code } });
    expect(res.status(), await res.text()).toBe(200);
    expect((await q('SELECT 1 FROM purchase_orders WHERE id = $1', [f.po.id])).length).toBe(0);
    expect((await q('SELECT 1 FROM po_boxes WHERE po_id = $1', [f.po.id])).length).toBe(0);  // cascaded
    expect((await q('SELECT 1 FROM po_lines WHERE po_id = $1', [f.po.id])).length).toBe(0);
    // The batch it was never linked to is still there, with its stock.
    expect((await q('SELECT 1 FROM items WHERE batch_id = $1', [f.batchId])).length).toBe(2);
  });

  test('a supplier can neither link nor delete', async ({ request }) => {
    const f = await fixture(request);
    for (const [path, data] of [
      ['/api/po/link-batch', { poId: f.po.id, batchId: f.batchId }],
      ['/api/po/unlink-batch', { poId: f.po.id, batchId: f.batchId }],
      ['/api/po/delete', { poId: f.po.id, confirm: f.po.po_code }],
    ]) {
      expect((await request.post(path, { headers: auth('supplier'), data })).status(), path).toBe(403);
      expect((await request.post(path, { data })).status(), path).toBe(401);
    }
  });
});

test('PH links the shipment, unlinks it, then deletes the order — all from the PO screen', async ({ page, request }) => {
  const f = await fixture(request);
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${f.po.id}`);

  const row = page.locator('.po-ov').filter({ hasText: f.po.po_code });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: /Link a received shipment/ }).click();

  const modal = page.locator('.modal.po-link');
  await expect(modal).toBeVisible();
  await modal.locator('.po-link-batch', { hasText: f.batchCode }).click();
  // The box is pre-matched to its label, and the shipped-labels trap is offered.
  await expect(modal.locator('.po-link-row select')).toHaveValue(String(f.poBoxId));
  await expect(modal.locator('.po-link-check input')).toBeChecked();
  await expect(modal.locator('.po-link-summary')).toContainText('2');
  await modal.getByRole('button', { name: /Link this shipment/ }).click();
  await expect(modal).toBeHidden({ timeout: 10_000 });

  // The order says what it's counting, and offers to undo it.
  const linked = row.locator('.po-ov-batch').filter({ hasText: f.batchCode });
  await expect(linked).toBeVisible({ timeout: 10_000 });
  // Delete is refused while it's linked — the screen says why instead of hiding it.
  await expect(row.locator('.po-ov-danger')).toContainText(/Can’t be deleted/i);

  await linked.getByRole('button', { name: 'Unlink' }).click();
  await expect(row.locator('.po-ov-batch')).toHaveCount(0, { timeout: 10_000 });

  await row.getByRole('button', { name: 'Delete this purchase order' }).click();
  const del = page.locator('.modal.po-del');
  const confirm = del.getByRole('button', { name: 'Delete permanently' });
  await expect(confirm).toBeDisabled();                 // nothing typed yet
  await del.locator('input').fill('PO-WRONG');
  await expect(confirm).toBeDisabled();                 // wrong code
  await del.locator('input').fill(f.po.po_code);
  await confirm.click();

  await expect(page.locator('.po-ov').filter({ hasText: f.po.po_code })).toHaveCount(0, { timeout: 10_000 });
  expect((await q('SELECT 1 FROM purchase_orders WHERE id = $1', [f.po.id])).length).toBe(0);
});
