// eBay Listings → Reprice + Coupons (docs/context/ebay-api-reprice.md, ebay-coupons.md).
// What this pins:
//   · the coupon request: code rules, eBay's fixed $ amounts, 1 use per buyer, EST days →
//     UTC (start now+5 min when today, end 23:59:59 EST), photo forced to ≥500 px;
//   · Reprice: pick listings → market price → market + markup (whole dollars) sent to eBay,
//     both directions unless "Only lower"; a size without a Custom label can't be picked;
//   · Coupons: the running coupon shows its listings; a new one sends the picked listings.
// eBay is never called — the page's endpoints are mocked.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { buildCoupon, codeProblem, couponImage, estDayStart } from '../src/lib/ebayCoupons.js';

test.describe('coupon request', () => {
  const base = { name: 'Fall', description: '$10 off', code: 'SBMFALL26', amount: 10, perUser: 1, visibility: 'private',
    startYmd: '2026-10-13', endYmd: '2026-11-12', listingIds: ['111', '111', '222'], imageUrl: 'http://i.ebayimg.com/images/g/x/s-l140.jpg', todayYmd: '2026-10-13' };
  const now = new Date('2026-10-13T15:00:00Z');

  test('a $10, once-per-buyer, private coupon on the picked listings', () => {
    const { payload, error } = buildCoupon(base, now);
    expect(error).toBeUndefined();
    expect(payload).toMatchObject({
      promotionType: 'CODED_COUPON', promotionStatus: 'SCHEDULED', marketplaceId: 'EBAY_US',
      startDate: '2026-10-13T15:05:00Z',            // today → 5 minutes from now
      endDate: '2026-11-13T04:59:59Z',              // Nov 12 23:59:59 EST (after DST ends)
      promotionImageUrl: 'https://i.ebayimg.com/images/g/x/s-l1600.jpg',
      couponConfiguration: { couponCode: 'SBMFALL26', couponType: 'PRIVATE_SINGLE_SELLER_COUPON', maxCouponRedemptionPerUser: 1 },
      discountRules: [{ discountBenefit: { amountOffItem: { value: '10', currency: 'USD' } }, discountSpecification: { minQuantity: 1 } }],
      inventoryCriterion: { inventoryCriterionType: 'INVENTORY_BY_VALUE', listingIds: ['111', '222'] },
    });
    expect(payload.budget).toBeUndefined();
  });

  test('eBay’s limits are refused before eBay sees them', () => {
    expect(buildCoupon({ ...base, amount: 12 }, now).error).toMatch(/only \$5/);
    expect(buildCoupon({ ...base, perUser: 11 }, now).error).toMatch(/1–10/);
    expect(buildCoupon({ ...base, listingIds: [] }, now).error).toMatch(/at least one/);
    expect(buildCoupon({ ...base, endYmd: '2026-10-12' }, now).error).toMatch(/after the start/);
    expect(buildCoupon({ ...base, budget: '50' }, now).error).toMatch(/Budget/);
    expect(codeProblem('SHORT')).toMatch(/8–15/);
    expect(codeProblem('A-B-C-DEFGH')).toMatch(/two dashes/);
    expect(codeProblem('SBM-FALL-26')).toBeNull();
    expect(couponImage('https://i.ebayimg.com/images/g/x/s-l500.webp')).toBe('https://i.ebayimg.com/images/g/x/s-l1600.jpg');
    expect(estDayStart('2026-07-01').toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(estDayStart('2026-01-15').toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  test('a future start begins at that EST midnight', () => {
    const { payload } = buildCoupon({ ...base, startYmd: '2026-12-01', endYmd: '2026-12-31' }, now);
    expect(payload.startDate).toBe('2026-12-01T05:00:00Z');
    expect(payload.endDate).toBe('2027-01-01T04:59:59Z');
  });
});

const STATUS = { ok: true, configured: true, missing: [], secrets: true, connected: true, canMarket: true, user: 'stickballman12',
  pull: { state: 'done', listings: 2, rows: 4, inventoryItems: 0 } };
const row = (item, vk, sku, size, price, qty, extra = {}) => ({ item_id: item, variation_key: vk, title: item === '1' ? 'Nike Dunk Low (DD1391-100)' : 'Jordan 4 (FV5029-141)',
  style: item === '1' ? 'DD1391-100' : 'FV5029-141', item_sku: `P${item}`, sku, size, price, qty_available: qty, qty_sold: 0, listing_type: 'FixedPriceItem',
  image_url: 'https://i.ebayimg.com/images/g/x/s-l140.jpg', ...extra });
const ROWS = [
  row('1', 'a', '10077481', '10', '140.00', 2),     // market 100 → 112: down $28
  row('1', 'b', '10077482', '10.5', '100.00', 1),   // market 100 → 112: up $12
  row('1', 'US Shoe Size=11', null, '11', '120.00', 1),   // no Custom label → can't be repriced
  row('2', '', 'S2', '9', '220.00', 1),             // market 180 → 202: down $18
];
const MARKET = { 'DD1391-100|10': 10000, 'DD1391-100|10.5': 10000, 'DD1391-100|11': 10000, 'FV5029-141|9': 18000 };

async function mockEbay(page) {
  await page.route('**/api/ebay/status', (r) => r.fulfill({ json: STATUS }));
  await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: ROWS } }));
  await page.route('https://i.ebayimg.com/**', (r) => r.fulfill({ status: 404 }));
  await page.route('**/api/ebay-reprice/prices', (r) => {
    const { jobs } = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, results: jobs.map((j) => ({ ...j, status: 'ok', valueCents: MARKET[`${j.sku}|${j.size}`], rank: 1, label: 'GI' })) } });
  });
}

test.describe('eBay Reprice (API) tab', () => {
  test('select all → market prices → market + 12 % sent to eBay, both ways; Only lower keeps the raise', async ({ page }) => {
    await mockEbay(page);
    const sent = [];
    await page.route('**/api/ebay/reprice', (r) => {
      if (r.request().method() === 'GET') return r.fulfill({ json: { ok: true, edits: [] } });
      const b = r.request().postDataJSON(); sent.push(b);
      return r.fulfill({ json: { ok: true, results: b.changes.map((c) => ({ itemId: c.itemId, variationKey: c.variationKey, ok: true, price: Number(c.price) })) } });
    });
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/ebay-listings?tab=reprice');
    await expect(page.locator('.ebr-listing')).toHaveCount(2);
    await page.getByLabel(/Select all 3 sizes in view/).check();       // the label-less size isn't selectable
    await page.getByRole('button', { name: /Get market prices for the 3 picked sizes/ }).click();
    await expect(page.getByRole('button', { name: 'Reprice 3 on eBay' })).toBeEnabled();
    await expect(page.getByText('3 will change (2 down, 1 up)')).toBeVisible();

    await page.getByLabel('Only lower prices').check();
    await expect(page.getByRole('button', { name: 'Reprice 2 on eBay' })).toBeEnabled();
    await page.getByLabel('Only lower prices').uncheck();

    await page.locator('.ebr-main').first().click();   // open the Dunk's sizes
    await expect(page.locator('.ebr-size').filter({ hasText: 'No Custom label on eBay' }).locator('input')).toBeDisabled();

    await page.getByRole('button', { name: 'Reprice 3 on eBay' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reprice 3 on eBay' }).click();
    await expect(page.getByText('✓ Repriced on eBay')).toBeVisible();
    const changes = sent.flatMap((b) => b.changes).map((c) => [c.itemId, c.variationKey, c.price, c.marketCents, c.markupPct]);
    expect(changes.sort()).toEqual([
      ['1', 'a', '112.00', 10000, 12], ['1', 'b', '112.00', 10000, 12], ['2', '', '202.00', 18000, 12],
    ]);
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().right)}`));
    expect(wide).toEqual([]);
  });
});

test.describe('eBay Coupons tab', () => {
  test('lists the running coupon with its listings; a new one sends the picked listings, $10, once per buyer', async ({ page }) => {
    await mockEbay(page);
    const created = [];
    const COUPON = { promotionId: '9001', name: 'Fall sale', couponCode: 'SBMFALL26', promotionStatus: 'RUNNING', startDate: '2026-10-01T04:00:00Z', endDate: '2026-10-31T03:59:59Z',
      listingIds: ['1'], discountRules: [{ discountBenefit: { amountOffItem: { value: '10.0', currency: 'USD' } }, discountSpecification: { minQuantity: 1 } }],
      couponConfiguration: { couponCode: 'SBMFALL26', couponType: 'PRIVATE_SINGLE_SELLER_COUPON', maxCouponRedemptionPerUser: 1 } };
    await page.route('**/api/ebay/coupons', (r) => {
      if (r.request().method() === 'GET') return r.fulfill({ json: { ok: true, coupons: [COUPON], log: [], canMarket: true } });
      created.push(r.request().postDataJSON());
      return r.fulfill({ json: { ok: true, promotionId: '9002' } });
    });
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/ebay-listings?tab=coupons');
    const card = page.locator('.ebc-card').first();
    await expect(card).toContainText('SBMFALL26');
    await expect(card).toContainText('$10 off each item · 1 use per buyer · private');
    await card.locator('.ebc-head').click();
    await expect(card.locator('.ebc-li')).toHaveCount(1);
    await expect(card.locator('.ebc-li')).toContainText('Nike Dunk Low');

    await page.getByRole('button', { name: '＋ New coupon' }).click();
    await page.getByLabel('Coupon code').fill('SBM-TEST-01');
    await page.getByRole('button', { name: 'Not in a coupon' }).click();
    await expect(page.locator('.ebc-pick')).toHaveCount(1);              // the Dunk is already in SBMFALL26
    await page.getByLabel('Add Jordan 4 (FV5029-141)').check();
    await page.getByRole('button', { name: /Create coupon · \$10 off · 1 listing/ }).click();
    await expect.poll(() => created.length).toBe(1);
    expect(created[0]).toMatchObject({ action: 'create', coupon: { code: 'SBM-TEST-01', amount: 10, perUser: 1, visibility: 'private', listingIds: ['2'] } });
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 6).map((el) => `${el.tagName}.${el.className} ${Math.round(el.getBoundingClientRect().right)}`));
    expect(wide).toEqual([]);
  });

  test('approved before coupons existed: says Connect eBay again', async ({ page }) => {
    await mockEbay(page);
    await page.route('**/api/ebay/coupons', (r) => r.fulfill({ json: { ok: true, coupons: null, log: [], canMarket: false, error: 'eBay: Insufficient permissions', needsReconnect: true } }));
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=coupons');
    await expect(page.getByText('Coupons need one more eBay permission')).toBeVisible();
    await expect(page.getByRole('button', { name: '＋ New coupon' })).toBeDisabled();
  });
});
