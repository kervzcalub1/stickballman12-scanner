// Raw 1ID stickers on the PO manifest.
//
// Receiving against a purchase order replaces the rapid-scan bar with the manifest
// checklist — which meant that with `prefs.rawVins` on, the commit gate demanded a
// sticker per pair on a screen that had no way to scan one and no highlight to point
// at ("Scan a 1ID sticker onto the 1 highlighted line", nothing highlighted, PO-100005
// on 2026-08-20). Receiving a PO box is the flow the stickers exist for, so the bar
// belongs here too.
//
// What has to hold: ticking a size asks for its stickers, an un-stickered ticked pair
// still can't reach Review, the row waiting for the next sticker is the one the screen
// marks, and the pair keeps the number that is physically on it.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`;
// One order per test: the first one COMMITS its box, and a received label has no
// "Add items" button left for the second test to click.
const PO_CODE = { commit: `PO-RAWVIN-${stamp.slice(-6)}A`, untick: `PO-RAWVIN-${stamp.slice(-6)}B` };
const SKU = `E2E-PORAW-${stamp.slice(-6)}`;
const RUN = 9998;
// Roll numbers derived from the run's own stamp: a run that fails to clean up
// mustn't collide with the next one on `vin_stock`'s primary key.
const VIN_BASE = Number(stamp.slice(-5)) * 10;
let poIds = [];
let stickers = [];

test.describe.configure({ mode: 'serial' });

// An order with one label carrying two pairs of ONE size — the sticker count has to
// follow the qty, not the row.
async function seedPo(code, suffix) {
  const po = (await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
     VALUES ($1, 'E2E RawVin Supplier', 'shipped', 1, 'box') RETURNING id`, [code]))[0];
  const id = Number(po.id);
  poIds.push(id);
  const box = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`,
    [id, `RAWVIN${stamp}${suffix}`]))[0];
  await q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, size, name, qty_expected, entered_on_behalf)
     VALUES ($1, $2, $3, '9', 'PO Raw Sticker Test', 2, true)`, [id, box.id, SKU]);
}

test.beforeAll(async () => {
  await seedPo(PO_CODE.commit, 'A');
  await seedPo(PO_CODE.untick, 'B');
  const rows = await q(
    `INSERT INTO vin_stock (vin, run_id, printed_by)
     SELECT 'SBM-R-' || lpad(($2::bigint + g)::text, 6, '0'), $1, 'e2e'
     FROM generate_series(1, 3) g RETURNING vin`, [RUN, VIN_BASE]);
  stickers = rows.map((r) => r.vin).sort();
});

test.afterAll(async () => {
  const items = await q('SELECT id, batch_id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  for (const poId of poIds) {
    await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
    // purchase_orders.received_batch_id references batches — the order has to let go
    // of the batch before it can be deleted.
    await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [poId]);
    await q('DELETE FROM batches WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
    await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
  await q('DELETE FROM vin_stock WHERE run_id = $1 OR vin LIKE $2', [RUN, `SBM-R-${String(VIN_BASE).slice(0, 5)}%`]);
  await pool.end();
});

// The pref is read from localStorage at mount, so it has to be set before boot.
async function rawMode(page, on = true) {
  await page.addInitScript((v) => {
    const k = 'sb_prefs';
    const cur = JSON.parse(localStorage.getItem(k) || '{}');
    localStorage.setItem(k, JSON.stringify({ ...cur, rawVins: v }));
  }, on);
}

// Header → pick the PO → open its one label's checklist.
async function toManifest(page, poCode) {
  await page.goto('/receiving');
  await page.locator('label:has-text("Buyer") input').fill('e2e');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.locator('.po-picker input').fill(poCode);
  await page.locator('.po-picker').getByRole('button', { name: 'Find' }).click();
  await expect(page.locator('.po-receive-banner')).toContainText(poCode);
  await page.getByRole('button', { name: 'Add items' }).first().click();
  await expect(page.locator('.po-manifest')).toBeVisible();
}

test('the manifest asks for a sticker per ticked pair, and marks the row it will land on', async ({ page }) => {
  const committed = stickers.slice(0, 2); // spent here — committing marks them assigned
  await rawMode(page);
  await loginAs(page, 'warehouse');
  await toManifest(page, PO_CODE.commit);

  // Nothing ticked yet: the box hasn't been opened, so there is nothing to stick.
  const bar = page.locator('.po-sticker-bar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.rawvin-beat')).toContainText('Tick a size');

  const row = page.locator('.po-manifest-size').first();
  await row.locator('input[type="checkbox"]').check();

  // Two pairs pulled → two stickers owed, and the row says so itself.
  await expect(row).toHaveClass(/needs-fix/);
  await expect(row).toHaveClass(/awaiting/);
  await expect(row.locator('.po-flag.id')).toHaveText('1ID 0/2');
  await expect(bar.locator('.rawvin-beat')).toContainText('sticker 1 of 2');

  // …and it can't be saved past this point.
  await page.getByRole('button', { name: /Review →/ }).click();
  await expect(page.locator('.error')).toContainText('2 ticked pairs still need a 1ID sticker');
  await expect(page.locator('.po-manifest')).toBeVisible(); // still on the checklist

  await bar.locator('input').fill(committed[0]);
  await bar.getByRole('button', { name: 'Add' }).click();
  await expect(row.locator('.po-flag.id')).toHaveText('1ID 1/2');
  await expect(bar.locator('.rawvin-beat')).toContainText('sticker 2 of 2');
  await expect(row).toHaveClass(/needs-fix/);

  await bar.locator('input').fill(committed[1]);
  await bar.getByRole('button', { name: 'Add' }).click();
  await expect(row.locator('.po-flag.id')).toHaveText('1ID 2/2');
  await expect(row).not.toHaveClass(/needs-fix/);
  await expect(bar.locator('.rawvin-beat')).toContainText('Every ticked pair has its 1ID');

  // Review now opens, and the pairs carry the numbers that are on the shoes — no
  // dated VIN was minted behind the scan.
  await page.getByRole('button', { name: /Review →/ }).click();
  await expect(page.locator('.recv-items.review')).toBeVisible();
  await page.locator('.recv-caret-btn').first().click();
  const vins = await page.locator('.recv-unit .vin').allInnerTexts();
  expect(vins.map((v) => v.trim()).sort()).toEqual(committed);

  // …and all the way through the commit: the box saves, and there is nothing to
  // print, because printing a label per shoe would put a SECOND number on a pair
  // that is already wearing one.
  await page.getByRole('button', { name: /Next →/ }).click();
  await page.getByRole('button', { name: 'Submit box' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.locator('.modal.success, .modal')).toContainText(/Box saved/i);
  await expect(page.getByRole('button', { name: /Print labels/i })).toHaveCount(0);

  const saved = await q('SELECT vin FROM items WHERE sku = $1 ORDER BY vin', [SKU]);
  expect(saved.map((r) => r.vin)).toEqual(committed);
  // The stickers are spent, so neither can be handed out again.
  const stock = await q('SELECT status FROM vin_stock WHERE vin = ANY($1)', [committed]);
  expect(stock.map((r) => r.status)).toEqual(['assigned', 'assigned']);
});

test('unticking a size hands its sticker back', async ({ page }) => {
  await rawMode(page);
  await loginAs(page, 'warehouse');
  await toManifest(page, PO_CODE.untick);

  const bar = page.locator('.po-sticker-bar');
  const row = page.locator('.po-manifest-size').first();
  await row.locator('input[type="checkbox"]').check();
  await bar.locator('input').fill(stickers[2]); // the one the first test didn't spend
  await bar.getByRole('button', { name: 'Add' }).click();
  await expect(row.locator('.po-flag.id')).toHaveText('1ID 1/2');

  // The pair isn't in the box after all — the sticker goes back on the roll rather
  // than staying bound to a pair nobody received.
  await row.locator('input[type="checkbox"]').uncheck();
  await expect(row.locator('.po-flag.id')).toHaveCount(0);
  await row.locator('input[type="checkbox"]').check();
  await expect(row.locator('.po-flag.id')).toHaveText('1ID 0/2');
});
