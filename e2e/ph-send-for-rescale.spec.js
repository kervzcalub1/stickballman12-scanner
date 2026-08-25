// "Send for rescale" from a PH New Inventory row.
//
// What matters is that it produces the SAME thing the standalone Request Rescale form
// produces — an `open` rescale_requests row the warehouse can audit — so the test drives
// the whole loop: PH raises it off the row, the warehouse audits the shelf, both counts
// land on the request. Plus the two things this entry point adds: the row's own counts
// are pre-filled (PH edits a number instead of retyping the shoe), and a SKU that already
// has an open request says so before a second one is raised.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);
const whAuth = { Authorization: `Bearer ${signToken({ uid: '424243', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` };

const stamp = `${Date.now()}`.slice(-6);
const SKU = `E2E-RESC-${stamp}`;
let batchId = null;

test.beforeEach(async ({ page }) => { page.on('pageerror', (err) => { throw err; }); });

test.beforeAll(async () => {
  batchId = Number((await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'closed','receiving','E2E Rescale Supplier') RETURNING id`,
    [`B-RESC-${stamp}`]))[0].id);
  // Two of US 9 and one of US 10, so the pre-fill has something to get right.
  const add = (size, n) => q(
    `INSERT INTO items (vin, batch_id, name, sku, size, status, price) VALUES ($1,$2,'E2E Rescale Shoe',$3,$4,'needs_shelf',180)`,
    [`SBM-RESC-${stamp}-${n}`, batchId, SKU, size]);
  await add('9', 1); await add('9', 2); await add('10', 3);
});

test.afterAll(async () => {
  await q(`DELETE FROM rescale_requests WHERE sku = $1`, [SKU]);
  const items = await q('SELECT id FROM items WHERE sku = $1', [SKU]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE sku = $1', [SKU]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await pool.end();
});

// The grid defaults to the current month, which is where a just-inserted item lands.
async function openRow(page) {
  await loginAs(page, 'ph_team');
  await page.goto('/ph/new-inventory?st=');   // no status filter — the row is Pending, but be explicit
  await page.locator('.ph-trow', { hasText: SKU }).first().waitFor();
  return page.locator('.ph-trow', { hasText: SKU }).first();
}

test('the modal pre-fills the row own per-size counts, and sends a request the warehouse can audit', async ({ page, request, baseURL }) => {
  const row = await openRow(page);
  await row.getByRole('button', { name: '⟳ Rescale…' }).click();

  const modal = page.locator('.modal.rescale-ask');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.modal-msg')).toContainText(SKU);
  // Pre-filled from the row: US 9 ×2 and US 10 ×1, ours shown beside each.
  const sizes = modal.locator('.ra-row');
  await expect(sizes).toHaveCount(2);
  await expect(sizes.nth(0).locator('input.sz')).toHaveValue('9');
  await expect(sizes.nth(0).locator('input.qty')).toHaveValue('2');
  await expect(sizes.nth(0).locator('.ra-onfile')).toHaveText('×2');
  await expect(sizes.nth(1).locator('input.sz')).toHaveValue('10');
  await expect(sizes.nth(1).locator('input.qty')).toHaveValue('1');
  // Every size shares one price, so "current price" comes in filled.
  await expect(modal.locator('.ra-fields input[type="number"]').first()).toHaveValue('180');  // not "180.00" — NUMERIC comes back as a string

  // PH reports one fewer US 9 than we hold — the difference is flagged on the row and totalled.
  await sizes.nth(0).locator('input.qty').fill('1');
  await expect(sizes.nth(0)).toHaveClass(/diff/);
  await expect(modal.locator('.ra-rows-foot')).toContainText('2 reported vs 3 on file');
  await modal.locator('.ra-note input').fill('Only one 9 on my sheet');
  await modal.getByRole('button', { name: 'Send for rescale' }).click();

  await expect(page.locator('.modal.rescale-ask')).toHaveCount(0);
  await expect(page.getByText(/Rescale requested for/)).toBeVisible();

  // It's a normal open request: same shape the standalone form makes.
  const [req] = await q('SELECT * FROM rescale_requests WHERE sku = $1', [SKU]);
  expect(req.status).toBe('open');
  expect(req.reason).toBe('mismatch');
  expect(req.note).toBe('Only one 9 on my sheet');
  expect(Number(req.price)).toBe(180);
  expect(req.sizes).toEqual([{ size: '9', qty: 1 }, { size: '10', qty: 1 }]);

  // …and the warehouse audits it through the endpoint it already uses.
  const res = await request.post(`${baseURL}/api/rescale-requests/audit`, {
    headers: whAuth,
    data: { id: Number(req.id), actualSizes: [{ size: '9', qty: 2 }, { size: '10', qty: 1 }], note: 'Counted the shelf' },
  });
  expect(res.ok()).toBeTruthy();
  const [after] = await q('SELECT status, actual_sizes FROM rescale_requests WHERE id = $1', [req.id]);
  expect(after.status).toBe('audited');
  expect(after.actual_sizes).toEqual([{ size: '9', qty: 2 }, { size: '10', qty: 1 }]);
});

test('a SKU with an open request is chipped, and warns before a second one', async ({ page }) => {
  await q(`UPDATE rescale_requests SET status = 'open', requested_by = 'Someone Else' WHERE sku = $1`, [SKU]);
  const row = await openRow(page);
  await expect(row.locator('.ph-rescale-chip')).toBeVisible();
  await row.getByRole('button', { name: '⟳ Rescale…' }).click();
  await expect(page.locator('.modal.rescale-ask .ra-dupe')).toContainText('Someone Else');
  // Warned, not blocked — a second, later count can be the whole point.
  await expect(page.getByRole('button', { name: 'Send for rescale' })).toBeEnabled();
});

// The button belongs to PH's own worklist. Admin/warehouse read the same grid at
// /report (kind=null, "Listings & Sync"), where they're read-only anyway — raising a
// request against yourself isn't a thing the warehouse does.
test('the admin/warehouse Listings & Sync grid gets no Rescale button', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/report');
  await page.locator('.ph-trow').first().waitFor();
  await expect(page.getByRole('button', { name: '⟳ Rescale…' })).toHaveCount(0);
});
