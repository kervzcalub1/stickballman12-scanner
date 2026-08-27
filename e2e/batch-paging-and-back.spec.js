// Paging the batch lists, and what the Back button does on this page (2026-08-27).
//
// The Back complaint that prompted this: searching, or opening a batch, and then pressing
// Back walked out to the home page. Both are now URL state — ?q= and ?b= — and opening a
// batch (or starting a search) pushes ONE history entry, so Back undoes that step instead
// of leaving the page.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const TRACK = `E2EPAGE-${stamp}`;
let code = null;

// A pager only exists when there is more than one page — by design, since a pager under
// a list of six is furniture. So this spec SEEDS its volume instead of assuming the
// database has any: the first version leaned on a developer machine with 466 batches and
// failed in CI, where there are barely two dozen. Enough for two pages of each list.
const SEED = 30;

test.beforeAll(async () => {
  // One committed batch we can find by name, so the Back tests don't depend on whatever
  // else is in the database.
  const b = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, tracking_number)
     VALUES ($1,'committed','receiving',$2,$3) RETURNING batch_code`,
    [`B-PAGE-${stamp}`, 'E2E Paging', TRACK]))[0];
  code = b.batch_code;
  // …and enough of both kinds to force a second page in the Recent card, the Open card
  // and Receiving's Recent tab. Newest-first ordering puts these at the top, so page 1
  // is this spec's own data whatever else is in the table.
  for (let i = 0; i < SEED; i += 1) {
    await q(`INSERT INTO batches (batch_code, status, kind, supplier_name)
             VALUES ($1,'committed','receiving',$2)`, [`B-PGC-${stamp}-${i}`, `E2E Closed ${i}`]);
    await q(`INSERT INTO batches (batch_code, status, kind, supplier_name)
             VALUES ($1,'open','receiving',$2)`, [`B-PGO-${stamp}-${i}`, `E2E Open ${i}`]);
  }
});
test.afterAll(async () => {
  await q(`DELETE FROM batches WHERE batch_code = $1 OR batch_code LIKE $2 OR batch_code LIKE $3`,
    [code, `B-PGC-${stamp}-%`, `B-PGO-${stamp}-%`]);
  await pool.end();
});

const rows = (page) => page.locator('.batch-nav-row');
// The page has two lists. "Recent" is the paged-by-the-server one, and its rows are the
// ones a Next click moves — the open list above it has its own pager and its own rows.
const recentCard = (page) => page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Recent batches' }) });
const recentRows = (page) => recentCard(page).locator('.batch-nav-row');

test('the recent list is paged, and the page is in the URL', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  const pager = recentCard(page).locator('.batch-pager');
  await expect(pager).toBeVisible();
  // "26–50 of N" — the total is the number people check against, not just a page number.
  await expect(pager.locator('.batch-pager-at')).toContainText('of');
  await expect(recentRows(page)).toHaveCount(25);
  const firstOnPage1 = await recentRows(page).first().textContent();

  await pager.getByRole('button', { name: /Next/ }).click();
  await expect(page).toHaveURL(/[?&]p=2/);
  await expect(recentRows(page).first()).not.toHaveText(firstOnPage1 || '');
  // Page 2 STARTS at 26. Where it ends depends on how many batches exist, so asserting
  // "26–50" would only hold on a database that happens to be big enough.
  await expect(pager.locator('.batch-pager-at')).toContainText(/26–\d+ of \d+ batches/);

  // A page survives a refresh, so a link to it is a link to what you were looking at.
  await page.reload();
  await expect(page).toHaveURL(/[?&]p=2/);
  await expect(recentCard(page).locator('.batch-pager-at')).toContainText(/26–\d+ of/);

  await recentCard(page).locator('.batch-pager').getByRole('button', { name: /Prev/ }).click();
  await expect(recentRows(page).first()).toHaveText(firstOnPage1 || '');
});

test('the open list is paged separately, on its own ?op=', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  const openCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: /^Open batches/ }) });
  const pager = openCard.locator('.batch-pager');
  await expect(pager.locator('.batch-pager-at')).toContainText('open');
  const first = await openCard.locator('.batch-nav-row').first().textContent();
  await pager.getByRole('button', { name: /Next/ }).click();
  await expect(page).toHaveURL(/[?&]op=2/);
  await expect(openCard.locator('.batch-nav-row').first()).not.toHaveText(first || '');
  // Two lists, two pagers, and moving one leaves the other where it was.
  await expect(page).not.toHaveURL(/[?&]p=2/);
});

test('no page is a lie: paging past the end says so instead of "no batches"', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches?p=9999');
  await expect(page.getByText('Nothing on page 9999')).toBeVisible();
  await page.getByRole('button', { name: 'Back to the first page' }).click();
  await expect(rows(page).first()).toBeVisible();
});

test('Back closes an opened batch and returns to the list — not to the home page', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  await page.goto('/batches');
  await rows(page).first().click();
  await expect(page.locator('.batch-page-code')).toBeVisible();
  await expect(page).toHaveURL(/[?&]b=\d+/);

  await page.goBack();
  await expect(page).toHaveURL(/\/batches/);
  await expect(page.locator('.batch-page-code')).toHaveCount(0);
  await expect(rows(page).first()).toBeVisible();
});

test('Back from a batch keeps the search that found it', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await page.locator('.batch-search input').fill(TRACK);
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().click();
  await expect(page.locator('.batch-page-code')).toContainText(code);

  await page.goBack();
  // The number is still in the box — being sent back to an unfiltered list would mean
  // typing it again.
  await expect(page.locator('.batch-search input')).toHaveValue(TRACK);
  await expect(rows(page)).toHaveCount(1);
});

test('Back from a search clears it and stays on the page; Back again leaves', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  await page.goto('/batches');
  await page.locator('.batch-search input').fill(TRACK);
  await expect(rows(page)).toHaveCount(1);

  await page.goBack();
  await expect(page).toHaveURL(/\/batches/);
  await expect(page.locator('.batch-search input')).toHaveValue('');
  // Only ONE entry for a search, however many keystrokes it took.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/batches/);
});

test('the in-page “← Batches” button also lands on the list, once', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await rows(page).first().click();
  await expect(page.locator('.batch-page-code')).toBeVisible();
  await page.getByRole('button', { name: '← Batches' }).click();
  await expect(rows(page).first()).toBeVisible();
  // It undid its own history entry, so Back now leaves the page rather than replaying
  // the batch that was just closed.
  await page.goBack();
  await expect(page.locator('.batch-page-code')).toHaveCount(0);
});

test('PH gets the same paging and the same Back', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph');
  await page.getByText('Batches', { exact: true }).click();
  await expect(page).toHaveURL(/\/ph\/batches/);
  await expect(page.locator('.batch-pager').last()).toBeVisible();

  await rows(page).first().click();
  await expect(page.locator('.batch-page-code')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/ph\/batches/);
  await expect(page.locator('.batch-page-code')).toHaveCount(0);
  await expect(rows(page).first()).toBeVisible();
});

test("Receiving's Recent tab is paged too — it no longer just stops at 25", async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/receiving');
  await page.getByRole('button', { name: 'Recent', exact: true }).click();
  const pager = page.locator('.batch-pager');
  await expect(pager).toBeVisible();
  const firstBefore = await page.locator('.batch-list > *').first().textContent();
  await pager.getByRole('button', { name: /Next/ }).click();
  await expect(page.locator('.batch-list > *').first()).not.toHaveText(firstBefore || '');
  // It is a panel inside the wizard, not a page you link to — its page stays out of the URL.
  await expect(page).not.toHaveURL(/p=2/);
});
