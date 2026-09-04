// Why a scan didn't land — and saying so.
//
// This file exists because of a real morning on the floor: scan-out "kept failing", and
// nothing in the system could say why. The reason for a failed scan lived in one tab in
// one browser and died with it, so the answer had to be reconstructed from a phone
// video and four tables of inference.
//
// The cause turned out to be ordinary and invisible: a box gets a sticker off the roll,
// the shoe is never received against it, and the sticker is real but has no pair behind
// it. Production had 344 such stickers, peeled out of the MIDDLE of worked rolls — which
// is why it looked random, and why a spot-test failed every time.
//
// So the tests below are about one thing: a failed scan must say what is actually wrong
// and what to do, and it must leave a record.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';

loadEnv();

// Real sticker states, seeded the way the warehouse produces them.
const LABELLED_NEVER_RECEIVED = 'SBM-R-990001'; // peeled onto a box, shoe never scanned in
const VOIDED = 'SBM-R-990002';
const NOT_OURS = 'SBM-R-990999';                // right shape, never printed
const RUN = 9901;

let pool;

test.beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`DELETE FROM vin_stock WHERE run_id = $1`, [RUN]);
  await pool.query(
    `INSERT INTO vin_stock (vin, run_id, printed_by, status) VALUES ($1,$3,'e2e','available'), ($2,$3,'e2e','void')`,
    [LABELLED_NEVER_RECEIVED, VOIDED, RUN],
  );
  await pool.query(`DELETE FROM scan_failures WHERE code LIKE 'SBM-R-99%' OR code = '012345678905'`);
});

test.afterAll(async () => {
  await pool.query(`DELETE FROM vin_stock WHERE run_id = $1`, [RUN]);
  await pool?.end();
});

async function asWarehouse(page) {
  const token = signToken({ uid: 'e2e-scan', username: 'e2e_scan', name: 'E2E Scanner', role: 'warehouse' });
  await page.addInitScript(([t, j]) => {
    sessionStorage.setItem('sb_session_token', t);
    sessionStorage.setItem('sb_user', j);
  }, [token, JSON.stringify({ username: 'e2e_scan', name: 'E2E Scanner', role: 'warehouse' })]);
}

// The banner clears itself after 1.6s, so a back-to-back scan can catch the previous
// one mid-fade and read empty. Wait for it to go before scanning, then wait for the new
// one to actually carry text.
async function scan(page, code) {
  await page.locator('.scan-flash').waitFor({ state: 'detached', timeout: 4000 }).catch(() => {});
  const box = page.locator('.card input').first();
  await box.fill(code);
  await box.press('Enter');
  const flash = page.locator('.scan-flash');
  await expect(flash).toBeVisible();
  await expect(flash).not.toHaveText('!', { timeout: 4000 });
  return flash.innerText();
}

test('a box labelled but never received says so, and says what to do', async ({ page }) => {
  await asWarehouse(page);
  await page.goto('/sold');
  const banner = await scan(page, LABELLED_NEVER_RECEIVED);
  // The old message here was "No item found for SBM-R-990001." — true, useless, and the
  // reason the floor concluded the app was broken.
  expect(banner).not.toContain('No item found');
  expect(banner).toContain('never received');
  expect(banner).toMatch(/Receiving/i);
  // It stays in the kept log, not just in a banner that the next scan overwrites.
  await expect(page.locator('.card').last()).toContainText(LABELLED_NEVER_RECEIVED);
});

test('a voided sticker and an unknown one get their own answers', async ({ page }) => {
  await asWarehouse(page);
  await page.goto('/sold');
  expect(await scan(page, VOIDED)).toMatch(/voided/i);
  expect(await scan(page, NOT_OURS)).toMatch(/not a sticker we printed/i);
});

test('every failed scan is recorded server-side, with its reason', async ({ page }) => {
  await asWarehouse(page);
  await page.goto('/sold');
  await scan(page, LABELLED_NEVER_RECEIVED);
  await scan(page, VOIDED);
  await scan(page, '012345678905');           // the manufacturer UPC
  await page.waitForTimeout(700);              // fire-and-forget by design

  const { rows } = await pool.query(
    `SELECT code, reason, screen FROM scan_failures
      WHERE code IN ($1,$2,'012345678905') ORDER BY id DESC LIMIT 3`,
    [LABELLED_NEVER_RECEIVED, VOIDED],
  );
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  // The reason is the sticker's real state, not a generic "not found" — that is what
  // makes "how often does this happen and to which boxes" a query.
  expect(byCode[LABELLED_NEVER_RECEIVED].reason).toBe('available');
  expect(byCode[VOIDED].reason).toBe('void');
  expect(byCode['012345678905'].reason).toBe('not_a_vin');
  expect(byCode[VOIDED].screen).toBe('mark-sold');
});

test('logging a failure can never break scanning', async ({ page }) => {
  await asWarehouse(page);
  // The recorder is dead; the scan still has to answer.
  await page.route('**/api/items/scan-failure', (r) => r.abort());
  await page.goto('/sold');
  const banner = await scan(page, LABELLED_NEVER_RECEIVED);
  expect(banner).toContain('never received');
});

test('a good VIN still scans straight onto the list', async ({ page }) => {
  const { rows } = await pool.query(
    `SELECT vin FROM items WHERE status NOT IN ('sold','shipped') ORDER BY id DESC LIMIT 1`,
  );
  test.skip(!rows.length, 'no scannable stock in this database');
  await asWarehouse(page);
  await page.goto('/sold');
  await scan(page, rows[0].vin);
  // The point of the whole change is that the good path is untouched.
  await expect(page.locator('.scan-flash--vin')).toBeVisible();
  await expect(page.locator('table')).toContainText(rows[0].vin);
});
