// Shopify Reprice (PH) — plan rules, the page with every endpoint mocked (CI must never
// write to the live store), and the endpoint guards. docs/context/shopify-reprice.md
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import { planChanges, defaultSelected, jobsFromVariants } from '../src/lib/shopifyReprice.js';

const v = (id, title, style, size, price, qty = 1) => ({
  variantId: `gid://shopify/ProductVariant/${id}`, productId: `gid://shopify/Product/${String(id).slice(0, 1)}`,
  productTitle: title, status: 'ACTIVE', sku: String(id), size, price, qty, style,
});
const VARIANTS = [
  v(11, 'Retropy E5 (Q47101)', 'Q47101', '9', '120.00'),        // market 86 → 96: cut 24
  v(12, 'Retropy E5 (Q47101)', 'Q47101', '10', '80.00'),        // market 86 → 96: raise 16
  v(13, 'Retropy E5 (Q47101)', 'Q47101', '11', '96.00'),        // → 96: same
  v(14, 'Retropy E5 (Q47101)', 'Q47101', '12', '300.00'),       // → 96: big swing (68 %)
  v(21, 'Nike Air Max 2017 Wolf Grey', null, '9', '150.00'),    // no style code
  v(22, 'Dunk (DD1503-101)', 'DD1503-101', '8', '100.00', 0),  // out of stock
];
const CACHE = { 'Q47101|9': { status: 'ok', valueCents: 8600 }, 'Q47101|10': { status: 'ok', valueCents: 8600 }, 'Q47101|11': { status: 'ok', valueCents: 8600 }, 'Q47101|12': { status: 'ok', valueCents: 8600 } };

test.describe('Shopify reprice rules', () => {
  test('both ways, big swings flagged and unticked, no-code left alone', () => {
    expect(jobsFromVariants(VARIANTS).map((j) => `${j.sku}|${j.size}`)).toEqual(['Q47101|9', 'Q47101|10', 'Q47101|11', 'Q47101|12']);
    expect(jobsFromVariants(VARIANTS, { inStockOnly: false })).toHaveLength(5);
    const rows = planChanges(VARIANTS, CACHE, 1200);
    const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
    expect(by['11']).toMatchObject({ kind: 'lower', nextCents: 9600, diffCents: -2400, big: false });
    expect(by['12']).toMatchObject({ kind: 'raise', nextCents: 9600, diffCents: 1600, big: false });
    expect(by['13']).toMatchObject({ kind: 'same' });
    expect(by['14']).toMatchObject({ kind: 'lower', big: true });
    expect(by['21']).toMatchObject({ kind: 'no_style' });
    expect(by['22']).toBeUndefined();   // out of stock, filtered
    expect([...defaultSelected(rows)].sort()).toEqual(['gid://shopify/ProductVariant/11', 'gid://shopify/ProductVariant/12']);
  });
});

test.describe('Shopify Reprice page', () => {
  test('pull → prices → review → apply (mocked) → recent changes', async ({ page }) => {
    await loginAs(page, 'ph_team');
    const applied = [];
    const history = [];
    await page.route('**/api/shopify-reprice/variants', (r) => r.fulfill({ json: { ok: true, variants: VARIANTS } }));
    await page.route('**/api/ebay-reprice/prices', (r) => {
      const { jobs } = r.request().postDataJSON();
      r.fulfill({ json: { ok: true, results: jobs.map((j) => ({ ...j, status: 'ok', valueCents: 8600 })) } });
    });
    await page.route('**/api/shopify-reprice/apply', (r) => {
      const body = r.request().postDataJSON();
      applied.push(body);
      for (const c of body.changes) history.push({ id: history.length + 1, changed_at: '2026-10-07T21:00:00Z', product_title: c.productTitle, style: c.style, size: c.size, old_price: c.oldPrice, new_price: '96.00', market_cents: c.marketCents, markup_pct: '12', changed_by: 'E2E PH' });
      r.fulfill({ json: { ok: true, results: body.changes.map((c) => ({ variantId: c.variantId, status: 'updated', price: '96.00' })) } });
    });
    await page.route('**/api/shopify-reprice/history', (r) => r.fulfill({ json: { ok: true, rows: history } }));
    await page.goto('/ph/shopify-reprice');
    await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('reprice:')).forEach((k) => localStorage.removeItem(k)); } catch { /* */ } });
    await page.reload();

    await page.getByRole('button', { name: 'Pull Shopify products' }).click();
    await expect(page.locator('.er-stat', { hasText: 'no style code' })).toContainText('1');
    await page.getByRole('button', { name: 'Fetch prices' }).click();
    await expect(page.getByText('4 of 4 priced')).toBeVisible();

    await expect(page.getByLabel('Markup percent')).toHaveValue('12');
    await expect(page.locator('.er-stat', { hasText: 'would be cut' })).toContainText('2');
    await expect(page.locator('.er-stat', { hasText: 'would be raised' })).toContainText('1');
    // The big swing is listed but starts unticked.
    await expect(page.getByLabel('Change Retropy E5 (Q47101) size 12')).not.toBeChecked();
    await expect(page.getByLabel('Change Retropy E5 (Q47101) size 9')).toBeChecked();
    await expect(page.locator('.sr-apply')).toContainText('2 ticked — 1 cut (−$24), 1 raised (+$16)');

    await page.getByRole('button', { name: 'Apply 2 prices to Shopify' }).click();
    await expect(page.getByText('Change 2 live prices on Shopify?')).toBeVisible();
    await page.getByRole('button', { name: 'Change 2 prices' }).click();
    await expect(page.getByText('✓ Done')).toBeVisible();
    await expect(page.getByText('2 updated on Shopify')).toBeVisible();
    // Only market prices and the markup travel — the server computes the new price.
    expect(applied[0].markupPctH).toBe(1200);
    expect(applied[0].changes.map((c) => [c.oldPrice, c.marketCents])).toEqual([['120.00', 8600], ['80.00', 8600]]);
    await expect(page.locator('.sr-table').last()).toContainText('$96.00');
  });

  test('the endpoints need a signed-in PH account', async ({ request }) => {
    expect((await request.get('/api/shopify-reprice/variants')).status()).toBe(401);
    expect((await request.post('/api/shopify-reprice/apply', { data: {} })).status()).toBe(401);
  });

  test('apply refuses a bad markup and a non-variant id before touching Shopify', async ({ page, request }) => {
    const u = await loginAs(page, 'ph_team');
    await page.goto('/ph');
    const token = await page.evaluate(() => sessionStorage.getItem('sb_session_token'));
    const h = { Authorization: `Bearer ${token}` };
    let r = await request.post('/api/shopify-reprice/apply', { headers: h, data: { markupPctH: 50000, changes: [{}] } });
    expect(r.status()).toBe(400);
    r = await request.post('/api/shopify-reprice/apply', { headers: h, data: { markupPctH: 1200, changes: [{ variantId: 'gid://shopify/Product/1', oldPrice: '10', marketCents: 900 }] } });
    expect(r.status()).toBe(400);
    expect(u.role).toBe('ph_team');
  });
});
