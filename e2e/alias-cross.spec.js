// Alias Cross-Listing (docs/context/alias-cross-listing.md): one pair listed on Alias under
// several SKUs of the same shoe. This suite NEVER reaches Alias or Telegram: the rules are
// pure, the sale path runs against our own tables with the Alias calls faked, the endpoints
// are only asked things they refuse before a marketplace call, and the page's API is mocked.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';
import * as X from '../src/lib/crossListing.js';

loadEnv();
const as = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e-${role}`, name: `E2E ${role}`, role })}` });

test.describe('cross-listing rules', () => {
  test('no SKU may hold more listings than the pairs left — the newest come down', () => {
    const open = [1, 2, 3, 4, 5].flatMap((i) => [{ id: i, group_sku_id: 1 }, { id: 10 + i, group_sku_id: 2 }, { id: 20 + i, group_sku_id: 3 }]);
    // 5 pairs, one sold on SKU 1 (its listing is no longer open): 4 left.
    expect(X.takeDownPlan(4, open.filter((l) => l.id !== 1)).map((l) => l.id)).toEqual([15, 25]);
    expect(X.takeDownPlan(5, open)).toEqual([]);
    expect(X.takeDownPlan(0, open)).toHaveLength(15);
    expect(X.roomFor({ qty: 5, sold: 1 }, open.filter((l) => l.group_sku_id !== 3), 3)).toBe(4);
    expect(X.roomFor({ qty: 5, sold: 1 }, open, 2)).toBe(0);
  });

  test('money: Alias’s payout when given, else price − 9.9 %; net only with a cost', () => {
    expect(X.saleMoney({ price_cents: 20000, payout_cents: 17500, unit_cost: '120.50' })).toEqual({ price: 200, payout: 175, estimated: false, cost: 120.5, net: 54.5 });
    expect(X.saleMoney({ price_cents: 20000, payout_cents: null, unit_cost: null })).toMatchObject({ payout: 180.2, estimated: true, cost: null, net: null });
    expect(X.priceCents('150')).toBe(15000);
    for (const bad of ['', '0', 'abc', '100001']) expect(Number.isNaN(X.priceCents(bad))).toBe(true);
    expect(X.costValue('')).toBeNull();
    expect(X.costValue('89.999')).toBe(90);
    expect(['10', '3.5', '9.5', '4Y'].sort(X.bySize)).toEqual(['3.5', '4Y', '9.5', '10']);
  });
});

test('a sale on one SKU takes one listing down on each of the others, once', async () => {
  const db = await import('../api/_lib/db.js');
  const { topUpSku, handleCrossSale } = await import('../api/_lib/cross.js');
  const tag = `E2E-${Date.now()}`;
  let n = 0; const removedOnAlias = [];
  const io = {
    create: async ({ priceCents }) => ({ ok: true, external_id: `${tag}-${++n}`, price_cents: priceCents }),
    remove: async (id) => { removedOnAlias.push(id); return { ok: true }; },
  };
  const groupId = await db.createCrossGroup({ name: `${tag} Dunk Low Light Carbon`, skus: [
    { catalogId: `${tag}-a`, sku: 'AA1111-100', name: 'Dunk A', sizes: { 9: 9 } },
    { catalogId: `${tag}-b`, sku: 'BB2222-200', name: 'Dunk B', sizes: { 9: 9 } },
    { catalogId: `${tag}-c`, sku: 'CC3333-300', name: 'Dunk C', sizes: { 9: 9 } },
  ] }, 'e2e');
  try {
    const skus = await db.getCrossGroupSkus(groupId);
    const pool = await db.upsertCrossPool({ groupId, size: '9', addQty: 5, unitCost: 100 }, 'e2e');
    for (const [i, k] of skus.entries()) {
      expect(await topUpSku(pool, k, { sizeValue: 9, priceCents: (150 + i * 10) * 100, active: true }, 'e2e', io)).toMatchObject({ wanted: 5, created: 5 });
    }
    // Listing again adds nothing: every SKU already holds the 5 pairs.
    expect((await topUpSku(pool, skus[0], { sizeValue: 9, priceCents: 15000, active: true }, 'e2e', io)).wanted).toBe(0);
    expect(await db.crossHasOpenListings()).toBe(true);

    const open = await db.openCrossListings(pool.id);
    const soldOn = open.find((l) => l.sku === 'BB2222-200');
    const [listing] = await db.crossListingsByExternal([soldOn.external_id]);
    const posts = [];
    const sale = { listing, orderId: `${tag}-order-1`, priceCents: 16000, payoutCents: 14400, soldAt: new Date().toISOString(), raw: {} };
    const r = await handleCrossSale(sale, { io, notify: async (lines) => { posts.push(lines); } });
    expect(r.removed.map((x) => x.sku).sort()).toEqual(['AA1111-100', 'CC3333-300']);
    expect(removedOnAlias).toHaveLength(2);
    const after = await db.openCrossListings(pool.id);
    for (const sku of ['AA1111-100', 'BB2222-200', 'CC3333-300']) expect(after.filter((l) => l.sku === sku), sku).toHaveLength(4);
    expect(await db.getCrossPool(pool.id)).toMatchObject({ qty: 5, sold: 1 });
    const text = posts[0].map((l) => (typeof l === 'string' ? l : `${l.b}${l.t || ''}`)).join('\n');
    expect(text).toContain('Sold as BB2222-200 · size 9');
    expect(text).toContain('NET: $44');                       // payout 144 − cost 100
    expect(text).toContain('Pairs left: 4 of 5');
    expect(text).toContain('Taken down on the other SKUs');
    // The watcher sees the same order on every poll: it lands once.
    expect(await handleCrossSale(sale, { io, notify: async () => { throw new Error('posted twice'); } })).toBeNull();
    expect(await db.getCrossPool(pool.id)).toMatchObject({ sold: 1 });
    // Pairs can't be set below what sold.
    expect(await db.setCrossPool(pool.id, { qty: 0 }, 'e2e')).toBeNull();
  } finally {
    await db.deleteCrossGroup(groupId);
  }
});

test('a bad request is refused with a reason before Alias is called', async ({ request }) => {
  const create = (role, data) => request.post('/api/cross-listing/create', { headers: as(role), data });
  const two = [{ catalogId: 'a', sku: 'AA1111-100', sizes: [{ label: '9', value: 9 }] }, { catalogId: 'b', sku: 'BB2222-200', sizes: [{ label: '9', value: 9 }] }];
  const one = await create('ph_team', { name: 'X', skus: two.slice(0, 1), lines: [] });
  expect(one.status()).toBe(400);
  expect((await one.json()).error).toContain('at least 2 SKUs');
  expect((await (await create('ph_team', { skus: two, lines: [] })).json()).error).toContain('name');
  expect((await (await create('ph_team', { name: 'X', skus: two, lines: [] })).json()).error).toContain('at least one size');
  const onePriced = await create('warehouse', { name: 'X', skus: two, lines: [{ size: '9', qty: 2, skus: [{ catalogId: 'a', price: 150 }] }] });
  expect((await onePriced.json()).error).toContain('at least 2 SKUs');
  const badQty = await create('warehouse', { name: 'X', skus: two, lines: [{ size: '9', qty: 51, skus: [{ catalogId: 'a', price: 150 }, { catalogId: 'b', price: 160 }] }] });
  expect(badQty.status()).toBe(400);
  expect((await create('ph_team', { groupId: 999999999, lines: [] })).status()).toBe(404);
  expect((await create('supplier', { name: 'X', skus: two, lines: [] })).status()).toBe(403);
  expect((await request.get('/api/cross-listing/list', { headers: as('supplier') })).status()).toBe(403);
  expect((await request.get('/api/cross-listing/search?q=ab', { headers: as('ph_team') })).status()).toBe(400);
  expect((await request.post('/api/cross-listing/action', { headers: as('ph_team'), data: { action: 'qty', poolId: 999999999, qty: 1 } })).status()).toBe(404);
  // The Telegram chat: only an admin (or Check Access) may change it, and it must look like a chat id.
  expect((await request.post('/api/cross-listing/settings', { headers: as('ph_team'), data: { chatId: '-1001234567890' } })).status()).toBe(403);
  expect((await request.post('/api/cross-listing/settings', { headers: as('admin'), data: { chatId: 'my group' } })).status()).toBe(400);
  const list = await (await request.get('/api/cross-listing/list', { headers: as('ph_team') })).json();
  expect(list).toMatchObject({ ok: true, canSettings: false });
  expect(Array.isArray(list.groups)).toBe(true);
});

test('the page: search by name → tick the same shoe → sizes with each SKU’s market → list', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'ph_team');
  const sizes = [{ label: '9', value: 9 }, { label: '9.5', value: 9.5 }];
  const results = [
    { catalogId: 'cat-a', sku: 'HF3063-002', name: "Nike Dunk Low SB 'Light Carbon'", image: null, gender: 'men', released: '2024-10-03', sizes },
    { catalogId: 'cat-b', sku: 'FJ4188-100', name: "Nike Dunk Low SE 'Light Carbon'", image: null, gender: 'men', released: null, sizes: sizes.slice(0, 1) },
    { catalogId: 'cat-c', sku: 'HV4388-300', name: "Nike Wmns Dunk Low 'Crocodile'", image: null, gender: 'women', released: null, sizes },
  ];
  let sent = null;
  await page.route('**/api/cross-listing/list', (r) => r.fulfill({ json: { ok: true, groups: [], sales: [], chatSet: false, canSettings: false } }));
  await page.route('**/api/cross-listing/search**', (r) => r.fulfill({ json: { ok: true, results } }));
  await page.route('**/api/cross-listing/prices', (r) => {
    const { catalogId } = r.request().postDataJSON();
    const ask = catalogId === 'cat-a' ? 150 : 172;
    r.fulfill({ json: { ok: true, prices: { 9: { lowestListing: ask, lastSold: ask - 5 }, 9.5: { lowestListing: ask + 10, lastSold: null } } } });
  });
  await page.route('**/api/cross-listing/create', (r) => {
    sent = r.request().postDataJSON();
    r.fulfill({ json: { ok: true, groupId: 7, created: 4, failed: 0, lines: [{ size: '9', poolId: 1, skus: [{ sku: 'HF3063-002', wanted: 2, created: 2, errors: [] }, { sku: 'FJ4188-100', wanted: 2, created: 2, errors: [] }] }] } });
  });
  await page.goto('/ph');
  await page.getByRole('button', { name: /Alias Cross-Listing/ }).click();
  await expect(page).toHaveURL(/\/ph\/alias-cross/);
  await expect(page.getByText('No Telegram chat is set')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);

  await page.getByLabel('Shoe name or SKU').fill('Nike Dunk Low Light Carbon');
  await page.getByRole('button', { name: 'Search Alias' }).click();
  await page.getByRole('button', { name: /HF3063-002/ }).click();
  await expect(page.getByRole('button', { name: 'Next: sizes and prices' })).toBeDisabled();   // one SKU is a normal listing
  await page.getByRole('button', { name: /FJ4188-100/ }).click();
  await page.getByRole('button', { name: 'Next: sizes and prices' }).click();

  await expect(page.getByRole('button', { name: 'ask $172' })).toBeVisible();
  await expect(page.getByText('not made')).toBeVisible();          // FJ4188-100 has no 9.5
  await page.getByLabel('Pairs, size 9', { exact: true }).fill('2');
  await page.getByLabel('Cost, size 9', { exact: true }).fill('110');
  await expect(page.getByText('Size 9: give at least 2 SKUs a price.')).toBeVisible();
  await page.getByRole('button', { name: 'Price blanks at the lowest ask' }).click();
  await expect(page.getByLabel('HF3063-002 price, size 9', { exact: true })).toHaveValue('150');
  await page.getByLabel('FJ4188-100 price, size 9', { exact: true }).fill('169');
  await expect(page.getByText('2 pairs → 4 Alias listings')).toBeVisible();
  await page.getByRole('button', { name: 'List on Alias (4)' }).click();
  await expect(page.getByText('HF3063-002 2/2 listed')).toBeVisible();
  expect(sent).toMatchObject({ name: "Nike Dunk Low SB 'Light Carbon'", activate: true,
    lines: [{ size: '9', qty: 2, cost: '110', skus: [{ catalogId: 'cat-a', price: '150' }, { catalogId: 'cat-b', price: '169' }] }] });
  expect(sent.skus.map((k) => k.sku)).toEqual(['HF3063-002', 'FJ4188-100']);
  // The size that went through is cleared, so a second press can't add its pairs again.
  await expect(page.getByLabel('Pairs, size 9', { exact: true })).toHaveValue('');

  // Phone width: the page itself never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
