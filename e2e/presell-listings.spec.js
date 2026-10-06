// Pre-sell Listings (docs/context/presell-listings.md): pairs listed straight to Alias +
// StockX from a scan, with their own stock. This suite NEVER creates a real listing —
// every call it makes is refused before a marketplace is reached (validation, role) or
// only reads our own tables.
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv, loginAs } from './helpers/auth.js';

loadEnv();
const as = (role) => ({ Authorization: `Bearer ${signToken({ uid: `e2e-${role}`, username: `e2e-${role}`, name: `E2E ${role}`, role })}` });
const create = (request, role, data) => request.post('/api/presell-listings/create', { headers: as(role), data });
const line = (over = {}) => ({ sku: 'DO7189-101', size: '13', qty: 1, alias: { price: 170 }, ...over });

test('a bad cart is a 400 with a reason, before any marketplace is called', async ({ request }) => {
  expect((await create(request, 'warehouse', { activate: false, items: [] })).status()).toBe(400);
  const noPrice = await create(request, 'warehouse', { activate: false, items: [line({ alias: {} })] });
  expect(noPrice.status()).toBe(400);
  expect((await noPrice.json()).error).toContain('Alias price');
  const noPlatform = await create(request, 'ph_team', { activate: false, items: [line({ alias: null })] });
  expect(noPlatform.status()).toBe(400);
  expect((await noPlatform.json()).error).toContain('tick Alias, StockX or both');
  expect((await create(request, 'ph_team', { activate: false, items: [line({ size: '' })] })).status()).toBe(400);
  expect((await create(request, 'ph_team', { activate: false, items: [line({ qty: 51 })] })).status()).toBe(400);
  // 2 platforms × 50 pairs + 1 = 101 listings: over the cap.
  expect((await create(request, 'ph_team', { activate: false, items: [line({ qty: 50, stockx: { price: 1 } }), line({ size: '12', qty: 1 })] })).status()).toBe(400);
});

test('stock and listing actions refuse nonsense without reaching a marketplace', async ({ request }) => {
  const act = (data) => request.post('/api/presell-listings/action', { headers: as('warehouse'), data });
  expect((await act({ listingId: 999999999, action: 'update', price: 150 })).status()).toBe(404);
  expect((await act({ listingId: 'x', action: 'refresh' })).status()).toBe(400);
  expect((await act({ stockId: 999999999, action: 'qty', qty: 2 })).status()).toBe(404);
  expect((await request.post('/api/presell-listings/prices', { headers: as('warehouse'), data: { platform: 'stockx', sku: '', sizes: [] } })).status()).toBe(400);
});

test('suppliers can neither list, read nor manage', async ({ request }) => {
  expect((await create(request, 'supplier', { activate: false, items: [line()] })).status()).toBe(403);
  expect((await request.get('/api/presell-listings/list?tab=stock', { headers: as('supplier') })).status()).toBe(403);
  expect((await request.post('/api/presell-listings/action', { headers: as('supplier'), data: { listingId: 1, action: 'delete' } })).status()).toBe(403);
  expect((await request.post('/api/presell-listings/prices', { headers: as('supplier'), data: { platform: 'alias', sku: 'DO7189-101', sizes: ['13'] } })).status()).toBe(403);
});

test('the three read views answer from our own tables', async ({ request }) => {
  const h = { headers: as('ph_team') };
  const listings = await (await request.get('/api/presell-listings/list?tab=listings&view=live&platform=stockx', h)).json();
  expect(listings.counts).toEqual(expect.objectContaining({ all: expect.any(Number), live: expect.any(Number), sold: expect.any(Number) }));
  expect(listings.rows.every((x) => x.status === 'live' && x.platform === 'stockx')).toBeTruthy();
  expect(Array.isArray((await (await request.get('/api/presell-listings/list?tab=stock', h)).json()).rows)).toBeTruthy();
  expect(Array.isArray((await (await request.get('/api/presell-listings/list?tab=sales', h)).json()).rows)).toBeTruthy();
});

test('the page: PH opens it from home and every tab renders', async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await loginAs(page, 'ph_team');
  await page.goto('/ph');
  await page.getByRole('button', { name: /Pre-sell Listings/ }).click();
  await expect(page).toHaveURL(/\/ph\/presell-listings/);
  await expect(page.getByLabel('UPC or SKU')).toBeVisible();
  await page.getByRole('button', { name: 'Stock', exact: true }).click();
  await expect(page.getByLabel('Search pre-sell stock')).toBeVisible();
  await page.getByRole('button', { name: 'Listings', exact: true }).click();
  await expect(page.getByLabel('Search listings')).toBeVisible();
  await page.getByRole('button', { name: 'Sales', exact: true }).click();
  await expect(page.getByText(/No pre-sell sales yet|Sold/).first()).toBeVisible();
});
