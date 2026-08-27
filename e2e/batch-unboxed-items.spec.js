// A batch with no BOXES still has SHOES in it (2026-08-27).
//
// `batch_boxes` rows exist only for a multi-box batch or one received against a PO. The
// ordinary receiving wizard commits its pairs straight to the batch with `box_id` NULL —
// which on prod is 165 of 190 batches (984 pairs), including ones received yesterday.
// The detail page grouped every item under a box, so all of those read
// "Boxes (0) · No boxes yet" over a batch that plainly had thirteen shoes in it.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const TRACK = `1Z3YY40803${stamp}`;
let plainCode = null;   // items, a tracking number, no boxes — the B-100069 shape
let mixedCode = null;   // one box AND a pair that never made it into one
let plainId = null; let mixedId = null;

test.beforeAll(async () => {
  const p = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, tracking_number)
     VALUES ($1,'committed','receiving','Council',$2) RETURNING id, batch_code`,
    [`B-NOBOX-${stamp}`, TRACK]))[0];
  plainId = p.id; plainCode = p.batch_code;
  for (let i = 1; i <= 3; i += 1) {
    await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
             VALUES ($1,$2,NULL,'E2E No-Box Shoe','NB-1234-100',$3,'needs_shelf')`,
      [`SBM-NOBOX-${stamp}-${i}`, plainId, String(8 + i)]);
  }
  const m = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name)
     VALUES ($1,'committed','receiving','Council') RETURNING id, batch_code`,
    [`B-MIX-${stamp}`]))[0];
  mixedId = m.id; mixedCode = m.batch_code;
  const box = (await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status)
                        VALUES ($1,1,$2,'received') RETURNING id`, [mixedId, `MIX-${stamp}`]))[0];
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,$3,'E2E Boxed Shoe','BX-1111-100','10','needs_shelf')`,
    [`SBM-MIXB-${stamp}`, mixedId, box.id]);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,NULL,'E2E Loose Shoe','LS-2222-200','11','needs_shelf')`,
    [`SBM-MIXL-${stamp}`, mixedId]);
});

test.afterAll(async () => {
  for (const id of [plainId, mixedId]) {
    const items = await q('SELECT id FROM items WHERE batch_id = $1', [id]);
    for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
    await q('DELETE FROM items WHERE batch_id = $1', [id]);
    await q('DELETE FROM batch_boxes WHERE batch_id = $1', [id]);
    await q('DELETE FROM batches WHERE id = $1', [id]);
  }
  await pool.end();
});

test('a batch with no boxes shows its shoes, not "No boxes yet"', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${plainId}`);
  await expect(page.locator('.batch-page-code')).toContainText(plainCode);
  // The three shoes are ON the page — this is the whole bug.
  await expect(page.locator('.batch-detail-row')).toHaveCount(3);
  await expect(page.getByText('E2E No-Box Shoe').first()).toBeVisible();
  // And it does not claim to be a box list with nothing in it.
  await expect(page.getByText('No boxes yet')).toHaveCount(0);
  // "0 boxes" over three shoes reads like something went missing; count the shoes.
  await expect(page.locator('.batch-progress')).toContainText('3 items');
  await expect(page.locator('.batch-progress')).not.toContainText('boxes');
});

test('a boxed batch still lists its boxes, and a loose pair is not hidden', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${mixedId}`);
  await expect(page.locator('.box-row')).toHaveCount(1);
  // The pair that never made it into a box gets its own section rather than vanishing.
  await expect(page.getByRole('heading', { name: /Not in a box/ })).toBeVisible();
  await expect(page.getByText('E2E Loose Shoe')).toBeVisible();
  // The boxed one is still behind its box row, where it belongs.
  await expect(page.getByText('E2E Boxed Shoe')).toHaveCount(0);
  await page.locator('.box-row').click();
  await expect(page.getByText('E2E Boxed Shoe')).toBeVisible();
});

test('PH sees the shoes too — read-only, no box controls', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/batches?b=${plainId}`);
  await expect(page.locator('.batch-detail-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '+ Add box', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toHaveCount(0);
});
