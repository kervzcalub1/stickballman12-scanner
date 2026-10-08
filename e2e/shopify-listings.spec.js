// Shopify Listings (PH) — the rules, the table with EVERY endpoint mocked (CI must never
// write to the live store), and the save endpoint's own guards.
// docs/context/shopify-listings.md
import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/auth.js';
import {
  groupProducts, productMatches, suggestion, emptyDrafts, setVariantDraft, setProductDraft,
  draftSuggested, summarizeDrafts, savePayloads,
} from '../src/lib/shopifyListings.js';

const v = (id, pid, title, style, size, price, qty = 1, extra = {}) => ({
  variantId: `gid://shopify/ProductVariant/${id}`, productId: `gid://shopify/Product/${pid}`, productTitle: title,
  status: 'ACTIVE', handle: 'h', image: null, sku: String(id), size, price, compareAt: null, qty, style, ...extra,
});
const VARIANTS = [
  v(11, 1, 'Retropy E5 (Q47101)', 'Q47101', '10', '80.00'),       // 86 → 96: raise 16
  v(12, 1, 'Retropy E5 (Q47101)', 'Q47101', '9', '120.00'),       // 86 → 96: cut 24 (sorted first)
  v(13, 1, 'Retropy E5 (Q47101)', 'Q47101', '12', '300.00'),      // big swing
  v(21, 2, 'Nike Air Max 2017 Wolf Grey', null, '9', '150.00'),   // no code
  v(31, 3, 'Dunk Low (DD1503-101)', 'DD1503-101', '8', '100.00', 0, { status: 'DRAFT' }),
];
const CACHE = { 'Q47101|9': { status: 'ok', valueCents: 8600 }, 'Q47101|10': { status: 'ok', valueCents: 8600 }, 'Q47101|12': { status: 'ok', valueCents: 8600 } };

test.describe('Shopify listings rules', () => {
  test('group, search, suggest both ways, big swing flagged', () => {
    const ps = groupProducts(VARIANTS);
    expect(ps.map((p) => p.title)).toEqual(['Dunk Low (DD1503-101)', 'Nike Air Max 2017 Wolf Grey', 'Retropy E5 (Q47101)']);
    expect(ps[2].variants.map((x) => x.size)).toEqual(['9', '10', '12']);
    expect(productMatches(ps[2], 'retropy q471')).toBe(true);
    expect(productMatches(ps[2], 'dunk')).toBe(false);
    expect(suggestion(VARIANTS[0], CACHE, 1200)).toMatchObject({ state: 'ok', kind: 'raise', suggestedCents: 9600, diffCents: 1600, big: false });
    expect(suggestion(VARIANTS[1], CACHE, 1200)).toMatchObject({ kind: 'lower', diffCents: -2400 });
    expect(suggestion(VARIANTS[2], CACHE, 1200)).toMatchObject({ kind: 'lower', big: true });
    expect(suggestion(VARIANTS[3], CACHE, 1200).state).toBe('no_style');
    expect(suggestion(VARIANTS[4], CACHE, 1200).state).toBe('not_priced');
  });

  test('drafts: editing back to Shopify’s value is no draft; bulk skips big swings', () => {
    let d = setVariantDraft(emptyDrafts(), VARIANTS[0], { price: '90' });
    expect(d.variants[VARIANTS[0].variantId]).toMatchObject({ price: '90' });
    d = setVariantDraft(d, VARIANTS[0], { price: '80' });
    expect(d.variants).toEqual({});
    const ps = groupProducts(VARIANTS);
    d = setProductDraft(emptyDrafts(), ps[2], { title: ps[2].title });
    expect(d.products).toEqual({});
    const r = draftSuggested(emptyDrafts(), VARIANTS, CACHE, 1200);
    expect(r.staged).toBe(2);
    expect(r.drafts.variants[VARIANTS[2].variantId]).toBeUndefined();
    const byId = new Map(VARIANTS.map((x) => [x.variantId, x]));
    expect(summarizeDrafts(r.drafts, byId)).toMatchObject({ prices: 2, cutCents: -2400, raiseCents: 1600, total: 2 });
    const [body] = savePayloads(r.drafts, byId, new Map(ps.map((p) => [p.productId, p])), 1200);
    expect(body.variants[0]).toMatchObject({ oldPrice: '80.00', price: '96', source: 'market', marketCents: 8600 });
  });
});

test.describe('Shopify Listings page', () => {
  test('loads on open → search → open a product → use suggested + edit → save (mocked)', async ({ page }) => {
    await loginAs(page, 'ph_team');
    const saves = [];
    await page.route('**/api/shopify-listings/variants', (r) => r.fulfill({ json: { ok: true, variants: VARIANTS, adminStore: 'test-store' } }));
    await page.route('**/api/ebay-reprice/prices', (r) => {
      const { jobs } = r.request().postDataJSON();
      r.fulfill({ json: { ok: true, results: jobs.map((j) => ({ ...j, status: 'ok', valueCents: 8600 })) } });
    });
    await page.route('**/api/shopify-listings/save', (r) => {
      const body = r.request().postDataJSON();
      saves.push(body);
      r.fulfill({ json: { ok: true,
        variants: body.variants.map((x) => ({ variantId: x.variantId, status: 'updated', price: x.price ? Number(x.price).toFixed(2) : x.oldPrice, compareAt: 'compareAt' in x ? x.compareAt : x.oldCompareAt })),
        products: body.products.map((x) => ({ productId: x.productId, status: 'updated', title: x.title ?? x.oldTitle, statusValue: x.status ?? x.oldStatus })) } });
    });
    await page.route('**/api/shopify-listings/history', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
    await page.goto('/ph/shopify-listings');
    await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith('reprice:')).forEach((k) => localStorage.removeItem(k)); } catch { /* */ } });
    await page.reload();

    // Loaded without a click; Active + in stock by default hides the DRAFT, out-of-stock Dunk.
    await expect(page.locator('.sl-product')).toHaveCount(2);
    await page.getByLabel('Search listings').fill('retropy');
    await expect(page.locator('.sl-product')).toHaveCount(1);

    // Opening the product prices its sizes by itself.
    await page.getByRole('button', { name: /Retropy E5/ }).click();
    await expect(page.locator('.sl-sizes tbody tr')).toHaveCount(3);
    await expect(page.locator('.sl-sizes')).toContainText('big swing');
    await page.getByRole('button', { name: 'Use suggested for 2' }).first().click();
    await expect(page.getByLabel('Price size 9')).toHaveValue('96');
    await expect(page.getByLabel('Price size 12')).toHaveValue('300.00');   // big swing untouched
    await page.getByLabel('Compare-at size 10').fill('150');
    await page.getByLabel('Product title').fill('Retropy E5 Grey (Q47101)');
    await page.getByLabel('Product status').selectOption('DRAFT');
    await expect(page.locator('.sl-savebar')).toContainText('5 changes');

    await page.getByRole('button', { name: 'Review & save' }).click();
    await expect(page.getByText('Save 5 changes to Shopify?')).toBeVisible();
    await page.getByRole('button', { name: 'Save 5' }).click();
    await expect(page.getByText('✓ Saved to Shopify')).toBeVisible();
    await expect(page.locator('.sl-savebar')).toHaveCount(0);

    const body = saves[0];
    expect(body.markupPctH).toBe(1200);
    const byId = Object.fromEntries(body.variants.map((x) => [x.variantId.split('/').pop(), x]));
    expect(byId['12']).toMatchObject({ oldPrice: '120.00', price: '96', source: 'market', marketCents: 8600 });
    expect(byId['11']).toMatchObject({ oldPrice: '80.00', price: '96', compareAt: '150', oldCompareAt: null });
    expect(body.products[0]).toMatchObject({ oldTitle: 'Retropy E5 (Q47101)', title: 'Retropy E5 Grey (Q47101)', oldStatus: 'ACTIVE', status: 'DRAFT' });
  });

  test('the endpoints need a signed-in PH account', async ({ request }) => {
    expect((await request.get('/api/shopify-listings/variants')).status()).toBe(401);
    expect((await request.post('/api/shopify-listings/save', { data: {} })).status()).toBe(401);
  });

  test('save refuses bad input before touching Shopify', async ({ page, request }) => {
    await loginAs(page, 'ph_team');
    await page.goto('/ph');
    const token = await page.evaluate(() => sessionStorage.getItem('sb_session_token'));
    const h = { Authorization: `Bearer ${token}` };
    const post = (data) => request.post('/api/shopify-listings/save', { headers: h, data });
    const vid = 'gid://shopify/ProductVariant/1';
    expect((await post({ variants: [{ variantId: 'gid://shopify/Product/1', oldPrice: '10', price: '9' }] })).status()).toBe(400);
    expect((await post({ variants: [{ variantId: vid, oldPrice: '10', price: '0.50' }] })).status()).toBe(400);
    // A "market" price that isn't market + markup is refused — the audit can't lie.
    expect((await post({ markupPctH: 1200, variants: [{ variantId: vid, oldPrice: '10', price: '99', source: 'market', marketCents: 8600 }] })).status()).toBe(400);
    expect((await post({ products: [{ productId: 'gid://shopify/Product/1', oldStatus: 'ACTIVE', status: 'GONE' }] })).status()).toBe(400);
  });
});
