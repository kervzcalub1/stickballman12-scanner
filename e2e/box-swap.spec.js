// BOX SWAP PENDING (docs/context/no-box.md "Box swap", Brent 2026-11-03).
//
// Andrew's pairs came with no box, and Brent wasn't inbounding them: "No box" sends them
// to the No Box page and the PH team, and asks for a VIN sticker today. So the PO had
// nothing received and Kevin couldn't audit it. Now:
//   · inbound can say BOX SWAP — recorded on the order, no sticker asked for (even in
//     raw-sticker mode), no label printed, never the PH team's;
//   · /no-box offers two cards; Box swap = scan the shoe, then the VIN sticker going on it
//     → the pair takes that number, is boxed, goes to Needs Shelf (and only then to PH).
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`;
const PO_CODE = `PO-BOXSWAP-${stamp.slice(-6)}`;
const SKU = `E2E-BSWAP-${stamp.slice(-6)}`;
const UPC9 = `19${stamp.slice(-10)}`;          // 12 digits, unique per run
const RUN = 9997;
const VIN_BASE = Number(stamp.slice(-5)) * 10 + 3;
const PH = { Authorization: `Bearer ${signToken({ uid: 'bs-ph', username: 'bs_ph', name: 'BS PH', role: 'ph_team' })}` };
const WH = { Authorization: `Bearer ${signToken({ uid: 'bs-wh', username: 'bs_wh', name: 'BS Warehouse', role: 'warehouse' })}` };
let poId = null;
let stickers = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const po = (await q(
    `INSERT INTO purchase_orders (po_code, supplier_name, status, expected_boxes, manifest_scope)
     VALUES ($1, 'E2E Box Swap Supplier', 'shipped', 1, 'box') RETURNING id`, [PO_CODE]))[0];
  poId = Number(po.id);
  const box = (await q(
    `INSERT INTO po_boxes (po_id, box_number, tracking_number, status) VALUES ($1, 1, $2, 'shipped') RETURNING id`,
    [poId, `BOXSWAP${stamp}`]))[0];
  await q(
    `INSERT INTO po_lines (po_id, po_box_id, sku, size, upc, name, qty_expected, entered_on_behalf)
     VALUES ($1, $2, $3, '9', $4, 'Box Swap Test Shoe', 2, true), ($1, $2, $3, '10', NULL, 'Box Swap Test Shoe', 1, true)`,
    [poId, box.id, SKU, UPC9]);
  const rows = await q(
    `INSERT INTO vin_stock (vin, run_id, printed_by)
     SELECT 'SBM-R-' || lpad(($2::bigint + g)::text, 6, '0'), $1, 'e2e'
     FROM generate_series(1, 3) g RETURNING vin`, [RUN, VIN_BASE]);
  stickers = rows.map((r) => r.vin).sort();
});

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  if (poId) {
    await q('DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE po_id = $1)', [poId]);
    await q('UPDATE purchase_orders SET received_batch_id = NULL WHERE id = $1', [poId]);
    await q('DELETE FROM batches WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_lines WHERE po_id = $1', [poId]);
    await q('DELETE FROM po_boxes WHERE po_id = $1', [poId]);
    await q('DELETE FROM purchase_orders WHERE id = $1', [poId]);
  }
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await pool.end();
});

async function rawMode(page) {
  await page.addInitScript(() => {
    const cur = JSON.parse(localStorage.getItem('sb_prefs') || '{}');
    localStorage.setItem('sb_prefs', JSON.stringify({ ...cur, rawVins: true }));
  });
}

test('inbound: a PO shoe marked Box swap needs no sticker, prints nothing, and lands on the order as box_swap', async ({ page }) => {
  await rawMode(page);   // the hardest case: raw stickers normally block every unstickered pair
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.locator('label:has-text("Buyer") input').fill('e2e');
  await page.getByRole('button', { name: /Receive against a purchase order/i }).click();
  await page.locator('.po-picker input').fill(PO_CODE);
  await page.locator('.po-picker').getByRole('button', { name: 'Find' }).click();
  await page.getByRole('button', { name: 'Add items' }).first().click();
  await expect(page.locator('.po-manifest')).toBeVisible();

  await page.locator('.po-manifest-box').getByRole('button', { name: 'Box swap' }).click();
  for (const row of await page.locator('.po-manifest-size').all()) await row.locator('input[type="checkbox"]').check();
  // No sticker owed, and the rows say why.
  await expect(page.locator('.po-manifest-size.needs-fix')).toHaveCount(0);
  await expect(page.locator('.po-flag.swap').first()).toHaveText('box swap · sticker later');
  await expect(page.locator('.po-flag.id')).toHaveCount(0);

  await page.getByRole('button', { name: /Review →/ }).click();
  await expect(page.locator('.recv-items.review')).toBeVisible();
  await page.getByRole('button', { name: /Next →/ }).click();
  // A box swap is deliberate — not a "No box" shipment problem to record.
  await expect(page.locator('.auto-issue')).toHaveCount(0);
  await page.getByRole('button', { name: 'Submit box' }).click();
  await page.getByRole('button', { name: 'Yes, commit' }).click();
  await expect(page.locator('.modal')).toContainText(/Box saved/i);
  await expect(page.getByRole('button', { name: /Print labels/i })).toHaveCount(0);

  const saved = await q('SELECT size, status, with_box, upc FROM items WHERE sku = $1 ORDER BY size, id', [SKU]);
  expect(saved.map((r) => `${r.size}:${r.status}:${r.with_box}`)).toEqual(['10:box_swap:false', '9:box_swap:false', '9:box_swap:false']);
  // On the order — Kevin can audit what came in.
  const onPo = await q('SELECT count(*)::int AS n FROM items i JOIN batches b ON b.id = i.batch_id WHERE b.po_id = $1', [poId]);
  expect(onPo[0].n).toBe(3);
});

test('the PH team never sees a box-swap pair, and it counts as warehouse work', async ({ request }) => {
  const list = await request.get('/api/ph/list?kind=receiving', { headers: PH });
  expect(list.ok()).toBeTruthy();
  expect(((await list.json()).rows || []).some((r) => r.sku === SKU)).toBe(false);
  const counts = (await (await request.get('/api/items/pending-counts', { headers: WH })).json()).counts;
  expect(counts.box_swap).toBeGreaterThanOrEqual(3);
  // …and shelving can't skip the swap — not even with "it has a box now" ticked.
  const vin = (await q(`SELECT vin FROM items WHERE sku = $1 LIMIT 1`, [SKU]))[0].vin;
  const shelf = (await q(`SELECT code FROM locations WHERE active ORDER BY id LIMIT 1`))[0];
  test.skip(!shelf, 'no active shelf in this database');
  const shelve = await request.post('/api/items/shelve', { headers: WH, data: { locationCode: shelf.code, units: [{ vin, nowHasBox: true }] } });
  const out = await shelve.json();
  expect(JSON.stringify(out)).toContain('box_swap');
  expect((await q(`SELECT status FROM items WHERE vin = $1`, [vin]))[0].status).toBe('box_swap');
});

test('/no-box: two cards; Box swap = scan the shoe, then its sticker', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/no-box');
  await expect(page.getByRole('button', { name: /Box swap/ })).toContainText(/Waiting \d+/);
  await expect(page.getByRole('button', { name: /Print box labels/ })).toBeVisible();
  await page.getByRole('button', { name: /Box swap/ }).click();
  await expect(page).toHaveURL(/\/no-box\/box-swap$/);
  const row = page.locator('.boxswap-list li', { hasText: SKU }).filter({ hasText: 'US 9' });
  await expect(row).toContainText('×2');

  const field = page.getByLabel("Scan the shoe's UPC, a SKU, or the VIN sticker");
  // A sticker before the shoe says what to do, and changes nothing.
  await field.fill(stickers[0]); await field.press('Enter');
  await expect(page.locator('.scan-flash')).toContainText('Scan the shoe first');

  await field.fill(UPC9); await field.press('Enter');
  await expect(page.locator('.boxswap-target')).toContainText('2 waiting in this size');
  await field.fill(stickers[0]); await field.press('Enter');
  await expect(page.locator('.scan-flash')).toContainText(`→ ${stickers[0]} · boxed, now Needs Shelf. 1 more of this size waiting.`);
  await expect(row).toContainText('×1');

  const swapped = await q(`SELECT id, vin, status, with_box FROM items WHERE vin = $1`, [stickers[0]]);
  expect(swapped[0]).toMatchObject({ status: 'needs_shelf', with_box: true });
  expect((await q(`SELECT status FROM vin_stock WHERE vin = $1`, [stickers[0]]))[0].status).toBe('assigned');
  const ev = await q(`SELECT details FROM item_events WHERE item_id = $1 AND type = 'box_swapped'`, [swapped[0].id]);
  expect(ev[0].details.note).toMatch(new RegExp(`sticker ${stickers[0]} put on \\(was system VIN SBM-`));

  // The same sticker again is refused by name.
  await field.fill(UPC9); await field.press('Enter');
  await field.fill(stickers[0]); await field.press('Enter');
  await expect(page.locator('.scan-flash')).toContainText('already on another pair');

  // Refresh keeps the sub-page.
  await page.reload();
  await expect(page.locator('.boxswap-list')).toBeVisible();
});

test('no sticker to hand: keep the pair’s own VIN and print it; "No box coming" moves it to No Box', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/no-box/box-swap');
  await page.locator('.boxswap-list li', { hasText: SKU }).filter({ hasText: 'US 10' }).locator('.boxswap-pick').click();
  const before = (await q(`SELECT vin FROM items WHERE sku = $1 AND size = '10'`, [SKU]))[0].vin;
  await page.getByRole('button', { name: /No sticker\? Print its VIN/ }).click();
  await expect(page.locator('.scan-flash')).toContainText(`boxed under ${before}`);
  await expect(page.getByText('Print VIN labels')).toBeVisible();      // the label dialog
  const after = (await q(`SELECT vin, status FROM items WHERE sku = $1 AND size = '10'`, [SKU]))[0];
  expect(after).toEqual({ vin: before, status: 'needs_shelf' });
  await page.keyboard.press('Escape');

  page.on('dialog', (d) => d.accept());
  await page.goto('/no-box/box-swap');
  await page.locator('.boxswap-list li', { hasText: SKU }).filter({ hasText: 'US 9' }).locator('.boxswap-pick').click();
  await page.getByRole('button', { name: 'No box coming' }).click();
  await expect(page.locator('.scan-flash')).toContainText('moved to No Box');
  const left = await q(`SELECT status FROM items WHERE sku = $1 AND size = '9' ORDER BY status`, [SKU]);
  expect(left.map((r) => r.status)).toEqual(['needs_shelf', 'no_box']);
});
