// Correcting a SIZE declared wrong at receiving (inventory.md).
//
// The real case: a box from Council was opened, the pair was received, and the size was
// typed as a 9 when the box says 9.5. The size is the one fact at intake nobody can scan
// — a `size?` row is typed off the tongue label — and until this existed the only way
// back was to remove the pair and receive it again, burning its VIN, its shelf and its
// history over one character.
//
// What the fix has to get right, and what this pins:
//   · it moves the pairs that went in on the SAME line (same code, same wrong size, same
//     box) and never a different size, which is a different declaration;
//   · the box UPC goes, because a UPC names ONE size's box;
//   · the Global Indicator / price go for a pair not yet on a store (Alias quotes per
//     size), and STAY for a listed one, whose numbers are what the live listing says;
//   · "9 M" and "US 9.5" are the same sizes as "9" and "9.5" — stock is grouped by
//     sku + size, so a second spelling is a row nothing else matches.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const SKU = 'E2E-SZ-1234-100';
const UI_SKU = 'E2E-SZ-9999-200';
const UPC = '012345678905';
// A real VIN shape (SBM-YYMMDD-<seq>) — Inventory's search box only opens the DETAIL
// for something that parses as one; anything else is a text search of the list.
const vin = (n) => `SBM-999999-${stamp}${n}`;
const A = vin(1); const B = vin(2); const C = vin(3); const TEN = vin(4);
const UI_BATCH = vin(5); const UI_INV = vin(6);
let batchId = null; let boxId = null;

test.beforeAll(async () => {
  batchId = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name)
     VALUES ($1,'committed','receiving','Council') RETURNING id`, [`B-SIZE-${stamp}`]))[0].id;
  boxId = (await q(`INSERT INTO batch_boxes (batch_id, box_number, status)
                    VALUES ($1,1,'received') RETURNING id`, [batchId]))[0].id;
  // Three 9s off one scan line, all priced as 9s; one of them already on StockX.
  for (const v of [A, B, C]) {
    await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, upc, status,
                                global_indicator, price, gi_basis)
             VALUES ($1,$2,$3,'E2E Council Shoe',$4,'9',$5,'needs_shelf',180,216,'consigned')`,
      [v, batchId, boxId, SKU, UPC]);
  }
  await q('UPDATE items SET synced_stockx = true WHERE vin = $1', [B]);
  // Same shoe, a genuinely different size, in the same box — must never move.
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, upc, status)
           VALUES ($1,$2,$3,'E2E Council Shoe',$4,'10','012345678912','needs_shelf')`,
    [TEN, batchId, boxId, SKU]);
  // Two pairs for the two screens, on their own code so they are nobody's sibling.
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,$3,'E2E Batch Page Shoe',$4,'8','needs_shelf')`, [UI_BATCH, batchId, boxId, UI_SKU]);
  await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
           VALUES ($1,$2,$3,'E2E Detail Shoe',$4,'7','needs_shelf')`, [UI_INV, batchId, boxId, UI_SKU]);
});

test.afterAll(async () => {
  const items = await q('SELECT id FROM items WHERE batch_id = $1', [batchId]);
  for (const i of items) await q('DELETE FROM item_events WHERE item_id = $1', [i.id]);
  await q('DELETE FROM items WHERE batch_id = $1', [batchId]);
  await q('DELETE FROM batch_boxes WHERE batch_id = $1', [batchId]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await pool.end();
});

const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, {
    method: m,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('sb_session_token')}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, body: await r.json() };
}, [method, path, body || null]);

test('the endpoint fixes one pair, or the whole line — never a different size', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');

  // The preview counts the OTHER pairs received on the same line: the two other 9s,
  // not the 10 sitting in the same box.
  const pre = await call(page, 'GET', `/api/items/set-size?vin=${A}`);
  expect(pre.status, JSON.stringify(pre.body)).toBe(200);
  expect(pre.body.siblings.map((s) => s.vin).sort()).toEqual([B, C].sort());
  expect(pre.body.siblings.find((s) => s.vin === B).listed).toBe(true);
  expect(pre.body.item.upc).toBe(UPC);

  // A typo is refused rather than stored, and "9 M" IS size 9 — the men's run is
  // written bare, so this is the same size, not a new one.
  expect((await call(page, 'POST', '/api/items/set-size', { vin: A, size: '99.3' })).status).toBe(400);
  expect((await call(page, 'POST', '/api/items/set-size', { vin: A, size: 'half a size up' })).status).toBe(400);
  const sameSize = await call(page, 'POST', '/api/items/set-size', { vin: A, size: '9 M' });
  expect(sameSize.status).toBe(400);
  expect(sameSize.body.error).toContain('already size 9');

  // Just this pair. "US 9.5" is stored as "9.5".
  const one = await call(page, 'POST', '/api/items/set-size', { vin: A, size: 'US 9.5', scope: 'one', reason: 'box says 9.5' });
  expect(one.status, JSON.stringify(one.body)).toBe(200);
  expect(one.body.updated).toBe(1);
  expect(one.body.listed).toBe(0);
  expect(one.body.upcCleared).toBe(true);
  expect(one.body.item.size).toBe('9.5');
  expect(one.body.item.upc).toBe(null);                  // the code was the size-9 box's
  expect(one.body.item.price).toBe(null);                // Alias quotes per size
  expect(one.body.item.global_indicator).toBe(null);
  const note = one.body.events.find((e) => e.type === 'note' && /Size changed/.test(e.details?.text));
  expect(note.details.text).toContain('9 → 9.5');
  expect(note.details.text).toContain('box says 9.5');
  expect(note.details.size_to).toBe('9.5');

  // The rest of the line, from the listed pair: b and c move, the 10 stays, and the
  // pair that is already on a store keeps the numbers that store is showing.
  const rest = await call(page, 'POST', '/api/items/set-size', { vin: B, size: '9.5', scope: 'same_group' });
  expect(rest.status, JSON.stringify(rest.body)).toBe(200);
  expect(rest.body.updated).toBe(2);
  expect(rest.body.listed).toBe(1);
  const rows = await q('SELECT vin, size, upc, price FROM items WHERE vin = ANY($1)', [[A, B, C, TEN]]);
  const by = Object.fromEntries(rows.map((r) => [r.vin, r]));
  expect(by[C].size).toBe('9.5');
  expect(by[C].price).toBe(null);
  expect(Number(by[B].price)).toBe(216);                 // listed: its live price stands
  expect(by[B].upc).toBe(null);                          // but the box code is still wrong
  expect(by[TEN].size).toBe('10');                       // a different declaration
  expect(by[TEN].upc).toBe('012345678912');
});

test('the pencil on the batch’s own contents fixes the size there', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?b=${batchId}`);
  await page.locator('.box-row').first().click();
  const row = page.locator('.batch-detail-row', { hasText: UI_BATCH });
  await expect(row).toContainText('size 8');
  await row.getByRole('button', { name: `Correct the size on ${UI_BATCH}` }).click();
  const modal = page.locator('.modal.size-edit');
  await expect(modal).toContainText('size 8');
  await modal.locator('input[placeholder="e.g. 9.5"]').fill('8.5');
  await modal.getByRole('button', { name: 'Change to 8.5' }).click();
  await expect(page.locator('.notice')).toContainText('1 pair now size 8.5');
  await expect(page.locator('.batch-detail-row', { hasText: UI_BATCH })).toContainText('size 8.5');
});

test('the pencil beside Size on the item detail does the same', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(UI_INV);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Correct the size' }).click();
  const modal = page.locator('.modal.size-edit');
  await expect(modal).toContainText(`${UI_INV} is on record as`);
  await modal.locator('input[placeholder="e.g. 9.5"]').fill('7.5');
  await modal.getByRole('button', { name: 'Change to 7.5' }).click();
  await expect(page.locator('.notice')).toContainText('1 pair now size 7.5');
  await expect(page.locator('.details dl').first()).toContainText('7.5');
});
