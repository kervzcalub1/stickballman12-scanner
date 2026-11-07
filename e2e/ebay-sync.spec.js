// eBay Sync (docs/ebay-sync-plan.md, docs/context/ebay-sync.md): stock, price, content, new listings,
// ending. Neither eBay nor Shopify is ever reached: the engine runs against a mocked IO whose
// every writer records what it was called with. What this pins:
//   · in shadow, off and under the kill switch NO write function is called (they throw if touched);
//   · a kept price (lock, or already repriced by our tool) is never written, even live;
//   · a Shopify read that is truncated / errored / shrank aborts the pass without touching anything;
//   · the blast limit stops a live pass and alerts;
//   · a draft / deleted product ends its listing (live, re-read first, via endEbayItem + ebay_listing_ends),
//     while a SKU that merely left Shopify is only reported (no_shopify);
//   · links by exact SKU (duplicates flagged, never guessed); the 87-character title; the listing
//     builder matches DPL's fields; eBay's errors in plain words.
import { test, expect } from '@playwright/test';
import {
  normalizeSettings, canWrite, buildLinks, stockDecision, priceDecision, decideLink, buildListing, precheck, shorterTitle, translateEbayErrors,
  contentDiff, blastCheck, readGuard, handoverChecklist, driftSince, driftPersists, productKey,
} from '../src/lib/ebaySync.js';
import { itemXml, parseItemContent } from '../api/_lib/ebay.js';
import { saveSettings, reconcilePass, queuePass, contentPass, createPass, runPass, productAction, readSettings } from '../api/_lib/ebay-sync.js';
import { routeShopifyWebhook } from '../api/shopify/webhook.js';
import { mkIO, ctxOf, NOW, OLD, TITLE, PROFILE, ALL_LIVE } from './helpers/ebaySyncIO.js';

// Live paths need a server that may write; the test process stands in for production.
process.env.EBAY_SYNC_WRITES = 'on';

/* ------------------------------ the pure lib ------------------------------ */

test.describe('eBay Sync: settings', () => {
  test('every switch defaults to shadow; garbage never becomes live; kill beats live', () => {
    const d = normalizeSettings(null);
    expect(d.switches).toEqual({ stock: 'shadow', price: 'shadow', content: 'shadow', create: 'shadow', end: 'shadow' });
    expect(d).toMatchObject({ kill: false, blastPct: 10 });
    expect(normalizeSettings({ switches: { stock: 'LIVE!', price: 'live' }, blastPct: 'x' }).switches).toMatchObject({ stock: 'shadow', price: 'live' });
    expect(canWrite(normalizeSettings({ switches: { stock: 'live' } }), 'stock')).toBe(true);
    expect(canWrite(normalizeSettings({ switches: { stock: 'live' }, kill: true }), 'stock')).toBe(false);
    expect(canWrite(d, 'stock')).toBe(false);
  });
  test('a settings change is logged with who', async () => {
    const t = mkIO();
    await saveSettings({ switches: { stock: 'live' }, kill: true }, 'kevin', t.io);
    expect(t.logs.map((l) => [l.action, l.by])).toEqual([['switch stock', 'kevin'], ['kill', 'kevin']]);
  });
});

test.describe('eBay Sync: links, stock, price', () => {
  test('link by EXACT SKU; a SKU used twice is flagged, never guessed', () => {
    const ebayRows = [
      { item_id: '1', variation_key: 'A', sku: 'A', size: '8', price: 100, qty_available: 1 },
      { item_id: '1', variation_key: 'D', sku: 'D', size: '9', price: 100, qty_available: 1 },
      { item_id: '2', variation_key: 'D', sku: 'D', size: '9', price: 100, qty_available: 1 },
      { item_id: '1', variation_key: 'X', sku: 'X', size: '10', price: 100, qty_available: 1 },
      { item_id: '1', variation_key: 'Z', sku: 'a', size: '7', price: 100, qty_available: 1 },
    ];
    const variants = [
      { variantId: 'vA', productId: 'P', sku: 'A', size: '8', price: '100', qty: 1, status: 'ACTIVE' },
      { variantId: 'vD1', productId: 'P', sku: 'D', size: '9', price: '100', qty: 1, status: 'ACTIVE' },
      { variantId: 'vD2', productId: 'Q', sku: 'D', size: '9', price: '100', qty: 1, status: 'ACTIVE' },
      { variantId: 'vN', productId: 'P', sku: 'N', size: '11', price: '100', qty: 2, status: 'ACTIVE' },
      { variantId: 'vO', productId: 'P', sku: 'O', size: '12', price: '100', qty: 0, status: 'ACTIVE' },
    ];
    const { links, dupShopify, dupEbay } = buildLinks({ ebayRows, variants });
    const by = (item, sku) => links.find((l) => l.item_id === item && l.sku === sku);
    expect(by('1', 'A').base).toBe('linked');
    expect(by('1', 'D').base).toBe('duplicate');
    expect(by('2', 'D').base).toBe('duplicate');
    expect(by('1', 'D').shopify_variant_id).toBeNull();
    expect(by('1', 'X').base).toBe('no_shopify');
    expect(by('1', 'a').base).toBe('no_shopify');            // exact: "a" is not "A"
    expect(links.find((l) => l.sku === 'N' && l.item_id === '').base).toBe('not_on_ebay');
    expect(links.find((l) => l.sku === 'O')).toBeUndefined();   // 0 stock, not on eBay: nothing to say
    expect([...dupShopify, ...dupEbay]).toContain('D');
  });
  test('stock: max(0, Shopify) from a complete read; a size with no Shopify variant is reported, never zeroed', () => {
    expect(stockDecision({ hasVariant: true, shopifyQty: -2, ebayQty: 1, shopifyComplete: true })).toEqual({ action: 'set', target: 0 });
    expect(stockDecision({ hasVariant: true, shopifyQty: 3, ebayQty: 3, shopifyComplete: true }).action).toBe('none');
    expect(stockDecision({ hasVariant: true, shopifyQty: 0, ebayQty: 4, shopifyComplete: false }).action).toBe('none');
    expect(stockDecision({ hasVariant: false, ebayQty: 4 }).action).toBe('report');
  });
  test('price: a lock or a successful reprice is KEPT; otherwise Shopify x uplift', () => {
    expect(priceDecision({ ebayPrice: 200, shopifyPrice: 90, locked: true })).toMatchObject({ rule: 'kept_lock', action: 'none' });
    expect(priceDecision({ ebayPrice: 200, shopifyPrice: 90, edited: true })).toMatchObject({ rule: 'kept_repriced', action: 'none' });
    const was = { price_rule: 'follows_shopify', ebay_price: 110, shopify_price: 100 };   // last pass: eBay equalled Shopify x 1.10
    expect(priceDecision({ ebayPrice: 110, shopifyPrice: 130, uplift: 10, prev: was })).toEqual({ rule: 'follows_shopify', target: 143, action: 'set' });
    expect(priceDecision({ ebayPrice: 100, shopifyPrice: 130, uplift: 10 })).toMatchObject({ rule: 'kept_manual', action: 'none' });   // no history: never overwrite
    expect(priceDecision({ ebayPrice: 143, shopifyPrice: 130, uplift: 10 }).action).toBe('none');
    const d = decideLink({ base: 'linked', item_id: '9', variation_key: 'K', ebay_qty: 1, shopify_qty: 1, ebay_price: 200, shopify_price: 90 }, { lockedItems: new Set(['9']) });
    expect(d).toMatchObject({ state: 'price_kept', price_rule: 'kept_lock' });
  });
  test('drift only counts once it has been seen on an earlier pass', () => {
    const first = driftSince(null, true, NOW);
    expect(driftPersists(first, NOW)).toBe(false);
    expect(driftPersists(OLD, NOW)).toBe(true);
    expect(driftSince(OLD, false, NOW)).toBeNull();
    expect(new Date(driftSince(OLD, true, NOW)).toISOString()).toBe(new Date(OLD).toISOString());
  });
  test('blast + read guards', () => {
    expect(blastCheck({ changes: 300, total: 2330, blastPct: 10 }).stop).toBe(true);
    expect(blastCheck({ changes: 4, total: 2330, blastPct: 10 }).stop).toBe(false);
    expect(readGuard({ shopify: { error: 'x' } }).ok).toBe(false);
    expect(readGuard({ shopify: { variants: [1], truncated: true } }).ok).toBe(false);
    expect(readGuard({ shopify: { variants: Array(80).fill(1) }, lastShopifyCount: 100 }).ok).toBe(false);
    expect(readGuard({ shopify: { variants: Array(95).fill(1) }, lastShopifyCount: 100, ebayRows: Array(95).fill(1), lastEbayRows: 100 }).ok).toBe(true);
  });
});

test.describe('eBay Sync: the listing', () => {
  const product = {
    id: 'P1', title: TITLE, vendor: 'adidas', descriptionHtml: '<p>Great shoe</p>',
    images: Array.from({ length: 14 }, (_, i) => ({ url: `https://cdn.shopify.com/${i}.jpg`, width: 1200, height: 1200 })),
    variants: [
      { sku: '1011', size: '10', barcode: '1011', price: '150.00', qty: 2 },
      { sku: '1009', size: '9.5', barcode: '1009', price: '140.00', qty: 1 },
      { sku: '1008', size: '9', barcode: '1008', price: '140.00', qty: 0 },
    ],
  };
  test('builder output matches DPL: verbatim title/description, Brand = vendor, Style Code, Size variation, a real UPC only, stocked sizes only, 12 pictures', () => {
    const l = buildListing(product, PROFILE);
    expect(l).toMatchObject({ title: TITLE, description: '<p>Great shoe</p>', categoryId: '15709', conditionId: 1000, duration: 'GTC', dispatchDays: 1, location: 'Manheim, Pennsylvania', postalCode: '17545', sizeName: 'Size' });
    expect(l.policies).toEqual({ shipping: '325744987021', return: '325744597021', payment: '325744328021' });
    expect(l.package).toMatchObject({ length: 16, width: 12, depth: 6, weightLbs: 4, type: 'PackageThickEnvelope' });
    expect(l.specifics).toEqual([['Brand', 'Adidas'], ['Color', 'Multicolor'], ['Department', 'Unisex Adults'], ['Style', 'Sneaker'], ['Upper Material', 'Leather'], ['Type', 'Sneaker'], ['Style Code', 'DD1391-100']]);
    expect(l.variations).toEqual([{ sku: '1009', size: '9.5', upc: 'Does not apply', price: 140, qty: 1 }, { sku: '1011', size: '10', upc: 'Does not apply', price: 150, qty: 2 }]);
    expect(l.sizeValues).toEqual(['9.5', '10']);
    expect(l.pictures).toHaveLength(12);
    expect(buildListing(product, { ...PROFILE, uplift: 10 }).variations[0].price).toBe(154);
  });
  test('a real UPC goes through; the 8-digit SKU-as-barcode eBay refuses does not', () => {
    const one = (barcode) => buildListing({ title: 'Nike Dunk (DD1391-100)', vendor: 'Nike', descriptionHtml: '<p>x</p>', images: ['https://x/a.jpg'], variants: [{ sku: '1009', size: '9', barcode, price: '100.00', qty: 1 }] }, PROFILE).variations[0].upc;
    expect(one('10120482')).toBe('Does not apply');
    expect(one('')).toBe('Does not apply');
    expect(one('196969000000')).toBe('196969000000');
  });

  test('Trading XML carries the same fields', () => {
    const x = itemXml(buildListing(product, PROFILE), 'add');
    for (const s of ['<CategoryID>15709</CategoryID>', '<ConditionID>1000</ConditionID>', '<ListingDuration>GTC</ListingDuration>', '<ShippingProfileID>325744987021</ShippingProfileID>',
      '<Name>Brand</Name><Value>Adidas</Value>', '<Name>Style Code</Name><Value>DD1391-100</Value>', '<PostalCode>17545</PostalCode>', '<UPC>Does not apply</UPC>',
      '<VariationSpecificsSet><NameValueList><Name>Size</Name><Value>9.5</Value><Value>10</Value>', '<![CDATA[<p>Great shoe</p>]]>']) expect(x).toContain(s);
    expect(x.match(/<PictureURL>/g)).toHaveLength(12);
    const r = itemXml({ title: 'New title' }, 'revise', '123');
    expect(r).toBe('<Item><ItemID>123</ItemID><Title>New title</Title></Item>');
  });
  test('an 87-character title is an issue with the length and a shorter title that fits', () => {
    const long = "Nike Air Jordan 1 Retro High OG Mens Basketball Shoes Sneakers Chicago Lost And Found (DZ5485-612)";
    expect(long.length).toBeGreaterThan(80);
    const p = { ...product, title: long };
    const issues = precheck(p, buildListing(p, PROFILE));
    const issue = issues.find((i) => i.code === 'title_long');
    expect(issue.message).toContain(`${long.length} characters`);
    expect(issue.message).toContain('80');
    const suggestion = issue.fix.match(/"(.+)"/)[1];
    expect(suggestion.length).toBeLessThanOrEqual(80);
    expect(suggestion).toContain('DZ5485-612');
    expect(shorterTitle(TITLE)).toBe(TITLE);
  });
  test('precheck: no photo, small photo, no description, no SKU, duplicate SKU, price 0, no style', () => {
    const bad = { ...product, title: 'Plain shoe', descriptionHtml: ' <p> </p> ', images: [], variants: [{ sku: '', size: '8', price: '0', qty: 1 }, { sku: 'D', size: '9', price: '10', qty: 1 }] };
    const codes = precheck(bad, buildListing(bad, PROFILE), { dupSkus: new Set(['D']) }).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['no_photo', 'no_description', 'no_sku', 'duplicate_sku', 'price_zero', 'no_style']));
    const small = { ...product, images: [{ url: 'u', width: 300, height: 200 }] };
    expect(precheck(small, buildListing(small, PROFILE)).map((i) => i.code)).toContain('photo_small');
    expect(precheck(product, buildListing(product, PROFILE))).toEqual([]);
  });
  test('eBay errors become {code,message,fix}', () => {
    const t = translateEbayErrors([{ code: '21919', long: 'Item specifics are missing.' }, { code: '', long: 'Add at least 1 photo to continue.' }, { code: '', long: 'The title is too long.' },
      { code: '', long: 'Variation specifics are required.' }, { code: '', long: 'Quantity is not valid.' }, { code: '', long: 'Start price is not valid.' }, { code: '21916', long: 'Something about SKUs' }]);
    expect(t.map((x) => x.code)).toEqual(['specifics_invalid', 'photo_small', 'title_long', 'variation_required', 'quantity_invalid', 'price_invalid', 'variation_invalid']);
    for (const x of t) { expect(x.message).toBeTruthy(); expect(x.fix).toBeTruthy(); }
    expect(translateEbayErrors('weird')[0].code).toBe('ebay_error');
  });
  test('content diff: title, description, picture count, new sizes; a size Shopify has at 0 is not drift', () => {
    const built = buildListing(product, PROFILE);
    const same = { title: TITLE, description: '<P>Great  shoe</P>', pictureCount: 12, variations: [{ sku: '1009' }, { sku: '1011' }, { sku: 'OLD' }] };
    expect(contentDiff(same, built).drift).toBe(false);
    const d = contentDiff({ ...same, title: 'Old title', pictureCount: 3, variations: [{ sku: '1009' }] }, built);
    expect(d.fields).toEqual(['title', 'pictures', 'sizes']);
    expect(d.addSizes).toEqual([{ sku: '1011', size: '10' }]);
  });
  test('GetItem content parses (CDATA description, sizes with sold)', () => {
    const c = parseItemContent(`<GetItemResponse><Item><ItemID>5</ItemID><Title>T &amp; U</Title><Description><![CDATA[<p>d</p>]]></Description>
      <PictureDetails><PictureURL>a</PictureURL><PictureURL>b</PictureURL></PictureDetails><SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus>
      <Variations><Variation><SKU>S1</SKU><StartPrice>10</StartPrice><Quantity>3</Quantity><SellingStatus><QuantitySold>1</QuantitySold></SellingStatus>
      <VariationSpecifics><NameValueList><Name>Size</Name><Value>9</Value></NameValueList></VariationSpecifics></Variation></Variations></Item></GetItemResponse>`);
    expect(c).toMatchObject({ item_id: '5', title: 'T & U', description: '<p>d</p>', pictureCount: 2, status: 'Active' });
    expect(c.variations[0]).toMatchObject({ sku: 'S1', size: '9', price: 10, quantity: 3, sold: 1, available: 2 });
  });
  test('hand-over checklist covers stock, price, content and listing only', () => {
    const c = handoverChecklist({ observedDays: 8, qtyDrift: 0, priceDrift: 0, contentLive: 2, createLive: 1 });
    expect(c.map((r) => r.key)).toEqual(['days', 'stock_drift', 'price_drift', 'content_live', 'create_live']);
    expect(c.every((r) => r.ok)).toBe(true);
    expect(handoverChecklist({ observedDays: 3 }).find((r) => r.key === 'days').ok).toBe(false);
    expect(productKey('a', ['x', 'y'])).toBe(productKey('a', ['y', 'x']));
  });
});

/* -------------------------------- the engine -------------------------------- */

test.describe('eBay Sync: no write in shadow, off or kill', () => {
  for (const [name, patch] of [
    ['shadow (the default)', {}],
    ['off', { switches: { stock: 'off', price: 'off', content: 'off', create: 'off', end: 'off' } }],
    ['kill switch with every switch live', { ...ALL_LIVE, kill: true }],
  ]) {
    test(`reconcile under ${name} calls no writer`, async () => {
      const t = mkIO({ productsLight: async () => ({ products: [{ id: 'P1', title: TITLE, status: 'DRAFT', vendor: 'nike' }, { id: 'P2', title: 'L', status: 'ACTIVE', vendor: 'nike' }] }),
        productsState: async (ids) => ({ products: new Map(ids.map((id) => [id, { status: 'DRAFT' }])) }) });
      const ctx = await ctxOf(t, patch);
      const r = await reconcilePass(ctx);
      expect(t.calls).toEqual([]);
      if (name.startsWith('shadow')) {
        expect(t.logs.filter((l) => l.mode === 'shadow').map((l) => l.action).sort()).toEqual(['end_listing', 'set_price', 'set_qty']);
        expect(r.stock.would).toBe(1);
      }
      if (name !== 'off') expect(t.saved.links).toBeTruthy();   // reading and recording still happen; with everything off the pass reads nothing
      else expect(t.saved.links).toBeNull();
    });
  }
  test('queue, content and create passes under kill call no writer either', async () => {
    const full = { id: 'P9', title: TITLE, status: 'ACTIVE', vendor: 'nike', descriptionHtml: '<p>x</p>', images: [{ url: 'u', width: 900, height: 900 }], variants: [{ sku: 'S', size: '9', barcode: 'S', price: '100', qty: 2 }] };
    const t = mkIO({
      queue: [{ id: 1, kind: 'sku', key: 'A' }], linksBySku: async () => [{ link_key: '111|A', item_id: '111', sku: 'A', ebay_qty: 1 }], stockForSku: async () => ({ levels: [{ available: 0 }] }),
      toCheck: [{ shopify_product_id: 'P9', item_id: '555' }], fullProduct: () => full,
      fetchEbayItemContent: async () => ({ title: 'Different', description: 'x', pictureCount: 1, variations: [] }),
      toVerify: [{ shopify_product_id: 'P9', shopify_key: 'k', issues: [] }], toAdd: [{ shopify_product_id: 'P9', shopify_key: 'k' }],
    });
    const ctx = await ctxOf(t, { ...ALL_LIVE, kill: true });
    await queuePass(ctx); await contentPass(ctx); await createPass(ctx);
    expect(t.calls).toEqual([]);
    expect(t.logs.some((l) => l.domain === 'content' && l.mode === 'shadow')).toBe(true);
    expect(t.logs.some((l) => l.domain === 'create' && l.action === 'add' && l.mode === 'shadow')).toBe(true);
  });
});

test.describe('eBay Sync: live writes', () => {
  test('live: stock goes out, and a KEPT price (lock) is never written while the follower is', async () => {
    const t = mkIO({ live: true, locked: ['222'] });
    const ctx = await ctxOf(t, ALL_LIVE);
    await reconcilePass(ctx);
    const qty = t.calls.find((c) => c[0] === 'reviseEbayQuantities');
    const price = t.calls.find((c) => c[0] === 'reviseEbayPrices');
    expect(qty[1][0]).toEqual([{ key: '111|A', itemId: '111', sku: 'A', qty: 0 }]);
    expect(price[1][0]).toEqual([{ key: '111|B', itemId: '111', sku: 'B', price: 130 }]);
    expect(JSON.stringify(t.calls)).not.toContain('"L"');
  });
  test('live: a size our reprice tool already sent is never written either', async () => {
    const t = mkIO({ live: true, repriced: ['111|B'], locked: ['222'] });
    const ctx = await ctxOf(t, ALL_LIVE);
    await reconcilePass(ctx);
    expect(t.calls.find((c) => c[0] === 'reviseEbayPrices')).toBeUndefined();
    expect(t.saved.links.find((l) => l.sku === 'B')).toMatchObject({ price_rule: 'kept_repriced', state: 'price_kept' });
    expect(t.saved.links.find((l) => l.sku === 'L')).toMatchObject({ price_rule: 'kept_lock', state: 'price_kept' });
  });
  test('drift seen for the first time is recorded but not sent', async () => {
    const t = mkIO({ live: true, prev: [], locked: ['222'] });
    await reconcilePass(await ctxOf(t, ALL_LIVE));
    expect(t.calls).toEqual([]);
    expect(t.saved.links.find((l) => l.sku === 'A').qty_drift_since).toBeTruthy();
  });
  test('blast limit: a live pass that would change too much stops, sends nothing and alerts', async () => {
    const t = mkIO({ live: true, locked: ['222'] });
    const ctx = await ctxOf(t, { switches: { stock: 'live', price: 'live', content: 'shadow', create: 'shadow', end: 'shadow' }, blastPct: 10 });
    await reconcilePass(ctx);
    expect(t.calls).toEqual([]);
    expect(t.alerts.map((a) => a.title)).toEqual(expect.arrayContaining([expect.stringContaining('stopped')]));
    expect(t.logs.some((l) => l.action === 'blast_stop')).toBe(true);
  });
  test('a truncated, errored or shrunken Shopify read aborts without touching anything', async () => {
    for (const allVariants of [
      async () => ({ variants: [], truncated: true }), async () => ({ error: 'timeout' }),
    ]) {
      const t = mkIO({ live: true, allVariants });
      const r = await reconcilePass(await ctxOf(t, ALL_LIVE));
      expect(r.aborted).toBe(true);
      expect(t.calls).toEqual([]);
      expect(t.saved.links).toBeNull();
      expect(t.alerts).toHaveLength(1);
    }
    const t = mkIO({ live: true });
    await t.io.setState('ebay_sync_state_reconcile', JSON.stringify({ lastShopifyCount: 100 }));
    const r = await reconcilePass(await ctxOf(t, ALL_LIVE));
    expect(r.aborted).toBe(true);
    expect(t.calls).toEqual([]);
  });
  test('ending: a DRAFT product ends its listing (live) through endEbayItem + the ends log; a SKU that only left Shopify does not', async () => {
    const light = [{ id: 'P1', title: TITLE, status: 'DRAFT', vendor: 'nike' }, { id: 'P2', title: 'L', status: 'ACTIVE', vendor: 'nike' }];
    const variants = [
      { variantId: 'v-A', productId: 'P1', sku: 'A', size: '8', price: '100', qty: 1, status: 'DRAFT', productTitle: TITLE },
      { variantId: 'v-B', productId: 'P1', sku: 'B', size: '9', price: '110', qty: 2, status: 'DRAFT', productTitle: TITLE },
      // L left Shopify entirely: item 222 must only be reported
    ];
    const t = mkIO({ live: true, light, variants, productsState: async (ids) => ({ products: new Map(ids.map((id) => [id, { status: 'DRAFT' }])) }) });
    const r = await reconcilePass(await ctxOf(t, { ...ALL_LIVE, switches: { ...ALL_LIVE.switches, stock: 'shadow', price: 'shadow' } }));
    const ended = t.calls.filter((c) => c[0] === 'endEbayItem');
    expect(ended.map((c) => c[1][0])).toEqual(['111']);
    expect(t.calls.find((c) => c[0] === 'logEbayEnd')[1][0]).toMatchObject({ itemId: '111', ok: true, by: 'eBay Sync' });
    expect(t.saved.links.find((l) => l.sku === 'L').state).toBe('no_shopify');
    expect(r.ends.ended).toBe(1);
  });
  test('ending re-reads Shopify live: a product that is ACTIVE again is not ended', async () => {
    const t = mkIO({ live: true, light: [{ id: 'P1', title: TITLE, status: 'DRAFT', vendor: 'nike' }, { id: 'P2', title: 'L', status: 'ACTIVE', vendor: 'nike' }],
      productsState: async (ids) => ({ products: new Map(ids.map((id) => [id, { status: 'ACTIVE' }])) }) });
    await reconcilePass(await ctxOf(t, { ...ALL_LIVE, switches: { ...ALL_LIVE.switches, stock: 'shadow', price: 'shadow' } }));
    expect(t.calls.filter((c) => c[0] === 'endEbayItem')).toEqual([]);
  });
  test('queue pass: a webhook SKU goes to eBay only when stock is live', async () => {
    const mk = () => mkIO({ live: true, queue: [{ id: 1, kind: 'sku', key: 'A' }], linksBySku: async () => [{ link_key: '111|A', item_id: '111', sku: 'A', variation_key: 'A', ebay_qty: 1 }], stockForSku: async () => ({ levels: [{ available: 1 }, { available: 2 }] }) });
    const t = mk();
    await queuePass(await ctxOf(t, ALL_LIVE));
    expect(t.calls[0][1][0]).toEqual([{ key: '111|A', itemId: '111', sku: 'A', qty: 3 }]);
    const s = mk();
    await queuePass(await ctxOf(s, {}));
    expect(s.calls).toEqual([]);
  });
});

test.describe('eBay Sync: new listings and content', () => {
  const full = { id: 'P9', title: TITLE, status: 'ACTIVE', vendor: 'nike', descriptionHtml: '<p>x</p>', images: [{ url: 'u', width: 900, height: 900 }], variants: [{ sku: 'S', size: '9', barcode: 'S', price: '100', qty: 2 }] };
  test('verify runs in shadow (it creates nothing) and stores the plain-word issues', async () => {
    const t = mkIO({ toVerify: [{ shopify_product_id: 'P9', shopify_key: 'k', issues: [] }], fullProduct: () => full,
      verify: async () => ({ ok: false, errors: [{ code: '', long: 'Add at least 1 photo' }] }) });
    await createPass(await ctxOf(t, {}));
    expect(t.calls).toEqual([]);
    const [, patch] = t.patches[0];
    expect(patch).toMatchObject({ status: 'needs_attention', verify_ok: false });
    expect(patch.issues[0]).toMatchObject({ code: 'photo_small' });
  });
  test('live create adds a verified product, capped per day, and records the item id', async () => {
    const t = mkIO({ live: true, toAdd: [{ shopify_product_id: 'P9', shopify_key: 'k' }], fullProduct: () => full });
    await createPass(await ctxOf(t, ALL_LIVE));
    expect(t.calls.filter((c) => c[0] === 'addFixedPriceItem')).toHaveLength(1);
    expect(t.patches.find(([, p]) => p.item_id === '999')[1]).toMatchObject({ status: 'uploaded', view_url: 'https://www.ebay.com/itm/999' });
    const full25 = mkIO({ live: true, liveToday: 25, toAdd: [], fullProduct: () => full });
    await createPass(await ctxOf(full25, ALL_LIVE));
    expect(full25.calls).toEqual([]);
  });
  test('Verify is allowed but List / Relist refuse when Create is not live', async () => {
    const t = mkIO({ fullProduct: () => full, verify: async () => ({ ok: true }) });
    await ctxOf(t, {});
    const v = await productAction('P9', 'verify', { by: 'k', io: t.io });
    expect(v).toEqual({ ok: true, issues: [] });
    const l = await productAction('P9', 'list', { by: 'k', io: t.io });
    expect(l.ok).toBe(false);
    expect(l.error).toMatch(/not live/i);
    expect((await productAction('P9', 'relist', { by: 'k', io: t.io })).ok).toBe(false);
    expect(t.calls).toEqual([]);
  });
  test('content drift: shadow records it; live sends ONLY the new size (never an existing one), with the union size set', async () => {
    const fullWithOld = { ...full, variants: [...full.variants, { sku: 'OLD', size: '8', barcode: '', price: '99', qty: 0 }] };
    const content = { status: 'Active', title: 'Old title', description: '<p>x</p>', pictureCount: 1, specificsSet: { name: 'Size', values: ['8'] },
      variations: [{ sku: 'OLD', size: '8', upc: 'OLD', price: 99, quantity: 5, sold: 3 }] };
    const base = { toCheck: [{ shopify_product_id: 'P9', item_id: '555', shopify_key: 'k' }], fullProduct: () => fullWithOld, fetchEbayItemContent: async () => content };
    const s = mkIO(base);
    await contentPass(await ctxOf(s, {}));
    expect(s.calls).toEqual([]);
    expect(s.patches[0][1].drift.fields).toEqual(['title', 'sizes']);
    const l = mkIO({ ...base, live: true });
    await contentPass(await ctxOf(l, ALL_LIVE));
    const [itemId, data] = l.calls.find((c) => c[0] === 'reviseFixedPriceItem')[1];
    expect(itemId).toBe('555');
    expect(data.title).toBe(TITLE);
    expect(data.variations.map((v) => [v.sku, v.price, v.qty])).toEqual([['S', 100, 2]]);   // OLD (5 total, 3 sold) is not in the request
    expect(data.sizeValues).toEqual(['8', '9']);
    expect(data.invocationId).toMatch(/^[0-9A-F]{32}$/);
  });
});

test.describe('eBay Sync: runner, webhook', () => {
  test('a failing pass records why in its state and does not throw', async () => {
    const t = mkIO({ allVariants: async () => { throw new Error('Shopify exploded'); } });
    const r = await runPass('reconcile', { io: t.io });
    expect(r).toMatchObject({ ok: false, error: 'Shopify exploded' });
    expect(JSON.parse(t.state.get('ebay_sync_state_reconcile'))).toMatchObject({ ok: false, note: 'Shopify exploded' });
  });
  test('the Shopify webhook queues for eBay beside SHEIN; an eBay queue error never reaches SHEIN', async () => {
    const queued = []; const pushed = [];
    const hook = { shopifySkuForInventoryItem: async () => 'SKU1', queuePush: (a) => pushed.push(a), ebaySyncQueue: async (i) => { queued.push(i); },
      listingProductChanged: () => {}, listingProductDeleted: async () => {} };
    await routeShopifyWebhook('inventory_levels/update', { inventory_item_id: 5 }, hook);
    await routeShopifyWebhook('products/update', { id: 7 }, hook);
    await routeShopifyWebhook('products/delete', { id: 7 }, hook);
    expect(pushed).toEqual([['SKU1']]);
    expect(queued).toEqual([[{ kind: 'sku', key: 'SKU1' }], [{ kind: 'product', key: 'gid://shopify/Product/7' }], [{ kind: 'product_delete', key: 'gid://shopify/Product/7' }]]);
    const bad = { ...hook, ebaySyncQueue: () => { throw new Error('db down'); } };
    expect(await routeShopifyWebhook('inventory_levels/update', { inventory_item_id: 5 }, bad)).toEqual({ pushed: 'SKU1' });
    const legacy = { shopifySkuForInventoryItem: async () => 'S', queuePush: (a) => pushed.push(a) };   // the SHEIN tests' hook has no eBay queue
    expect(await routeShopifyWebhook('inventory_levels/update', { inventory_item_id: 5 }, legacy)).toEqual({ pushed: 'S' });
  });
});
