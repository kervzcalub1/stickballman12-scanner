// eBay Sync, the independent review's findings (D1 to D18) and eBay's quantity facts, one regression test each.
// Mocked IO: eBay, Shopify and the database are never reached (the real-SQL half is e2e/ebay-sync-db.spec.js).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { buildLinks, priceRule, readGuard, contentDiff, buildListing, validateProfile, pageOffset, canWrite, normalizeSettings, endsByZero } from '../src/lib/ebaySync.js';
import { itemXml, uuidDuplicateItemId } from '../api/_lib/ebay.js';
import { reconcilePass, queuePass, contentPass, createPass, runPass, productAction, readState } from '../api/_lib/ebay-sync.js';
import { shopifyEbayProductsLight, shopifyCollectionProductIds, shopifyListingState } from '../api/_lib/shopify.js';
import { mkIO, ctxOf, NOW, TITLE, ALL_LIVE } from './helpers/ebaySyncIO.js';

process.env.EBAY_SYNC_WRITES = 'on';
const LIVE = { ...ALL_LIVE, blastPct: 10 };
const full = { id: 'P9', title: TITLE, status: 'ACTIVE', vendor: 'nike', descriptionHtml: '<p>x</p>', images: [{ url: 'u', width: 900, height: 900 }], variants: [{ sku: 'S', size: '9', barcode: 'S', price: '100', qty: 2 }] };
const drift = (n) => Array.from({ length: n }, (_, i) => i);
const manyRows = (n) => drift(n).map((i) => ({ item_id: `I${i}`, variation_key: `S${i}`, sku: `S${i}`, size: '9', price: 100, qty_available: 1, title: `Shoe ${i} (AB123${i}-001)` }));
const manyVariants = (n, qty = 0) => drift(n).map((i) => ({ variantId: `v${i}`, productId: `PP${i}`, sku: `S${i}`, size: '9', price: '100.00', qty, status: 'ACTIVE', productTitle: `Shoe ${i}` }));
const manyLight = (n) => drift(n).map((i) => ({ id: `PP${i}`, title: `Shoe ${i} (AB123${i}-001)`, status: 'ACTIVE', vendor: 'nike', updatedAt: 'x' }));
const manyPrev = (n) => drift(n).map((i) => ({ link_key: `I${i}|S${i}`, qty_drift_since: '2026-11-08T12:00:00Z', price_drift_since: null, ebay_price: 100, shopify_price: 100, price_rule: 'follows_shopify' }));

test.describe('D1: state and the budget stay out of the live tables', () => {
  test('D1: an idle queue pass writes no state; a busy pass writes only ebay_sync_state, never app_settings', async () => {
    const t = mkIO();
    await runPass('queue', { io: t.io });
    expect(t.stateWrites).toEqual([]);
    const r = mkIO({ live: false });
    await runPass('reconcile', { io: r.io });
    expect(r.stateWrites.length).toBeGreaterThan(0);
    expect(r.stateWrites.every((k) => k.startsWith('ebay_sync_state_'))).toBe(true);
    expect(r.store.has('ebay_sync_state_reconcile')).toBe(false);   // not in app_settings
  });
  test('D1: ebay_sync_state is not a LIVE_TABLE, and the budget no longer writes app_settings', () => {
    const setup = fs.readFileSync('scripts/db-setup.mjs', 'utf8');
    const live = setup.slice(setup.indexOf('const LIVE_TABLES = ['), setup.indexOf('];', setup.indexOf('const LIVE_TABLES = [')));
    expect(live).not.toContain('ebay_sync_state');
    expect(live).toContain('ebay_sync_links');
    const ebay = fs.readFileSync('api/_lib/ebay.js', 'utf8');
    expect(ebay).not.toContain('setSetting(BUDGET_KEY');
    expect(ebay).toContain('Date.now() - budgetFlushed >= 60_000');
  });
});

test.describe('D2: the shrink guard can be accepted, and alerts are daily', () => {
  test('D2: an abort is kept in state, the alert key is the same all day, and acceptCounts lets one pass through', async () => {
    const t = mkIO({ live: true });
    await t.io.setState('ebay_sync_state_reconcile', JSON.stringify({ lastShopifyCount: 100 }));
    const ctx = await ctxOf(t, ALL_LIVE);
    expect((await reconcilePass(ctx)).aborted).toBe(true);
    const later = mkIO({ live: true, now: () => new Date(NOW.getTime() + 3 * 3600_000) });
    await later.io.setState('ebay_sync_state_reconcile', JSON.stringify({ lastShopifyCount: 100 }));
    await reconcilePass(await ctxOf(later, ALL_LIVE));
    expect(later.alerts[0].ref).toBe(t.alerts[0].ref);   // 3 hours later, same day: same key, so no repeat
    const st = await readState('reconcile', t.io);
    expect(st.aborted).toMatchObject({ shrank: true, shopify: 3 });
    expect(st.aborted.why).toMatch(/shrank/);
    const ok = await reconcilePass({ ...ctx, acceptCounts: true });
    expect(ok.aborted).toBeUndefined();
    const after = await readState('reconcile', t.io);
    expect(after.aborted).toBeNull();
    expect(after.lastShopifyCount).toBe(3);
  });
  test('D2: an errored or truncated read is never accepted', () => {
    expect(readGuard({ shopify: { error: 'x' }, acceptCounts: true }).ok).toBe(false);
    expect(readGuard({ shopify: { variants: [], truncated: true }, acceptCounts: true }).ok).toBe(false);
  });
});

test.describe('D3: content cannot crowd out the reconcile', () => {
  test('D3: content stops at 2,000 calls used; the reconcile still runs; the sweep is capped at 100 a day', async () => {
    const t = mkIO({ used: 2100, toCheck: [{ shopify_product_id: 'P9', item_id: '1', shopify_key: 'k' }] });
    await expect(contentPass(await ctxOf(t, {}))).rejects.toThrow(/budget/);
    await expect(reconcilePass(await ctxOf(t, {}))).resolves.toBeTruthy();
    const f = mkIO();
    await contentPass(await ctxOf(f, {}));
    expect(f.dbCalls.find((c) => c[0] === 'toCheck')).toEqual(['toCheck', 40, 100]);
    const g = mkIO();
    await g.io.setState('ebay_sync_state_content', JSON.stringify({ sweepDay: '2026-11-08', sweepN: 95 }));
    await contentPass(await ctxOf(g, {}));
    expect(g.dbCalls.find((c) => c[0] === 'toCheck')[2]).toBe(5);
  });
});

test.describe('D4 + D8: an empty answer from Shopify is not an answer', () => {
  const realFetch = globalThis.fetch;
  const env = { SHOPIFY_STORE_DOMAIN: 'x.myshopify.com', SHOPIFY_ACCESS_TOKEN: 't', EBAY_SYNC_PAGE_GAP_MS: '0' };
  const saved = {};
  test.beforeEach(() => { for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; } });
  test.afterEach(() => { globalThis.fetch = realFetch; for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const answer = (json, status = 200) => async () => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

  test('D4: an empty 200 on the product list or collection is an error, not "no products"', async () => {
    globalThis.fetch = answer({ data: {} });
    expect((await shopifyEbayProductsLight()).error).toMatch(/without a product list/);
    let n = 0;
    globalThis.fetch = async () => (++n === 1
      ? new Response(JSON.stringify({ data: { collections: { nodes: [{ id: 'gid://c/1', title: 'Footwear' }] } } }))
      : new Response(JSON.stringify({ data: { collection: null } })));
    expect((await shopifyCollectionProductIds('Footwear')).error).toMatch(/collection/);
    globalThis.fetch = answer({ data: { products: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/Product/1', title: 'T' }] } } });
    expect((await shopifyEbayProductsLight()).products).toHaveLength(1);
  });
  test('D8: shopifyListingState needs one entry per id; only a null entry means deleted', async () => {
    const ids = ['gid://shopify/Product/1', 'gid://shopify/Product/2'];
    globalThis.fetch = answer({ data: { nodes: [] } });
    expect((await shopifyListingState([], ids)).error).toBeTruthy();
    globalThis.fetch = answer({ data: {} });
    expect((await shopifyListingState([], ids)).error).toBeTruthy();
    globalThis.fetch = answer({ data: { nodes: [{ id: ids[0], title: 'a', status: 'ACTIVE' }, null] } });
    const ok = await shopifyListingState([], ids);
    expect(ok.error).toBeUndefined();
    expect(ok.products.get(ids[0]).status).toBe('ACTIVE');
    expect(ok.products.has(ids[1])).toBe(false);   // gone
  });
  test('D4: the product list shrinking over 10% aborts', () => {
    expect(readGuard({ shopify: { variants: Array(100).fill(1) }, products: Array(80).fill(1), lastProductCount: 100 }).ok).toBe(false);
    expect(readGuard({ shopify: { variants: Array(100).fill(1) }, products: Array(95).fill(1), lastProductCount: 100 }).ok).toBe(true);
  });
  test('throttle: Shopify "THROTTLED" is waited out a few times, then the read stops cleanly; pages are at least a gap apart', async () => {
    process.env.EBAY_SYNC_PAGE_GAP_MS = '10';
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] })); };
    const r = await shopifyEbayProductsLight();
    expect(r.code).toBe('throttled');
    expect(calls).toBe(4);
    process.env.EBAY_SYNC_PAGE_GAP_MS = '60';
    const at = [];
    globalThis.fetch = async () => { at.push(Date.now()); return new Response(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: at.length < 2, endCursor: 'c' }, nodes: [] } } })); };
    await shopifyEbayProductsLight();
    expect(at.length).toBe(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(55);
  });
});

test.describe('D5: the blast limit works on a sliding hour', () => {
  test('D5: small batches add up: the second 8% batch within the hour is stopped, with an alert', async () => {
    const rows = drift(8).map((i) => ({ id: i, kind: 'sku', key: `S${i}` }));
    const t = mkIO({ live: true, linkCount: 100, queue: rows, linksBySku: async (sku) => [{ link_key: `I${sku}|${sku}`, item_id: `I${sku}`, sku, variation_key: sku, ebay_qty: 3 }],
      stockForSku: async () => ({ levels: [{ available: 1 }], tracked: true }) });
    const ctx = await ctxOf(t, LIVE);
    await queuePass(ctx);
    expect(t.calls.filter((c) => c[0] === 'reviseEbayQuantities').length).toBeGreaterThan(0);
    const sent = t.calls.length;
    await queuePass(ctx);
    expect(t.calls.length).toBe(sent);
    expect(t.alerts.at(-1).title).toMatch(/stopped/);
    expect(t.logs.some((l) => l.action === 'blast_stop' && l.domain === 'stock')).toBe(true);
  });
  test('D5: ending uses the LISTING count as its denominator (2 of 10 listings is 20%)', async () => {
    const mk = (listingCount) => mkIO({
      live: true, listingCount, queue: [{ id: 1, kind: 'product', key: 'PA' }, { id: 2, kind: 'product', key: 'PB' }], itemsOfProducts: ['I1', 'I2'],
      ebayRows: [{ item_id: 'I1', variation_key: 'a1', sku: 'a1', size: '9', price: 1, qty_available: 1 }, { item_id: 'I2', variation_key: 'a2', sku: 'a2', size: '9', price: 1, qty_available: 1 }],
      links: [{ item_id: 'I1', shopify_product_id: 'PA', sku: 'a1', title: 't1' }, { item_id: 'I2', shopify_product_id: 'PB', sku: 'a2', title: 't2' }],
      productsState: async (ids) => ({ products: new Map(ids.map((id) => [id, { status: 'DRAFT' }])) }),
    });
    const small = mk(10);
    await queuePass(await ctxOf(small, LIVE));
    expect(small.calls.filter((c) => c[0] === 'endEbayItem')).toEqual([]);
    expect(small.alerts[0].title).toMatch(/ending/);
    const big = mk(100);
    await queuePass(await ctxOf(big, LIVE));
    expect(big.calls.filter((c) => c[0] === 'endEbayItem')).toHaveLength(2);
  });
  test('D5: content revises count in the hour against the listing count', async () => {
    const t = mkIO({ live: true, uploaded: 100, window: { 'content.revise': 10 }, toCheck: [{ shopify_product_id: 'P9', item_id: '555', shopify_key: 'k' }], fullProduct: () => full,
      fetchEbayItemContent: async () => ({ status: 'Active', title: 'Old', description: '<p>x</p>', pictureCount: 1, specificsSet: { name: 'Size', values: [] }, variations: [] }) });
    await contentPass(await ctxOf(t, LIVE));
    expect(t.calls.filter((c) => c[0] === 'reviseFixedPriceItem')).toEqual([]);
    expect(t.alerts[0].title).toMatch(/content/);
  });
});

test.describe('D6: a shared SKU never pins a listing to another shoe', () => {
  test('D6: a duplicate SKU links to no product; the content pass refuses a listing holding another product\'s SKU', async () => {
    const variants = [
      { variantId: 'v1', productId: 'WRONG', sku: 'X', size: '9', qty: 1, price: '100', status: 'ACTIVE' },
      { variantId: 'v2', productId: 'RIGHT', sku: 'X', size: '9', qty: 1, price: '100', status: 'ACTIVE' },
    ];
    const { links } = buildLinks({ ebayRows: [{ item_id: '555', variation_key: 'X', sku: 'X', price: 100, qty_available: 1, title: 'Right shoe' }], variants });
    expect(links.find((l) => l.item_id)).toMatchObject({ duplicate: true, shopify_product_id: null });
    const t = mkIO({ live: true, toCheck: [{ shopify_product_id: 'P9', item_id: '555', shopify_key: 'k' }], fullProduct: () => full,
      fetchEbayItemContent: async () => ({ status: 'Active', title: 'Different', description: 'z', pictureCount: 1, variations: [{ sku: 'NOT-MINE', size: '9', price: 1, quantity: 1 }] }) });
    const r = await contentPass(await ctxOf(t, LIVE));
    expect(t.calls.filter((c) => c[0] === 'reviseFixedPriceItem')).toEqual([]);
    expect(r.note).toMatch(/refused/);
  });
  test('D6: the reconcile does not map a product to a listing through a duplicate link', async () => {
    const t = mkIO({
      ebayRows: [{ item_id: '555', variation_key: 'X', sku: 'X', price: 100, qty_available: 1, title: 'Right (AB1234-001)' }],
      variants: [{ variantId: 'v1', productId: 'WRONG', sku: 'X', size: '9', qty: 1, price: '100', status: 'ACTIVE', productTitle: 'Wrong' },
        { variantId: 'v2', productId: 'RIGHT', sku: 'X', size: '9', qty: 1, price: '100', status: 'ACTIVE', productTitle: 'Right' }],
      light: [{ id: 'WRONG', title: 'Wrong', status: 'DRAFT', vendor: 'n' }, { id: 'RIGHT', title: 'Right', status: 'ACTIVE', vendor: 'n' }], collection: ['RIGHT'], prev: [],
    });
    await reconcilePass(await ctxOf(t, {}));
    expect(t.saved.products.find((p) => p.id === 'WRONG')).toBeUndefined();
    expect(t.logs.filter((l) => l.action === 'end_listing')).toEqual([]);
  });
});

test.describe('D7: no double listing', () => {
  const ready = { shopify_product_id: 'P9', shopify_key: 'k' };
  test('D7: Add carries a 32-hex UUID, the same one on a retry; eBay\'s "UUID already used" answer is a success with that item id', async () => {
    const a = mkIO({ live: true, toAdd: [ready], fullProduct: () => full });
    await createPass(await ctxOf(a, LIVE));
    const uuid = a.calls.find((c) => c[0] === 'addFixedPriceItem')[1][0].uuid;
    expect(uuid).toMatch(/^[0-9A-F]{32}$/);
    const b = mkIO({ live: true, toAdd: [ready], fullProduct: () => full });
    await createPass(await ctxOf(b, LIVE));
    expect(b.calls.find((c) => c[0] === 'addFixedPriceItem')[1][0].uuid).toBe(uuid);
    expect(itemXml({ uuid, title: 'x', categoryId: '1', policies: {}, package: {} }, 'add')).toContain(`<UUID>${uuid}</UUID>`);
    expect(uuidDuplicateItemId([{ long: 'The UUID 123 has already been used.', short: '', params: ['123456789012'] }])).toBe('123456789012');
    expect(uuidDuplicateItemId([{ long: 'Title too long', short: '', params: [] }])).toBeNull();
  });
  test('D7: one fresh look at eBay first: a SKU or the style code already there means no Add', async () => {
    const t = mkIO({ live: true, toAdd: [ready], fullProduct: () => full, ebayRows: [{ item_id: '1', variation_key: 'S', sku: 'S', size: '9', price: 1, qty_available: 1, style: 'DD1391-100' }] });
    await createPass(await ctxOf(t, LIVE));
    expect(t.calls.filter((c) => c[0] === 'addFixedPriceItem')).toEqual([]);
    expect(t.logs.some((l) => l.action === 'skip_already_on_ebay')).toBe(true);
    const u = mkIO({ live: true, toAdd: [ready], fullProduct: () => ({ ...full, variants: [{ ...full.variants[0], sku: 'T' }] }),
      ebayRows: [{ item_id: '1', variation_key: 'Q', sku: 'Q', size: '9', price: 1, qty_available: 1, title: 'Same shoe (DD1391-100)', style: 'DD1391-100' }] });
    await createPass(await ctxOf(u, LIVE));
    expect(u.calls.filter((c) => c[0] === 'addFixedPriceItem')).toEqual([]);
  });
  test('D7: the manual action: one at a time per product, not while the create pass runs, only ACTIVE, relist needs a stored id', async () => {
    const t = mkIO({ live: true, fullProduct: () => full });
    t.io.write.addFixedPriceItem = async (d) => { t.calls.push(['addFixedPriceItem', [d]]); await new Promise((r) => setTimeout(r, 60)); return { ok: true, itemId: '999' }; };
    await ctxOf(t, LIVE);
    const [one, two] = await Promise.all([productAction('P9', 'list', { by: 'k', io: t.io }), productAction('P9', 'list', { by: 'k', io: t.io })]);
    expect([one.ok, two.ok].sort()).toEqual([false, true]);
    expect(t.calls.filter((c) => c[0] === 'addFixedPriceItem')).toHaveLength(1);
    const noId = mkIO({ live: true, fullProduct: () => full });
    await ctxOf(noId, LIVE);
    expect((await productAction('P9', 'relist', { by: 'k', io: noId.io })).error).toMatch(/no earlier/);
    expect(noId.calls).toEqual([]);
    const draft = mkIO({ live: true, fullProduct: () => ({ ...full, status: 'DRAFT' }) });
    await ctxOf(draft, LIVE);
    expect((await productAction('P9', 'list', { by: 'k', io: draft.io })).error).toMatch(/not active/);
    const busy = mkIO({ live: true, fullProduct: () => full, toVerify: [{ shopify_product_id: 'P9', shopify_key: 'k', issues: [] }] });
    await ctxOf(busy, LIVE);
    const slow = busy.io.db.toVerify; busy.io.db.toVerify = async () => { await new Promise((r) => setTimeout(r, 80)); return slow(); };
    const run = runPass('create', { io: busy.io });
    await new Promise((r) => setTimeout(r, 20));
    expect((await productAction('P9', 'list', { by: 'k', io: busy.io })).error).toMatch(/running/);
    await run;
  });
});

test.describe('D9: ending is checked live', () => {
  const light = [{ id: 'P1', title: TITLE, status: 'DRAFT', vendor: 'nike' }, { id: 'P2', title: 'L', status: 'ACTIVE', vendor: 'nike' }];
  const variants = [{ variantId: 'v-A', productId: 'P1', sku: 'A', size: '8', price: '100', qty: 1, status: 'DRAFT', productTitle: TITLE }, { variantId: 'v-B', productId: 'P1', sku: 'B', size: '9', price: '110', qty: 2, status: 'DRAFT', productTitle: TITLE }];
  const base = { live: true, light, variants, ebayRows: [
    { item_id: '111', variation_key: 'A', sku: 'A', size: '8', price: 100, qty_available: 1, title: TITLE }, { item_id: '111', variation_key: 'B', sku: 'B', size: '9', price: 110, qty_available: 2, title: TITLE }],
  productsState: async (ids) => ({ products: new Map(ids.map((id) => [id, { status: 'DRAFT' }])) }) };
  const run = async (over) => { const t = mkIO({ ...base, ...over }); await reconcilePass(await ctxOf(t, { ...ALL_LIVE, switches: { ...ALL_LIVE.switches, stock: 'shadow', price: 'shadow' } })); return t; };
  test('D9: ended through endEbayItem + the ends log, and gone from our ebay_listings copy', async () => {
    const t = await run({});
    expect(t.calls.filter((c) => c[0] === 'endEbayItem').map((c) => c[1][0])).toEqual(['111']);
    expect(t.dbCalls).toContainEqual(['dropListing', '111']);
  });
  test('D9: a SKU live on an ACTIVE product, or a size eBay has that we do not know, refuses the end', async () => {
    const active = await run({ stockForSku: async (sku) => ({ levels: [{ available: 1 }], tracked: true, productStatus: sku === 'A' ? 'ACTIVE' : 'DRAFT' }) });
    expect(active.calls.filter((c) => c[0] === 'endEbayItem')).toEqual([]);
    const unknown = await run({ fetchEbayItemContent: async () => ({ status: 'Active', variations: [{ sku: 'A' }, { sku: 'B' }, { sku: 'NEW' }] }) });
    expect(unknown.calls.filter((c) => c[0] === 'endEbayItem')).toEqual([]);
  });
});

test.describe('D10 + Oversell: new sizes only', () => {
  test('D10: a shared SKU is never added as a new size', async () => {
    const content = { status: 'Active', title: TITLE, description: '<p>x</p>', pictureCount: 1, specificsSet: { name: 'Size', values: ['8'] }, variations: [{ sku: 'OLD', size: '8', price: 1, quantity: 1, sold: 0 }] };
    const fp = { ...full, variants: [...full.variants, { sku: 'OLD', size: '8', barcode: '', price: '5', qty: 0 }] };
    const t = mkIO({ live: true, toCheck: [{ shopify_product_id: 'P9', item_id: '555', shopify_key: 'k' }], fullProduct: () => fp, fetchEbayItemContent: async () => content });
    await t.io.setState('ebay_sync_state_reconcile', JSON.stringify({ dupSkus: ['S'] }));
    await contentPass(await ctxOf(t, LIVE));
    expect(t.calls.filter((c) => c[0] === 'reviseFixedPriceItem')).toEqual([]);   // S is shared, so there is nothing to add
  });
  test('Oversell: no existing size is in the revise request; a new size carries the available number', async () => {
    const content = { status: 'Active', title: TITLE, description: '<p>x</p>', pictureCount: 1, specificsSet: { name: 'Size', values: ['8', '8.5'] },
      variations: [{ sku: 'OLD', size: '8', price: 99, quantity: 7, sold: 6 }, { sku: 'OLD2', size: '8.5', price: 99, quantity: 3, sold: 1 }] };
    const fp = { ...full, variants: [...full.variants, { sku: 'OLD', size: '8', barcode: '', price: '99', qty: 1 }, { sku: 'OLD2', size: '8.5', barcode: '', price: '99', qty: 2 }] };
    const t = mkIO({ live: true, toCheck: [{ shopify_product_id: 'P9', item_id: '555', shopify_key: 'k' }], fullProduct: () => fp, fetchEbayItemContent: async () => content });
    await contentPass(await ctxOf(t, LIVE));
    const [, data] = t.calls.find((c) => c[0] === 'reviseFixedPriceItem')[1];
    const xml = itemXml(data, 'revise', '555');
    expect(xml).not.toContain('OLD');
    expect(xml).toContain('<SKU>S</SKU>');
    expect(xml).toContain('<Quantity>2</Quantity>');   // Shopify has 2 available
    expect(xml).toContain('<Value>8</Value><Value>8.5</Value><Value>9</Value>');
    expect(xml.match(/<Variation>/g)).toHaveLength(1);
    expect(itemXml({ title: 'only title', invocationId: 'ABC' }, 'revise', '555')).not.toContain('<Variations>');
  });
});

test.describe('D11: the kill switch stops a running pass', () => {
  test('D11: pressed after the first 20 sizes, the next 20 are never sent', async () => {
    let t;
    t = mkIO({ live: true, linkCount: 1000, ebayRows: manyRows(25), variants: manyVariants(25), light: manyLight(25), prev: manyPrev(25), collection: manyLight(25).map((p) => p.id),
      onQty: () => { t.io.patchSettings({ kill: true }); } });
    await reconcilePass(await ctxOf(t, { ...ALL_LIVE, switches: { ...ALL_LIVE.switches, end: 'shadow', price: 'shadow' } }));
    expect(t.calls.filter((c) => c[0] === 'reviseEbayQuantities')).toHaveLength(1);
    expect(t.calls.find((c) => c[0] === 'reviseEbayQuantities')[1][0]).toHaveLength(20);
  });
});

test.describe('D12 + D17 + D16: the queue', () => {
  test('D17: one SKU that throws keeps only its own row; the others are processed and deleted', async () => {
    const rows = [{ id: 1, kind: 'sku', key: 'A' }, { id: 2, kind: 'sku', key: 'BAD' }];
    const t = mkIO({ live: true, linkCount: 100, queue: rows, linksBySku: async (sku) => [{ link_key: `${sku}`, item_id: '111', sku, variation_key: sku, ebay_qty: 3 }],
      stockForSku: async (sku) => { if (sku === 'BAD') throw new Error('boom'); return { levels: [{ available: 1 }], tracked: true }; } });
    await queuePass(await ctxOf(t, ALL_LIVE));
    expect(t.calls.filter((c) => c[0] === 'reviseEbayQuantities')).toHaveLength(1);
    expect(t.dbCalls.find((c) => c[0] === 'queueDone')[1]).toEqual([1]);
  });
  test('D16: no stock levels, or an untracked item, never sends 0', async () => {
    for (const answer of [{ levels: [], tracked: true }, { levels: [{ available: 0 }], tracked: false }, { error: 'x', code: 'error' }]) {
      const t = mkIO({ live: true, linkCount: 100, queue: [{ id: 1, kind: 'sku', key: 'A' }], linksBySku: async () => [{ link_key: 'k', item_id: '111', sku: 'A', variation_key: 'A', ebay_qty: 3 }], stockForSku: async () => answer });
      await queuePass(await ctxOf(t, ALL_LIVE));
      expect(t.calls.filter((c) => c[0] === 'reviseEbayQuantities')).toEqual([]);
    }
  });
  test('D12: the delete is guarded by claimed_at (checked against the real SQL in ebay-sync-db.spec.js)', () => {
    expect(fs.readFileSync('api/_lib/db.js', 'utf8')).toContain('WHERE id = ANY(${ids}::bigint[]) AND claimed_at IS NOT NULL');
  });
});

test.describe('D13: read again right before writing', () => {
  test('D13: a lock added after the reconcile read it still stops the price write', async () => {
    const t = mkIO({ live: true, lockedFn: (n) => (n === 1 ? [] : ['111']) });
    await reconcilePass(await ctxOf(t, ALL_LIVE));
    expect(t.calls.filter((c) => c[0] === 'reviseEbayPrices')).toEqual([]);
  });
  test('D13: stock is read from Shopify live and that number is sent, not the reconcile\'s', async () => {
    const t = mkIO({ live: true, locked: ['222'], stockForSku: async (sku) => ({ levels: [{ available: sku === 'A' ? 5 : 2 }], tracked: true }) });
    await reconcilePass(await ctxOf(t, ALL_LIVE));
    expect(t.calls.find((c) => c[0] === 'reviseEbayQuantities')[1][0]).toEqual([{ key: '111|A', itemId: '111', sku: 'A', qty: 5 }]);
  });
  test('D13: a sized revise reads the listing again first', async () => {
    let reads = 0;
    const content = { status: 'Active', title: TITLE, description: '<p>x</p>', pictureCount: 1, specificsSet: { name: 'Size', values: ['8'] }, variations: [{ sku: 'OLD', size: '8', price: 1, quantity: 1, sold: 0 }] };
    const fp = { ...full, variants: [...full.variants, { sku: 'OLD', size: '8', barcode: '', price: '5', qty: 0 }] };
    const t = mkIO({ live: true, toCheck: [{ shopify_product_id: 'P9', item_id: '555', shopify_key: 'k' }], fullProduct: () => fp, fetchEbayItemContent: async () => { reads++; return content; } });
    await contentPass(await ctxOf(t, LIVE));
    expect(reads).toBe(2);
    expect(t.calls.filter((c) => c[0] === 'reviseFixedPriceItem')).toHaveLength(1);
  });
});

test.describe('D14: relist', () => {
  const row = { shopify_product_id: 'P9', shopify_key: 'k', item_id: '777', last_prices: { S: 150 } };
  test('D14: a relist keeps the price we do not own, moves locks and reprice history to the new id, and is not a plain Add', async () => {
    const t = mkIO({ live: true, toAdd: [row], fullProduct: () => full });
    await createPass(await ctxOf(t, LIVE));
    const [oldId, data] = t.calls.find((c) => c[0] === 'relistFixedPriceItem')[1];
    expect(oldId).toBe('777');
    expect(data.variations[0]).toMatchObject({ sku: 'S', price: 150, qty: 2 });
    expect(data.uuid).toMatch(/^[0-9A-F]{32}$/);
    expect(t.dbCalls).toContainEqual(['moveItemId', '777', '998']);
    expect(t.calls.filter((c) => c[0] === 'addFixedPriceItem')).toEqual([]);
  });
  test('D14: relists count in the daily cap', async () => {
    const t = mkIO({ live: true, toAdd: [row], fullProduct: () => full, liveTodayBy: { add: 10, relist: 15 } });
    await createPass(await ctxOf(t, LIVE));
    expect(t.dbCalls.find((c) => c[0] === 'toAdd')[1]).toBe(0);
    expect(t.calls.filter((c) => c[0] === 'relistFixedPriceItem')).toEqual([]);
  });
  test('D14: a listing that vanished is "ended by stock" unless somebody ended it through the app; the ended id is kept', async () => {
    const mk = (endedByApp) => mkIO({
      light: [{ id: 'P9', title: TITLE, status: 'ACTIVE', vendor: 'n', updatedAt: 'x' }], variants: [{ variantId: 'v', productId: 'P9', sku: 'S', size: '9', price: '1', qty: 2, status: 'ACTIVE' }], ebayRows: [
        { item_id: '1', variation_key: 'Q', sku: 'Q', size: '9', price: 1, qty_available: 1, title: 'Other' }], collection: ['P9'], prev: [],
      productPrev: [{ shopify_product_id: 'P9', item_id: '777', status: 'uploaded' }], endedByApp,
    });
    const a = mk([]);
    await reconcilePass(await ctxOf(a, {}));
    expect(a.saved.products.find((p) => p.id === 'P9').ended_by_stock).toBe(true);
    const b = mk(['777']);
    await reconcilePass(await ctxOf(b, {}));
    expect(b.saved.products.find((p) => p.id === 'P9').ended_by_stock).toBe(false);
  });
});

test.describe('D15: a price we never owned is kept', () => {
  const P = (ebay, shop, rule = 'follows_shopify') => ({ price_rule: rule, ebay_price: ebay, shopify_price: shop });
  test('D15: the rule table', () => {
    expect(priceRule({ ebayPrice: 100, shopifyPrice: 100 })).toBe('follows_shopify');                       // no history, equal
    expect(priceRule({ ebayPrice: 120, shopifyPrice: 100 })).toBe('kept_manual');                           // no history, differs
    expect(priceRule({ ebayPrice: 100, shopifyPrice: 130, prev: P(100, 100) })).toBe('follows_shopify');    // Shopify moved
    expect(priceRule({ ebayPrice: 100, shopifyPrice: 130, prev: P(100, 130) })).toBe('follows_shopify');    // still catching up: unchanged both sides
    expect(priceRule({ ebayPrice: 150, shopifyPrice: 100, prev: P(100, 100) })).toBe('kept_manual');        // someone changed eBay
    expect(priceRule({ ebayPrice: 150, shopifyPrice: 100, prev: P(150, 100, 'kept_manual') })).toBe('kept_manual');
    expect(priceRule({ ebayPrice: 100, shopifyPrice: 100, prev: P(150, 100, 'kept_manual') })).toBe('follows_shopify');   // equal again
    expect(priceRule({ ebayPrice: 150, shopifyPrice: 100, locked: true })).toBe('kept_lock');
    expect(priceRule({ ebayPrice: 150, shopifyPrice: 100, edited: true })).toBe('kept_repriced');
  });
  test('D15: a manually priced size is never written, even live', async () => {
    const t = mkIO({ live: true, prev: [], locked: [] });
    await reconcilePass(await ctxOf(t, ALL_LIVE));
    expect(t.calls.filter((c) => c[0] === 'reviseEbayPrices')).toEqual([]);
    expect(t.saved.links.find((l) => l.sku === 'B')).toMatchObject({ price_rule: 'kept_manual', state: 'price_kept' });
  });
});

test.describe('D18: the rest', () => {
  test('D18: an empty Shopify description is not drift and is never sent', () => {
    const built = buildListing({ ...full, descriptionHtml: '  <p> </p> ' }, {});
    expect(contentDiff({ title: TITLE, description: '<p>live text</p>', pictureCount: 1, variations: [{ sku: 'S' }] }, built).fields).not.toContain('description');
  });
  test('D18: writes need an allowed server: without EBAY_SYNC_WRITES or production, a live switch writes nothing', async () => {
    const was = [process.env.EBAY_SYNC_WRITES, process.env.RAILWAY_ENVIRONMENT_NAME];
    delete process.env.EBAY_SYNC_WRITES; delete process.env.RAILWAY_ENVIRONMENT_NAME;
    try {
      expect(canWrite(normalizeSettings({ switches: { stock: 'live' } }), 'stock')).toBe(false);
      const t = mkIO({ locked: ['222'] });   // writers throw if touched
      await reconcilePass(await ctxOf(t, ALL_LIVE));
      expect(t.calls).toEqual([]);
      process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
      expect(canWrite(normalizeSettings({ switches: { stock: 'live' } }), 'stock')).toBe(true);
    } finally { process.env.EBAY_SYNC_WRITES = was[0]; if (was[1] === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME; else process.env.RAILWAY_ENVIRONMENT_NAME = was[1]; }
  });
  test('D18: profile values are checked; offsets are floored and garbage refused', () => {
    const ok = { categoryId: '15709', conditionId: 1000, postalCode: '17545', location: 'X', collection: 'Footwear', uplift: 0, policies: { shipping: '325744987021', return: '325744597021', payment: '325744328021' } };
    expect(validateProfile(ok)).toBeNull();
    expect(validateProfile({ ...ok, uplift: 150 })).toMatch(/uplift/);
    expect(validateProfile({ ...ok, uplift: -1 })).toMatch(/uplift/);
    expect(validateProfile({ ...ok, policies: { ...ok.policies, return: '' } })).toMatch(/return/);
    expect(validateProfile({ ...ok, categoryId: '' })).toMatch(/categoryId/);
    expect([pageOffset('2.9'), pageOffset(''), pageOffset(null), pageOffset('-1'), pageOffset('abc'), pageOffset('Infinity')]).toEqual([2, 0, 0, null, null, null]);
  });
});

test.describe('Zero: a stock push to 0 that takes the last size ends the listing', () => {
  test('Zero: endsByZero finds only listings with every size at 0', () => {
    const l = (k, q) => ({ link_key: k, item_id: 'I', ebay_qty: q });
    expect(endsByZero([{ link: l('a', 1), qty: 0 }], () => [l('a', 1), l('b', 0)])).toEqual(['I']);
    expect(endsByZero([{ link: l('a', 1), qty: 0 }], () => [l('a', 1), l('b', 2)])).toEqual([]);
  });
  test('Zero: live, it is logged as an end and counts toward end\'s window; in shadow it is logged as "would end"', async () => {
    const mk = (live) => mkIO({ live, linkCount: 100, listingCount: 100, queue: [{ id: 1, kind: 'sku', key: 'A' }], links: [{ link_key: 'k', item_id: '111', sku: 'A', ebay_qty: 3, title: 'T' }],
      linksBySku: async () => [{ link_key: 'k', item_id: '111', sku: 'A', variation_key: 'A', ebay_qty: 3 }], stockForSku: async () => ({ levels: [{ available: 0 }], tracked: true }) });
    const t = mk(true);
    await queuePass(await ctxOf(t, ALL_LIVE));
    expect(t.logs.find((l) => l.domain === 'end' && l.action === 'end_listing')).toMatchObject({ mode: 'live', itemId: '111' });
    expect(await t.io.db.liveCount('end', 'end_listing')).toBe(1);
    const w = mk(true);
    const full1 = await ctxOf(w, LIVE);
    w.io.db.liveCount = async (d, a) => (d === 'end' ? 10 : 0);   // ten ends already this hour
    await queuePass(full1);
    expect(w.calls.filter((c) => c[0] === 'reviseEbayQuantities')).toEqual([]);   // blocked by end's window
    expect(w.alerts[0].title).toMatch(/stopped/);
  });
});
