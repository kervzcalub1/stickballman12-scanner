// New Inventory's WAITLIST (docs/context/waitlist.md): a line — or some of its sizes — held
// out of listing until a date, then back on Pending by itself, with a daily CSV of what is
// on hold. From the 2026-10-09 pricing review (DZ2628-110 size 8: one $70 ask under a $76
// cost, next ask $133 — wait for it to sell instead of listing into it).
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { signToken } from '../api/_lib/util.js';
import { estToday } from '../src/lib/format.js';
import { unzipSync, strFromU8 } from 'fflate';
import { loginAs } from './helpers/auth.js';

const WH = { Authorization: `Bearer ${signToken({ uid: 'wl-wh', username: 'wl_wh', name: 'WL Warehouse', role: 'warehouse' })}` };
const PH = { Authorization: `Bearer ${signToken({ uid: 'wl-ph', username: 'wl_ph', name: 'WL PH', role: 'ph_team' })}` };
const ADMIN = { Authorization: `Bearer ${signToken({ uid: 'wl-ad', username: 'wl_ad', name: 'WL Admin', role: 'admin' })}` };
const SKU = 'QAWL-HOLD-1';

let db;
const batchCodes = [];
const vinsOf = async (size) => (await db.query(`SELECT vin FROM items WHERE sku = $1 AND size = $2 ORDER BY vin`, [SKU, size])).rows.map((r) => r.vin);

test.beforeAll(async ({ request }) => {
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const r = await request.post('/api/batches/commit', {
    headers: WH,
    data: {
      batch: { supplier: 'QAWL-Fixture', tracking: `${SKU}-${Date.now()}`, dateReceived: estToday(), manifestReceived: true },
      items: ['8', '8', '9'].map((size) => ({ name: `QAWL ${SKU}`, sku: SKU, size, cost: 76, withBox: true })),
    },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  batchCodes.push((await r.json()).batchCode);
});

test.afterAll(async () => {
  if (!db) return;
  await db.query(`DELETE FROM items WHERE sku LIKE 'QAWL-%'`);
  await db.query(`DELETE FROM batches WHERE batch_code = ANY($1)`, [batchCodes]).catch(() => {});
  await db.end();
});

test.describe.configure({ mode: 'serial' });

test('PH holds one size from its own ⏸ in the per-size detail: it moves to the Waitlist tab, the other size stays on Pending', async ({ page }) => {
  await page.route('**/api/payout/batch', (route) => route.fulfill({ json: { ok: true, quotes: {}, consigned: true } }));
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/new-inventory?q=${SKU}`);
  const row = page.locator('.ph-trow', { hasText: SKU });
  await expect(row).toHaveCount(1);
  await row.click();                                                   // open the per-size detail
  await page.locator('.ph-sizetable tr', { hasText: 'US 8' }).getByRole('button', { name: '⏸ Waitlist…' }).click();

  const modal = page.getByRole('dialog', { name: 'Put on the waitlist' });
  await expect(modal.locator('.waitlist-size')).toHaveCount(1);       // that size only — no picker
  await modal.getByRole('button', { name: '14 days' }).click();
  await modal.getByRole('textbox').fill('one $70 ask on size 8, next $133');
  await modal.getByRole('button', { name: 'Hold 2 pairs' }).click();
  await expect(page.locator('.notice')).toContainText('2 pairs on the waitlist until');

  // Pending keeps size 9 alone; the held size 8 is under ⏸ Waitlist with its date.
  await expect(page.locator('.ph-trow', { hasText: SKU })).toHaveCount(1);
  await page.getByRole('button', { name: /⏸ Waitlist/ }).first().click();   // the tab
  const held = page.locator('.ph-trow', { hasText: SKU }).filter({ has: page.locator('.waitlist-chip') });
  await expect(held).toHaveCount(1);
  await expect(held.locator('.waitlist-chip')).toContainText('14d');
  await expect(held.getByRole('button', { name: '▶ Release now' })).toBeVisible();
  await expect(held.getByRole('button', { name: 'Edit' })).toHaveCount(0);   // held = nothing to edit
});

test('a held pair cannot be listed: the grid save skips it', async ({ request }) => {
  const [v8] = await vinsOf('8');
  // A stale tab ticking Alias on a held pair: the server writes nothing to it.
  await request.post('/api/ph/update', { headers: PH, data: { sizes: [{ vins: [v8], fields: { synced_alias: true } }] } });
  const { rows } = await db.query(`SELECT synced_alias FROM items WHERE vin = $1`, [v8]);
  expect(rows[0].synced_alias).toBe(false);
});

test('the waitlist reads as one row per SKU + size, and as the daily Excel file', async ({ request }) => {
  const list = await (await request.get('/api/ph/waitlist', { headers: ADMIN })).json();
  const mine = list.rows.filter((r) => r.sku === SKU);
  expect(mine).toEqual([expect.objectContaining({ size: '8', qty: 2, note: 'one $70 ask on size 8, next $133', waitlisted_by: 'E2E PH' })]);

  // .xlsx, not CSV: a CSV can't carry column widths, so its long columns arrived squashed.
  const file = await request.get('/api/ph/waitlist?format=xlsx', { headers: ADMIN });
  expect(file.headers()['content-type']).toContain('spreadsheetml.sheet');
  expect(file.headers()['content-disposition']).toMatch(/waitlist-\d{4}-\d{2}-\d{2}\.xlsx/);
  const sheet = strFromU8(unzipSync(new Uint8Array(await file.body()))['xl/worksheets/sheet1.xml']);
  expect(sheet).toContain('<pane ySplit="1"');                  // header frozen
  expect(sheet).toMatch(/<col min="1" max="1" width="\d+" customWidth="1"\/>/);   // sized columns
  expect(sheet).toContain(`<t xml:space="preserve">${SKU}</t>`);
  expect(sheet).toContain('<t xml:space="preserve">On hold</t>');   // State
  expect(sheet).toMatch(/<c r="E\d+" s="3"><v>2<\/v><\/c>/);    // qty is a number
  expect(sheet).toMatch(/<c r="F\d+" s="2"><v>76<\/v><\/c>/);   // cost is money

  // Filtered by the day it was waitlisted (EST): today has it, yesterday doesn't.
  const today = estToday();
  const byDay = await (await request.get(`/api/ph/waitlist?from=${today}&to=${today}`, { headers: ADMIN })).json();
  expect(byDay.rows.filter((r) => r.sku === SKU)).toEqual([expect.objectContaining({ size: '8', qty: 2, state: 'On hold' })]);
  const past = await (await request.get('/api/ph/waitlist?from=2020-01-01&to=2020-01-02', { headers: ADMIN })).json();
  expect(past.rows.filter((r) => r.sku === SKU)).toHaveLength(0);
  const named = await request.get(`/api/ph/waitlist?format=xlsx&from=${today}&to=${today}`, { headers: ADMIN });
  expect(named.headers()['content-disposition']).toContain(`waitlist-held-${today}.xlsx`);

  // Only PH changes it — the review (admin) reads.
  const no = await request.post('/api/ph/waitlist', { headers: ADMIN, data: { action: 'release', vins: await vinsOf('8') } });
  expect(no.status()).toBe(403);
});

test('⬇ Waitlist (Excel) downloads by date: on hold now, or waitlisted between two days', async ({ page }) => {
  await page.route('**/api/payout/batch', (route) => route.fulfill({ json: { ok: true, quotes: {}, consigned: true } }));
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/new-inventory?q=${SKU}`);
  await page.getByRole('button', { name: '⬇ Waitlist (Excel)' }).click();
  const modal = page.getByRole('dialog', { name: 'Waitlist report' });
  await modal.getByRole('button', { name: 'Waitlisted between…' }).click();
  const today = estToday();
  await modal.getByLabel('From (EST)').fill(today);
  await modal.getByLabel('To (EST)').fill(today);
  const dl = page.waitForEvent('download');
  await modal.getByRole('button', { name: 'Download' }).click();
  expect((await dl).suggestedFilename()).toBe(`waitlist-held-${today}.xlsx`);
  // A range with nothing in it says so instead of handing over an empty file.
  await page.getByRole('button', { name: '⬇ Waitlist (Excel)' }).click();
  await modal.getByRole('button', { name: 'Waitlisted between…' }).click();
  await modal.getByLabel('From (EST)').fill('2020-01-01');
  await modal.getByLabel('To (EST)').fill('2020-01-02');
  await modal.getByRole('button', { name: 'Download' }).click();
  await expect(modal.locator('.error')).toContainText('Nothing was put on the waitlist in those dates');
});

test('its date passing puts it back on Pending by itself, and the heads-up is claimed once', async ({ page }) => {
  await db.query(`UPDATE items SET waitlist_until = now() - interval '1 minute' WHERE sku = $1 AND waitlist_until IS NOT NULL`, [SKU]);
  const { claimWaitlistReturns } = await import('../api/_lib/db.js');
  const first = (await claimWaitlistReturns()).filter((r) => r.sku === SKU);
  const second = (await claimWaitlistReturns()).filter((r) => r.sku === SKU);
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(0);

  await page.route('**/api/payout/batch', (route) => route.fulfill({ json: { ok: true, quotes: {}, consigned: true } }));
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/new-inventory?q=${SKU}`);
  // Pending again, with nothing held — both sizes back on one to-list row.
  await expect(page.locator('.ph-trow', { hasText: SKU })).toHaveCount(1);
  await expect(page.locator('.ph-trow', { hasText: SKU }).locator('.waitlist-chip')).toHaveCount(0);

  // A dated report still lists today's holds after they've come back, saying so.
  const today = estToday();
  const back = await (await page.request.get(`/api/ph/waitlist?from=${today}`, { headers: ADMIN })).json();
  expect(back.rows.filter((r) => r.sku === SKU)).toEqual([expect.objectContaining({ size: '8', state: 'Back on Pending' })]);
});

test('⏸ on the row holds the entire row', async ({ page }) => {
  await page.route('**/api/payout/batch', (route) => route.fulfill({ json: { ok: true, quotes: {}, consigned: true } }));
  await loginAs(page, 'ph_team');
  await page.goto(`/ph/new-inventory?q=${SKU}`);
  await page.locator('.ph-trow', { hasText: SKU }).getByRole('button', { name: '⏸ Waitlist…' }).click();
  const modal = page.getByRole('dialog', { name: 'Put on the waitlist' });
  await expect(modal).toContainText('Entire row — all 2 sizes');
  await modal.getByRole('button', { name: 'Hold 3 pairs' }).click();
  await expect(page.locator('.notice')).toContainText('3 pairs on the waitlist until');
  // Release just size 9 from the held row's per-size detail.
  await page.getByRole('button', { name: /⏸ Waitlist/ }).first().click();   // the tab
  await page.locator('.ph-trow', { hasText: SKU }).click();
  await page.locator('.ph-sizetable tr', { hasText: 'US 9' }).getByRole('button', { name: '▶ Release' }).click();
  await expect(page.locator('.notice')).toContainText('1 pair released');
  const { rows } = await db.query(`SELECT size, waitlist_until > now() AS held FROM items WHERE sku = $1 ORDER BY size`, [SKU]);
  expect(rows.map((r) => `${r.size}:${r.held}`)).toEqual(['8:true', '8:true', '9:false']);
  await db.query(`UPDATE items SET waitlist_until = now() - interval '1 minute', waitlist_alerted_at = now() WHERE sku = $1 AND waitlist_until > now()`, [SKU]);
});

test('Release now brings a held line straight back', async ({ request }) => {
  const vins = await vinsOf('9');
  const hold = await request.post('/api/ph/waitlist', { headers: PH, data: { action: 'hold', vins, days: 30 } });
  expect(hold.ok(), await hold.text()).toBeTruthy();
  expect((await hold.json()).held).toBe(1);
  const rel = await (await request.post('/api/ph/waitlist', { headers: PH, data: { action: 'release', vins } })).json();
  expect(rel.released).toBe(1);
  const { rows } = await db.query(`SELECT waitlist_until <= now() AS back FROM items WHERE vin = $1`, [vins[0]]);
  expect(rows[0].back).toBe(true);
});
