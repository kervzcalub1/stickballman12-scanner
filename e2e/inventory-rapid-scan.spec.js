// Inventory rapid scan: scanning builds a list instead of opening each pair.
//
// The job this exists for is walking a shelf with a gun, where the old flow was
// scan → read → Back → scan. So the assertions are about the loop STAYING on the list:
// three scans in a row must leave three rows and never navigate, and the session has to
// survive a trip into a pair's detail and back — the operator opens one pair to check
// something and would otherwise lose the whole walk.
//
// Everything is SEEDED rather than read out of whatever the local DB happens to hold.
// The first cut of this spec queried for existing items and skipped when it found none,
// which meant it passed on CI's empty database by testing nothing at all.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js'; // also loads .env for DATABASE_URL (no-op on CI)
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-6);
// Must satisfy VIN_RE (/^SBM-(?:\d{6}-\d+|R-\d+)$/) — a code that only looks VIN-ish
// falls through to a text search and never reaches the scan list at all.
const VINS = [1, 2, 3].map((n) => `SBM-260902-${stamp.slice(-5)}${n}`);
const STICKER = `SBM-R-8977${stamp.slice(-2)}`; // minted, still on the roll
const MISSING = `SBM-260101-999${stamp.slice(-3)}`; // shaped like a VIN, no pair wears it
const RUN = 9997;
let batchId = null;

test.beforeAll(async () => {
  batchId = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name)
     VALUES ($1,'committed','receiving','E2E Rapid') RETURNING id`, [`B-RAPID-${stamp}`]))[0].id;
  for (let i = 0; i < VINS.length; i += 1) {
    await q(`INSERT INTO items (vin, batch_id, box_id, name, sku, size, status)
             VALUES ($1,$2,NULL,$3,'RS-1234-100',$4,'needs_shelf')`,
      [VINS[i], batchId, `E2E Rapid Shoe ${i + 1}`, String(9 + i)]);
  }
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await q(`INSERT INTO vin_stock (vin, run_id, printed_by) VALUES ($1,$2,'e2e')`, [STICKER, RUN]);
});

test.afterAll(async () => {
  await q('DELETE FROM items WHERE batch_id = $1', [batchId]);
  await q('DELETE FROM batches WHERE id = $1', [batchId]);
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await pool.end();
});

async function openRapid(page) {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const toggle = page.getByRole('button', { name: /Rapid scan/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(page.locator('.scan-session')).toBeVisible();
  return page.locator('.searchrow input').first();
}
// What a scanner gun does: type the code, press Enter.
const gun = async (input, code) => { await input.fill(code); await input.press('Enter'); };

test('three scans build three rows and never leave the list', async ({ page }) => {
  const input = await openRapid(page);
  for (const v of VINS) {
    await gun(input, v);
    await expect(page.locator('.scan-row', { hasText: v })).toBeVisible({ timeout: 15000 });
  }
  await expect(page.locator('.scan-row')).toHaveCount(3);
  await expect(page.locator('.scan-session-head b')).toHaveText('3 scanned');
  // never navigated: still in list mode, no detail view opened
  await expect(page.getByRole('button', { name: 'Back to list' })).toHaveCount(0);
  await expect(page.locator('.scan-session')).toBeVisible();
  // the box clears itself, or the next gun scan appends to the last code
  await expect(input).toHaveValue('');
  // newest first — the pair just scanned is under the operator's thumb
  await expect(page.locator('.scan-row').first()).toContainText(VINS[2]);
  await expect(page.locator('.scan-row').first()).toContainText('E2E Rapid Shoe 3');
});

test('re-scanning a pair bumps its count instead of stacking a duplicate row', async ({ page }) => {
  const input = await openRapid(page);
  await gun(input, VINS[0]);
  await expect(page.locator('.scan-row')).toHaveCount(1);
  await gun(input, VINS[0]);
  await expect(page.locator('.scan-row')).toHaveCount(1);
  await expect(page.locator('.scan-row-seen')).toHaveText('scanned ×2');
});

test('the session survives opening a pair and coming back', async ({ page }) => {
  const input = await openRapid(page);
  await gun(input, VINS[0]);
  await gun(input, VINS[1]);
  await expect(page.locator('.scan-row')).toHaveCount(2);
  await page.locator('.scan-row-main').first().click();
  // NOTE: the detail view has its own .searchrow (the custom-tag input), so "did it
  // navigate" has to key on Back to list — an input count passes for the wrong reason.
  const back = page.getByRole('button', { name: 'Back to list' });
  await expect(back).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.scan-session')).toHaveCount(0);
  await back.click();
  await expect(page.locator('.scan-row')).toHaveCount(2); // the walk is still there
});

test('an unused 1ID sticker answers in the row, not as an error', async ({ page }) => {
  const input = await openRapid(page);
  await gun(input, STICKER);
  const row = page.locator('.scan-row', { hasText: STICKER });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row.locator('.sr-state')).toContainText('not used yet');
  await expect(row).not.toHaveClass(/bad/);
});

test('a VIN no pair wears is a failed row, not a lost scan', async ({ page }) => {
  const input = await openRapid(page);
  await gun(input, MISSING);
  const row = page.locator('.scan-row', { hasText: MISSING });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toHaveClass(/bad/);
  await expect(page.locator('.scan-session')).toBeVisible(); // still scanning
});

test('undo and clear', async ({ page }) => {
  const input = await openRapid(page);
  await gun(input, VINS[0]);
  await gun(input, VINS[1]);
  await expect(page.locator('.scan-row')).toHaveCount(2);
  await page.getByRole('button', { name: /Undo last/ }).click();
  await expect(page.locator('.scan-row')).toHaveCount(1);
  await expect(page.locator('.scan-row').first()).toContainText(VINS[0]);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.scan-row')).toHaveCount(0);
});

test('with rapid scan OFF a scan still opens the pair', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const toggle = page.getByRole('button', { name: /Rapid scan/ });
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  await expect(page.locator('.scan-session')).toHaveCount(0);
  const input = page.locator('.searchrow input').first();
  await gun(input, VINS[0]);
  await expect(page.getByRole('button', { name: 'Back to list' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.scan-session')).toHaveCount(0);
});
