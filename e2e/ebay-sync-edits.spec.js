// eBay Sync: eBay-only edits, a person's one-off "List on eBay", and ending a duplicate listing
// (docs/context/ebay-sync.md "eBay-only edits"). Neither eBay nor Shopify is ever reached: the engine runs against
// the mocked IO (every eBay writer records or throws), the page against mocked /api/ebay-sync/* routes, and the
// SQL against the LOCAL database only. What this pins:
//   · an override's title / description / photos are what buildListing sends, and precheck judges THOSE;
//   · the style code still comes from the Shopify title when the override drops it;
//   · every caller passes the override (create verify + add, productAction, content), so the content pass never
//     "fixes" eBay back to the long Shopify title; a changed override changes the product key (re-verify);
//   · List on eBay works while New listings is in Test mode, and the kill switch / a server that may not write /
//     Off still stop it;
//   · End the extra listing ends only the one a person picked, re-reads eBay first, never loses sizes silently.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import {
  buildListing, precheck, normalizeOverride, validateOverride, overrideKey, productKey, manualWriteBlock, normalizeSettings, defaultEbayDescription, shorterTitle,
} from '../src/lib/ebaySync.js';
import { createPass, contentPass, reconcilePass, productAction, saveEbayEdit, ebayEditInfo, duplicateListings, endExtraListing } from '../api/_lib/ebay-sync.js';
import * as db from '../api/_lib/db.js';
import { loginAs } from './helpers/auth.js';
import { mkIO, ctxOf, PROFILE } from './helpers/ebaySyncIO.js';

process.env.EBAY_SYNC_WRITES = 'on';

const LONG = "Nike Air Force 1 Low '07 LV8 Photon Dust White Gum Medium Brown Psychic Blue (IB6388-002)";   // 89, from prod 11-14
const SHORT = 'Nike Air Force 1 Low 07 LV8 Photon Dust Psychic Blue';                                         // drops the style code
const PID = 'gid://shopify/Product/9124220895422';
const product = (over = {}) => ({
  id: PID, title: LONG, status: 'ACTIVE', vendor: 'nike', descriptionHtml: '<p>Shopify words</p>',
  images: [{ url: 'https://cdn.shopify.com/a.jpg', width: 1200, height: 1200 }],
  variants: [{ sku: 'S1', size: '9', barcode: '', price: '120', qty: 2 }], ...over,
});

/* ------------------------------ the pure lib ------------------------------ */

test.describe('eBay-only edits: buildListing + precheck', () => {
  test('an override replaces Shopify\'s title / description / photos; the style code stays from the Shopify title', () => {
    const plain = buildListing(product(), PROFILE);
    expect(plain.title).toBe(LONG);
    expect(plain.overridden).toEqual([]);
    const l = buildListing(product(), PROFILE, { title: SHORT, description_html: '<p>eBay words</p>', pictures: ['https://cdn.stickballman12.com/x/1.jpg', 'https://cdn.stickballman12.com/x/2.jpg'] });
    expect(l.title).toBe(SHORT);
    expect(l.description).toBe('<p>eBay words</p>');
    expect(l.pictures).toEqual(['https://cdn.stickballman12.com/x/1.jpg', 'https://cdn.stickballman12.com/x/2.jpg']);
    expect(l.style).toBe('IB6388-002');
    expect(l.specifics).toContainEqual(['Style Code', 'IB6388-002']);
    expect(l.overridden).toEqual(['title', 'description', 'pictures']);
    // only a title: Shopify's description and photos stay
    const t = buildListing(product(), PROFILE, { title: SHORT });
    expect(t.description).toBe('<p>Shopify words</p>');
    expect(t.pictures).toEqual(['https://cdn.shopify.com/a.jpg']);
    // Shopify title without a style code: the override's own is used
    expect(buildListing(product({ title: 'Mystery shoe' }), PROFILE, { title: 'Mystery shoe (HQ1234-001)' }).style).toBe('HQ1234-001');
  });

  test('precheck judges what is SENT: a short title clears title_long, eBay photos clear no_photo / photo_small, an eBay description clears no_description', () => {
    const codes = (p, ov) => precheck(p, buildListing(p, PROFILE, ov)).map((i) => i.code);
    expect(codes(product())).toEqual(['title_long']);
    expect(codes(product(), { title: SHORT })).toEqual([]);
    expect(codes(product(), { title: 'x'.repeat(81) })).toEqual(['title_long']);
    const noPhoto = product({ title: 'Nike Dunk Low (DD1391-100)', images: [] });
    expect(codes(noPhoto)).toEqual(['no_photo']);
    expect(codes(noPhoto, { pictures: ['https://cdn.stickballman12.com/a.jpg'] })).toEqual([]);
    const small = product({ title: 'Nike Dunk Low (DD1391-100)', images: [{ url: 'https://s/a.jpg', width: 300, height: 300 }] });
    expect(codes(small)).toEqual(['photo_small']);
    expect(codes(small, { pictures: ['https://cdn.stickballman12.com/a.jpg'] })).toEqual([]);
    const noDesc = product({ title: 'Nike Dunk Low (DD1391-100)', descriptionHtml: '' });
    expect(codes(noDesc)).toEqual(['no_description']);
    expect(codes(noDesc, { description: 'Brand new with original box.' })).toEqual([]);
    // the fix says the eBay-only way too
    expect(precheck(product(), buildListing(product(), PROFILE))[0].fix).toMatch(/Edit for eBay/);
  });

  test('normalize / validate / key: blanks mean Shopify\'s, plain text becomes paragraphs, bad input is refused in words', () => {
    expect(normalizeOverride({ title: '  ', description: '', pictures: [] })).toBeNull();
    expect(normalizeOverride({ description: 'Line one\nA < B & C' }).description).toBe('<p>Line one</p><p>A &lt; B &amp; C</p>');
    expect(normalizeOverride({ pictures: '["https://a/1.jpg","https://a/1.jpg"]' }).pictures).toEqual(['https://a/1.jpg']);
    expect(validateOverride({})).toMatch(/Nothing to save/);
    expect(validateOverride({ title: 'x'.repeat(81) })).toMatch(/81 characters/);
    expect(validateOverride({ title: 'ok', pictures: ['http://insecure/a.jpg'] })).toMatch(/https/);
    expect(validateOverride({ description: '<p onclick="x()">hi</p>' })).toMatch(/scripts/);
    expect(validateOverride({ description: '<script>alert(1)</script>' })).toMatch(/scripts/);
    expect(validateOverride({ title: 'ok', pictures: Array.from({ length: 13 }, (_, i) => `https://a/${i}.jpg`) })).toMatch(/12/);
    expect(validateOverride({ title: SHORT })).toBeNull();
    expect(overrideKey(null)).toBe('');
    expect(overrideKey({ title: SHORT })).not.toBe(overrideKey({ title: `${SHORT} 2` }));
    // no override = the same key as before overrides existed (no mass re-verify on deploy); an override changes it
    expect(productKey('2026-11-01', ['A', 'B'])).toBe(productKey('2026-11-01', ['B', 'A'], ''));
    expect(productKey('2026-11-01', ['A'], overrideKey({ title: SHORT }))).not.toBe(productKey('2026-11-01', ['A']));
    expect(defaultEbayDescription(shorterTitle(LONG), 'IB6388-002')).toBe(`${shorterTitle(LONG)}. Brand new with original box. Style code IB6388-002.`);
    expect(shorterTitle(LONG).length).toBeLessThanOrEqual(80);
  });

  test('a person\'s one-off write: Test mode is fine; kill, a server that may not write, and Off stop it', () => {
    const on = { EBAY_SYNC_WRITES: 'on' };
    expect(manualWriteBlock(normalizeSettings({}), 'create', on)).toBeNull();                        // shadow
    expect(manualWriteBlock(normalizeSettings({ switches: { create: 'live' } }), 'create', on)).toBeNull();
    expect(manualWriteBlock(normalizeSettings({ kill: true }), 'create', on)).toMatch(/kill switch/);
    expect(manualWriteBlock(normalizeSettings({}), 'create', {})).toMatch(/not allowed to write/);
    expect(manualWriteBlock(normalizeSettings({ switches: { create: 'off' } }), 'create', on)).toMatch(/switched Off/);
    expect(manualWriteBlock(normalizeSettings({ switches: { end: 'off' } }), 'end', on)).toMatch(/End listings is switched Off/);
  });
});

/* ------------------------------ Shopify is never written ------------------------------ */

test.describe('eBay-only edits never write Shopify', () => {
  test('the engine and the new endpoints import only Shopify READS, and none of those runs a mutation', async () => {
    const fs = await import('node:fs');
    const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    const engine = src('api/_lib/ebay-sync.js');
    const imported = engine.match(/import \{([^}]+)\} from '\.\/shopify\.js'/)[1].split(',').map((x) => x.trim()).filter(Boolean);
    expect(imported.sort()).toEqual(['shopifyAllVariants', 'shopifyCollectionProductIds', 'shopifyConfigured', 'shopifyEbayProductsFull', 'shopifyEbayProductsLight', 'shopifyListingState', 'shopifyStockForSku'].sort());
    const shop = src('api/_lib/shopify.js');
    for (const name of imported) {
      const at = shop.search(new RegExp(`export (async )?function ${name}\\b`));
      expect(at, name).toBeGreaterThanOrEqual(0);
      const next = shop.slice(at + 10).search(/\nexport /);
      const body = shop.slice(at, next < 0 ? undefined : at + 10 + next);
      expect(body, `${name} must not write Shopify`).not.toMatch(/\bmutation\b|productUpdate|inventorySet|inventoryAdjust|method:\s*'(PUT|DELETE)'/);
    }
    for (const f of ['api/ebay-sync/edit.js', 'api/ebay-sync/duplicates.js', 'api/ebay-sync/products.js']) expect(src(f), f).not.toMatch(/shopify\.js/);
    expect(src('src/screens/EbaySync.jsx')).not.toMatch(/shopify(Listing)?(Save|Update|Edit)\(/i);
  });

  test('saving, clearing, checking and listing touch no Shopify writer: the IO has none, and every IO call is a read', async () => {
    const t = mkIO({ live: true, fullProduct: () => product() });
    const touched = [];
    for (const k of Object.keys(t.io)) if (/shopify|product/i.test(k) && typeof t.io[k] === 'function') { const f = t.io[k]; t.io[k] = async (...a) => { touched.push(k); return f(...a); }; }
    await ctxOf(t, {});
    await saveEbayEdit(PID, { title: SHORT }, { by: 'k', io: t.io });
    await productAction(PID, 'list', { by: 'k', io: t.io });
    await saveEbayEdit(PID, { clear: true }, { by: 'k', io: t.io });
    const READS = ['shopifyReady', 'productsLight', 'productsFull', 'productsState'];   // every Shopify-facing IO function is a read
    expect(touched).toContain('productsFull');
    expect(touched.filter((k) => !READS.includes(k))).toEqual([]);
    expect(Object.keys(t.io.write).filter((k) => /shopify/i.test(k))).toEqual([]);
    expect(t.calls.map((c) => c[0])).toEqual(['addFixedPriceItem']);   // the one eBay write, the person's List on eBay
  });
});

/* ------------------------------ the engine, mocked IO ------------------------------ */

test.describe('eBay-only edits: every caller passes the override', () => {
  const ov = { [PID]: { shopify_product_id: PID, title: SHORT, description_html: null, pictures: null } };

  test('create verify: the long Shopify title needs attention; with the override it goes to eBay\'s dry run with the SHORT title and clears', async () => {
    const seen = [];
    const verify = async (l) => { seen.push(l.title); return { ok: true }; };
    const a = mkIO({ toVerify: [{ shopify_product_id: PID, shopify_key: 'k', issues: [] }], fullProduct: () => product(), verify });
    await createPass(await ctxOf(a, {}));
    expect(a.patches[0][1]).toMatchObject({ status: 'needs_attention' });
    expect(a.patches[0][1].issues.map((i) => i.code)).toEqual(['title_long']);
    const b = mkIO({ toVerify: [{ shopify_product_id: PID, shopify_key: 'k', issues: [] }], fullProduct: () => product(), verify, overrides: ov });
    await createPass(await ctxOf(b, {}));
    expect(seen).toEqual([SHORT]);
    expect(b.patches[0][1]).toMatchObject({ status: 'not_uploaded', verify_ok: true, issues: [] });
    expect(b.calls).toEqual([]);
  });

  test('create add (live) sends the override title', async () => {
    const t = mkIO({ live: true, toAdd: [{ shopify_product_id: PID, shopify_key: 'k' }], fullProduct: () => product(), overrides: ov });
    await createPass(await ctxOf(t, { switches: { create: 'live' }, blastPct: 100 }));
    const add = t.calls.find((c) => c[0] === 'addFixedPriceItem');
    expect(add[1][0].title).toBe(SHORT);
    expect(add[1][0].specifics).toContainEqual(['Style Code', 'IB6388-002']);
  });

  test('content: an eBay listing already carrying the override title is NOT revised back to the long Shopify title', async () => {
    const content = (title) => async () => ({ status: 'Active', title, description: '<p>Shopify words</p>', pictureCount: 1, specificsSet: { name: 'Size', values: ['9'] }, variations: [{ sku: 'S1', size: '9', quantity: 2, sold: 0 }] });
    const base = { live: true, toCheck: [{ shopify_product_id: PID, item_id: '555', shopify_key: 'k' }], fullProduct: () => product(), overrides: ov };
    const same = mkIO({ ...base, fetchEbayItemContent: content(SHORT) });
    await contentPass(await ctxOf(same, { switches: { content: 'live' }, blastPct: 100 }));
    expect(same.calls.filter((c) => c[0] === 'reviseFixedPriceItem')).toEqual([]);
    expect(same.patches[0][1].drift).toBeNull();
    // In Test mode nothing is queued / logged for it either.
    const shadow = mkIO({ ...base, live: false, fetchEbayItemContent: content(SHORT) });
    await contentPass(await ctxOf(shadow, { switches: { content: 'shadow' } }));
    expect(shadow.logs.filter((l) => l.domain === 'content')).toEqual([]);
    expect(shadow.patches[0][1].drift).toBeNull();
    // Without the override the same listing WOULD be "fixed" back to the long Shopify title: that is what the override stops.
    const noOv = mkIO({ ...base, live: false, overrides: {}, fetchEbayItemContent: content(SHORT) });
    await contentPass(await ctxOf(noOv, { switches: { content: 'shadow' } }));
    expect(noOv.patches[0][1].drift).toBeNull();   // a long Shopify title is never sent (over 80), so no revert either way
    const old = mkIO({ ...base, fetchEbayItemContent: content('Some old title') });
    await contentPass(await ctxOf(old, { switches: { content: 'live' }, blastPct: 100 }));
    expect(old.calls.find((c) => c[0] === 'reviseFixedPriceItem')[1][1].title).toBe(SHORT);
  });

  test('reconcile folds the override into the product key, so saving one re-verifies', async () => {
    const light = [{ id: 'P1', title: 'Nike Dunk Low Retro Panda (DD1391-100)', handle: 'p1', vendor: 'nike', status: 'ACTIVE', updatedAt: '2026-11-01T00:00:00Z', image: null },
      { id: 'P2', title: 'Locked Shoe (HQ1234-001)', handle: 'p2', vendor: 'nike', status: 'ACTIVE', updatedAt: '2026-11-01T00:00:00Z', image: null }];
    const a = mkIO({ light });
    await reconcilePass(await ctxOf(a, {}));
    const b = mkIO({ light, overrides: { P1: { title: 'Dunk Low Panda (DD1391-100)' } } });
    await reconcilePass(await ctxOf(b, {}));
    const key = (t, id) => t.saved.products.find((p) => p.id === id).shopify_key;
    expect(key(a, 'P1')).not.toBe(key(b, 'P1'));
    expect(key(a, 'P2')).toBe(key(b, 'P2'));
  });

  test('saveEbayEdit: refused in words when bad; otherwise stored, re-check forced, eBay\'s dry run at once; nothing is written anywhere', async () => {
    const t = mkIO({ fullProduct: () => product() });
    await ctxOf(t, {});
    expect(await saveEbayEdit(PID, { title: 'x'.repeat(90) }, { by: 'k', io: t.io })).toMatchObject({ ok: false });
    const r = await saveEbayEdit(PID, { title: SHORT, description: 'Brand new with original box.', pictures: [] }, { by: 'k', io: t.io });
    expect(r).toMatchObject({ ok: true, saved: true, issues: [], checkError: null });
    expect(t.overrides[PID]).toMatchObject({ title: SHORT, description_html: '<p>Brand new with original box.</p>', pictures: null, updated_by: 'k' });
    expect(t.dbCalls.map((c) => c[0])).toEqual(expect.arrayContaining(['overrideSave', 'forceRecheck']));
    expect(t.patches.at(-1)[1]).toMatchObject({ status: 'not_uploaded', issues: [], verify_ok: true });
    expect(t.logs.some((l) => l.action === 'ebay_edit_saved' && l.by === 'k')).toBe(true);
    const c = await saveEbayEdit(PID, { clear: true }, { by: 'k', io: t.io });
    expect(c).toMatchObject({ ok: true, cleared: true });
    expect(c.issues.map((i) => i.code)).toEqual(['title_long']);
    expect(t.overrides[PID]).toBeUndefined();
    expect(t.calls).toEqual([]);   // no eBay write, and the IO has no Shopify writer at all
  });

  test('ebayEditInfo: shorter title, plain description and the Image Finder slides for the style code', async () => {
    const t = mkIO({ fullProduct: () => product(), imageFinder: { 'IB6388-002': [{ url: 'https://cdn.stickballman12.com/listings/IB6388-002/ph_edited/side.jpg', angle: 'side' }, { url: 'http://old/x.jpg', angle: 'top' }] } });
    const r = await ebayEditInfo(PID, { io: t.io });
    expect(r.defaults.title.length).toBeLessThanOrEqual(80);
    expect(r.defaults.description).toMatch(/^.+\. Brand new with original box\. Style code IB6388-002\.$/);
    expect(r.imageFinder).toEqual([{ url: 'https://cdn.stickballman12.com/listings/IB6388-002/ph_edited/side.jpg', angle: 'side' }]);   // https only
    expect(r.saved).toBeNull();
    expect(r.shopify.style).toBe('IB6388-002');
  });
});

test.describe('List on eBay by hand while New listings is in Test mode', () => {
  test('Test mode: lists once (fresh eBay look, UUID, logged live + manual); kill and a server that may not write refuse', async () => {
    const t = mkIO({ live: true, fullProduct: () => product(), overrides: { [PID]: { title: SHORT } } });
    await ctxOf(t, { switches: { create: 'shadow' } });
    const r = await productAction(PID, 'list', { by: 'kevin', io: t.io });
    expect(r).toEqual({ ok: true, itemId: '999' });
    const adds = t.calls.filter((c) => c[0] === 'addFixedPriceItem');
    expect(adds).toHaveLength(1);
    expect(adds[0][1][0].title).toBe(SHORT);
    expect(adds[0][1][0].uuid).toMatch(/^[0-9A-F]{32}$/);
    expect(t.logs.find((l) => l.domain === 'create' && l.action === 'add')).toMatchObject({ mode: 'live', ok: true, by: 'kevin', after: expect.objectContaining({ manual: true }) });
    // already on eBay (SKU) = not listed again
    const again = mkIO({ live: true, fullProduct: () => product(), overrides: { [PID]: { title: SHORT } }, ebayRows: [{ item_id: '1', variation_key: 'S1', sku: 'S1', size: '9', price: 1, qty_available: 1 }] });
    await ctxOf(again, {});
    expect((await productAction(PID, 'list', { by: 'k', io: again.io })).error).toMatch(/already on eBay/);
    expect(again.calls).toEqual([]);
    // kill switch
    const k = mkIO({ live: true, fullProduct: () => product(), overrides: { [PID]: { title: SHORT } } });
    await ctxOf(k, { kill: true });
    expect((await productAction(PID, 'list', { by: 'k', io: k.io })).error).toMatch(/kill switch/);
    expect(k.calls).toEqual([]);
    // a server that may not write
    process.env.EBAY_SYNC_WRITES = '';
    try {
      const n = mkIO({ live: true, fullProduct: () => product(), overrides: { [PID]: { title: SHORT } } });
      await ctxOf(n, {});
      expect((await productAction(PID, 'list', { by: 'k', io: n.io })).error).toMatch(/not allowed to write/);
      expect(n.calls).toEqual([]);
    } finally { process.env.EBAY_SYNC_WRITES = 'on'; }
  });

  test('a shoe that still needs attention is not listed', async () => {
    const t = mkIO({ live: true, fullProduct: () => product() });
    await ctxOf(t, {});
    const r = await productAction(PID, 'list', { by: 'k', io: t.io });
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(['title_long']);
    expect(t.calls).toEqual([]);
  });
});

test.describe('End the extra listing (same SKU on two of our listings)', () => {
  const SHOX = 'gid://shopify/Product/9091517415614';
  const A = '327106732406'; const B = '327444779878';
  const dupListings = [
    { item_id: A, sku: '10043212', size: '5Y', title: 'Nike Shox R4 GS', view_url: `https://www.ebay.com/itm/${A}`, ebay_qty: 1, ebay_price: 150, dup: true, start_time: '2026-09-01T12:00:00Z' },
    { item_id: B, sku: '10043212', size: '5Y', title: 'Nike Shox R4 GS', view_url: `https://www.ebay.com/itm/${B}`, ebay_qty: 1, ebay_price: 155, dup: true, start_time: '2026-11-10T12:00:00Z' },
    { item_id: B, sku: '10043299', size: '6Y', title: 'Nike Shox R4 GS', view_url: `https://www.ebay.com/itm/${B}`, ebay_qty: 2, ebay_price: 155, dup: false, start_time: '2026-11-10T12:00:00Z' },
  ];
  const shox = { id: SHOX, title: 'Nike Shox R4 Black Bright Crimson (GS)', status: 'ACTIVE', vendor: 'nike', descriptionHtml: '<p>x</p>', images: [], variants: [{ sku: '10043212', size: '5Y', price: '150', qty: 1 }] };
  const live = { [A]: [{ sku: '10043212', size: '5Y', available: 1 }], [B]: [{ sku: '10043212', size: '5Y', available: 1 }, { sku: '10043299', size: '6Y', available: 2 }] };
  const reads = [];
  const mk = (over = {}) => mkIO({ live: true, fullProduct: () => shox, dupListings,
    fetchEbayItemContent: async (id, opt) => { reads.push([id, opt]); return { status: 'Active', title: 'Nike Shox R4 GS', variations: (over.live || live)[id] || [],
      ...(id === A ? { watchCount: 4, startTime: '2026-09-01T12:00:00.000Z' } : { watchCount: null, startTime: null }) }; }, ...over });

  test('lists both listings; price, start date and watchers come from a read-only GetItem at open; no watchers from eBay = null ("—"); nothing is ended by looking', async () => {
    reads.length = 0;
    const t = mk();
    const r = await duplicateListings(SHOX, { io: t.io });
    expect(r.dupSkus).toEqual(['10043212']);
    expect(reads).toEqual([[A, { watchers: true }], [B, { watchers: true }]]);
    // A: eBay's own start date + 4 watchers. B: eBay sent neither -> start date from our last pull, watchers unknown.
    expect(r.listings.map((l) => [l.item_id, l.watch_count, l.start_time, l.sizes.length])).toEqual([[A, 4, '2026-09-01T12:00:00.000Z', 1], [B, null, '2026-11-10T12:00:00Z', 2]]);
    expect(t.calls).toEqual([]);
    // eBay unreadable: the listing still shows, from our copy, marked as such
    const down = mk({ fetchEbayItemContent: async () => { throw new Error('eBay down'); } });
    const d = await duplicateListings(SHOX, { io: down.io });
    expect(d.listings.map((l) => [l.live, l.watch_count])).toEqual([[false, null], [false, null]]);
  });

  test('ends ONLY the picked one (even in Test mode), after a live read of both; logged to ebay_listing_ends and the sync log', async () => {
    const t = mk();
    await ctxOf(t, { switches: { end: 'shadow' } });
    const r = await endExtraListing(SHOX, { endItemId: A, keepItemId: B }, { by: 'kevin', io: t.io });
    expect(r).toMatchObject({ ok: true, ended: A, kept: B });
    expect(t.calls.filter((c) => c[0] === 'endEbayItem').map((c) => c[1][0])).toEqual([A]);
    expect(t.calls.find((c) => c[0] === 'logEbayEnd')[1][0]).toMatchObject({ itemId: A, ok: true, by: 'kevin', reason: expect.stringContaining(B) });
    expect(t.logs.find((l) => l.action === 'end_duplicate')).toMatchObject({ domain: 'end', mode: 'live', itemId: A, ok: true, after: expect.objectContaining({ manual: true }) });
    expect(t.dbCalls).toEqual(expect.arrayContaining([['dropListing', A], ['dropLinks', A]]));
  });

  test('refuses: a size with stock only on the ended one (unless accepted), a kept listing without the SKU, a pair that is not a duplicate, the kill switch, Off', async () => {
    const loss = mk();
    await ctxOf(loss, {});
    const r = await endExtraListing(SHOX, { endItemId: B, keepItemId: A }, { by: 'k', io: loss.io });
    expect(r.ok).toBe(false);
    expect(r.lost).toEqual(['10043299']);
    expect(loss.calls).toEqual([]);
    expect((await endExtraListing(SHOX, { endItemId: B, keepItemId: A, acceptLoss: true }, { by: 'k', io: loss.io })).ok).toBe(true);

    const gone = mk({ live: { [A]: [{ sku: '10043212', available: 1 }], [B]: [{ sku: 'OTHER', available: 1 }] } });
    await ctxOf(gone, {});
    expect((await endExtraListing(SHOX, { endItemId: A, keepItemId: B }, { by: 'k', io: gone.io })).error).toMatch(/no longer has SKU/);
    expect(gone.calls).toEqual([]);

    const notDup = mk();
    await ctxOf(notDup, {});
    expect((await endExtraListing(SHOX, { endItemId: A, keepItemId: '999' }, { by: 'k', io: notDup.io })).ok).toBe(false);
    expect((await endExtraListing(SHOX, { endItemId: A, keepItemId: A }, { by: 'k', io: notDup.io })).ok).toBe(false);
    expect(notDup.calls).toEqual([]);

    const k = mk();
    await ctxOf(k, { kill: true });
    expect((await endExtraListing(SHOX, { endItemId: A, keepItemId: B }, { by: 'k', io: k.io })).error).toMatch(/kill switch/);
    const off = mk();
    await ctxOf(off, { switches: { end: 'off' } });
    expect((await endExtraListing(SHOX, { endItemId: A, keepItemId: B }, { by: 'k', io: off.io })).error).toMatch(/switched Off/);
    expect([...k.calls, ...off.calls]).toEqual([]);
  });
});

/* ------------------------------ the real SQL (local database only) ------------------------------ */

test.describe.serial('eBay-only edits: the real SQL', () => {
  test.skip(!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || ''), 'needs the local database');
  const P = 'gid://shopify/Product/990000001';
  let pool;
  test.beforeAll(async () => { pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); });
  test.afterAll(async () => {
    await pool.query('DELETE FROM ebay_sync_overrides WHERE shopify_product_id = $1', [P]);
    await pool.query('DELETE FROM ebay_sync_products WHERE shopify_product_id = $1', [P]);
    await pool.query("DELETE FROM ebay_sync_links WHERE link_key LIKE 'e2e-dup|%'");
    await pool.end();
  });
  test('save / read / clear an override; the product list shows it; a save clears the verify and content keys', async () => {
    await pool.query(`INSERT INTO ebay_sync_products (shopify_product_id, title, status, shopify_key, verify_key, content_key, checked_at, issues)
      VALUES ($1, $2, 'needs_attention', 'k1', 'k1', 'k1', now(), '[{"code":"title_long"}]'::jsonb) ON CONFLICT (shopify_product_id) DO UPDATE SET verify_key = 'k1', content_key = 'k1'`, [P, `zz e2e ${LONG}`]);
    await db.ebaySyncOverrideSave(P, normalizeOverride({ title: SHORT, pictures: ['https://cdn.stickballman12.com/a.jpg'] }), 'sqltest');
    const got = (await db.ebaySyncOverridesOf([P])).get(P);
    expect(got).toMatchObject({ title: SHORT, description_html: null, pictures: ['https://cdn.stickballman12.com/a.jpg'], updated_by: 'sqltest' });
    expect(buildListing(product(), PROFILE, got).title).toBe(SHORT);
    expect(overrideKey((await db.ebaySyncOverridesAll()).get(P))).toBe(overrideKey(got));
    await db.ebaySyncProductForceRecheck(P);
    expect((await pool.query('SELECT verify_key, content_key FROM ebay_sync_products WHERE shopify_product_id = $1', [P])).rows[0]).toEqual({ verify_key: null, content_key: null });
    const { rows } = await db.ebaySyncProducts({ tab: 'needs_attention', q: 'zz e2e' });
    expect(rows[0]).toMatchObject({ shopify_product_id: P, has_ebay_edit: true, ebay_title: SHORT, ebay_pictures: 1, ebay_description: false });
    await db.ebaySyncOverrideDelete(P);
    expect((await db.ebaySyncOverridesOf([P])).size).toBe(0);
  });
  test('duplicate listings: every listing carrying a SKU that is on two of ours, with all its sizes', async () => {
    const ins = (key, sku, item, size) => pool.query(`INSERT INTO ebay_sync_links (link_key, sku, item_id, variation_key, title, size, ebay_qty, ebay_price, duplicate, state, seen_at)
      VALUES ($1, $2, $3, $2, 'e2e dup', $4, 1, 100, true, 'duplicate', now()) ON CONFLICT (link_key) DO NOTHING`, [key, sku, item, size]);
    await ins('e2e-dup|1', '9900001', 'E2E-DUP-A', '5Y');
    await ins('e2e-dup|2', '9900001', 'E2E-DUP-B', '5Y');
    await ins('e2e-dup|3', '9900002', 'E2E-DUP-B', '6Y');
    const rows = await db.ebaySyncDupListings(['9900001']);
    expect(rows.map((r) => [r.item_id, r.sku, r.dup])).toEqual([['E2E-DUP-A', '9900001', true], ['E2E-DUP-B', '9900001', true], ['E2E-DUP-B', '9900002', false]]);
    expect(await db.ebaySyncDupListings(['9900002'])).toEqual([]);   // on one listing only: not a duplicate
    await db.ebaySyncDropLinks('E2E-DUP-A');
    expect(await db.ebaySyncDupListings(['9900001'])).toEqual([]);
  });
});

/* ------------------------------ the page (every /api/ebay-sync/* call mocked) ------------------------------ */

const STATUS = (over = {}) => ({
  ok: true, settings: { switches: { stock: 'shadow', price: 'shadow', content: 'shadow', create: 'shadow', end: 'shadow' }, kill: false, blastPct: 10, ...over },
  counts: {}, passes: {}, budget: { used: 1, limit: 5000 }, ebay: { connected: true, user: 'stickballman12' }, facts: {}, handover: [], writes_enabled: true,
});
const ROW = { shopify_product_id: PID, title: LONG, style: 'IB6388-002', status: 'needs_attention', item_id: null, view_url: null, image: null, sizes: null, qty: 2, checked_at: '2026-11-14T14:00:00Z',
  issues: [{ code: 'title_long', message: "The title is 89 characters; eBay's limit is 80.", fix: 'Shorten it. Or press Edit for eBay to change it on eBay only.' }] };
const DUP_ROW = { shopify_product_id: 'gid://shopify/Product/9091517415614', title: 'Nike Shox R4 Black Bright Crimson (GS)', style: null, status: 'needs_attention', item_id: null, view_url: null, image: null, qty: 1, checked_at: '2026-11-14T14:00:00Z',
  issues: [{ code: 'duplicate_sku', message: 'SKU 10043212 is used by more than one size or listing.', fix: 'Make each SKU unique in Shopify, or end the other listing that uses it.' }] };

async function mockPage(page, { kill = false, finder = true } = {}) {
  const st = { rows: [ROW, DUP_ROW], posts: [], status: STATUS({ kill }) };
  await page.route('**/api/ebay/status', (r) => r.fulfill({ json: { ok: true, configured: true, missing: [], secrets: true, connected: true, user: 'stickballman12', pull: { state: 'idle' } } }));
  await page.route('**/api/ebay/pull', (r) => r.fulfill({ json: { ok: true, rows: [] } }));
  await page.route('**/api/ebay/orders**', (r) => r.fulfill({ json: { ok: true, rows: [], orders: [] } }));
  await page.route('**/api/ebay-sync/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const name = url.pathname.replace('/api/ebay-sync/', '');
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      st.posts.push({ name, body });
      if (name === 'edit') {
        st.rows = st.rows.filter((r) => r.shopify_product_id !== body.productId);   // the check passed: it leaves Needs Attention
        return route.fulfill({ json: { ok: true, saved: true, issues: [], checkError: null } });
      }
      if (name === 'products' && body.action === 'list') {
        return route.fulfill({ status: 200, json: st.status.settings.kill ? { ok: false, error: 'The kill switch is on, so nothing is sent to eBay.' } : { ok: true, itemId: '999' } });
      }
      if (name === 'duplicates') return route.fulfill({ json: { ok: true, ended: body.endItemId, kept: body.keepItemId } });
      return route.fulfill({ json: { ok: true } });
    }
    if (name === 'status') return route.fulfill({ json: st.status });
    if (name === 'products') {
      const tab = url.searchParams.get('tab');
      const rows = tab === 'needs_attention' ? st.rows : [];
      return route.fulfill({ json: { ok: true, rows, total: rows.length, tabs: { uploaded: 977, not_uploaded: 11, needs_attention: st.rows.length } } });
    }
    if (name === 'edit') {
      return route.fulfill({ json: { ok: true, saved: null, titleMax: 80,
        shopify: { title: LONG, description: '<p>Shopify words</p>', pictures: ['https://cdn.shopify.com/a.jpg'], style: 'IB6388-002' },
        defaults: { title: shorterTitle(LONG), description: defaultEbayDescription(shorterTitle(LONG), 'IB6388-002') },
        imageFinder: finder ? [{ url: 'https://cdn.stickballman12.com/listings/IB6388-002/ph_edited/side.jpg', angle: 'side' }, { url: 'https://cdn.stickballman12.com/listings/IB6388-002/ph_edited/top.jpg', angle: 'top' }] : [] } });
    }
    if (name === 'duplicates') {
      return route.fulfill({ json: { ok: true, title: DUP_ROW.title, dupSkus: ['10043212'], listings: [
        { item_id: '327106732406', title: 'Nike Shox R4 GS', view_url: 'https://www.ebay.com/itm/327106732406', start_time: '2026-09-01T12:00:00Z', watch_count: 4, sizes: [{ sku: '10043212', size: '5Y', qty: 1, price: 150, dup: true }] },
        { item_id: '327444779878', title: 'Nike Shox R4 GS', view_url: 'https://www.ebay.com/itm/327444779878', start_time: '2026-11-10T12:00:00Z', watch_count: null, sizes: [{ sku: '10043212', size: '5Y', qty: 1, price: 155, dup: true }] },
      ] } });
    }
    return route.fulfill({ json: { ok: true, rows: [], total: 0, tabs: {} } });
  });
  // The thumbnails point at made-up addresses: answer them with nothing rather than reaching out.
  await page.route('https://cdn.stickballman12.com/**', (r) => r.fulfill({ status: 404, body: '' }));
  return st;
}

test.describe('eBay Sync page: Edit for eBay, List on eBay, End the extra listing', () => {
  test('PH without the privilege sees the issues but none of the buttons', async ({ page }) => {
    await mockPage(page);
    await loginAs(page, 'ph_team');
    await page.goto('/ph/ebay-listings?tab=sync&sync=products&ssub=needs_attention');
    await expect(page.getByText("The title is 89 characters; eBay's limit is 80.")).toBeVisible();
    for (const name of ['Edit for eBay', 'List on eBay', 'End the extra listing']) await expect(page.getByRole('button', { name })).toHaveCount(0);
  });

  test('Edit for eBay: prefilled short title with a live /80 counter, Image Finder photos, says eBay only; Save checks with eBay and the issue clears', async ({ page }) => {
    const st = await mockPage(page);
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=products&ssub=needs_attention');
    await page.locator('tr', { hasText: LONG }).getByRole('button', { name: 'Edit for eBay' }).click();
    const dlg = page.getByRole('dialog', { name: 'Edit for eBay' });
    await expect(dlg.locator('[data-ebay-only]')).toHaveText('Changes eBay only. Shopify keeps its own title/description/photos.');
    const title = dlg.getByLabel('eBay title');
    await expect(title).toHaveValue(shorterTitle(LONG));
    await expect(dlg.locator('[data-count]')).toHaveText(`${shorterTitle(LONG).length}/80`);
    await title.fill('x'.repeat(85));
    await expect(dlg.locator('[data-count]')).toHaveText('85/80');
    await expect(dlg.getByRole('button', { name: 'Save and check with eBay' })).toBeDisabled();
    await title.fill(SHORT);
    await expect(dlg.getByLabel('eBay description')).toHaveValue(defaultEbayDescription(shorterTitle(LONG), 'IB6388-002'));
    await dlg.getByRole('button', { name: /Use Image Finder photos \(2\)/ }).click();
    await expect(dlg.getByLabel('eBay photos')).toHaveValue('https://cdn.stickballman12.com/listings/IB6388-002/ph_edited/side.jpg\nhttps://cdn.stickballman12.com/listings/IB6388-002/ph_edited/top.jpg');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(400);   // let the dialog's open animation finish before the picture
    await page.screenshot({ path: 'test-results/ebay-edit-desktop.png' });
    await dlg.getByRole('button', { name: 'Save and check with eBay' }).click();
    await expect(dlg.locator('[data-edit-result]')).toContainText('Checked with eBay: nothing stops it now.');
    const post = st.posts.find((p) => p.name === 'edit');
    expect(post.body).toMatchObject({ productId: PID, title: SHORT, pictures: ['https://cdn.stickballman12.com/listings/IB6388-002/ph_edited/side.jpg', 'https://cdn.stickballman12.com/listings/IB6388-002/ph_edited/top.jpg'] });
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('tr', { hasText: LONG })).toHaveCount(0);
  });

  test('a style code with no Image Finder slides: the button says so plainly and is off', async ({ page }) => {
    await mockPage(page, { finder: false });
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=products&ssub=needs_attention');
    await page.locator('tr', { hasText: LONG }).getByRole('button', { name: 'Edit for eBay' }).click();
    const btn = page.locator('[data-finder]');
    await expect(btn).toHaveText('No Image Finder photos for IB6388-002');
    await expect(btn).toBeDisabled();
  });

  test('List on eBay asks first, names Test mode, and shows the kill-switch refusal', async ({ page }) => {
    const st = await mockPage(page, { kill: true });
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=products&ssub=needs_attention');
    await page.locator('tr', { hasText: LONG }).getByRole('button', { name: 'List on eBay' }).click();
    await expect(page.getByRole('dialog')).toContainText('even though New listings is in Test mode');
    await page.getByRole('button', { name: 'Yes, list it' }).click();
    await expect(page.getByRole('alert')).toContainText('The kill switch is on, so nothing is sent to eBay.');
    expect(st.posts.filter((p) => p.name === 'products').map((p) => p.body)).toEqual([{ productId: PID, action: 'list' }]);
  });

  test('End the extra listing: both item ids with price, start date and watchers; the person picks; only that one is sent', async ({ page }) => {
    const st = await mockPage(page);
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=products&ssub=needs_attention');
    await expect(page.locator('tr', { hasText: LONG }).getByRole('button', { name: 'End the extra listing' })).toHaveCount(0);   // only on a duplicate_sku row
    await page.locator('tr', { hasText: DUP_ROW.title }).getByRole('button', { name: 'End the extra listing' }).click();
    const dlg = page.getByRole('dialog', { name: 'End the extra listing' });
    await expect(dlg.locator('[data-dup="327106732406"]')).toContainText('$150.00');
    await expect(dlg.locator('[data-dup="327106732406"]')).toContainText('EST');
    await expect(dlg.locator('[data-dup="327106732406"]')).toContainText('4');
    await expect(dlg.locator('[data-dup="327444779878"]')).toContainText('$155.00');
    await expect(dlg.locator('[data-dup="327444779878"] dd').nth(2)).toHaveText('—');   // eBay sent no watchers
    await expect(dlg.locator('[data-dup="327106732406"] dd').nth(2)).toHaveText('4');
    await expect(dlg.getByRole('button', { name: 'Pick one to end' })).toBeDisabled();
    expect(st.posts.filter((p) => p.name === 'duplicates')).toEqual([]);
    await dlg.locator('[data-dup="327444779878"] input[type="radio"]').check();
    await page.waitForTimeout(400);   // let the dialog's open animation finish before the picture
    await page.screenshot({ path: 'test-results/ebay-dup-desktop.png' });
    await dlg.getByRole('button', { name: 'End listing #327444779878' }).click();
    await expect(dlg.getByRole('status')).toContainText('Ended listing #327444779878 on eBay. #327106732406 stays.');
    expect(st.posts.filter((p) => p.name === 'duplicates').map((p) => p.body)).toEqual([{ productId: DUP_ROW.shopify_product_id, endItemId: '327444779878', keepItemId: '327106732406', acceptLoss: false }]);
  });

  test('phone 390: the rows and both dialogs fit without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockPage(page);
    await loginAs(page, 'admin');
    await page.goto('/ebay?tab=sync&sync=products&ssub=needs_attention');
    await expect(page.getByRole('button', { name: 'Edit for eBay' }).first()).toBeVisible();
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await wide()).toBeLessThanOrEqual(0);
    await page.screenshot({ path: 'test-results/ebay-edit-rows-390.png', fullPage: true });
    await page.getByRole('button', { name: 'Edit for eBay' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Edit for eBay' }).getByLabel('eBay title')).toBeVisible();
    await page.getByRole('button', { name: /Use Image Finder photos/ }).click();
    expect(await wide()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(400);   // let the dialog's open animation finish before the picture
    await page.screenshot({ path: 'test-results/ebay-edit-390.png' });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'End the extra listing' }).click();
    await expect(page.locator('[data-dup="327106732406"]')).toBeVisible();
    expect(await wide()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(400);   // let the dialog's open animation finish before the picture
    await page.screenshot({ path: 'test-results/ebay-dup-390.png' });
  });
});
