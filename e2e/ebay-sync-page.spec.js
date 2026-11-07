// eBay Sync page (docs/ebay-sync-plan.md): every /api/ebay-sync/* call is mocked, so neither
// eBay nor Shopify is ever reached. Pins what staff rely on: the Overview says in words who
// writes what, Needs Attention shows the fix, Live asks first and names the second writer,
// the kill switch stops at once, a refresh keeps the tab, and the phone layout never scrolls
// sideways.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';

const baseStatus = () => ({
  ok: true,
  settings: { switches: { stock: 'shadow', price: 'off', content: 'shadow', create: 'live', end: 'off' }, kill: false, blastPct: 10 },
  counts: { linked_sizes: 2330, products_needing_attention: 3 },
  passes: { queue: { at: '2026-11-08T15:00:00Z', ok: true, note: '4 changes checked' }, reconcile: { at: '2026-11-08T14:30:00Z', ok: false, note: 'Shopify read timed out' } },
  budget: { used: 812, limit: 5000, resetAt: '2026-11-09T13:00:00Z' },
  ebay: { connected: true, user: 'stickballman12' },
  facts: { dpl_orders_checked: 185 },
  handover: [
    { key: 'orders', label: 'Every eBay order matched for 7 days', ok: true, detail: '185 of 185 matched' },
    { key: 'stock', label: 'Stock drift explained', ok: false, detail: '4 sizes still differ' },
  ],
});
const PRODUCT = { shopify_product_id: 'p1', title: 'Nike Dunk Low Panda', style: 'DD1391-100', status: 'needs_attention', item_id: null, view_url: null, image: null, sizes: ['8', '9'], qty: 3,
  issues: [{ code: 'title_long', message: 'Title is 87 characters, eBay allows 80.', fix: 'Shorten the title in Shopify to 80 characters or fewer.' }], checked_at: '2026-11-08T14:00:00Z' };

async function mock(page, over = {}) {
  const state = { status: over.status || baseStatus(), posts: [] };
  // The eBay page around the Sync tab: connected, nothing pulled yet (Sync must still show).
  await page.route('**/api/ebay/status', (r) => r.fulfill({ json: { ok: true, configured: true, missing: [], secrets: true, connected: true, user: 'stickballman12', pull: { state: 'idle' } } }));
  await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
  await page.route('**/api/ebay/orders**', (r) => r.fulfill({ json: { ok: true, rows: [], orders: [] } }));
  await page.route('**/api/ebay-sync/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace('/api/ebay-sync/', '');
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      state.posts.push({ name, body });
      if (name === 'settings') {
        const s = state.status.settings;
        if (body.switches) s.switches = { ...s.switches, ...body.switches };
        if (body.kill !== undefined) s.kill = body.kill;
        return route.fulfill({ json: { ok: true, settings: s } });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (name === 'status') return over.statusFail ? route.fulfill({ status: 500, json: { ok: false, error: 'status is down' } }) : route.fulfill({ json: state.status });
    if (name === 'products') return route.fulfill({ json: { ok: true, rows: url.searchParams.get('tab') === 'needs_attention' ? [PRODUCT] : [], total: 1, tabs: { uploaded: 10, not_uploaded: 2, needs_attention: 1 } } });
    if (name === 'listings') return route.fulfill({ json: { ok: true, rows: [{ item_id: '111', title: 'Nike Dunk', view_url: null, sku: '1001', size: '9', ebay_qty: 1, shopify_qty: 2, ebay_price: 120, shopify_price: 110, price_rule: 'kept_repriced', state: 'qty_drift', drift_since: null }], total: 1, tabs: { all: 1 } } });
    if (name === 'inventory') return route.fulfill({ json: { ok: true, rows: [{ sku: '1001', title: 'Nike Dunk', stock: 2, listing_count: 2, duplicate: true }], total: 1 } });
    if (name === 'profiles') return route.fulfill({ json: { ok: true, profiles: [{ id: 1, name: 'STICKBALLMAN12', is_default: true, config: { category: '15709', condition_id: 1000, specifics: { Brand: 'Nike' } } }] } });
    if (name === 'log') return route.fulfill({ json: { ok: true, rows: [{ id: 1, at: '2026-11-08T15:00:00Z', domain: 'stock', action: 'would_revise', mode: 'shadow', item_id: '111', sku: '1001', before: 1, after: 2, ok: true, error: null, by: 'worker' }], total: 1 } });
    return route.fulfill({ status: 404, json: { ok: false, error: 'not mocked' } });
  });
  return state;
}

test.describe('eBay Sync page', () => {
  test('Overview says in words who writes what, and shows the hand-over list', async ({ page }) => {
    await mock(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=sync');
    await expect(page.locator('[data-part="stock"]')).toContainText('Test mode: recording only, DPL is still writing');
    await expect(page.locator('[data-orders-note]')).toContainText("DPL brings eBay orders into Shopify. This page doesn't touch orders.");
    await expect(page.locator('[data-part="orders"]')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Orders' })).toHaveCount(0);
    await expect(page.locator('[data-part="create"]')).toContainText('Live: we write this');
    await expect(page.locator('[data-part="price"]')).toContainText('Off');
    await expect(page.locator('[data-pass="reconcile"]')).toContainText('Shopify read timed out');
    await expect(page.locator('[data-pass="reconcile"]')).toContainText('EST');
    await expect(page.getByText('812')).toBeVisible();
    await expect(page.locator('[data-ok="1"]')).toContainText('185 of 185 matched');
    await expect(page.locator('[data-ok="0"]')).toContainText('4 sizes still differ');
    // PH without the privilege cannot run passes
    await expect(page.getByRole('button', { name: 'Run now' })).toHaveCount(0);
  });

  test('a failed status read says so instead of showing zeros', async ({ page }) => {
    await mock(page, { statusFail: true });
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=sync');
    await expect(page.getByRole('alert')).toContainText('status is down');
    await expect(page.locator('[data-part]')).toHaveCount(0);
  });

  test('Needs Attention shows the fix in plain words; refresh keeps the tab', async ({ page }) => {
    await mock(page);
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync');
    await page.getByRole('tab', { name: 'Shopify Products' }).click();
    await expect(page).toHaveURL(/sync=products/);
    await expect(page.getByText('Title is 87 characters, eBay allows 80.')).toBeVisible();
    await expect(page.getByText('Shorten the title in Shopify to 80 characters or fewer.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check with eBay' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Shopify Products' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Title is 87 characters, eBay allows 80.')).toBeVisible();
  });

  test('other tabs load with their words', async ({ page }) => {
    await mock(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=sync&sync=listings');
    await expect(page.getByRole('cell', { name: 'Kept: repriced' })).toBeVisible();
    await page.getByRole('tab', { name: 'Linked Inventory' }).click();
    await expect(page.getByText('Duplicate:')).toBeVisible();
    await page.getByRole('tab', { name: 'Profiles' }).click();
    await expect(page.getByText('STICKBALLMAN12')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save profile' })).toHaveCount(0);
  });

  test('a stopped full check says why, and an admin can accept the new counts', async ({ page }) => {
    await mock(page);
    const sent = [];
    await page.route('**/api/ebay-sync/status', (route) => route.fulfill({ json: { ...baseStatus(), passes: { ...baseStatus().passes, reconcile: { at: '2026-11-08T14:30:00Z', ok: false, note: '', aborted: { why: 'The Shopify read shrank from 4500 to 3000 variants (over 10%).', shrank: true } } } } }));
    await page.route('**/api/ebay-sync/run', (route) => { sent.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true, started: true } }); });
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=overview');
    await expect(page.getByText('The full check stopped and changed nothing')).toBeVisible();
    await page.getByRole('button', { name: 'Accept the new counts' }).click();
    await expect.poll(() => sent[0]).toEqual({ pass: 'reconcile', acceptCounts: true });
  });

  test('Sync is a tab on the eBay page, not its own page or home card', async ({ page }) => {
    await mock(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings');
    await expect(page.locator('.ebl-tabs').getByRole('button', { name: 'Sync' })).toBeVisible();
    await page.locator('.ebl-tabs').getByRole('button', { name: 'Sync' }).click();
    await expect(page).toHaveURL(/tab=sync/);
    await expect(page.locator('[data-part="stock"]')).toBeVisible();
    await page.goto('/ph/ebay-sync');
    await expect(page.locator('[data-part]')).toHaveCount(0);
    await page.goto('/ph');
    await expect(page.getByText('eBay Sync')).toHaveCount(0);
    await expect(page.getByText('Orders & late shipments, listings, reprice, coupons').first()).toBeVisible();
  });

  test('eBay Products links to the eBay page for ending and repricing', async ({ page }) => {
    await mock(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=sync&sync=listings&sf=no_shopify');
    const end = page.locator('[data-link-note="end"]');
    await expect(end).toContainText('Ending these is done in the Not in Shopify');
    await expect(end.getByRole('link')).toHaveAttribute('href', '/ph/ebay-listings?tab=orphans');
    await expect(page.locator('.ebl-tabs')).toBeVisible();
    await page.getByRole('button', { name: /Price kept/ }).click();
    await expect(page.locator('[data-link-note="reprice"]').getByRole('link')).toHaveAttribute('href', '/ph/ebay-listings?tab=reprice');
    await expect(page.locator('.esy').getByRole('button', { name: /^(End|Reprice)/ })).toHaveCount(0);
    // The links switch the eBay tab in place, no reload.
    await page.evaluate(() => { window.__noReload = true; });
    await page.locator('[data-link-note="reprice"]').getByRole('link').click();
    await expect(page).toHaveURL(/tab=reprice/);
    await expect(page.locator('.ebl-tabs .seg-btn.on')).toHaveText('Reprice');
    expect(await page.evaluate(() => window.__noReload)).toBe(true);
  });

  test('Live asks first and names the second writer; Test and Off do not ask', async ({ page }) => {
    const st = await mock(page);
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=settings');
    const stock = page.locator('[data-switch="stock"]');
    await stock.getByRole('button', { name: 'Live' }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('DPL also writes this while it is still on');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(st.posts.filter((p) => p.name === 'settings')).toHaveLength(0);
    await stock.getByRole('button', { name: 'Live' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, go live' }).click();
    await expect(stock).toContainText('Live: we write this');
    expect(st.posts.find((p) => p.name === 'settings').body).toEqual({ switches: { stock: 'live' } });
    // going to Test is not a confirm
    await stock.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(stock).toContainText('Test mode');
    await expect(page.locator('[data-switch="orders"]')).toHaveCount(0);
  });

  test('the kill switch is instant to turn on and asks before it is turned off', async ({ page }) => {
    const st = await mock(page);
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=settings');
    await page.getByRole('button', { name: 'STOP EVERYTHING NOW' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('The kill switch is ON.').first()).toBeVisible();
    expect(st.posts.at(-1)).toEqual({ name: 'settings', body: { kill: true } });
    await page.getByRole('button', { name: 'Turn the kill switch off' }).click();
    await expect(page.getByRole('dialog')).toContainText('start writing again');
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, allow writes again' }).click();
    await expect(page.getByText('The kill switch is ON.')).toHaveCount(0);
    expect(st.posts.at(-1).body).toEqual({ kill: false });
  });

  test('without the privilege the controls are not usable', async ({ page }) => {
    await mock(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=sync&sync=settings');
    await expect(page.getByText('You can look at the switches but not change them')).toBeVisible();
    await expect(page.getByRole('button', { name: 'STOP EVERYTHING NOW' })).toHaveCount(0);
    await expect(page.locator('[data-switch="stock"]').getByRole('button', { name: 'Test' })).toBeDisabled();
  });

  test('390px: no sideways scroll on any tab', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mock(page);
    await loginAs(page, 'admin');
    for (const tab of ['overview', 'products', 'listings', 'inventory', 'profiles', 'settings']) {
      await page.goto(`/ebay?tab=sync&sync=${tab}`);
      await expect(page.locator('.esy-tabs')).toBeVisible();
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `tab ${tab} overflows by ${over}px`).toBeLessThanOrEqual(0);
    }
  });
});
