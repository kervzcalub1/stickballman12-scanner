// The one SHEIN page (src/screens/Shein.jsx, docs/context/shein-listings.md → "The one page"). What this pins:
//   · every old address lands on the right section with its query, and Back still works;
//   · one card on each home; who sees which section, including a warehouse account holding only
//     Connect integrations, whom the endpoints really refuse;
//   · nothing is lost moving between sections or (where it can be kept) on a refresh;
//   · a hidden section does nothing: no reads, no URL changes;
//   · Today: a failed read says so instead of showing 0;
//   · Advanced stays reachable and is remembered in the URL;
//   · the old words are gone from what a person reads, and a phone never scrolls sideways.
// Every SHEIN / Shopify / price call is mocked in the page, except the ones that prove a real refusal.
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { signToken } from '../api/_lib/util.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import { canonicalSheinUrl, sheinSectionsFor, isSheinPath } from '../src/lib/sheinPage.js';
import { plain, SECTION_WORDS } from '../src/lib/sheinWords.js';
import { BLOCKERS, STATUSES, renderBlocker, ITEM_STATUSES, OP_SAY } from '../src/lib/sheinListings.js';
import { ISSUES } from '../src/lib/sheinCheck.js';
import { REASONS } from '../src/lib/sheinFix.js';
import { TICKS } from '../src/lib/sheinCutover.js';

const JARGON = [/dry[- ]?run/i, /re-?read/i, /snapshot/i, /\bwalk\b/i, /\bSPU\b/, /\bSKC\b/, /goodsId/i, /partialEdit/i, /cut-?over/i, /\bgates?\b/i, /blocker/i, /seller[- ]sku/i, /out of date/i, /only on shein/i, /live (sync|fix)/i, /webhook/i];
const jargonIn = (text) => JARGON.filter((re) => re.test(text)).map(String);

const AT = '2026-11-07T15:00:00Z';
const LISTINGS = () => ({
  ok: true, connected: true, configured: true, canWrite: true, isAdmin: true, total: 1, shopifyCounts: { active: 1, inactive: 0 },
  summary: {
    all: 12, off: 1, activeJob: null, latestSnapshot: null, autoPrice: { on: false }, hooks: { on: true, at: AT }, brands: [{ brand: 'Nike', products: 12 }],
    lastSnapshot: { finished_at: AT, counts: { products: 12, shopify_products: 12, shein_products: 8 } },
    byStatus: { synced: { products: 3, sizes: 20 }, not_on_shein: { products: 2, sizes: 7 }, out_of_date: { products: 4, sizes: 9 }, blocked: { products: 3, sizes: 5 }, error: { products: 0, sizes: 0 }, in_review: { products: 0, sizes: 0 } },
    topBlockers: [{ code: 'size_needs_map', title: '14.5W isn’t a SHEIN size yet.', products: 2, sizes: 3 }],
  },
  products: [{ shopify_product_id: 'gid://shopify/Product/1', title: 'Nike Dunk Low (DD1391-100)', style: 'DD1391-100', vendor: 'Nike', spu: 'I0ABC', status: 'blocked', shopify_status: 'ACTIVE',
    counts: { all: 3, sizes: 3, on_shein: 2, by: { blocked: 1, synced: 2 } }, worst: { level: 'blocked', title: '14.5W isn’t a SHEIN size yet.', fix: 'Confirm the spelling once.', sizes: 1 }, shopifyUrl: 'https://example.invalid/p/1' }],
});
const LIVE = (over = {}) => ({
  ok: true, connected: true, configured: true, worker: true, shopifyOrdersReady: true, shopifyOrders: [], shopifyStore: 'x', itemsTotal: 1,
  sync: { orders: 'on', push: 'on', shopifyOrders: 'on', polledAt: AT, since: AT, shopifyOrdersSince: AT }, unitCounts: { last24: 3, failing: 0 },
  units: [{ goods_id: 'g1', order_no: 'GSH1', order_time: AT, seller_sku: '100', title: 'Nike Dunk Low', unit_status: 2, deducted_at: AT, due: true }],
  run: { id: 9, mode: 'dry', status: 'done', phase: 'Walk finished, snapshot read', started_at: AT, finished_at: AT, counts: { sizes: 4, products: 1 } },
  items: [{ id: 1, product_name: 'Nike Dunk Low', spu: 'I0ABC', shein_size: 'US9', seller_sku: '100', shopify_size: '9', shopify_qty: 1, held: 0, before_qty: 2, target_qty: 1, reason: 'ok', result: 'changed', wrote: 'dry', action: 'Set stock; seller SKU stays' }],
  ...over,
});

async function mockShein(page, { listings = LISTINGS, live = LIVE, status = { ok: true, configured: true, connected: true, connectedAt: AT, connectedBy: 'Alex' }, counter = null } = {}) {
  await page.route('**/api/shein/**', (route) => {
    const u = new URL(route.request().url());
    const count = (k) => { if (counter) counter[k] = (counter[k] || 0) + 1; };
    if (route.request().method() !== 'GET') return route.fulfill({ status: 500, json: { ok: false, error: 'The test refuses every write' } });
    if (u.pathname.endsWith('/shein/status')) return route.fulfill({ json: status });
    if (u.pathname.endsWith('/shein/live')) { count('live'); const b = live(); return route.fulfill(b.__status ? { status: b.__status, json: { ok: false, error: b.error } } : { json: b }); }
    if (u.pathname.endsWith('/shein/links')) return route.fulfill({ json: { ok: true, links: [] } });
    if (u.pathname.endsWith('/shein/listings')) {
      count('listings');
      if (u.searchParams.get('probe') === '1') return route.fulfill({ json: { ok: true, probe: null, canWrite: true } });
      const b = listings();
      return route.fulfill(b.__status ? { status: b.__status, json: { ok: false, error: b.error } } : { json: b });
    }
    return route.fulfill({ json: { ok: true, jobs: [], box: { confirmed: false } } });
  });
  await page.route('**/api/shopify-listings/variants', (r) => r.fulfill({ json: { ok: true, variants: [{ sku: '100', size: '9', qty: 1, status: 'ACTIVE', productTitle: 'Nike Dunk Low', productId: 'p1' }] } }));
  await page.route('**/api/ebay-reprice/prices', (r) => r.fulfill({ json: { ok: true, results: [] } }));
}

const HEAD = ['SPU', 'SKC', 'SKU', 'Secondary Specification Value1', 'brand name', 'Default Product Name(en)', 'sellerSKU', 'Main Image', 'Current inventory', 'link'];
const exportFile = () => ({
  name: 'Export Products_2026-11-07 13_36_02.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buffer: Buffer.from(buildXlsx({ sheetName: 'Product Information', columns: HEAD.map((label) => ({ label })), rows: [['spu1', 'skc1', 'I1', 'US8', 'Nike', 'Nike Dunk Low', '100', '', '1', '']] })),
});
const holder = async (page, privileges = ['connect_integrations']) => {
  const u = { uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' };
  await page.addInitScript(([t, j]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', j); }, [signToken(u), JSON.stringify({ ...u, privileges })]);
};
const sectionTabs = (page) => page.getByRole('tablist', { name: 'SHEIN sections' }).getByRole('tab');
const panel = (page, k) => page.locator(`[data-section="${k}"]`);

test.describe('SHEIN page — the rules (pure)', () => {
  test('every old address maps to the right section, keeps its query, and is stable', () => {
    const c = (p, q = '', base = '/ph/shein') => canonicalSheinUrl(p, q, base);
    expect(c('/ph/shein-listings', '?tab=sizes&q=nike')).toBe('/ph/shein?section=listings&tab=sizes&q=nike');
    expect(c('/shein-listings', '?status=blocked', '/shein')).toBe('/shein?section=listings&status=blocked');
    expect(c('/ph/shein-check')).toBe('/ph/shein?section=check');
    expect(c('/shein-check', '', '/shein')).toBe('/shein?section=check');
    expect(c('/ph/shein-reprice')).toBe('/ph/shein?section=reprice');
    // the old Match link: ?tab= belongs to Listings here, so it must not be left in the URL
    expect(c('/ph/shein-check', '?tab=match')).toBe('/ph/shein?section=check&chk=match');
    // back from SHEIN, on the old path or the new one, always shows beside the Connect button
    expect(c('/ph/shein-check', '?shein_error=x')).toBe('/ph/shein?section=live&shein_error=x');
    expect(c('/shein', '?section=live&shein=connected', '/ph/shein')).toBe('/ph/shein?section=live&shein=connected');
    // the wrong workspace's spelling moves to the right one
    expect(c('/shein', '?section=reprice', '/ph/shein')).toBe('/ph/shein?section=reprice');
    expect(c('/ph/shein', '?section=check', '/shein')).toBe('/shein?section=check');
    // already right: nothing to do, including no section at all
    expect(c('/ph/shein', '')).toBeNull();
    expect(c('/ph/shein', '?section=check&chk=fix')).toBeNull();
    expect(c('/ph/inventory', '?q=x')).toBeNull();
    expect(isSheinPath('/ph/shein-listings/')).toBe(true);
    expect(isSheinPath('/shein-reprice')).toBe(false);
  });

  test('who sees what', () => {
    const five = ['today', 'listings', 'check', 'reprice', 'live'];
    expect(sheinSectionsFor({ role: 'ph_team' })).toEqual(five);
    expect(sheinSectionsFor({ role: 'admin' })).toEqual(five);
    expect(sheinSectionsFor({ role: 'superadmin' })).toEqual(five);
    expect(sheinSectionsFor({ role: 'warehouse', privileges: ['connect_integrations'] })).toEqual(['check', 'live']);
    expect(sheinSectionsFor({ role: 'warehouse', privileges: ['audit_po'] })).toEqual([]);
    expect(sheinSectionsFor({ role: 'warehouse' })).toEqual([]);
  });

  test('the words: nothing we wrote still says the old jargon, and server text is translated', () => {
    const said = [];
    for (const [code, def] of Object.entries(BLOCKERS)) {
      for (const params of [{}, { size: '9', why: 'typed_per_shoe', sheinMessage: '' }]) {
        const b = renderBlocker({ code, params });
        said.push(b.title, b.fix, b.action?.label || '');
      }
      expect(def).toBeTruthy();
    }
    said.push(...Object.values(STATUSES).flatMap((s) => [s.label, s.meaning]));
    said.push(...Object.values(ITEM_STATUSES).flatMap((g) => Object.values(g).flatMap((x) => [x.label, x.say || ''])));
    said.push(...Object.values(OP_SAY).flatMap((g) => Object.values(g)));
    said.push(...Object.values(ISSUES).flatMap((i) => [i.label, i.help]));
    said.push(...Object.values(REASONS));
    said.push(...Object.values(TICKS).map((t) => t.label));
    expect(said.flatMap((t) => jargonIn(String(t)).map((j) => `${j}: ${t}`))).toEqual([]);
    expect(plain('Dry run: reading Shopify + SHEIN, seller SKU 12 on SPU X (the live stock walk)')).toBe('Preview: reading Shopify + SHEIN, SKU 12 on product X (the full check)');
    expect(plain(null)).toBeNull();
  });
});

test.describe('SHEIN page — old addresses', () => {
  for (const [from, want, section] of [
    ['/ph/shein-listings?tab=jobs&job=7', /\/ph\/shein\?section=listings&tab=jobs&job=7$/, 'listings'],
    ['/ph/shein-check', /\/ph\/shein\?section=check$/, 'check'],
    ['/ph/shein-reprice', /\/ph\/shein\?section=reprice$/, 'reprice'],
  ]) {
    test(`PH: ${from}`, async ({ page }) => {
      await mockShein(page);
      await loginAs(page, 'ph_team');
      await page.goto(from);
      await expect(page).toHaveURL(want);
      await expect(panel(page, section)).toBeVisible();
      await expect(page.getByRole('tab', { name: SECTION_WORDS[section] })).toHaveAttribute('aria-selected', 'true');
    });
  }
  for (const [from, want, section] of [
    ['/shein-listings?status=blocked', /\/shein\?section=listings&status=blocked$/, 'listings'],
    ['/shein-check', /\/shein\?section=check$/, 'check'],
    // an admin following a PH link: today this fell through to the home page
    ['/ph/shein-check', /\/shein\?section=check$/, 'check'],
  ]) {
    test(`admin: ${from}`, async ({ page }) => {
      await mockShein(page);
      await loginAs(page, 'admin');
      await page.goto(from);
      await expect(page).toHaveURL(want);
      await expect(panel(page, section)).toBeVisible();
    });
  }
  test('Back leaves the page: the old address isn’t left in history', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/payout');
    await page.goto('/ph/shein-listings?tab=sizes');
    await expect(page).toHaveURL(/\/ph\/shein\?section=listings&tab=sizes$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/ph\/payout$/);
  });
  test('back from SHEIN: the result shows, then only its own params leave the URL', async ({ page }) => {
    await mockShein(page, { status: { ok: true, configured: true, connected: false } });
    await loginAs(page, 'admin');
    await page.goto('/shein?section=live&shein_error=SHEIN%20said%20no&q=keepme');
    await expect(panel(page, 'live').getByRole('alert')).toContainText('SHEIN said no');
    await expect(page).toHaveURL(/section=live/);
    await expect(page).toHaveURL(/q=keepme/);
    await expect(page).not.toHaveURL(/shein_error/);
    await expect(panel(page, 'live').getByRole('button', { name: 'Connect SHEIN' })).toBeVisible();
  });
  test('SHEIN not set up on this server: the connection card says so', async ({ page }) => {
    await mockShein(page, { status: { ok: true, configured: false, connected: false } });
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein?section=live');
    await expect(panel(page, 'live').locator('[data-connect-state="not_set_up"]')).toContainText('isn’t set up on this server');
  });
  test('a PH account on the callback’s address lands in its own workspace, connected', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/shein?section=live&shein=connected');
    await expect(page).toHaveURL(/\/ph\/shein\?section=live$/);
    await expect(panel(page, 'live').getByText('SHEIN connected.', { exact: true })).toBeVisible();
  });
});

test.describe('SHEIN page — home cards and who sees what', () => {
  test('one card on the PH home, one on the admin home', async ({ page, context }) => {
    await loginAs(page, 'ph_team');
    await mockShein(page);
    await page.goto('/ph');
    const ph = page.locator('.home-card', { hasText: /SHEIN/ });
    await expect(ph).toHaveCount(1);
    await expect(ph).toContainText('See what’s listed, fix problems, change prices');
    await ph.click();
    await expect(page).toHaveURL(/\/ph\/shein$/);
    await expect(sectionTabs(page)).toHaveText(['Today', 'Shoes on SHEIN', 'Fix problems', 'Prices', 'Automatic sync']);
    await expect(page.locator('.brand')).toHaveText('SHEIN');

    const admin = await context.newPage();
    await loginAs(admin, 'admin');
    await mockShein(admin);
    await admin.goto('/');
    const card = admin.locator('.home-card', { hasText: /SHEIN/ });
    await expect(card).toHaveCount(1);
    await card.click();
    await expect(admin).toHaveURL(/\/shein$/);
    await expect(sectionTabs(admin)).toHaveText(['Today', 'Shoes on SHEIN', 'Fix problems', 'Prices', 'Automatic sync']);
    await admin.close();
  });

  test('a warehouse account holding only Connect integrations: Fix problems + Automatic sync, and an honest word when the server refuses', async ({ page }) => {
    await holder(page);
    await page.goto('/');
    await page.locator('.home-card', { hasText: /SHEIN/ }).click();
    await expect(sectionTabs(page)).toHaveText(['Fix problems', 'Automatic sync']);
    await expect(page.getByLabel('SHEIN export file')).toBeAttached();
    // no Listings, Prices or Today, however they ask
    for (const s of ['listings', 'reprice', 'today']) {
      await page.goto(`/shein?section=${s}`);
      await expect(page).toHaveURL(/section=check/);
      await expect(sectionTabs(page)).toHaveText(['Fix problems', 'Automatic sync']);
    }
    await page.goto('/shein-listings');
    await expect(page).toHaveURL(/section=check/);
    // the real endpoints answer 403 to this role; the section says so instead of being blank
    await page.getByRole('tab', { name: 'Automatic sync' }).click();
    await expect(panel(page, 'live').locator('[data-connect-state="refused"]')).toBeVisible();
    await expect(panel(page, 'live').getByRole('button', { name: 'Connect SHEIN' })).toHaveCount(0);
  });

  test('a warehouse account without it never reaches the page', async ({ page }) => {
    await holder(page, []);
    await page.goto('/');
    await expect(page.locator('.home-card', { hasText: /SHEIN/ })).toHaveCount(0);
    await page.goto('/shein?section=check');
    await expect(sectionTabs(page)).toHaveCount(0);
    await page.goto('/shein-check');
    await expect(sectionTabs(page)).toHaveCount(0);
  });
});

test.describe('SHEIN page — moving around loses nothing', () => {
  test('an uploaded export is still there after visiting Prices; a Prices file too; hidden params stay', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein?section=check&q=keepme&tab=sizes');
    await page.getByLabel('SHEIN export file').setInputFiles(exportFile());
    await expect(panel(page, 'check')).toContainText('Export Products_2026-11-07');
    await expect(panel(page, 'check').locator('.shc-tile.bad').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Prices' }).click();
    await expect(panel(page, 'check')).toBeHidden();
    await page.locator('#sr-export').setInputFiles(exportFile());
    await expect(panel(page, 'reprice').locator('.er-file-name').first()).toContainText('Export Products_2026-11-07');
    await page.getByRole('tab', { name: 'Fix problems' }).click();
    await expect(panel(page, 'check')).toContainText('Export Products_2026-11-07');
    await expect(panel(page, 'check').locator('.shc-tile.bad').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Prices' }).click();
    await expect(panel(page, 'reprice').locator('.er-file-name').first()).toContainText('Export Products_2026-11-07');
    await expect(page).toHaveURL(/q=keepme/);
    await expect(page).toHaveURL(/tab=sizes/);
  });

  test('refresh keeps the section and the sub-tab; a lost export says so', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein?section=listings&tab=sizes');
    await expect(page.getByRole('tab', { name: /^Sizes/ })).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Shoes on SHEIN' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: /^Sizes/ })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: 'Fix problems' }).click();
    await page.getByLabel('SHEIN export file').setInputFiles(exportFile());
    await page.getByRole('button', { name: 'Match sizes' }).click();
    await expect(page).toHaveURL(/chk=match/);
    await page.reload();
    await expect(page).toHaveURL(/section=check.*chk=match|chk=match.*section=check/);
    const gone = panel(page, 'check').locator('[data-file-gone]');
    await expect(gone).toContainText('Export Products_2026-11-07');
    await expect(gone).toContainText('gone after a refresh');
    await expect(gone).toContainText('Match sizes');
    await page.getByLabel('SHEIN export file').setInputFiles(exportFile());
    await expect(gone).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Match sizes' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('a link between sections doesn’t reload, and a filtered link opens filtered', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein');
    await page.evaluate(() => { window.__noReload = true; });
    await panel(page, 'today').locator('[data-today="blocked"]').getByRole('button').click();
    await expect(page).toHaveURL(/section=listings/);
    await expect(page).toHaveURL(/status=blocked/);
    await expect(panel(page, 'listings').locator('.shc-tile[data-status="blocked"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.__noReload)).toBe(true);
  });

  test('a hidden section reads nothing, and catches up when shown', async ({ page }) => {
    const counter = {};
    await page.clock.install();
    await mockShein(page, { counter });
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein?section=live');
    await expect(panel(page, 'live').locator('.shc-tile').first()).toBeVisible();
    await page.getByRole('tab', { name: 'Prices' }).click();
    await expect(panel(page, 'live')).toBeHidden();
    const before = counter.live;
    await page.clock.runFor(5 * 60_000);
    await page.waitForTimeout(100);
    expect(counter.live).toBe(before);
    await page.getByRole('tab', { name: 'Automatic sync' }).click();
    await page.clock.runFor(2_000);
    await expect.poll(() => counter.live).toBeGreaterThan(before);
  });
});

test.describe('SHEIN page — Today', () => {
  test('is the first section: counts with a button each, and one line on the sync', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein');
    await expect(page.getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'true');
    const t = panel(page, 'today');
    await expect(t.locator('[data-health="ok"]')).toContainText('Automatic sync is working');
    await expect(t.locator('[data-today="not_on_shein"]')).toContainText('7');
    await expect(t.locator('[data-today="blocked"]')).toContainText('14.5W isn’t a SHEIN size yet');
    await expect(t.locator('[data-today="out_of_date"]')).toContainText('9');
    await expect(t.locator('[data-today="failing"]')).toHaveCount(0);
  });

  test('sales that didn’t reach Shopify are on top of the list, and the button goes to them', async ({ page }) => {
    await mockShein(page, { live: () => LIVE({ unitCounts: { last24: 1, failing: 2 } }) });
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein');
    const t = panel(page, 'today');
    await expect(t.locator('[data-health="bad"]')).toContainText('2 SHEIN sales haven’t reached Shopify');
    await t.locator('[data-today="failing"]').getByRole('button').click();
    await expect(page).toHaveURL(/section=live/);
  });

  test('a failed read says it couldn’t read, and never shows 0', async ({ page }) => {
    await mockShein(page, { listings: () => ({ __status: 500, error: 'the list is down' }), live: () => ({ __status: 500, error: 'the sync read is down' }) });
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein');
    const t = panel(page, 'today');
    await expect(t.locator('[data-today="list"]')).toContainText('couldn’t read this');
    await expect(t.locator('[data-today="live"]')).toContainText('couldn’t read this');
    await expect(t.locator('[data-health="unread"]')).toBeVisible();
    await expect(t.locator('[data-today="clear"]')).toHaveCount(0);
    const text = await t.innerText();
    expect(text).not.toMatch(/\b0\b/);
    await expect(t.getByRole('button', { name: 'Try again' })).toHaveCount(2);
  });

  test('against the real endpoints (our database only): the health line and the list render, nothing “couldn’t read”', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto('/shein');
    const t = panel(page, 'today');
    await expect(t.locator('[data-health]')).toBeVisible();
    await expect(t.locator('[data-health="unread"]')).toHaveCount(0);
    await expect(t.locator('[data-unread]')).toHaveCount(0);
    await expect(t.locator('.shl-skel')).toHaveCount(0);
    await expect(t.locator('[data-today]').first()).toBeVisible();
  });

  test('one read failing leaves the other’s numbers', async ({ page }) => {
    await mockShein(page, { live: () => ({ __status: 500, error: 'down' }) });
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein');
    const t = panel(page, 'today');
    await expect(t.locator('[data-today="not_on_shein"]')).toContainText('7');
    await expect(t.locator('[data-today="live"]')).toContainText('couldn’t read this');
  });
});

test.describe('SHEIN page — Advanced', () => {
  test('Shoes on SHEIN: Jobs and Setup are behind Advanced, and it survives a refresh', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein?section=listings');
    const p = panel(page, 'listings');
    await expect(p.getByRole('tab', { name: /^Jobs/ })).toHaveCount(0);
    await p.locator('[data-adv-toggle]').click();
    await expect(page).toHaveURL(/adv=1/);
    await expect(p.getByRole('tab', { name: /^Jobs/ })).toBeVisible();
    await expect(p.getByRole('tab', { name: /^Setup/ })).toBeVisible();
    await expect(p.locator('.shl-auto')).toBeVisible();
    await page.reload();
    await expect(p.getByRole('tab', { name: /^Setup/ })).toBeVisible();
    await p.locator('[data-adv-toggle]').click();
    await expect(page).not.toHaveURL(/adv=1/);
    await expect(p.getByRole('tab', { name: /^Setup/ })).toHaveCount(0);
    // an old link straight to a tab inside it still opens it
    await page.goto('/ph/shein-listings?tab=setup');
    await expect(p.getByRole('tab', { name: /^Setup/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('Automatic sync: the switches and the full check are behind Advanced, remembered in the URL', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'admin');
    await page.goto('/shein?section=live');
    const p = panel(page, 'live');
    await expect(p.locator('[data-sync-switches]')).toBeHidden();
    await p.locator('[data-adv="liveadv"] > summary').click();
    await expect(page).toHaveURL(/liveadv=1/);
    await expect(p.locator('[data-sync-switches]')).toBeVisible();
    await page.reload();
    await expect(p.locator('[data-sync-switches]')).toBeVisible();
    await expect(p.getByRole('button', { name: /Start: Preview \(changes nothing\)/ })).toBeVisible();
  });

  test('the sync being off opens the switches by itself', async ({ page }) => {
    await mockShein(page, { live: () => LIVE({ sync: { orders: 'off', push: 'off', shopifyOrders: 'off' } }) });
    await loginAs(page, 'admin');
    await page.goto('/shein?section=live');
    await expect(panel(page, 'live').getByRole('button', { name: /Turn on SHEIN sales → Shopify/ })).toBeVisible();
  });
});

test.describe('SHEIN page — the old words are gone, and phones fit', () => {
  const VISITS = [
    ['today', '/ph/shein'],
    ['listings', '/ph/shein?section=listings'],
    ['listings', '/ph/shein?section=listings&tab=sizes&sizeadv=1'],
    ['listings', '/ph/shein?section=listings&tab=jobs'],
    ['listings', '/ph/shein?section=listings&tab=setup'],
    ['reprice', '/ph/shein?section=reprice&priceadv=1'],
    ['live', '/ph/shein?section=live&liveadv=1'],
    ['check', '/ph/shein?section=check'],
  ];
  for (const [section, url] of VISITS) {
    test(`${url}: no old words, no sideways scroll at 390`, async ({ page }) => {
      await mockShein(page);
      await loginAs(page, 'ph_team');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(url);
      const p = panel(page, section);
      await expect(p).toBeVisible();
      await expect(p.locator('.shl-skel')).toHaveCount(0);
      for (const d of await p.locator('details.shein-how').all()) await d.locator('summary').click();
      const text = await p.innerText();
      expect(jargonIn(text), text).toEqual([]);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(390);
      const wide = await page.evaluate(() => [...document.querySelectorAll('.app *')]
        .filter((el) => !el.closest('.ap-tablewrap, .shl-vwrap, .shl-rtable') && el.offsetParent && el.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 6).map((el) => `${el.tagName}.${el.className}`));
      expect(wide).toEqual([]);
      for (const box of await sectionTabs(page).all()) expect((await box.boundingBox()).height).toBeGreaterThanOrEqual(44);
    });
  }

  test('Fix problems with a file: every tab, no old words, no sideways scroll at 390', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/shein?section=check&fixadv=1');
    await page.getByLabel('SHEIN export file').setInputFiles(exportFile());
    const p = panel(page, 'check');
    for (const name of ['Problems', 'Match sizes', 'Fix & download']) {
      await p.locator('.shein-subtabs').getByRole('button', { name, exact: true }).click();
      expect(jargonIn(await p.innerText())).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
  });

  test('the product details and the row: no old words', async ({ page }) => {
    await mockShein(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein?section=listings');
    const row = panel(page, 'listings').locator('.shl-product').first();
    await expect(row).toContainText('Nike Dunk Low');
    expect(jargonIn(await panel(page, 'listings').innerText())).toEqual([]);
  });
});
