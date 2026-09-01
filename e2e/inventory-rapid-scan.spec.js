// Inventory rapid scan: scanning builds a list instead of opening each pair.
//
// The job this exists for is walking a shelf with a gun, where the old flow was
// scan → read → Back → scan. So the assertions are about the loop STAYING on the list:
// three scans in a row must leave three rows and never navigate, and the session has to
// survive a trip into a pair's detail and back — the operator opens one pair to check
// something and would otherwise lose the whole walk.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import pg from 'pg';
import fs from 'node:fs';

for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let VINS = []; let STICKER = null;

test.beforeAll(async () => {
  VINS = (await pool.query(`SELECT vin FROM items WHERE vin IS NOT NULL ORDER BY id DESC LIMIT 3`)).rows.map((r) => r.vin);
  STICKER = (await pool.query(`SELECT vin FROM vin_stock WHERE status = 'available' LIMIT 1`)).rows[0]?.vin || null;
});
test.afterAll(() => pool.end());

async function openRapid(page) {
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const toggle = page.getByRole('button', { name: /Rapid scan/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(page.locator('.scan-session')).toBeVisible();
  return page.locator('.searchrow input');
}
const gun = async (page, input, code) => { await input.fill(code); await input.press('Enter'); };

test('three scans build three rows and never leave the list', async ({ page }) => {
  test.skip(VINS.length < 3, 'needs 3 VINs in the local DB');
  const input = await openRapid(page);
  for (const v of VINS) {
    await gun(page, input, v);
    await expect(page.locator('.scan-row', { hasText: v })).toBeVisible({ timeout: 15000 });
  }
  await expect(page.locator('.scan-row')).toHaveCount(3);
  await expect(page.locator('.scan-session-head b')).toHaveText('3 scanned');
  // never navigated: still in list mode, no detail view opened
  await expect(page.getByRole('button', { name: 'Back to list' })).toHaveCount(0);
  await expect(page.locator('.scan-session')).toBeVisible();
  // the box clears itself so the next gun scan doesn't append to the last code
  await expect(input).toHaveValue('');
  await expect(page.locator('.scan-row').first()).toContainText(VINS[2]); // newest first
  await page.locator('.scan-session').screenshot({ path: process.env.SP + '/rapid/session.png' });
});

test('re-scanning a pair bumps its count instead of stacking a duplicate row', async ({ page }) => {
  test.skip(!VINS.length, 'needs a VIN');
  const input = await openRapid(page);
  await gun(page, input, VINS[0]);
  await expect(page.locator('.scan-row')).toHaveCount(1);
  await gun(page, input, VINS[0]);
  await expect(page.locator('.scan-row')).toHaveCount(1);
  await expect(page.locator('.scan-row-seen')).toHaveText('scanned ×2');
});

test('the session survives opening a pair and coming back', async ({ page }) => {
  test.skip(VINS.length < 2, 'needs 2 VINs');
  const input = await openRapid(page);
  await gun(page, input, VINS[0]);
  await gun(page, input, VINS[1]);
  await expect(page.locator('.scan-row')).toHaveCount(2);
  await page.locator('.scan-row-main').first().click();
  const back = page.getByRole('button', { name: 'Back to list' });
  await expect(back).toBeVisible({ timeout: 15000 });   // the pair's full detail
  await expect(page.locator('.scan-session')).toHaveCount(0);
  await back.click();
  await expect(page.locator('.scan-row')).toHaveCount(2); // the walk is still there
});

test('an unused 1ID sticker answers in the row, not as an error', async ({ page }) => {
  test.skip(!STICKER, 'needs an available sticker in vin_stock');
  const input = await openRapid(page);
  await gun(page, input, STICKER);
  const row = page.locator('.scan-row', { hasText: STICKER });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row.locator('.sr-state')).toContainText('not used yet');
  await expect(row).not.toHaveClass(/bad/);
});

test('undo and clear', async ({ page }) => {
  test.skip(VINS.length < 2, 'needs 2 VINs');
  const input = await openRapid(page);
  await gun(page, input, VINS[0]);
  await gun(page, input, VINS[1]);
  await expect(page.locator('.scan-row')).toHaveCount(2);
  await page.getByRole('button', { name: /Undo last/ }).click();
  await expect(page.locator('.scan-row')).toHaveCount(1);
  await expect(page.locator('.scan-row').first()).toContainText(VINS[0]);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.scan-row')).toHaveCount(0);
});

test('with rapid scan OFF a scan still opens the pair', async ({ page }) => {
  test.skip(!VINS.length, 'needs a VIN');
  await loginAs(page, 'warehouse');
  await page.goto('/inventory');
  const toggle = page.getByRole('button', { name: /Rapid scan/ });
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  await expect(page.locator('.scan-session')).toHaveCount(0);
  const input = page.locator('.searchrow input');
  await input.fill(VINS[0]); await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Back to list' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.scan-session')).toHaveCount(0);
});
