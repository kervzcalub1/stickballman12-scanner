// Home dashboard: the find box, the daily-job shortcuts, and who is shown which
// "Needs attention" tiles (src/screens/Home.jsx, HOME_ATTENTION in src/lib/constants.js).
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
const admin = () => ({ Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` });

test('the find box searches the WHOLE inventory, not just this week', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  await page.locator('#home-find').fill('CT4838');
  await page.locator('.home-find button[type="submit"]').click();
  await expect(page).toHaveURL(/\/inventory\?.*q=CT4838/);
  // No date window in the URL: Inventory reads that as "everything", the same thing its
  // own search box does. A default week here was the bug this guards.
  const url = new URL(page.url());
  expect(url.searchParams.get('from')).toBeNull();
  expect(url.searchParams.get('to')).toBeNull();
  await expect(page.locator('input[placeholder^="Scan a VIN or shelf"]')).toHaveValue('CT4838');
});

test('a VIN typed into the find box opens that pair', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  await page.locator('#home-find').fill('SBM-260101-000001');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/inventory\?.*vin=SBM-260101-000001/);
});

test('the daily-job shortcuts open their screens', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  await page.locator('.home-quick-btn', { hasText: 'Mark sold' }).click();
  await expect(page).toHaveURL(/\/sold/);
});

test('buying tiles are drawn only for someone who holds that duty', async ({ page, request }) => {
  const counts = (await (await request.get('/api/items/pending-counts', { headers: admin() })).json()).counts;
  test.skip(!(counts.carts_to_approve > 0 || counts.carts_to_audit > 0), 'no buying requests waiting in this database');
  // A warehouse account with no privileges: the counts are global, but the tiles are not
  // its work and the screen behind them refuses it.
  await loginAs(page, 'warehouse');
  await page.goto('/');
  await expect(page.locator('.home-quick-btn').first()).toBeVisible();
  await expect(page.locator('.home-attention', { hasText: 'Buying requests to approve' })).toHaveCount(0);
  await expect(page.locator('.home-attention', { hasText: 'Spend to audit' })).toHaveCount(0);
});

test('admin sees the buying tiles when something is waiting', async ({ page, request }) => {
  const counts = (await (await request.get('/api/items/pending-counts', { headers: admin() })).json()).counts;
  test.skip(!(counts.carts_to_approve > 0), 'no buying requests waiting in this database');
  await loginAs(page, 'admin');
  await page.goto('/');
  await expect(page.locator('.home-attention', { hasText: 'Buying requests to approve' })).toBeVisible();
});

// 2026-11-13 regroup: tools by job, daily floor work first, and title-only cards (the
// sentence is the hover text). Guards the order and that no tool card shows its sentence.
test('warehouse home: tools grouped by job, title-only cards with the sentence as hover text', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  const titles = (await page.locator('.home-sections .home-section-title').allTextContents());
  expect(titles).toEqual(['Receiving', 'Shelves & Stock', 'Boxes', 'Sell & Ship', 'On the Way', 'Buying & In-Store', 'Setup & Help']);
  const receive = page.locator('.home-sections .home-card', { hasText: 'Receive New' });
  await expect(receive).toHaveAttribute('title', 'Scan a new shipment into a batch');
  await expect(receive.locator('.home-card-sub')).toBeHidden();
  // Admin-only sections stay admin-only.
  await expect(page.locator('.home-section-title', { hasText: 'Administration' })).toHaveCount(0);
});

test('admin home: Marketplaces + Administration, every card still there', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/');
  const titles = (await page.locator('.home-sections .home-section-title').allTextContents());
  expect(titles).toEqual(['Receiving', 'Shelves & Stock', 'Boxes', 'Sell & Ship', 'On the Way', 'Buying & In-Store', 'Marketplaces', 'Administration', 'Setup & Help']);
  for (const t of ['Settings', 'Check Access', 'StockX Listings', 'Buying Requests', 'Duplicate Tracking', 'Count Existing Stock']) {
    await expect(page.locator('.home-sections .home-card-title', { hasText: new RegExp(`^${t}$`) })).toBeVisible();
  }
});

test('phone: tool cards sit two to a row, no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await loginAs(page, 'warehouse');
  await page.goto('/');
  const cards = page.locator('.home-sections .home-card');
  await expect(cards.nth(1)).toBeVisible();
  // Compare x, not y: the sections slide in (rise-in) and the strips above them load late,
  // so a y measured mid-render drifts; side by side means the second card starts right of
  // the first one's middle.
  const a = await cards.nth(0).boundingBox(); const b = await cards.nth(1).boundingBox();
  expect(b.x).toBeGreaterThan(a.x + a.width / 2);
  expect(a.width).toBeLessThan(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
