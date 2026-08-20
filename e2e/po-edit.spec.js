// Editing a purchase order after it exists: its details, and its labels.
//
// The rule that shapes all of it (the user's, 2026-08-21): a label the warehouse has
// already counted stock into can be MOVED to another order but never deleted — and a move
// has to take the received stock with it, or the old order is left holding units nothing
// claims and the new one reads fully short. That's the difference between moving a label
// and just re-typing which order it says on it.
import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const auth = { Authorization: `Bearer ${signToken({ uid: '424242', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };

const stamp = `${Date.now()}`;
const CODE = {
  a: `PO-EDITA-${stamp.slice(-6)}`,
  b: `PO-EDITB-${stamp.slice(-6)}`,
  pdf: `PO-EDITC-${stamp.slice(-6)}`,
};
const TRK = {
  one: `EDIT${stamp}A`, two: `EDIT${stamp}B`, add: `EDIT${stamp}C`, fixed: `EDIT${stamp}D`,
  // Read off a PDF rather than typed — see the import tests. 18 characters, because
  // that's a UPS number: the decoder picks tracking numbers by their real formats, and a
  // short made-up string decodes as nothing at all.
  pdf1: `1ZEDIT${stamp.slice(-10)}A1`, pdf2: `1ZEDIT${stamp.slice(-10)}A2`,
};
const SKU = `E2E-POEDIT-${stamp.slice(-6)}`;
let poA = null; let poB = null; let poPdf = null; let boxTwo = null; let batchA = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const mkPo = async (code, status) => Number((await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope, date_of_purchase)
     VALUES ($1, 'E2E Edit Supplier', $2, 2, 'box', '2026-08-01') RETURNING id`, [code, status]))[0].id);
  poA = await mkPo(CODE.a, 'receiving');
  poB = await mkPo(CODE.b, 'draft');
  poPdf = await mkPo(CODE.pdf, 'draft');
  const mkBox = async (poId, n, t) => (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1,$2,$3,'shipped') RETURNING id`,
    [poId, n, t]))[0];
  await mkBox(poA, 1, TRK.one);
  boxTwo = Number((await mkBox(poA, 2, TRK.two)).id);
  await mkBox(poB, 1, `${TRK.one}Z`);
  await mkBox(poPdf, 1, `${TRK.one}Y`);
  // Label 2 is declared AND received: two pairs counted into its box.
  await q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected) VALUES ($1,$2,$3,'9','Edit Test Shoe',2)`,
    [poA, boxTwo, SKU]);
  batchA = Number((await q(
    `INSERT INTO batches (batch_code, po_id, status, kind, supplier_name, date_received)
     VALUES ($1, $2, 'closed', 'receiving', 'E2E Edit Supplier', '2026-08-10') RETURNING id`,
    [`B-EDIT${stamp.slice(-6)}`, poA]))[0].id);
  const bbox = Number((await q(
    `INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status) VALUES ($1,2,$2,'received') RETURNING id`,
    [batchA, TRK.two]))[0].id);
  for (let i = 1; i <= 2; i++) {
    await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status) VALUES ($1,$2,$3,'Edit Test Shoe',$4,'9','needs_shelf')`,
      [`SBM-POEDIT-${stamp.slice(-6)}-${i}`, batchA, bbox, SKU]);
  }
});

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  const pos = await q("SELECT id FROM purchase_orders WHERE po_code LIKE $1", [`PO-EDIT%${stamp.slice(-6)}`]);
  const ids = pos.map((p) => Number(p.id));
  for (const id of ids) {
    await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [id]);
    await q('DELETE FROM batches WHERE po_id = $1', [id]);
    await q('DELETE FROM po_comments WHERE po_id = $1', [id]);
    await q('DELETE FROM po_lines WHERE po_id = $1', [id]);
    await q('DELETE FROM po_boxes WHERE po_id = $1', [id]);
    await q('DELETE FROM purchase_orders WHERE id = $1', [id]);
  }
  await pool.end();
});

const post = (request, path, data) => request.post(path, { headers: auth, data });

test('the order’s own details can be corrected, and boxes-expected can’t drop below its labels', async ({ request }) => {
  const bad = await post(request, '/api/po/update', { poId: poA, expectedBoxes: 1 });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toContain('2 label');

  const ok = await post(request, '/api/po/update', {
    poId: poA, tagCode: 'Edited tag', dateOfPurchase: '2026-08-05', expectedBoxes: 6, notes: 'edited by e2e',
  });
  expect(ok.ok()).toBeTruthy();
  const po = (await ok.json()).po;
  expect(po.tag_code).toBe('Edited tag');
  expect(po.expected_boxes).toBe(6);          // higher than the labels entered so far: allowed
  expect(String(po.date_of_purchase).slice(0, 10)).toBe('2026-08-05');
  // The thread is the order's audit trail — an edit nobody can account for later is worse
  // than no edit at all.
  const sys = await q("SELECT body FROM po_comments WHERE po_id = $1 AND kind = 'system'", [poA]);
  expect(sys.some((c) => c.body.includes('Order details edited'))).toBeTruthy();
});

test('labels can be added, and a tracking number can only ever be on one label', async ({ request }) => {
  const dup = await post(request, '/api/po/label-add', { poId: poA, labels: [{ trackingNumber: TRK.one }] });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).error).toContain('already label 1');

  const add = await post(request, '/api/po/label-add', { poId: poA, labels: [{ trackingNumber: TRK.add, carrierKey: 100002 }] });
  expect(add.ok()).toBeTruthy();
  const [added] = (await add.json()).boxes;
  expect(added.box_number).toBe(3);           // numbered on from the highest already there
  expect(added.status).toBe('pending');

  // A typo'd number is the common case this exists for.
  const fix = await post(request, '/api/po/label-update', { boxId: added.id, trackingNumber: TRK.fixed });
  expect(fix.ok()).toBeTruthy();
  expect((await fix.json()).box.tracking_number).toBe(TRK.fixed);

  // …and the new one can be removed again, taking nothing with it.
  const rm = await post(request, '/api/po/label-remove', { boxId: added.id, confirm: '3' });
  expect(rm.ok()).toBeTruthy();
  expect((await q('SELECT id FROM po_boxes WHERE id = $1', [added.id])).length).toBe(0);
});

test('a label with stock counted into it cannot be deleted', async ({ request }) => {
  const res = await post(request, '/api/po/label-remove', { boxId: boxTwo, confirm: '2' });
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.mustMove).toBe(true);
  expect(body.received).toBe(2);
  expect(body.error).toContain('Move the label to another order');
  // Still there — a refusal that half-deleted would be the worst outcome of the three.
  expect((await q('SELECT id FROM po_boxes WHERE id = $1', [boxTwo])).length).toBe(1);
});

test('moving a label takes its lines AND the stock received on it', async ({ request }) => {
  const res = await post(request, '/api/po/label-move', { boxId: boxTwo, targetPoId: poB });
  expect(res.ok()).toBeTruthy();
  const out = await res.json();
  expect(out.units).toBe(2);
  expect(out.boxNumber).toBe(2);              // renumbered onto the end of the target

  const box = (await q('SELECT po_id, box_number FROM po_boxes WHERE id = $1', [boxTwo]))[0];
  expect(Number(box.po_id)).toBe(poB);
  const lines = await q('SELECT po_id FROM po_lines WHERE po_box_id = $1', [boxTwo]);
  expect(lines.every((l) => Number(l.po_id) === poB)).toBeTruthy();

  // The receiving side followed: the box row and its items now sit in a batch linked to
  // the target order — which is the only reason the target can reconcile at all.
  const bb = (await q('SELECT batch_id FROM batch_boxes WHERE tracking_number = $1', [TRK.two]))[0];
  const batch = (await q('SELECT po_id FROM batches WHERE id = $1', [bb.batch_id]))[0];
  expect(Number(batch.po_id)).toBe(poB);
  const items = await q('SELECT batch_id FROM items WHERE sku = $1', [SKU]);
  expect(items.every((i) => Number(i.batch_id) === Number(bb.batch_id))).toBeTruthy();

  // Both orders say what happened, in their own threads.
  const fromThread = await q("SELECT body FROM po_comments WHERE po_id = $1 AND kind = 'system'", [poA]);
  const toThread = await q("SELECT body FROM po_comments WHERE po_id = $1 AND kind = 'system'", [poB]);
  expect(fromThread.some((c) => c.body.includes(`moved to ${CODE.b}`))).toBeTruthy();
  expect(toThread.some((c) => c.body.includes(`moved in from ${CODE.a}`))).toBeTruthy();

  // And the label reads its received count on the order it now belongs to.
  const detail = await (await request.get(`/api/po/get?id=${poB}`, { headers: auth })).json();
  const moved = detail.boxes.find((b) => Number(b.id) === boxTwo);
  expect(moved.received_units).toBe(2);
});

test('a label can be moved onto a brand-new order raised for it', async ({ request }) => {
  // The label that's left on PO A, moved out to an order that doesn't exist yet. The new
  // order is created with a placeholder label (createPo needs one) which the move then
  // clears away — a blank label left behind is one nobody could account for later.
  const box = (await q('SELECT id, box_number FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [poA]))[0];
  const res = await post(request, '/api/po/label-move', { boxId: Number(box.id), newPo: { tagCode: 'Split off' } });
  expect(res.ok()).toBeTruthy();
  const out = await res.json();
  expect(out.createdPo?.po_code).toBeTruthy();
  const made = await (await request.get(`/api/po/get?id=${out.createdPo.id}`, { headers: auth })).json();
  expect(made.boxes.length).toBe(1);                       // just the moved label
  expect(Number(made.boxes[0].id)).toBe(Number(box.id));
  expect(made.po.supplier_name).toBe('E2E Edit Supplier'); // inherited from the order it left
  expect(made.po.tag_code).toBe('Split off');
  // Clean-up hook: this order is outside the PO-EDIT% naming, so drop it here.
  await q('DELETE FROM po_comments WHERE po_id = $1', [out.createdPo.id]);
  await q('DELETE FROM po_lines WHERE po_id = $1', [out.createdPo.id]);
  await q('DELETE FROM po_boxes WHERE po_id = $1', [out.createdPo.id]);
  await q('DELETE FROM purchase_orders WHERE id = $1', [out.createdPo.id]);
});

// The courier sends one PDF of labels, the same as when the order was raised — typing
// twelve tracking numbers off a screen is how a digit gets transposed.
// (The sheet's real shape: a packing slip after every label, so two labels are FOUR pages.)
async function labelsPdf(numbers) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const t of numbers) {
    doc.addPage([612, 792]).drawText(t, { x: 20, y: 700, size: 12, font });
    doc.addPage([612, 792]).drawText('PACKING SLIP', { x: 20, y: 700, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

test('labels can be read off a PDF instead of typed', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${poPdf}`);
  await page.getByRole('button', { name: '+ Add label' }).click();
  await page.locator('.po-edit-form .po-dropzone input[type="file"]').setInputFiles({
    name: 'labels.pdf', mimeType: 'application/pdf', buffer: await labelsPdf([TRK.pdf1, TRK.pdf2]),
  });

  // Two labels out of four pages — the packing slips are not labels.
  const rows = page.locator('.po-edit-form .po-label-row');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator('.po-pdf-status')).toContainText('Added 2 labels from 4 pages');
  await expect(rows.nth(0).locator('input')).toHaveValue(TRK.pdf1);
  await expect(rows.nth(1).locator('input')).toHaveValue(TRK.pdf2);

  // This order has no sheet on file, so saving it is the safe default — nothing to lose.
  const store = page.locator('.po-store-sheet input');
  await expect(store).toBeChecked();
  await store.uncheck();                       // keep the test off R2

  await page.getByRole('button', { name: 'Add to order' }).click();
  await expect(page.locator('.po-lbl')).toHaveCount(3, { timeout: 15_000 });
  const saved = await q('SELECT box_number, tracking_number FROM po_boxes WHERE po_id = $1 ORDER BY box_number', [poPdf]);
  expect(saved.map((r) => r.tracking_number)).toEqual([`${TRK.one}Y`, TRK.pdf1, TRK.pdf2]);
  expect(saved.map((r) => Number(r.box_number))).toEqual([1, 2, 3]);
});

test('a page whose label is already on the order is skipped, not offered again', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/po-status?po=${poPdf}`);
  await page.getByRole('button', { name: '+ Add label' }).click();
  // The same sheet again, plus one new label. Re-adding the first two would be refused by
  // the server anyway (one parcel, one label) — better not to offer them at all.
  const third = `1ZEDIT${stamp.slice(-10)}A3`;
  await page.locator('.po-edit-form .po-dropzone input[type="file"]').setInputFiles({
    name: 'labels.pdf', mimeType: 'application/pdf', buffer: await labelsPdf([TRK.pdf1, TRK.pdf2, third]),
  });
  const rows = page.locator('.po-edit-form .po-label-row');
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  await expect(rows.first().locator('input')).toHaveValue(third);
  await expect(page.locator('.po-pdf-status')).toContainText('2 pages already on this order, skipped');
});

test('a settled order is frozen', async ({ request }) => {
  await q("UPDATE purchase_orders SET status = 'reconciled' WHERE id = $1", [poA]);
  const upd = await post(request, '/api/po/update', { poId: poA, notes: 'nope' });
  expect(upd.status()).toBe(409);
  const add = await post(request, '/api/po/label-add', { poId: poA, labels: [{ trackingNumber: `${TRK.add}X` }] });
  expect(add.status()).toBe(409);
  await q("UPDATE purchase_orders SET status = 'receiving' WHERE id = $1", [poA]);
});
