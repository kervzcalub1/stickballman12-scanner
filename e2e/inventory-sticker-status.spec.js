// Inventory: "is this 1ID sticker used yet?"
//
// Scanning a pre-printed SBM-R-… sticker on the Inventory page used to answer
// "No item found for SBM-R-000123." for every sticker still on the roll — which is
// the normal case, not an error. vin_stock knows all four states, and each one has a
// different next action, so the page says which.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const RUN = 9998;
const FREE = 'SBM-R-899001';   // minted, still on the roll
const VOIDED = 'SBM-R-899002'; // torn/misprinted
const ORPHAN = 'SBM-R-899003'; // used, but the pair was later removed
const NEVER = 'SBM-R-899999';  // never minted — a real shape, not our stock

test.beforeAll(async () => {
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await q(`INSERT INTO vin_stock (vin, run_id, printed_by) VALUES ($1,$4,'e2e'), ($2,$4,'e2e'), ($3,$4,'e2e')`,
    [FREE, VOIDED, ORPHAN, RUN]);
  await q(`UPDATE vin_stock SET status='void', voided_at=now(), voided_by='e2e' WHERE vin=$1`, [VOIDED]);
  // assigned_item_id is deliberately NOT a FK: the pair can be deleted and the
  // sticker still existed. That is exactly the orphan state under test.
  await q(`UPDATE vin_stock SET status='assigned', assigned_item_id=987654321, assigned_at=now() WHERE vin=$1`, [ORPHAN]);
});
test.afterAll(async () => {
  await q('DELETE FROM vin_stock WHERE run_id = $1', [RUN]);
  await pool.end();
});

// Type the sticker into the one search box and submit it, the way a scanner gun does.
async function scan(page, vin) {
  await page.getByPlaceholder(/Scan a VIN or shelf/i).fill(vin);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  return page.locator('.sticker-result');
}

test.describe('Inventory · 1ID sticker status', () => {
  test('an unused sticker reads "Not used yet", with its print run', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    const card = await scan(page, FREE);
    await expect(card).toContainText(FREE);
    await expect(card.locator('.sr-state')).toHaveText('Not used yet');
    await expect(card).toContainText(/still on the roll/i);
    await expect(card).toContainText(String(RUN));
  });

  test('a voided sticker says so instead of reading as free', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    const card = await scan(page, VOIDED);
    await expect(card.locator('.sr-state')).toHaveText('Voided');
    await expect(card).toContainText(/never reused/i);
  });

  test('a sticker used on a since-removed pair still reads as spent', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    const card = await scan(page, ORPHAN);
    await expect(card.locator('.sr-state')).toHaveText('In use');
    await expect(card).toContainText(/removed from inventory/i);
  });

  test('a sticker we never printed is called out rather than treated as free stock', async ({ page }) => {
    await loginAs(page, 'warehouse');
    await page.goto('/inventory');
    const card = await scan(page, NEVER);
    await expect(card.locator('.sr-state')).toHaveText('Not one of ours');
  });

  test('PH team gets the same read-only answer', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph/inventory'); // PH gets the same page, read-only
    const card = await scan(page, FREE);
    await expect(card.locator('.sr-state')).toHaveText('Not used yet');
  });
});
