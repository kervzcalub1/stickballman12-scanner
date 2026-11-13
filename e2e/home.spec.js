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

// 2026-11-13 regroup: tools by job, daily floor work first, and title-only cards.
// 2026-11-14: the sentence comes back on hover (a popup under the card) or for every card
// with the "Show descriptions" switch, remembered per browser (HomeTools.jsx).
test('warehouse home: tools grouped by job, title-only cards, sentence in the card on hover', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  const titles = (await page.locator('.home-sections .home-section-title').allTextContents());
  expect(titles).toEqual(['Receiving', 'Shelves & Stock', 'Boxes', 'Sell & Ship', 'On the Way', 'Buying & In-Store', 'Setup & Help']);
  const wrap = page.locator('.home-sections .home-card-wrap', { hasText: 'Receive New' });
  const receive = wrap.locator('.home-card');
  await expect(receive).toHaveAttribute('aria-description', 'Scan a new shipment into a batch');
  await expect(receive.locator('.home-card-sub')).toBeHidden();
  const tip = wrap.locator('.home-card-tip');
  await expect(tip).toBeHidden();
  await receive.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('Scan a new shipment into a batch');
  // Admin-only sections stay admin-only.
  await expect(page.locator('.home-section-title', { hasText: 'Administration' })).toHaveCount(0);
});

test('"Show descriptions" switch: every card shows its sentence, remembered after a reload', async ({ page }) => {
  await loginAs(page, 'warehouse');
  await page.goto('/');
  const sw = page.getByRole('switch', { name: 'Show descriptions' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  const sub = page.locator('.home-sections .home-card', { hasText: 'Receive New' }).locator('.home-card-sub');
  await expect(sub).toBeHidden();
  await page.getByText('Show descriptions', { exact: true }).click();   // the label works too
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(sub).toBeVisible();
  await expect(sub).toHaveText('Scan a new shipment into a batch');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Show descriptions' })).toHaveAttribute('aria-checked', 'true');
  await expect(sub).toBeVisible();
  await page.getByRole('switch', { name: 'Show descriptions' }).click();
  await expect(sub).toBeHidden();
});

test('phone: the ⓘ opens one card\'s sentence inside it; the card itself still navigates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'warehouse');
  await page.goto('/');
  const wrap = page.locator('.home-sections .home-card-wrap', { hasText: 'Receive New' });
  const info = wrap.getByRole('button', { name: 'Show what Receive New does' });
  const sub = wrap.locator('.home-card-sub');
  await expect(sub).toBeHidden();
  const box = await info.boundingBox();
  // 44px, give or take a subpixel (a loaded runner measured 43.99997).
  expect(box.width).toBeGreaterThanOrEqual(43.5); expect(box.height).toBeGreaterThanOrEqual(43.5);
  await info.click();
  await expect(sub).toBeVisible();
  await expect(sub).toHaveText('Scan a new shipment into a batch');
  await expect(page).toHaveURL(/\/$/);                                     // ⓘ didn't navigate
  await expect(wrap.getByRole('button', { name: 'Hide what Receive New does' })).toHaveAttribute('aria-expanded', 'true');
  // Only that card opened.
  await expect(page.locator('.home-sections .home-card-wrap', { hasText: 'Batches' }).locator('.home-card-sub')).toBeHidden();
  await wrap.getByRole('button', { name: 'Hide what Receive New does' }).click();
  await expect(sub).toBeHidden();
  // With every sentence already showing, the ⓘ goes away.
  await page.getByRole('switch', { name: 'Show descriptions' }).click();
  await expect(info).toBeHidden();
});

test('PH home has the same switch', async ({ page }) => {
  await loginAs(page, 'ph_team');
  await page.goto('/ph');
  await page.getByRole('switch', { name: 'Show descriptions' }).click();
  await expect(page.locator('.ph-home .home-card-sub').first()).toBeVisible();
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

test('phone: tool cards sit two to a row, no sideways scroll; one a row with descriptions on', async ({ page }) => {
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
  // A sentence doesn't fit a half-width tile, so with the switch on it's one card a row.
  await page.getByRole('switch', { name: 'Show descriptions' }).click();
  await expect(cards.nth(0).locator('.home-card-sub')).toBeVisible();
  const c = await cards.nth(0).boundingBox(); const d = await cards.nth(1).boundingBox();
  expect(d.y).toBeGreaterThan(c.y + c.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
