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

    await page.getByRole('button', { name: 'Only lower' }).click();
    await expect(page.getByRole('button', { name: 'Reprice 2 on eBay' })).toBeEnabled();
    // Only raise: mark up what's under market + markup, never cut (the $100 → $112 one).
    await page.getByRole('button', { name: 'Only raise' }).click();
    await expect(page.getByRole('button', { name: 'Reprice 1 on eBay' })).toBeEnabled();
    await expect(page.getByText('1 will change (0 down, 1 up)')).toBeVisible();
    await page.getByRole('button', { name: 'Both ways' }).click();

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

// 🔒 KEEP PRICE (docs/context/ebay-api-reprice.md "Locks", 2026-11-03): the exceptions —
// "listed at 120, market 60: keep the 120" — never in a run, whatever the mode.
test.describe('Keep price locks', () => {
  test('a locked listing can’t be picked, says why, and is left out of the run', async ({ page }) => {
    await mockEbay(page);
    const locked = ROWS.map((r) => (r.item_id === '2' ? { ...r, locked: true, lock_note: 'holding at 220', locked_by: 'PH' } : r));
    await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: locked } }));
    await page.route('**/api/ebay/reprice', (r) => r.fulfill({ json: { ok: true, edits: [] } }));
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=reprice');
    await expect(page.locator('.ebr-listing.locked')).toContainText('🔒 Keep price');
    await expect(page.locator('.ebr-listing.locked')).toContainText('“holding at 220”');
    await page.getByLabel(/Select all 2 sizes in view/).check();          // the Jordan's size isn't selectable
    await page.getByRole('button', { name: /Get market prices for the 2 picked sizes/ }).click();
    await expect(page.getByRole('button', { name: 'Reprice 2 on eBay' })).toBeEnabled();
    await page.getByLabel(/Locked only/).check();
    await expect(page.locator('.ebr-listing')).toHaveCount(1);
    await page.locator('.ebr-listing.locked .ebr-main').click();
    await expect(page.locator('.ebr-size').first()).toContainText('🔒 Kept — Keep price is on');
    await expect(page.locator('.ebr-size input').first()).toBeDisabled();
  });

  test('🔒 Keep asks why and sends the lock; Unlock sends the unlock', async ({ page }) => {
    await mockEbay(page);
    const calls = [];
    await page.route('**/api/ebay/lock', (r) => { calls.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); });
    await page.route('**/api/ebay/reprice', (r) => r.fulfill({ json: { ok: true, edits: [] } }));
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=reprice');
    await page.getByRole('button', { name: /Lock Jordan 4/ }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('rare — keep at 220');
    await page.getByRole('dialog').getByRole('button', { name: '🔒 Keep price' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ itemId: '2', lock: true, note: 'rare — keep at 220' });
  });

  // "Too many to mark as keep" (2026-11-03): find the exceptions with a filter, keep them all at once.
  test('would-drop and price filters find the exceptions; Keep all locks every listing in view', async ({ page }) => {
    await mockEbay(page);
    const calls = [];
    await page.route('**/api/ebay/lock', (r) => { calls.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true, count: 1 } }); });
    await page.route('**/api/ebay/reprice', (r) => r.fulfill({ json: { ok: true, edits: [] } }));
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=reprice');
    await page.getByRole('button', { name: /Get market prices for \d+ sizes? in view/ }).click();
    await expect(page.getByRole('button', { name: /Get market prices/ })).toHaveCount(0);
    // Dunk size 10: $140 → $112 is a 20 % cut; Jordan $220 → $202 only 8 %.
    await page.getByLabel('Would drop by at least percent').fill('15');
    await expect(page.locator('.ebr-listing')).toHaveCount(1);
    await expect(page.locator('.ebr-listing')).toContainText('Nike Dunk Low');
    await page.getByLabel('Would drop by at least percent').fill('');
    await page.getByLabel('Price from').fill('200');
    await expect(page.locator('.ebr-listing')).toHaveCount(1);
    await expect(page.locator('.ebr-listing')).toContainText('Jordan 4');
    await page.getByRole('button', { name: /Keep all 1 listing in view/ }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('above market on purpose');
    await page.getByRole('dialog').getByRole('button', { name: '🔒 Keep 1' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ itemIds: ['2'], lock: true, note: 'above market on purpose' });
  });

  test('the server refuses a locked listing even when the screen sends it', async () => {
    const { default: pg } = await import('pg');
    const { Readable } = await import('node:stream');
    const { signToken } = await import('../api/_lib/util.js');
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
    const ITEM = `99${Date.now() % 1e9}`;
    Object.assign(process.env, { EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID || 'x', EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET || 'x', EBAY_RUNAME: process.env.EBAY_RUNAME || 'x' });
    try {
      await db.query(`INSERT INTO ebay_listings (item_id, variation_key, title, sku, size, price, listing_type) VALUES ($1, '', 'E2E lock', 'S', '9', 120, 'FixedPriceItem')`, [ITEM]);
      const { default: lock } = await import('../api/ebay/lock.js');
      const { default: reprice } = await import('../api/ebay/reprice.js');
      const token = signToken({ uid: 'lk', username: 'lk', name: 'Lock Tester', role: 'ph_team' });
      const call = (handler, body) => new Promise((resolve) => {
        const req = Readable.from([Buffer.from(JSON.stringify(body))]);
        Object.assign(req, { method: 'POST', url: '/x', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, socket: { remoteAddress: `10.9.${Date.now() % 250}.1` } });
        const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, end(p) { resolve({ status: this.statusCode, body: JSON.parse(p) }); } };
        handler(req, res);
      });
      const l = await call(lock, { itemId: ITEM, lock: true, note: 'keep 120' });
      expect(l.status).toBe(200);
      expect(l.body.lock).toMatchObject({ item_id: ITEM, note: 'keep 120', locked_by: 'Lock Tester' });
      const r = await call(reprice, { changes: [{ itemId: ITEM, variationKey: '', price: 72 }] });
      expect(r.status).toBe(200);
      expect(r.body.results[0]).toMatchObject({ ok: false, skipped: true });
      expect(r.body.results[0].error).toMatch(/Locked/);
      expect((await db.query(`SELECT price FROM ebay_listings WHERE item_id = $1`, [ITEM])).rows[0].price).toBe('120.00');
      const u = await call(lock, { itemId: ITEM, lock: false });
      expect(u.body.unlocked).toBe(true);
      // Many at once: lock, then unlock, a list.
      const many = await call(lock, { itemIds: [ITEM], lock: true, note: 'bulk' });
      expect(many.body).toMatchObject({ ok: true, count: 1 });
      expect((await db.query(`SELECT note FROM ebay_price_locks WHERE item_id = $1`, [ITEM])).rows[0].note).toBe('bulk');
      const off = await call(lock, { itemIds: [ITEM], lock: false });
      expect(off.body.count).toBe(1);
    } finally {
      await db.query(`DELETE FROM ebay_price_locks WHERE item_id = $1`, [ITEM]);
      await db.query(`DELETE FROM ebay_listings WHERE item_id = $1`, [ITEM]);
      await db.end();
    }
  });
});
