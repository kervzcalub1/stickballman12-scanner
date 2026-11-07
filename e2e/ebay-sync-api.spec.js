// eBay Sync endpoints against the real server and database, with nothing mocked but eBay's own
// status (no eBay account in tests). Proves the page and the API agree, and who may do what.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';

const token = (role) => signToken({ uid: `e2e-${role}`, username: `e2e_${role}`, name: `E2E ${role}`, role });
const auth = (role) => ({ headers: { Authorization: `Bearer ${token(role)}` } });
const READS = ['status', 'products?tab=needs_attention', 'listings?filter=all', 'inventory', 'profiles', 'log'];

test.describe('eBay Sync: real endpoints', () => {
  test('PH and admin read every section; warehouse and supplier cannot', async ({ request }) => {
    for (const path of READS) {
      for (const role of ['admin', 'ph_team']) {
        const r = await request.get(`/api/ebay-sync/${path}`, auth(role));
        expect(r.status(), `${role} ${path}`).toBe(200);
        expect((await r.json()).ok).toBe(true);
      }
      for (const role of ['warehouse', 'supplier']) {
        expect((await request.get(`/api/ebay-sync/${path}`, auth(role))).status(), `${role} ${path}`).toBe(403);
      }
      expect((await request.get(`/api/ebay-sync/${path}`)).status(), `anonymous ${path}`).toBe(401);
    }
  });

  test('a fresh install is in test mode, has the real profile, and has nothing about orders', async ({ request }) => {
    const st = await (await request.get('/api/ebay-sync/status', auth('admin'))).json();
    expect(Object.keys(st.settings.switches).sort()).toEqual(['content', 'create', 'end', 'price', 'stock']);
    expect(st.settings).not.toHaveProperty('orderBackstopMin');
    expect(st).not.toHaveProperty('ordersAppConfigured');
    expect(Object.keys(st.passes).sort()).toEqual(['content', 'create', 'queue', 'reconcile']);
    expect(st.handover.map((h) => h.key)).not.toContain('orders');
    const { profiles } = await (await request.get('/api/ebay-sync/profiles', auth('admin'))).json();
    const p = profiles.find((x) => x.is_default);
    expect(p.name).toBe('STICKBALLMAN12');
    expect(p.config).toMatchObject({ categoryId: '15709', conditionId: 1000, postalCode: '17545' });
  });

  test('only an admin changes anything, and a bad value is refused', async ({ request }) => {
    const before = (await (await request.get('/api/ebay-sync/status', auth('admin'))).json()).settings;
    expect((await request.post('/api/ebay-sync/settings', { ...auth('ph_team'), data: { kill: true } })).status()).toBe(403);
    expect((await request.post('/api/ebay-sync/run', { ...auth('ph_team'), data: { pass: 'reconcile' } })).status()).toBe(403);
    expect((await request.post('/api/ebay-sync/profiles', { ...auth('ph_team'), data: { name: 'x', config: {} } })).status()).toBe(403);
    const bad = await request.post('/api/ebay-sync/settings', { ...auth('admin'), data: { switches: { stock: 'banana' } } });
    const after = (await (await request.get('/api/ebay-sync/status', auth('admin'))).json()).settings;
    expect(after.switches.stock, `answered ${bad.status()}`).toBe(before.switches.stock);
    const killed = await request.post('/api/ebay-sync/settings', { ...auth('admin'), data: { kill: true } });
    expect((await killed.json()).settings.kill).toBe(true);
    await request.post('/api/ebay-sync/settings', { ...auth('admin'), data: { kill: before.kill } });
  });

  test('listing a product is refused while New listings is not live', async ({ request }) => {
    const r = await request.post('/api/ebay-sync/products', { ...auth('admin'), data: { productId: 'gid://shopify/Product/1', action: 'list' } });
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(String(j.error)).toMatch(/live|test|new listings/i);
  });

  test('the Sync tab renders from the real API on an empty database', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await loginAs(page, 'admin');
    await page.route('**/api/ebay/status', (route) => route.fulfill({ json: { ok: true, configured: true, connected: true, secrets: true, user: 'stickballman12', canOrders: true, canFinances: true, canMarket: true, pull: null } }));
    await page.route('**/api/ebay/pull', (route) => route.fulfill({ json: { ok: true, rows: [] } }));
    for (const s of ['overview', 'products', 'listings', 'inventory', 'profiles', 'settings']) {
      await page.goto(`/ebay?tab=sync&sync=${s}`);
      await expect(page.getByText('Could not load')).toHaveCount(0);
    }
    await page.goto('/ebay?tab=sync&sync=overview');
    await expect(page.getByText("Orders: DPL brings eBay orders into Shopify. This page doesn't touch orders.")).toBeVisible();
    expect(errors).toEqual([]);
  });
});
