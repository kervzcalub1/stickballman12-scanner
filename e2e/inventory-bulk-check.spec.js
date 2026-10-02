// Inventory · "Bulk · check all" (2026-10-03): scan or paste a hundred-plus VINs FIRST, then
// ask once which are registered. The sibling of "Rapid · instant", which answers each scan
// as it lands. What matters here: nothing is looked up while scanning, one Check answers
// the whole list with the same states a single scan gives, the summary can be filtered and
// exported, and a refresh mid-walk doesn't lose the list.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
const VINS = [1, 2, 3].map((n) => `SBM-261003-${stamp.slice(-5)}${n}`);
const SOLD = `SBM-261003-${stamp.slice(-5)}7`;
const STICKER = `SBM-R-8966${stamp.slice(-2)}`;   // minted, still on the roll
const VOID = `SBM-R-8967${stamp.slice(-2)}`;      // voided
const GONE = `SBM-261003-${stamp.slice(-5)}8`;    // a pair that was removed
const MISSING = `SBM-260101-998${stamp.slice(-3)}`;
const RUN = 9996;
let batchId = null;
const wh = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' })}` };

test.beforeAll(async () => {
  batchId = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name) VALUES ($1,'committed','receiving','E2E Bulk') RETURNING id`,
    [`B-BULK-${stamp}`]))[0].id;
  for (let i = 0; i < VINS.length; i += 1) {
    await q(`INSERT INTO items (vin, batch_id, name, sku, size, status, location_code)
             VALUES ($1,$2,$3,'BK-1234-100',$4,'in_stock',$5)`, [VINS[i], batchId, `E2E Bulk Shoe ${i + 1}`, String(9 + i), i === 0 ? 'A-01-01' : null]);
  }
  await q(`INSERT INTO items (vin, batch_id, name, sku, size, status) VALUES ($1,$2,'E2E Bulk Sold','BK-1234-100','12','sold')`, [SOLD, batchId]);
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await q(`INSERT INTO vin_stock (vin, run_id, printed_by) VALUES ($1,$2,'e2e')`, [STICKER, RUN]);
  await q(`INSERT INTO vin_stock (vin, run_id, printed_by, status, voided_at) VALUES ($1,$2,'e2e','void',now())`, [VOID, RUN]);
  await q(`INSERT INTO deleted_items (vin, sku, name, size, status, deleted_by, deleted_at, reason, item_json)
           VALUES ($1,'BK-1234-100','E2E Bulk Gone','8','needs_shelf','E2E Admin',now(),'duplicate','{}'::jsonb)`, [GONE]);
});

test.afterAll(async () => {
  await q('DELETE FROM items WHERE batch_id = $1', [batchId]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await q('DELETE FROM deleted_items WHERE vin = $1', [GONE]);
  await pool.end();
});

test('one call answers a whole list with the same states a single scan gives', async ({ request }) => {
  const r = await request.post('/api/items/check-vins', {
    headers: wh,
    data: { vins: [VINS[0], VINS[0].toLowerCase(), SOLD, STICKER, VOID, GONE, MISSING, '197620655946'] },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  const { results, counts } = await r.json();
  const by = Object.fromEntries(results.map((x) => [x.vin, x]));
  expect(results).toHaveLength(7);   // the lowercase repeat is the same VIN
  expect(by[VINS[0]]).toMatchObject({ result: 'registered', item: { sku: 'BK-1234-100', size: '9', status: 'in_stock', location: 'A-01-01' } });
  expect(by[SOLD]).toMatchObject({ result: 'registered', item: { status: 'sold' } });
  expect(by[STICKER].result).toBe('sticker_unused');
  expect(by[VOID].result).toBe('sticker_void');
  expect(by[GONE]).toMatchObject({ result: 'deleted', deleted: { by: 'E2E Admin', reason: 'duplicate' } });
  expect(by[MISSING].result).toBe('not_registered');
  expect(by['197620655946'].result).toBe('not_a_vin');
  expect(counts).toMatchObject({ registered: 2, sticker_unused: 1, sticker_void: 1, deleted: 1, not_registered: 1, not_a_vin: 1 });

  const big = await request.post('/api/items/check-vins', { headers: wh, data: { vins: Array.from({ length: 1001 }, (_, i) => `SBM-260101-${i}`) } });
  expect(big.status()).toBe(400);
});

test('scan, paste, then Check all — a summary you can filter, and it survives a refresh', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Bulk · check all' }).click();
  const panel = page.locator('.bulk-check');
  await expect(panel).toBeVisible();
  if (await panel.getByRole('button', { name: 'Clear' }).isEnabled()) {
    page.once('dialog', (d) => d.accept());
    await panel.getByRole('button', { name: 'Clear' }).click();
  }

  // Nothing is looked up while scanning — count the lookups.
  let lookups = 0;
  page.on('request', (r) => { if (/\/api\/(items\/lookup|vins\/check|items\/check-vins)/.test(r.url())) lookups += 1; });
  const gun = async (code) => { const i = panel.getByLabel('Scan a VIN into the bulk list'); await i.fill(code); await i.press('Enter'); };
  await gun(VINS[0]); await gun(VINS[1]); await gun(VINS[0]);   // the repeat bumps, not stacks
  await panel.getByRole('button', { name: 'Paste a list' }).click();
  await panel.locator('textarea').fill(`${STICKER}\n${MISSING}, ${GONE}`);
  await panel.getByRole('button', { name: 'Add these' }).click();
  await expect(panel.locator('.bulk-row')).toHaveCount(5);
  // Several VINs pasted into the SCAN box are several scans, not one long bogus VIN.
  await gun(`${SOLD} ${VOID}`);
  await expect(panel.locator('.bulk-row')).toHaveCount(7);
  await panel.getByRole('button', { name: /Undo last/ }).click();
  await panel.getByRole('button', { name: /Undo last/ }).click();
  await expect(panel.locator('.bulk-row')).toHaveCount(5);
  await expect(panel.locator('.bulk-row').filter({ hasText: VINS[0] })).toContainText('×2');
  expect(lookups).toBe(0);

  await panel.getByRole('button', { name: 'Check all 5' }).click();
  await expect(panel.getByRole('button', { name: /Registered 2/ })).toBeVisible();
  expect(lookups).toBe(1);
  await expect(panel.getByRole('button', { name: /Not registered 1/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Unused sticker 1/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Deleted 1/ })).toBeVisible();

  // Filter to what isn't registered.
  await panel.getByRole('button', { name: /Not registered 1/ }).click();
  await expect(panel.locator('.bulk-row')).toHaveCount(1);
  await expect(panel.locator('.bulk-row')).toContainText(MISSING);
  await panel.getByRole('button', { name: /Not registered 1/ }).click();

  // A new scan after a check is "new" until checked — only it is sent.
  await gun(VINS[2]);
  await expect(panel.getByRole('button', { name: 'Check 1 new' })).toBeVisible();
  const sent = page.waitForRequest((r) => r.url().includes('/api/items/check-vins'));
  await panel.getByRole('button', { name: 'Check 1 new' }).click();
  expect(JSON.parse((await sent).postData()).vins).toEqual([VINS[2]]);
  await expect(panel.getByRole('button', { name: /Registered 3/ })).toBeVisible();

  // A refresh keeps the mode, the list and the answers.
  await page.reload();
  await expect(page.locator('.bulk-check .bulk-row')).toHaveCount(6);
  await expect(page.locator('.bulk-check').getByRole('button', { name: /Registered 3/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bulk · check all' })).toHaveAttribute('aria-pressed', 'true');

  // A registered row opens the pair.
  await page.locator('.bulk-row').filter({ hasText: VINS[1] }).getByRole('button', { name: 'Details →' }).click();
  await expect(page.getByRole('button', { name: 'Back to list' })).toBeVisible({ timeout: 15000 });
});
