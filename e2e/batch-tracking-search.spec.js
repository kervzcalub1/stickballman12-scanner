// Finding a receiving batch by the number on the parcel — and the PH team's read-only
// view of the same page (2026-08-27).
//
// The fixture is its own: a batch with a batch-level number and two boxes with their
// own, plus an in-store batch that the PH team must never see. Hard-coding a number
// that happens to exist locally would pass here and fail in CI.
import { test, expect } from '@playwright/test';
import { loadEnv, loginAs } from './helpers/auth.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (text, values) => pool.query(text, values).then((r) => r.rows);

const stamp = `${Date.now()}`.slice(-8);
const BOX_TRACK = `1Z999AA10${stamp}`;      // the number on box 2 — what someone holds
const TAIL = BOX_TRACK.slice(-6);           // what they actually quote
const BATCH_TRACK = `E2ETRK-BATCH-${stamp}`;
let code = null;      // the receiving batch's code
let instoreCode = null;

test.beforeAll(async () => {
  const b = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, tracking_number)
     VALUES ($1,'open','receiving',$2,$3) RETURNING id, batch_code`,
    [`B-TRK-${stamp}`, 'E2E Tracking', BATCH_TRACK]))[0];
  code = b.batch_code;
  await q(`INSERT INTO batch_boxes (batch_id, box_number, tracking_number, status)
           VALUES ($1,1,$2,'received'), ($1,2,$3,'received')`,
    [b.id, `E2ETRK-BOX1-${stamp}`, BOX_TRACK]);
  // Kind the PH team must never be shown, carrying a number that WOULD match.
  const ins = (await q(
    `INSERT INTO batches (batch_code, status, kind, supplier_name, tracking_number)
     VALUES ($1,'closed','instore',$2,$3) RETURNING batch_code`,
    [`B-INS-${stamp}`, 'E2E In-store', `E2ETRK-INSTORE-${stamp}`]))[0];
  instoreCode = ins.batch_code;
});

test.afterAll(async () => {
  await q(`DELETE FROM batch_boxes WHERE batch_id IN (SELECT id FROM batches WHERE batch_code = ANY($1))`, [[code, instoreCode]]);
  await q(`DELETE FROM batches WHERE batch_code = ANY($1)`, [[code, instoreCode]]);
  await pool.end();
});

const search = async (page, text) => {
  await page.locator('.batch-search input').fill(text);
  await expect(page.locator('.batch-search input')).toHaveValue(text);
};

test('warehouse: a box tracking number finds its batch, and opens it', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await search(page, BOX_TRACK);
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
  await expect(page.locator('.batch-nav-row')).toContainText(code);
  // The number that matched is ON the row — otherwise the answer is "some batch",
  // not "this parcel's batch".
  await expect(page.locator('.batch-nav-track')).toContainText(BOX_TRACK);
  // It rides in ?q=, so a search is a link you can paste to whoever is asking.
  expect(page.url()).toContain('q=');
  await page.reload();
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
  await page.locator('.batch-nav-row').click();
  await expect(page.locator('.batch-page-code')).toContainText(code);
});

test('warehouse: the last six digits are enough, and punctuation does not matter', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await search(page, TAIL);
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
  // Pasted out of an email it arrives spaced; a scanner types it clean. One number.
  await search(page, `${BOX_TRACK.slice(0, 4)} ${BOX_TRACK.slice(4)}`.toLowerCase());
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
  await expect(page.locator('.batch-nav-row')).toContainText(code);
});

test('warehouse: the batch-level number and the batch code find it too', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await search(page, BATCH_TRACK);
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
  await search(page, code);
  await expect(page.locator('.batch-nav-row')).toContainText(code);
});

test('warehouse: a number nobody has says so, instead of falling back to the recent list', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/batches');
  await search(page, `NOSUCHPARCEL${stamp}`);
  await expect(page.getByText('No batch carries that number')).toBeVisible();
  await expect(page.locator('.batch-nav-row')).toHaveCount(0);
});

test('PH reaches Batches from their home, searches it, and opens one', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph');
  await page.getByText('Batches', { exact: true }).click();
  await expect(page).toHaveURL(/\/ph\/batches/);
  await search(page, TAIL);
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
  await page.locator('.batch-nav-row').click();
  await expect(page.locator('.batch-page-code')).toContainText(code);
  // What the page is FOR on this side: the boxes and what came in them.
  await expect(page.locator('.box-row')).toHaveCount(2);
});

test('PH_EXCLUDED_KINDS still holds: an in-store batch is invisible to PH, visible to warehouse', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?q=${instoreCode}`);
  await expect(page.locator('.batch-nav-row')).toContainText(instoreCode);

  await page.context().clearCookies();
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/batches?q=${instoreCode}`);
  await expect(page.getByText('No batch carries that number')).toBeVisible();
  await expect(page.locator('.batch-nav-row')).toHaveCount(0);
});

test('PH gets no way to change a batch — the buttons are not rendered', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/batches?q=${TAIL}`);
  await page.locator('.batch-nav-row').first().click();
  await expect(page.locator('.batch-page-code')).toBeVisible();
  for (const label of ['+ Add box', 'Finish batch', 'Reopen', 'Add items']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  }
  await expect(page.locator('.box-row-renum')).toHaveCount(0);
});

test('warehouse keeps every one of those buttons', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto(`/batches?q=${TAIL}`);
  await page.locator('.batch-nav-row').first().click();
  await expect(page.locator('.batch-page-code')).toBeVisible();
  await expect(page.locator('.box-row-renum').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Add box', exact: true }).first()).toBeVisible();
});

test('on a phone the row still fits — the tracking line truncates, it does not push the page sideways', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/batches?q=${TAIL}`);
  await expect(page.locator('.batch-nav-row')).toHaveCount(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
