// Receiving a WHOLE-ORDER-manifest PO in raw-1ID mode.
//
// Reported from the floor: a shipment was scanned in and linked to its PO, the PO carried
// a whole-order manifest rather than per-box lines, and the warehouse could not work. The
// PO checklist screen is sticker-only by design — the pair is already on the label's list,
// so you tick the size as it comes out of the box and scan its 1ID, two beats instead of
// three. That design assumes the label HAS a list.
//
// A whole-order manifest is one list for the whole purchase, so EVERY label legitimately
// has an empty checklist. Nothing to tick, so the sticker bar had no row to bind to and
// the shoe could not be scanned at all — with 1ID mode on, which is what they run daily,
// the screen was a dead end.
//
// Same for a per-box order where one label was never declared.
//
// It was reported as two things — "can't scan the 1ID" and "it prompts to select a size
// but there are no size options to tick" — and they are one bug: the sticker bar's prompt
// ("Tick a size as you pull it from the box") sat directly above a checklist that a
// whole-order manifest leaves empty.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const auth = () => ({ Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` });
const SUPPLIER = 'E2E WholeOrder 1ID';
const SKU = 'E2E-WO1ID-1';

test.afterAll(async () => {
  await q(`UPDATE purchase_orders SET received_batch_id = NULL WHERE supplier_name = $1`, [SUPPLIER]);
  await q(`DELETE FROM items WHERE batch_id IN (SELECT id FROM batches WHERE supplier_name = $1)`, [SUPPLIER]);
  await q(`DELETE FROM batches WHERE supplier_name = $1`, [SUPPLIER]);
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await pool.end();
});

// A shipped PO whose manifest is ONE whole-order list — no per-box lines at all.
async function wholeOrderPo(labels = 2) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, tag_code, expected_boxes, status, manifest_scope)
     VALUES ($1, 'E2E-WO', $2, 'shipped', 'po') RETURNING *`, [SUPPLIER, labels]))[0];
  const boxes = await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status)
     SELECT $1, g, 'E2E-WO-' || g || '-' || $2, 'shipped' FROM generate_series(1, $3) g RETURNING *`,
    [po.id, stamp, labels]);
  // The whole-order list: po_box_id NULL, which is exactly why no label has a checklist.
  await q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, name, size, qty_expected)
     VALUES ($1, NULL, $2, 'E2E WO Runner', '9', 6)`, [po.id, SKU]);
  boxes.sort((a, b) => a.box_number - b.box_number);
  return { po, boxes };
}

const stubCatalog = (page) => page.route('**/api/upc-search', (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, product: { name: 'E2E WO Runner', sku: SKU, scannedSize: '9', sizes: ['9'] } }),
}));

// Open Receiving against the PO, in raw-1ID mode, and get into box 1's scan screen.
async function intoBox(page, po) {
  await loginAs(page, 'warehouse');
  await page.addInitScript(() => localStorage.setItem('sb_prefs', JSON.stringify({ rawVins: true })));
  await stubCatalog(page);
  await page.goto('/receiving');
  await expect(page.getByRole('button', { name: /Receive against a purchase order/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.getByText(po.po_code, { exact: false }).first().click();
  await expect(page.getByText(/Receiving against/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Add items$/ }).first().click();
  await page.waitForTimeout(1200);
}

test('a whole-order PO still lets the shoe be scanned, then its 1ID', async ({ page }) => {
  const { po } = await wholeOrderPo();
  await intoBox(page, po);

  // The screen says why there is nothing to tick, rather than looking broken.
  await expect(page.getByText(/one whole-order list/i)).toBeVisible();

  // The OTHER half of the same bug, reported separately as "it prompts to select a size
  // but there are no sizes to tick": the checklist bar told you to tick a size while the
  // checklist under it was empty, because a whole-order manifest declares nothing per
  // label. No list, so no such prompt.
  await expect(page.getByText(/Tick a size/i)).toHaveCount(0);
  await expect(page.getByText(/had no expected items/i)).toHaveCount(0);

  // The two-beat bar is present — this is the part that was missing.
  const bar = page.locator('.searchrow input').first();
  await expect(bar).toBeVisible();
  await expect(page.getByText(/Scan the shoe/i).first()).toBeVisible();

  // Beat 1: the shoe.
  await bar.fill('196604049588');
  await page.keyboard.press('Enter');
  await expect(page.getByText('E2E WO Runner').first()).toBeVisible({ timeout: 15_000 });

  // Beat 2: its 1ID. A fresh roll sticker binds rather than being refused.
  const sticker = `SBM-R-77${String(Date.now()).slice(-6)}`;
  await bar.fill(sticker);
  await page.keyboard.press('Enter');
  await expect(page.getByText(new RegExp(`✓ ${sticker}`))).toBeVisible({ timeout: 15_000 });
});

test('a checklist opened before its lines arrived catches up', async ({ page }) => {
  // The warehouse's report: box 1 of 15 had nothing to tick and no way to scan; boxes 2
  // onwards were normal. That is what a checklist built before the PO's lines were on
  // hand looks like — it is built once, on open, and nothing rebuilt it afterwards.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, tag_code, expected_boxes, status)
     VALUES ($1, 'E2E-LATE', 2, 'shipped') RETURNING *`, [SUPPLIER]))[0];
  const boxes = await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status)
     SELECT $1, g, 'E2E-LATE-' || g || '-' || $2, 'shipped' FROM generate_series(1,2) g RETURNING *`,
    [po.id, stamp]);
  boxes.sort((a, b) => a.box_number - b.box_number);
  await q(`INSERT INTO po_lines (po_id, po_box_id, sku, name, size, qty_expected)
           VALUES ($1, $2, $3, 'E2E Late Runner', '9', 4)`, [po.id, boxes[0].id, SKU]);

  // Hold the PO fetch open so the box is opened while the lines are still in flight —
  // the race the report describes, made deterministic.
  await loginAs(page, 'warehouse');
  await page.addInitScript(() => localStorage.setItem('sb_prefs', JSON.stringify({ rawVins: true })));
  await stubCatalog(page);
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/po/get*', async (route) => { await held; route.continue(); });
  await page.goto('/receiving');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.getByText(po.po_code, { exact: false }).first().click();
  release();
  await expect(page.getByText(/Receiving against/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^Add items$/ }).first().click();

  // Box 1 DOES have a declared line, so its checklist must show it however the timing fell.
  await expect(page.getByText('E2E Late Runner').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/exp 4/i).first()).toBeVisible();
});

test('a label the supplier never declared behaves the same way', async ({ page }) => {
  // Same dead end, different cause: a per-box order where one label carries no lines.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, tag_code, expected_boxes, status)
     VALUES ($1, 'E2E-BLIND', 1, 'shipped') RETURNING *`, [SUPPLIER]))[0];
  await q(`INSERT INTO po_boxes (po_id, box_number, tracking_number, status)
           VALUES ($1, 1, $2, 'shipped')`, [po.id, `E2E-BLIND-${stamp}`]);
  await intoBox(page, po);
  await expect(page.getByText(/declared nothing for this label/i)).toBeVisible();
  const bar = page.locator('.searchrow input').first();
  await bar.fill('196604049588');
  await page.keyboard.press('Enter');
  await expect(page.getByText('E2E WO Runner').first()).toBeVisible({ timeout: 15_000 });
});
