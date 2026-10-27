// SHEIN Listings — Phase 0 (probe) + Phase 1 (read-only dashboard), the SERVER side
// (docs/shein-listings-plan.md; docs/context/shein-listings.md). The page's own tests are added
// with the screens. What this pins:
//   · the engine (src/lib/sheinListings.js): one status per size, the plan's fixtures — 14.5W with
//     custom sizes allowed / not allowed (never the nearest size), 4Y/5Y, a swap, a SHEIN-only SKU,
//     an in-review SPU, the 4seller parent-SKU supplier_code that must NOT match, a pending relink;
//     the size-name rules (≤ 50, no full-width, no emoji); stock never makes a size Out of date;
//   · sheinCall's log hook: one shein_api_log row per call, a read logs no body, traceId surfaced;
//   · the snapshot as a server job, end to end against a FAKE SHEIN (HTTP on 127.0.0.1:5194; it
//     answers read paths and REFUSES every write path) and a fake Shopify: a restart mid-run →
//     interrupted → Resume carries on from the first unfinished product; ZERO write calls;
//   · Shopify webhooks: inventory_levels/update goes to the live push exactly as before; a price
//     change flips the size to Out of date without a re-read; a stock-only update changes nothing;
//   · the endpoints: list / filters / search / detail, the gates (probe 403 without the privilege,
//     the log admin-only), 409 while a job runs, the size map's validation (DB only);
//   · the PAGE (/ph/shein-listings, /shein-listings): an empty database renders the designed
//     "Nothing read yet" state; a tile sets ?status= and survives a refresh; ?product= reopens
//     the drawer; ticked products are NOT restored; the custom-size form refuses full-width and
//     emoji; no horizontal scroll at 390 px; times read EST with the browser in Asia/Manila.
// Nothing here can reach a real API: SHEIN goes to the fake (the test server gets SHEIN_API_HOST
// from playwright.config.js), Shopify is faked in-process and never configured for the endpoints'
// jobs (no endpoint test starts a snapshot).
import { test, expect } from '@playwright/test';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { loginAs } from './helpers/auth.js';
import {
  STATUSES, STATUS_ORDER, TILE_STATUSES, BLOCKERS, renderBlocker, sizeKey, resolveSize, validateCustomText, suggestCustomSpelling,
  spuPayload, templateSizes, computeListings, listingHash, normalizeWebhookProduct, rollup, isSheinWrite, matchStore,
  planAddSizes, summarizePlan, sheinNewSizePrice, reviewVerdict, customTextConflict, planPrice, planEdit, variantReadiness, PRICE_FROM, itemRetryable, productReadiness,
} from '../src/lib/sheinListings.js';

const FAKE_PORT = 5194;
const FAKE_HOST = `http://127.0.0.1:${FAKE_PORT}`;
process.env.SHEIN_API_HOST = FAKE_HOST;   // the in-process SHEIN client goes to the fake too

/* --------------------------------- fixtures --------------------------------- */

const ATTR = 87;
const skuRow = (skuCode, supplierSku, label, valueId, extra = {}) => ({ skuCode, supplierSku, label, valueId, ...extra });
function SPU_INFO(spuName, { categoryId, productTypeId, name, supplierCode = null, skcs, price = 150 }) {
  return {
    spuName, categoryId, productTypeId, supplierCode, brandCode: 'NIKE', productMultiNameList: [{ language: 'en', productName: name }], dimensionAttributeInfoList: [],
    skcInfoList: skcs.map((c) => ({
      skcName: c.skcName, supplierCode: c.supplierCode || null, shelfStatusInfoList: [{ siteAbbr: 'shein-us', shelfStatus: 1 }], productMultiNameList: c.names || [],
      skuInfoList: c.sizes.map((s) => ({
        skuCode: s.skuCode, supplierSku: s.supplierSku, mallState: s.mallState ?? 1, length: '33', width: '21', height: '12', weight: 1400,
        saleAttributeList: [{ attributeId: ATTR, attributeValueId: s.valueId, attributeValueMultiList: [{ language: 'en', attributeValueName: s.label }] }],
        priceInfoList: [{ basePrice: s.price ?? price, specialPrice: s.special ?? 0, currency: 'USD', site: 'shein-us' }],
      })),
    })),
  };
}
// SHEIN: men's (custom allowed) · women's (custom allowed, one custom value already in the store) ·
// toddler (custom NOT allowed) · GS (in review) · a SHEIN-only shoe · 7 fillers spu-info doesn't return.
const SHEIN = {
  E2ESPU1: SPU_INFO('E2ESPU1', { categoryId: 1001, productTypeId: 501, name: 'Nike Air Max 95 (IB7936-100)', supplierCode: 'A12', price: 160,   // 4seller's borrowed parent SKU
    skcs: [{ skcName: 'E2ESKC1', supplierCode: 'A12', sizes: [
      skuRow('E2E1-07', 'A7', 'US7', 1), skuRow('E2E1-08', 'A9', 'US8', 2), skuRow('E2E1-09', 'A8', 'US9', 3),   // 8 ⇄ 9 swapped
      skuRow('E2E1-10', 'OLD10', 'US10', 4),                                                                     // relinked to A10, not on SHEIN yet
      skuRow('E2E1-11', 'GONE11', 'US11', 5) ] }] }),                                                            // Shopify has no GONE11
  E2ESPU2: SPU_INFO('E2ESPU2', { categoryId: 1002, productTypeId: 502, name: 'Nike Dunk Low Women (DD1503-101)', price: 120,
    skcs: [{ skcName: 'E2ESKC2', names: [{ language: 'en', productName: 'Dunk Low Women White' }], sizes: [skuRow('E2E2-07', 'W7', 'US7W', 11), skuRow('E2E2-08', 'W8', 'US8W', 12)] }] }),
  E2ESPU3: SPU_INFO('E2ESPU3', { categoryId: 1004, productTypeId: 504, name: 'Jordan 1 GS (GS0001-001)', price: 110,
    skcs: [{ skcName: 'E2ESKC3', sizes: [skuRow('E2E3-4Y', 'Y4', 'US4Y', 31), skuRow('E2E3-5Y', 'Y5', 'US5', 32)] }] }),
  E2ESPU4: SPU_INFO('E2ESPU4', { categoryId: 1003, productTypeId: 503, name: 'Nike Toddler (TD0001-001)', price: 60,
    skcs: [{ skcName: 'E2ESKC4', sizes: [skuRow('E2E4-4C', 'T4', 'US4C', 21)] }] }),
  E2ESPU5: SPU_INFO('E2ESPU5', { categoryId: 1001, productTypeId: 501, name: 'Old 4seller shoe',
    skcs: [{ skcName: 'E2ESKC5', sizes: [skuRow('E2E5-09', 'ZZ9', 'US9', 3), skuRow('E2E5-10', 'ZZ10', 'US10', 4)] }] }),
};
const FILLERS = Array.from({ length: 7 }, (_, i) => `E2EFIL${i + 1}`);
const SPU_ORDER = ['E2ESPU1', 'E2ESPU2', 'E2ESPU3', 'E2ESPU4', 'E2ESPU5', ...FILLERS];   // 12 = two batches of 10
const DOC_STATE = { E2ESPU3: 1 };   // GS: SHEIN is reviewing an earlier edit
const PERM = { 1001: 1, 1002: 1, 1003: 0, 1004: 1 };
const val = (id, label, custom = false) => ({ attribute_value_id: id, attribute_value: label, attribute_value_en: label, is_custom_attribute_value: custom });
const TPL = {
  501: [val(1, 'US7'), val(2, 'US8'), val(3, 'US9'), val(4, 'US10'), val(5, 'US11'), val(6, 'US12'), val(7, 'US14'), val(8, 'US15')],
  502: [val(11, 'US7W'), val(12, 'US8W'), val(13, 'US14W'), val(14, 'US15W'), val(15, 'US 9.5W', true)],
  503: [val(21, 'US4C'), val(22, 'US5C')],
  504: [val(31, 'US4Y'), val(32, 'US5'), val(33, 'US6Y')],
};
const TEMPLATE = (t) => ({ product_type_id: t, attribute_infos: [
  { attribute_id: 27, attribute_name_en: 'Color', attribute_type: 1, attribute_label: 1, attribute_status: 3, attribute_value_info_list: [val(81, 'Black')] },
  { attribute_id: ATTR, attribute_name_en: 'Size', attribute_type: 1, attribute_label: 0, attribute_status: 3, attribute_value_info_list: TPL[t] },
] });

const gidP = (n) => `gid://shopify/Product/${n}`;
const gidV = (n) => `gid://shopify/ProductVariant/${n}`;
function P(n, title, variants, extra = {}) {
  return { productId: gidP(n), title, handle: `e2e-${n}`, vendor: extra.vendor || 'Nike', productType: 'Shoes', tags: [], status: extra.status || 'ACTIVE',
    updatedAt: '2026-10-27T12:00:00Z', image: null, imageCount: 3, style: extra.style ?? (title.match(/\(([A-Z0-9-]+)\)/)?.[1] || null),
    variants: variants.map(([v, sku, size, price, qty]) => ({ variantId: gidV(v), sku, size, price: price == null ? null : String(price), compareAt: null, qty, barcode: null, weightG: null })) };
}
const SHOPIFY = () => [
  P(7701, 'Nike Air Max 95 (IB7936-100)', [[770107, 'A7', '7', 160, 2], [770108, 'A8', '8', 160, 1], [770109, 'A9', '9', 160, 1], [770110, 'A10', '10', 160, 3], [770112, 'A12', '12', 160, 1], [770145, 'A145', '14.5', 160, 1]]),
  P(7702, 'Nike Dunk Low Women (DD1503-101)', [[770207, 'W7', '7W', 120, 1], [770208, 'W8', '8W', 120, 2], [770295, 'W95', '9.5W', 120, 1], [770245, 'W145', '14.5W', 120, 1]]),
  P(7703, 'Nike Toddler (TD0001-001)', [[770304, 'T4', '4C', 60, 1], [770335, 'T35', '3.5C', 60, 1]]),
  P(7704, 'Jordan 1 GS (GS0001-001)', [[770404, 'Y4', '4Y', 110, 1], [770405, 'Y5', '5Y', 110, 1], [770406, 'Y6', '6Y', 110, 1]]),
  P(7705, 'New Shoe (NEW001-001)', [[770509, 'N9', '9', 120, 1], [770510, 'N10', '10', 120, 0], [770500, 'NOS', 'One Size', 120, 1], [770511, 'N11', '11', 0, 1]], { vendor: 'Adidas' }),
  P(7706, 'Draft Shoe (DRF001-001)', [[770609, 'DR9', '9', 100, 1]], { status: 'DRAFT' }),
  P(7707, 'Dup Shoe (DUP001-001)', [[770709, 'DUP1', '9', 100, 1], [770710, 'DUP1', '10', 100, 1]]),
];
const LINKS = [{ shein_sku: 'E2E1-10', spu: 'E2ESPU1', decision: 'link', link_sku: 'A10', seller_sku_was: 'OLD10' }];

// The same answers the fake SHEIN gives, for the pure tests.
const PAYLOADS = () => Object.values(SHEIN).map((s) => spuPayload(s, { docState: DOC_STATE[s.spuName] ? { skcList: [{ skcName: 'x', documentState: DOC_STATE[s.spuName] }] } : null }));
const TEMPLATES = () => new Map(Object.keys(TPL).map((t) => [Number(t), templateSizes([TEMPLATE(Number(t))], Number(t), ATTR)]));
const PERMS = () => new Map(Object.entries(PERM).map(([c, p]) => [`${c}|${ATTR}`, p]));
const compute = (extra = {}) => computeListings({ products: SHOPIFY(), spus: PAYLOADS(), links: LINKS, templates: TEMPLATES(), permissions: PERMS(), customValues: ['US 9.5W'], ...extra });
const byKey = (rows) => new Map(rows.flatMap((p) => p.variants).map((v) => [v.row_key, v]));

/* -------------------------------- the engine -------------------------------- */

test.describe('SHEIN Listings — the engine', () => {
  test('statuses: 8 + unknown, roll-up order, a chip and a label each', () => {
    expect(STATUS_ORDER).toEqual(['blocked', 'error', 'out_of_date', 'not_on_shein', 'shein_only', 'in_review', 'synced', 'excluded']);
    expect(TILE_STATUSES).not.toContain('excluded');
    for (const s of [...STATUS_ORDER, 'unknown']) expect(STATUSES[s]).toMatchObject({ label: expect.any(String), chip: expect.stringContaining('ebo-chip') });
  });

  test('every blocker renders from { code, field, params } — with params and without', () => {
    const codes = ['size_needs_map', 'size_not_on_shein', 'size_unreadable', 'custom_text_invalid', 'no_seller_sku', 'dup_seller_sku', 'seller_sku_taken', 'wrong_link',
      'spu_spans_products', 'no_size_table_value', 'missing_attr', 'no_category', 'brand_not_authorized', 'no_image', 'image_rejected', 'title_too_long', 'no_price',
      'no_weight', 'store_cannot_publish', 'publish_quota_used', 'shelf_quota_full', 'multi_skc_size', 'size_field_retired', 'review_open', 'review_rejected',
      'shein_prevalid', 'price_locked', 'shelf_locked', 'api_error', 'custom_size', 'shopify_inactive'];
    for (const c of codes) {
      expect(BLOCKERS[c], c).toBeTruthy();
      for (const params of [{}, { size: '14.5W', sku: 'A1', spu: 'S1', sheinMessage: 'nope', categoryName: 'Women’s Sneakers', text: 'US14.5W' }]) {
        const r = renderBlocker({ code: c, field: null, params });
        expect(r.title.length, c).toBeGreaterThan(5);
        expect(['blocked', 'error', 'review', 'note']).toContain(r.level);
      }
    }
    const r = renderBlocker({ code: 'size_needs_map', params: { size: '14.5W', categoryName: 'Women’s Sneakers', suggestion: 'US14.5W' } });
    expect(r.title).toBe('14.5W isn’t a SHEIN size yet.');
    expect(r.action.label).toBe('Add 14.5W as a custom size');
    expect(renderBlocker({ code: 'shein_prevalid', params: { sheinMessage: 'Title too long' } }).sheinSaid).toBe('Title too long');
    expect(renderBlocker({ code: 'not_a_code' }).title).toContain('not_a_code');
  });

  test('sizeKey and the size-name rules (≤ 50, half-width, no emoji)', () => {
    expect([sizeKey('9.5W'), sizeKey('10'), sizeKey('US 5Y'), sizeKey('4C'), sizeKey('One Size'), sizeKey('EU 42')]).toEqual(['9.5|W', '10|M', '5|Y', '4|C', null, null]);
    expect(validateCustomText('US14.5W')).toBe(null);
    expect(validateCustomText('US 14.5W')).toBe(null);
    expect(validateCustomText('１４.５W')).toMatch(/Full-width/);
    expect(validateCustomText('US14.5W 👟')).toMatch(/Emoji/);
    expect(validateCustomText('US14.5W ★')).toMatch(/Emoji/);
    expect(validateCustomText('U'.repeat(51))).toMatch(/50/);
    expect(validateCustomText(' US7 ')).toMatch(/spaces/);
    // D1: SHEIN's own pattern; a custom value already in the store wins as typed.
    expect(suggestCustomSpelling('14.5W', ['US7W', 'US8W'])).toBe('US14.5W');
    expect(suggestCustomSpelling('14.5W', ['US 7 W', 'US 8 W'])).toBe('US 14.5 W');
    expect(suggestCustomSpelling('9.5W', ['US7W'], ['US 9.5W'])).toBe('US 9.5W');
    expect(suggestCustomSpelling('14.5W', ['US7W'], ['US 9.5W'])).toBe('US 14.5W');   // the store's own custom pattern wins
  });

  test('14.5W: custom sizes allowed → blocked until a person confirms the spelling, then a note; not allowed → blocked; NEVER the nearest size', () => {
    const values = TPL[502].map((v) => ({ id: v.attribute_value_id, label: v.attribute_value, custom: v.is_custom_attribute_value }));
    const ctx = { categoryId: 1002, attributeId: ATTR, values, maps: [] };
    const allowed = resolveSize('14.5W', { ...ctx, permission: 1 });
    expect(allowed.kind).toBe(null);                                   // not US14W, not US15W
    expect(allowed.blocker).toMatchObject({ code: 'size_needs_map', params: { size: '14.5W', suggestion: 'US 14.5W' } });   // the store's custom 'US 9.5W' sets the pattern (D1)
    expect(resolveSize('14.5W', { ...ctx, permission: 0 }).blocker.code).toBe('size_not_on_shein');
    expect(resolveSize('14.5W', { ...ctx, permission: null }).note.code).toBe('size_unchecked');
    const mapped = resolveSize('14.5W', { ...ctx, permission: 1, maps: [{ category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: 'US14.5W', source: 'custom_created' }] });
    expect(mapped).toMatchObject({ kind: 'custom', label: 'US14.5W', blocker: null, note: { code: 'custom_size' } });
    expect(resolveSize('7W', { ...ctx, permission: 1 })).toMatchObject({ kind: 'value', valueId: 11, source: 'exact' });
    // a typo'd custom value in the map is refused, not sent
    expect(resolveSize('14.5W', { ...ctx, permission: 1, maps: [{ category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: '１４.５W' }] }).blocker.code).toBe('custom_text_invalid');
    // size chart products need a foot length
    expect(resolveSize('7W', { ...ctx, permission: 1, sizeTable: true }).blocker.code).toBe('no_size_table_value');
  });

  test('matching: seller SKU, then shein_links — never the SPU/SKC supplier_code (4seller’s borrowed parent SKU)', () => {
    const m = matchStore({ products: SHOPIFY(), sheinRows: PAYLOADS().flatMap((p) => p.rows), links: LINKS });
    expect(m.byVariant.get(gidV(770107))).toMatchObject({ match: 'sku', row: { sheinSku: 'E2E1-07' } });
    expect(m.byVariant.get(gidV(770110))).toMatchObject({ match: 'link', row: { sheinSku: 'E2E1-10', sellerSku: 'OLD10' } });
    expect(m.byVariant.has(gidV(770112))).toBe(false);                       // A12 = the SPU's supplierCode: NOT a match
    expect(m.sheinOnly.map((x) => x.row.sheinSku).sort()).toEqual(['E2E1-11', 'E2E5-09', 'E2E5-10']);
    expect(m.skuCount.get('DUP1')).toBe(2);
  });

  test('the fixtures, one status per size', () => {
    const rows = compute();
    const v = byKey(rows);
    const st = (n) => v.get(gidV(n))?.status;
    // Air Max: synced · swap (both blocked) · relink pending · parent-SKU size not matched · 14.5 custom allowed · SHEIN-only
    expect(st(770107)).toBe('synced');
    expect([st(770108), st(770109)]).toEqual(['blocked', 'blocked']);
    expect(v.get(gidV(770108)).blockers[0]).toMatchObject({ code: 'wrong_link', params: { sheinSize: 'US9', size: '8' } });
    expect(st(770110)).toBe('out_of_date');
    expect(v.get(gidV(770110)).diffs).toEqual([expect.objectContaining({ field: 'seller_sku', from: 'OLD10', to: 'A10' })]);
    expect(v.get(gidV(770112))).toMatchObject({ status: 'not_on_shein', match: 'none', size_plan: { kind: 'value', valueId: 6 } });
    expect(v.get(gidV(770145)).blockers[0].code).toBe('size_needs_map');
    expect(v.get('shein:E2E1-11')).toMatchObject({ status: 'shein_only', shopify_product_id: gidP(7701), shopify_variant_id: null });
    // Women's: synced; 9.5W reuses the store's custom value as the suggestion; 14.5W needs a person
    expect([st(770207), st(770208)]).toEqual(['synced', 'synced']);
    expect(v.get(gidV(770295)).blockers[0]).toMatchObject({ code: 'size_needs_map', params: { suggestion: 'US 9.5W' } });
    expect(v.get(gidV(770245)).blockers[0]).toMatchObject({ code: 'size_needs_map', params: { suggestion: 'US 14.5W' } });
    // Toddler: SHEIN won't take a custom size → blocked, never rounded
    expect(st(770304)).toBe('synced');
    expect(v.get(gidV(770335)).blockers[0].code).toBe('size_not_on_shein');
    // GS in review: 4Y and 5Y (SHEIN "US5" for a 5Y — youth vs adult, not a wrong link) are In review; 6Y to add, with the review note
    expect([st(770404), st(770405)]).toEqual(['in_review', 'in_review']);
    expect(v.get(gidV(770406))).toMatchObject({ status: 'not_on_shein', size_plan: { valueId: 33 } });
    expect(v.get(gidV(770406)).notes.map((n) => n.code)).toContain('review_open');
    // New shoe: no category yet → not on SHEIN with a note; unreadable size + no price → blocked
    expect(st(770509)).toBe('not_on_shein');
    expect(v.get(gidV(770509)).notes[0]).toMatchObject({ code: 'size_unchecked', params: { reason: 'no_category' } });
    expect(v.get(gidV(770500)).blockers[0].code).toBe('size_unreadable');
    expect(v.get(gidV(770511)).blockers[0].code).toBe('no_price');
    // Draft → off; a SKU on two variants → blocked
    expect(st(770609)).toBe('excluded');
    expect([st(770709), st(770710)]).toEqual(['blocked', 'blocked']);
    expect(v.get(gidV(770709)).blockers[0]).toMatchObject({ code: 'dup_seller_sku', params: { sku: 'DUP1', count: 2 } });
    // products: one row each (+ the SHEIN-only shoe), roll-ups, coverage
    const prods = new Map(rows.map((p) => [p.shopify_product_id, p]));
    expect(rows.length).toBe(8);
    expect(prods.get(gidP(7701))).toMatchObject({ status: 'blocked', spu: 'E2ESPU1', category_id: 1001, counts: { sizes: 6, on_shein: 4 } });
    expect(prods.get(gidP(7704)).status).toBe('not_on_shein');   // worst of in-stock: 6Y to add beats in review
    expect(prods.get(gidP(7706)).status).toBe('excluded');
    expect(prods.get('shein:E2ESPU5')).toMatchObject({ status: 'shein_only', title: 'Old 4seller shoe' });
    for (const p of rows) for (const x of p.variants) expect([...STATUS_ORDER]).toContain(x.status);
  });

  test('zero-stock sizes don’t count toward the roll-up (D10)', () => {
    expect(rollup([{ status: 'synced', qty: 2 }, { status: 'blocked', qty: 0 }])).toBe('synced');
    expect(rollup([{ status: 'not_on_shein', qty: 0 }, { status: 'blocked', qty: 0 }])).toBe('blocked');   // nothing in stock: all count
    expect(rollup([{ status: 'excluded', qty: 1 }])).toBe('excluded');
  });

  test('stock never makes a size Out of date; a price change does (the accepted baseline carries over)', () => {
    const first = compute();
    const prev = { products: new Map(first.map((p) => [p.shopify_product_id, p])), variants: byKey(first) };
    const stockOnly = SHOPIFY(); stockOnly[0].variants[0].qty = 0;
    expect(listingHash(stockOnly[0])).toBe(listingHash(SHOPIFY()[0]));
    expect(byKey(compute({ products: stockOnly, prev })).get(gidV(770107)).status).toBe('synced');
    const priced = SHOPIFY(); priced[0].variants[0].price = '149.00';
    expect(listingHash(priced[0])).not.toBe(listingHash(SHOPIFY()[0]));
    const after = byKey(compute({ products: priced, prev })).get(gidV(770107));
    expect(after.status).toBe('out_of_date');
    // the Shopify change AND (Phase 3, D4) SHEIN's price vs the new target
    expect(after.diffs).toEqual([expect.objectContaining({ field: 'shein_price', from: '160.00', to: '149.00' }), expect.objectContaining({ field: 'price', from: '160.00', to: '149.00' })]);
  });

  test('a person’s “leave off SHEIN” carries over; a REST webhook payload hashes like the GraphQL read', () => {
    const first = compute();
    const vars = byKey(first); vars.set(gidV(770145), { ...vars.get(gidV(770145)), excluded: true, excluded_by: 'Kim' });
    const v = byKey(compute({ prev: { products: new Map(), variants: vars } })).get(gidV(770145));
    expect(v).toMatchObject({ status: 'excluded', excluded: true });
    expect(v.notes[0]).toMatchObject({ code: 'excluded_by_person', params: { by: 'Kim' } });
    const rest = { id: 7701, admin_graphql_api_id: gidP(7701), title: 'Nike Air Max 95 (IB7936-100)', vendor: 'Nike', product_type: 'Shoes', tags: '', status: 'active', handle: 'e2e-7701',
      options: [{ name: 'Size', position: 1 }], images: [{}, {}, {}],
      variants: SHOPIFY()[0].variants.map((x) => ({ id: Number(x.variantId.split('/').pop()), admin_graphql_api_id: x.variantId, sku: x.sku, option1: x.size, price: Number(x.price).toFixed(2), compare_at_price: null, inventory_quantity: 99, barcode: '' })) };
    expect(listingHash(normalizeWebhookProduct(rest))).toBe(listingHash(SHOPIFY()[0]));
  });

  test('the nightly snapshot: 03:00–03:59 EST (never the host’s clock), once per EST day', async () => {
    const { nightlyDue } = await import('../api/_lib/shein-listing.js');
    expect(nightlyDue(null, new Date('2026-10-27T07:30:00Z'))).toBe(true);    // 03:30 EDT
    expect(nightlyDue(null, new Date('2026-10-27T06:30:00Z'))).toBe(false);   // 02:30 EDT
    expect(nightlyDue(null, new Date('2026-12-01T08:10:00Z'))).toBe(true);    // 03:10 EST (winter)
    expect(nightlyDue({ created_at: '2026-10-27T07:01:00Z' }, new Date('2026-10-27T07:40:00Z'))).toBe(false);   // already ran this EST day
    expect(nightlyDue({ created_at: '2026-10-26T07:01:00Z' }, new Date('2026-10-27T07:40:00Z'))).toBe(true);
  });

  test('the read-only list: every Phase 0/1 call is a read; partialEdit, publish, stock and price are writes', () => {
    for (const p of ['/open-api/goods/searchProduct', '/open-api/goods/spu-info', '/open-api/goods/query-document-state', '/open-api/goods/get-custom-attribute-permission-config',
      '/open-api/goods/query-attribute-template', '/open-api/openapi-business-backend/product/query']) expect(isSheinWrite(p), p).toBe(false);
    for (const p of ['/open-api/goods/product/partialEdit', '/open-api/goods/product/publishOrEdit', '/open-api/stock/change-inventory/v2',
      '/open-api/openapi-business-backend/product/price/save', '/open-api/goods/modify-skc-shelf', '/open-api/goods/delete/s1', '/open-api/goods/add-custom-attribute-value']) expect(isSheinWrite(p), p).toBe(true);
  });
});

/* ------------------------- the fake SHEIN + the database ------------------------- */

// Phase 2: `fake.p2` turns on a STATEFUL partialEdit (else every write is refused): what SHEIN was
// sent (edits), the seller SKUs it now knows (in review), each SPU's review state, refusals / no answer.
const fake = { calls: [], writes: [], gate: null, traces: 0, p2: null };
// Stricter since the API review (scratchpad plan/phase2-review.md): partialEdit VALIDATES the body
// the way doc 3002047 describes (one SKC; the siblings' one sale attribute; value id XOR custom text;
// custom only where has_permission 1; plain ASCII ≤ 50; no value twice in the SKC; L/W/H strings,
// weight, mall_state 1, USD price, stock 0 in OUR warehouse code; no "" anywhere (= "clear it"); no
// size chart; the SKC title re-sent where the store carries one) and refuses with a CODED answer
// (code ≠ 0 + info.pre_valid_result) like SHEIN does. It answers every SKU of the SKC (untouched
// ones with supplier_sku ""), answers query-document-state for the version ASKED, can lag the
// seller-SKU check, and plays the IP-whitelist / "system busy" / no-version answers.
const P2 = () => ({ edits: [], pending: new Map(), docs: {}, hist: {}, refuse: {}, refuseCoded: {}, fail503: 0, busy: 0, whitelist: false, noVersion: 0, warn: false, lag: false,
  approved: {}, relinked: {}, sort: true, nextId: 9901, versions: 0,
  // Phase 3: SHEIN's prices / special prices / stopped sizes / titles as they are now, price/save calls, rises in review
  prices: {}, special: {}, mall: {}, title: {}, priceCalls: [], priceReview: {}, endedSpecials: [], losePriceAnswer: 0,
  fill: { 1002: [{ module: 'basic_info', field_key: 'skc_title', show: true, required: false }] } });
function validateEdit(body) {
  const base = SHEIN[body.spu_name];
  if (!base) return `spu_name ${body.spu_name} doesn’t exist`;
  const empty = (o, at = '') => { for (const [k, v] of Object.entries(o || {})) { if (v === '' || v === null) return `${at}${k}`; if (v && typeof v === 'object') { const r = empty(v, `${at}${k}.`); if (r) return r; } } return null; };
  const blank = empty(body);
  if (blank) return `field ${blank} is empty — that would clear it`;
  if (body.multi_language_name_list) {
    const l = body.multi_language_name_list;
    if (!Array.isArray(l) || !l.some((x) => x.language === 'en') || l.some((x) => !x.name || x.name.length > 1000)) return 'multi_language_name_list: the default language (en), ≤ 1000';
    if (!body.skc_list) return null;   // a title-only edit (SPU level)
  }
  if ((body.skc_list || []).length !== 1) return 'one SKC per edit here';
  if (body.size_attribute_list) return 'this product has no size chart';
  const cur = sheinNow(body.spu_name); const c = body.skc_list[0];
  const skc = cur.skcInfoList.find((x) => x.skcName === c.skc_name);
  if (!skc) return `skc_name ${c.skc_name} isn’t on ${body.spu_name}`;
  const title = (fake.p2.fill[base.categoryId] || []).find((x) => x.field_key === 'skc_title');
  if (title?.show && (skc.productMultiNameList || []).length && !c.skc_title) return 'skc_title left out — that clears the SKC title';
  const have = new Set(skc.skuInfoList.flatMap((k) => (k.saleAttributeList || []).flatMap((a) => [`id:${a.attributeValueId}`, `t:${a.attributeValueMultiList?.[0]?.attributeValueName}`])));
  for (const k of c.sku_list || []) {
    if (k.sku_code) {
      if (!skc.skuInfoList.some((x) => x.skuCode === k.sku_code)) return `sku_code ${k.sku_code} not found`;
      if ('mall_state' in k && ![1, 2].includes(k.mall_state)) return 'mall_state: 1 or 2';
      if (k.price_info_list || k.stock_info_list) return 'price_info_list / stock_info_list can’t be sent for an existing SKU (编辑时不可传)';
      continue;
    }
    const a = k.sale_attribute_list || [];
    if (a.length !== 1 || a[0].attribute_id !== ATTR) return 'every SKU must carry the same sale attributes as its siblings (the size only)';
    const hasId = a[0].attribute_value_id != null; const hasText = a[0].custom_attribute_value != null;
    if (hasId === hasText) return 'give attribute_value_id OR custom_attribute_value';
    if (hasText) {
      if (PERM[base.categoryId] !== 1) return 'This attribute does not support custom attribute values in this category';
      if (!/^[\x21-\x7E](?:[\x21-\x7E]| (?! ))*$/.test(a[0].custom_attribute_value) || a[0].custom_attribute_value.length > 50 || a[0].language !== 'en') return 'custom value: half-width, ≤ 50, language en';
    } else if (!TPL[base.productTypeId].some((v) => v.attribute_value_id === a[0].attribute_value_id)) return `attribute_value_id ${a[0].attribute_value_id} isn’t in this category`;
    const key = hasId ? `id:${a[0].attribute_value_id}` : `t:${a[0].custom_attribute_value}`;
    if (have.has(key)) return 'sale attribute value repeated in this SKC';
    have.add(key);
    if (!k.supplier_sku) return 'supplier_sku is required';
    for (const f of ['length', 'width', 'height']) if (!(typeof k[f] === 'string' && Number(k[f]) > 0)) return `${f}: a positive number (string)`;
    if (!(typeof k.weight === 'number' && k.weight > 0) || k.mall_state !== 1) return 'weight / mall_state';
    const pr = k.price_info_list || [];
    if (!pr.length || pr.some((x) => !(x.base_price > 0) || x.currency !== 'USD' || x.sub_site !== 'shein-us')) return 'price_info_list is required for a new SKU';
    const st = k.stock_info_list || [];
    if (st.length !== 1 || st[0].inventory_num !== 0 || st[0].supplier_warehouse_id !== 'PSE2E1') return 'stock_info_list: inventory_num 0 in warehouse PSE2E1';
  }
  return null;
}
// spu-info as SHEIN shows it after the reviews approved so far (new sizes + relinks applied).
function sheinNow(spuName) {
  const base = SHEIN[spuName];
  if (!base || !fake.p2) return base || {};
  const s = JSON.parse(JSON.stringify(base));
  const p = fake.p2;
  if (p.title[spuName]) s.productMultiNameList = p.title[spuName];
  for (const c of s.skcInfoList) {
    for (const k of c.skuInfoList) {
      if (p.relinked[k.skuCode]) k.supplierSku = p.relinked[k.skuCode];
      if (p.mall[k.skuCode]) k.mallState = p.mall[k.skuCode];
      for (const pr of k.priceInfoList || []) { if (p.prices[k.skuCode] != null) pr.basePrice = p.prices[k.skuCode]; if (p.special[k.skuCode] != null) pr.specialPrice = p.special[k.skuCode]; }
    }
    for (const n of fake.p2.approved[spuName] || []) if (n.skc === c.skcName) {
      c.skuInfoList.push({ skuCode: n.skuCode, supplierSku: n.supplierSku, mallState: 1, length: '33', width: '21', height: '12', weight: 1400,
        saleAttributeList: [{ attributeId: ATTR, attributeValueId: n.valueId, attributeValueMultiList: [{ language: 'en', attributeValueName: n.label }] }],
        priceInfoList: [{ basePrice: n.price, specialPrice: 0, currency: 'USD', site: 'shein-us' }] });
    }
  }
  return s;
}
// SHEIN approves what it was sent for this SPU: the sizes appear in spu-info (a custom value gets an id).
function approveOnFake(spuName) {
  const p = fake.p2; const list = p.approved[spuName] || (p.approved[spuName] = []);
  for (const e of p.edits.filter((x) => x.body.spu_name === spuName && x.ok && !x.applied)) {
    e.applied = true;
    if (e.body.multi_language_name_list) p.title[spuName] = e.body.multi_language_name_list.map((x) => ({ language: x.language, productName: x.name }));
    for (const c of e.body.skc_list || []) for (const k of c.sku_list) {
      if (k.sku_code) { if (k.supplier_sku) p.relinked[k.sku_code] = k.supplier_sku; if (k.mall_state) p.mall[k.sku_code] = k.mall_state; continue; }
      const a = k.sale_attribute_list[0];
      const label = a.custom_attribute_value || Object.values(TPL).flat().find((v) => v.attribute_value_id === a.attribute_value_id)?.attribute_value;
      list.push({ skc: c.skc_name, skuCode: `NEW-${k.supplier_sku}`, supplierSku: k.supplier_sku, valueId: a.attribute_value_id ?? p.nextId++, label, price: k.price_info_list[0].base_price });
    }
  }
  for (const e of p.edits.filter((x) => x.body.spu_name === spuName && x.ok && x.version)) p.hist[`${spuName}|${e.version}`] = { state: 2 };
  p.docs[spuName] = { ...(p.docs[spuName] || {}), state: 2 };
}
/* Phase 4 — the fake's new-product side (spec scratchpad plan/phase4-spec.md). Ids far from real SHEIN ones. */
const P4CAT = 9960001; const P4TYPE = 960601;
const P4TREE = [{ category_id: 9960000, category_name: 'E2E Shoes', last_category: false, children: [
  { category_id: P4CAT, category_name: 'E2E Men’s Sneakers', last_category: true, product_type_id: P4TYPE, parent_category_id: 9960000, children: [] },
  { category_id: 9960002, category_name: 'E2E Women’s Sneakers', last_category: true, product_type_id: 960602, parent_category_id: 9960000, children: [] }] }];
const P4TEMPLATE = { product_type_id: P4TYPE, main_attribute_status: 2, attribute_infos: [
  { attribute_id: 27, attribute_name_en: 'Color', attribute_type: 1, attribute_label: 1, attribute_status: 3, attribute_mode: 2, attribute_value_info_list: [val(900, 'Default'), val(901, 'White')] },
  { attribute_id: ATTR, attribute_name_en: 'Size', attribute_type: 1, attribute_label: 0, attribute_status: 3, attribute_mode: 2,
    attribute_value_info_list: [7, 8, 9, 10, 11, 12, 14].map((n) => val(6000 + n, `US${n}`)) },
  { attribute_id: 7000, attribute_name_en: 'Upper Material', attribute_type: 4, attribute_mode: 3, attribute_status: 3, data_dimension: 1, attribute_value_info_list: [val(7001, 'Leather'), val(7002, 'Mesh')] },
  { attribute_id: 7100, attribute_name_en: 'Closure Type', attribute_type: 4, attribute_mode: 1, attribute_status: 2, attribute_input_num: 2, data_dimension: 1, attribute_value_info_list: [val(7101, 'Lace-up'), val(7102, 'Hook-and-loop')] },
  { attribute_id: 7200, attribute_name_en: 'Lining Material', attribute_type: 4, attribute_mode: 3, attribute_status: 2, data_dimension: 1, attribute_value_info_list: [val(7201, 'Fabric')] },
] };
const P4FILL = { fill_in_standard_list: [{ module: 'basic_info', field_key: 'brand_code', required: true, show: true }, { module: 'basic_info', field_key: 'skc_title', required: false, show: false }],
  default_language: 'en', default_language_title_max_length: 60, currency: 'USD', support_sale_attribute_sort: true, supplier_code_in_spu_dimension: false,
  picture_config_list: [{ field_key: 'switch_spu_picture', is_true: false }, { field_key: 'sku_image_required', is_true: false }] };
const P4 = () => ({ canPublish: true, reason: null, quota: { isControlled: true, availableQuota: 5, totalQuota: 10, usedCount: 5 }, shelf: { need: false, remain_count: null },
  calls: [], transforms: [], rejectNext: 0, noAnswer: 0, refuse: null, pending: new Map(), docs: {}, hist: {}, versions: 0, spus: 0,
  // review S10: the store's rules can be swapped (new picture plans A/B, supplier_code at SPU level, brand optional),
  // answers can carry filtered_result / an mcc type-2 block, the seller-SKU check can lag, a request can be dropped
  fill: null, answer: null, lag: false, drop: 0 });
const P4PLAN_A = [{ field_key: 'spu_image_detail_show', is_true: true }, { field_key: 'spu_image_detail_single', is_true: true }, { field_key: 'skc_image_detail_required', is_true: true },
  { field_key: 'skc_image_square_required', is_true: true }, { field_key: 'sku_image_required', is_true: false }];
const P4PLAN_B = [{ field_key: 'spu_image_detail_show', is_true: true }, { field_key: 'spu_image_detail_required', is_true: true }, { field_key: 'spu_image_square_required', is_true: true },
  { field_key: 'skc_image_detail_required', is_true: false }, { field_key: 'skc_image_square_required', is_true: false }, { field_key: 'sku_image_required', is_true: false }];
const p4fill = () => fake.p4?.fill || P4FILL;
// The body checks doc 3002018 + the spec describe; a failure → a coded refusal (code ≠ 0 + info.pre_valid_result).
function validatePublish(b) {
  const bad = (m) => m;
  const walk = (o, at = '') => { for (const [k, v] of Object.entries(o || {})) { if (['spu_name', 'skc_name', 'sku_code', 'image_group_code', 'image_item_id', 'special_price'].includes(k)) return `${at}${k} can’t be sent on a new product`; if (v === '' || v === null) return `${at}${k} is empty`; if (v && typeof v === 'object') { const r = walk(v, `${at}${k}.`); if (r) return r; } } return null; };
  const w = walk(b); if (w) return bad(w);
  if (b.category_id !== P4CAT || b.product_type_id !== P4TYPE) return bad('category_id must be a leaf and product_type_id its type');
  const fill = p4fill(); const flags = new Map((fill.picture_config_list || []).map((x) => [x.field_key, x.is_true === true]));
  const newPlan = flags.has('spu_image_detail_show');
  if (b.source_system !== 'OpenAPI' || b.suit_flag !== '0' || b.is_spu_pic !== newPlan) return bad('source_system / suit_flag / is_spu_pic (by the picture plan)');
  const brandReq = (fill.fill_in_standard_list || []).some((f) => f.field_key === 'brand_code' && f.required);
  if (brandReq && b.brand_code !== 'NIKE01') return bad('brand_code is required in this category');
  if ('brand_code' in b && b.brand_code !== 'NIKE01') return bad('brand_code isn’t one of the store’s brands');
  if (fill.supplier_code_in_spu_dimension === true ? b.supplier_code !== `SB12-P${String(b.skc_list?.[0]?.supplier_code || '').replace('SB12-P', '')}` || !b.supplier_code : 'supplier_code' in b) return bad('supplier_code level (supplier_code_in_spu_dimension)');
  if (newPlan) {   // guide 4d96fc8f: plans A / B are built from the flags
    const spu = b.image_info?.image_info_list || [];
    if ('image_info' in b && !spu.length) return bad('image_info with an empty list');
    const st = (n2) => spu.filter((x) => x.image_type === n2).length;
    if (flags.get('spu_image_detail_show') && (st(1) !== 1 || spu.find((x) => x.image_type === 1)?.image_sort !== 1)) return bad('SPU main image (type 1 at sort 1)');
    if (flags.get('spu_image_detail_show') && !flags.get('spu_image_detail_single') && !st(2)) return bad('SPU detail images');
    if (flags.get('spu_image_detail_single') && st(2)) return bad('SPU single: main only');
    if (!!flags.get('spu_image_square_required') !== (st(5) === 1)) return bad('SPU square (type 5) iff required');
  }
  const n = b.multi_language_name_list || [];
  if (n.length !== 1 || n[0].language !== 'en' || n[0].name.length < 2 || n[0].name.length > 60) return bad('multi_language_name_list: en, 2–60');
  if (b.multi_language_desc_list && (/<[^>]+>/.test(b.multi_language_desc_list[0].name) || b.multi_language_desc_list[0].language !== 'en')) return bad('the description must be plain text');
  if (JSON.stringify(b.site_list) !== JSON.stringify([{ main_site: 'shein', sub_site_list: ['shein-us'] }])) return bad('site_list');
  const pa = b.product_attribute_list || [];
  const upper = pa.filter((x) => x.attribute_id === 7000);
  if (upper.length !== 1 || ![7001, 7002].includes(upper[0].attribute_value_id)) return bad('Upper Material is required (one value)');
  if (upper[0].attribute_value_id === 7001 && !pa.some((x) => x.attribute_id === 7200 && x.attribute_value_id === 7201)) return bad('Lining Material is required with a leather upper');
  if (pa.some((x) => ![7000, 7100, 7200].includes(x.attribute_id))) return bad('a product attribute that isn’t in the template');
  if ((b.skc_list || []).length !== 1) return bad('one SKC');
  const c = b.skc_list[0];
  if (!c.supplier_code) return bad('skc supplier_code');
  if (c.sale_attribute?.attribute_id !== 27 || ![900, 901].includes(c.sale_attribute?.attribute_value_id)) return bad('the SKC sale attribute (colour)');
  const imgs = c.image_info?.image_info_list || [];
  const t = (n2) => imgs.filter((x) => x.image_type === n2);
  if (!newPlan && (t(1).length !== 1 || t(1)[0].image_sort !== 1 || !t(2).length || t(2).length > 10 || t(5).length !== 1)) return bad('images: 1 main at sort 1, 1–10 details, 1 square');
  if (newPlan && (t(1).length !== 1 || t(1)[0].image_sort !== 1 || (!!flags.get('skc_image_detail_required') && !flags.get('skc_image_detail_single')) !== (t(2).length > 0) || !!flags.get('skc_image_square_required') !== (t(5).length === 1))) return bad('SKC images per the new plan');
  if (new Set(imgs.map((x) => x.image_sort)).size !== imgs.length || imgs.some((x) => !/^https:\/\/img\.ltwebstatic\.com\//.test(x.image_url))) return bad('image_sort unique; SHEIN image URLs only');
  const seen = new Set();
  for (const k of c.sku_list || []) {
    const a = k.sale_attribute_list || [];
    if (a.length !== 1 || a[0].attribute_id !== ATTR) return bad('one size attribute per SKU');
    if ((a[0].attribute_value_id != null) === (a[0].custom_attribute_value != null)) return bad('attribute_value_id OR custom_attribute_value');
    const key = a[0].attribute_value_id ?? a[0].custom_attribute_value; if (seen.has(key)) return bad('a size twice'); seen.add(key);
    if (!k.supplier_sku || k.mall_state !== 1) return bad('supplier_sku / mall_state');
    for (const f of ['length', 'width', 'height']) if (typeof k[f] !== 'string' || !(Number(k[f]) > 0)) return bad(`${f}: a positive number as a string`);
    if (typeof k.weight !== 'number' || !(k.weight > 0)) return bad('weight: grams (number)');
    const pr = k.price_info_list || [];
    if (pr.length !== 1 || !(pr[0].base_price > 0) || pr[0].currency !== 'USD' || pr[0].sub_site !== 'shein-us') return bad('price_info_list: base_price, USD, shein-us');
    const st = k.stock_info_list || [];
    if (st.length !== 1 || st[0].inventory_num !== 0 || st[0].supplier_warehouse_id !== 'PSE2E1') return bad('stock_info_list: 0 in our warehouse');
    if (fake.p4.pending.has(k.supplier_sku)) return bad(`supplier_sku ${k.supplier_sku} repeated`);
  }
  return null;
}
async function onPublishSide(path, body, res) {
  const p = fake.p4; if (!p) return false;
  const known = { '/open-api/goods/product/check-publish-permission': 1, '/open-api/goods-publish-quotas/detail': 1, '/open-api/goods/query-shelf-quota': 1, '/open-api/goods/query-site-list': 1,
    '/open-api/goods/query-brand-list': 1, '/open-api/goods/query-category-tree': 1, '/open-api/goods/image-category-suggestion': 1, '/open-api/goods/get-associated-attribute-rules': 1,
    '/open-api/goods/transform-pic': 1, '/open-api/goods/product/publishOrEdit': 1, '/open-api/goods-compliance-requirements/list': 1 };
  if (!known[path] && !(path === '/open-api/goods/query-publish-fill-in-standard' && body.category_id === P4CAT) && !(path === '/open-api/goods/query-attribute-template' && (body.product_type_id_list || []).includes(P4TYPE))
    && !(path === '/open-api/goods/get-custom-attribute-permission-config' && (body.category_id_list || []).includes(P4CAT))) return false;
  p.calls.push(path);
  switch (path) {
    case '/open-api/goods/product/check-publish-permission': answer(res, { canPublishProduct: p.canPublish, reason: p.canPublish ? null : p.reason || 'store closed' }); return true;
    case '/open-api/goods-publish-quotas/detail': answer(res, p.quota); return true;
    case '/open-api/goods/query-shelf-quota': answer(res, p.shelf); return true;
    case '/open-api/goods/query-site-list': answer(res, { data: [{ main_site: 'shein', main_site_name: 'SHEIN', sub_site_list: [{ site_abbr: 'shein-us', site_name: 'US', site_status: 1, currency: 'USD', store_type: 1 }] }] }); return true;
    case '/open-api/goods/query-brand-list': answer(res, { data: [{ brand_code: 'NIKE01', brand_name: 'Nike' }] }); return true;
    case '/open-api/goods/query-category-tree': answer(res, { data: P4TREE }); return true;
    case '/open-api/goods/image-category-suggestion': answer(res, { data: [{ categoryId: String(P4CAT), order: 1, vote: 92 }] }); return true;
    case '/open-api/goods/query-publish-fill-in-standard': answer(res, p4fill()); return true;
    case '/open-api/goods/query-attribute-template': answer(res, { data: [P4TEMPLATE] }); return true;
    case '/open-api/goods/get-custom-attribute-permission-config': answer(res, { data: [{ last_category_id: P4CAT, attribute_id: ATTR, has_permission: 1 }] }); return true;
    case '/open-api/goods/get-associated-attribute-rules': {
      const req = (body.get_linked_rule_req_list || [])[0] || {};
      const leather = (req.attribute_list || []).some((x) => x.attribute_id === 7000 && x.attribute_value_id === 7001);
      answer(res, { data: [{ group_id: req.group_id, link_rule_attribute_list: leather ? [{ attribute_id: 7200, attribute_value_list: [7201], attribute_value_pre_fill_list: [] }] : [] }] }); return true;
    }
    case '/open-api/goods/transform-pic': {
      p.transforms.push(body);
      if (!/^https:\/\/r2\.e2e\.test\//.test(body.original_url || '')) { answer(res, { original: body.original_url, transformed: '', failure_reason: 'not our host' }); return true; }
      if (p.rejectNext > 0) { p.rejectNext -= 1; answer(res, { original: body.original_url, transformed: '', failure_reason: '图片下载异常' }); return true; }
      answer(res, { original: body.original_url, transformed: `https://img.ltwebstatic.com/e2e/${crypto.createHash('sha1').update(body.original_url).digest('hex').slice(0, 10)}-${body.image_type}.jpg` }); return true;
    }
    case '/open-api/goods-compliance-requirements/list':
      answer(res, { data: (body.skcNames || []).map((skcName) => ({ skcName, items: [{ certificateTypeName: 'CPC', certificateTypeCode: 'CPC', isRequired: 1, reviewState: 0 }] })) }); return true;
    case '/open-api/goods/product/publishOrEdit': {
      const why = validatePublish(body);
      if (why) { answer(res, { success: false, pre_valid_result: [{ module: 'e2e-validate', messages: [why] }] }, 200, '20003', 'Product verification failed'); return true; }
      if (p.refuse) { const m = p.refuse; p.refuse = null; answer(res, { success: false, pre_valid_result: [{ module: 'image_info', form: 'skc_list.image_info', messages: [m] }] }); return true; }
      if (p.drop > 0) { p.drop -= 1; p.dropped = (p.dropped || 0) + 1; answer(res, null, 503, 'E2E-503', 'gateway timeout (never reached SHEIN)'); return true; }
      if (p.answer === 'mcc2') { p.answer = null; answer(res, { success: false, mcc_valid_result: [{ type: 2, message: 'Governance: this brand is blocked for the store' }] }); return true; }
      const spu = `E2ENEW${++p.spus}`; const version = `E2EPV${++p.versions}`; const skc = `${spu}SKC`;
      for (const k of body.skc_list[0].sku_list) p.pending.set(k.supplier_sku, spu);
      p.published = p.published || []; p.published.push({ spu, version, body });
      p.docs[spu] = { state: 1, version }; p.hist[`${spu}|${version}`] = { state: 1 };
      if (p.noAnswer > 0) { p.noAnswer -= 1; answer(res, null, 503, 'E2E-503', 'gateway timeout (the answer was lost)'); return true; }
      if (p.sysError) { p.sysError = false; answer(res, null, 200, '500001', '系统异常'); return true; }   // re-review G2: a coded system error AFTER SHEIN took it
      const filtered = p.answer === 'filtered' ? [{ scene: 'skc', message: 'competing_product_link dropped' }] : null; if (p.answer === 'filtered') p.answer = null;
      answer(res, { success: true, spu_name: spu, version, pre_valid_result: null, filtered_result: filtered,
        skc_list: [{ skc_name: skc, sku_list: body.skc_list[0].sku_list.map((k, i) => ({ sku_code: `${spu}-K${i + 1}`, supplier_sku: k.supplier_sku })) }] }); return true;
    }
    default: return false;
  }
}
// SHEIN approves a published product: spu-info shows it from now on.
function approvePublishOnFake(spu) {
  const pub = fake.p4.published.find((x) => x.spu === spu); const b = pub.body;
  SHEIN[spu] = { spuName: spu, categoryId: b.category_id, productTypeId: b.product_type_id, brandCode: b.brand_code, productMultiNameList: [{ language: 'en', productName: b.multi_language_name_list[0].name }], dimensionAttributeInfoList: [],
    skcInfoList: [{ skcName: `${spu}SKC`, shelfStatusInfoList: [{ siteAbbr: 'shein-us', shelfStatus: 1 }], productMultiNameList: [],
      skuInfoList: b.skc_list[0].sku_list.map((k, i) => ({ skuCode: `${spu}-K${i + 1}`, supplierSku: k.supplier_sku, mallState: 1, length: k.length, width: k.width, height: k.height, weight: k.weight,
        saleAttributeList: [{ attributeId: ATTR, attributeValueId: k.sale_attribute_list[0].attribute_value_id ?? 9990 + i, attributeValueMultiList: [{ language: 'en', attributeValueName: P4TEMPLATE.attribute_infos[1].attribute_value_info_list.find((v) => v.attribute_value_id === k.sale_attribute_list[0].attribute_value_id)?.attribute_value || k.sale_attribute_list[0].custom_attribute_value }] }],
        priceInfoList: [{ basePrice: k.price_info_list[0].base_price, specialPrice: 0, currency: 'USD', site: 'shein-us' }] })) }] };
  fake.p4.docs[spu].state = 2; fake.p4.hist[`${spu}|${pub.version}`] = { state: 2 };
}
let server; let pool; let foreign = false; let saved = {}; let secretsOk = false;
const jobsMade = new Set();
const answer = (res, info, status = 200, code = '0', msg = 'OK') => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code, msg, info, traceId: `e2e-tr-${++fake.traces}` })); };

async function onShein(req, res) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
  const path = req.url.split('?')[0];
  fake.calls.push({ path, body });
  if (await onPublishSide(path, body, res)) return;
  if (path === '/open-api/goods/product/partialEdit' && fake.p2) {
    const p = fake.p2;
    if (p.hold) { const h = p.hold; p.hold = null; h.hit(); await h.open; }
    if (p.whitelist) return answer(res, null, 200, '10403', 'Request IP 203.0.113.9 is not in the whitelist');
    if (p.fail503 > 0) { p.fail503 -= 1; return answer(res, null, 503, 'E2E-503', 'Service Unavailable'); }
    if (p.busy > 0) { p.busy -= 1; return answer(res, null, 200, '20999', 'System busy, please try again later'); }
    const coded = p.refuseCoded[body.spu_name] || validateEdit(body);
    if (coded) { p.edits.push({ body, ok: false, coded: true }); return answer(res, { success: false, pre_valid_result: [{ module: 'e2e-validate', form: null, messages: [coded] }] }, 200, '20003', 'Product verification failed'); }
    const why = p.refuse[body.spu_name];
    if (why) { p.edits.push({ body, ok: false }); return answer(res, { success: false, pre_valid_result: [{ module: 'sales_info', form: 'size_attribute_list', messages: [why] }] }); }
    const version = `E2EV${++p.versions}`;
    p.edits.push({ body, ok: true, version });
    for (const c of body.skc_list || []) for (const k of c.sku_list || []) if (!k.sku_code && !p.lag) p.pending.set(k.supplier_sku, body.spu_name);
    p.docs[body.spu_name] = { state: 1, version };
    p.hist[`${body.spu_name}|${version}`] = { state: 1 };
    const noVersion = p.noVersion > 0 && p.noVersion--;
    const c0 = (body.skc_list || [])[0] || { skc_name: sheinNow(body.spu_name).skcInfoList[0].skcName, sku_list: [] };   // a title-only edit: SPU level
    const skc = sheinNow(body.spu_name).skcInfoList.find((x) => x.skcName === c0.skc_name);
    const sent = new Map((c0.sku_list || []).map((k) => [k.sku_code || `NEW-${k.supplier_sku}`, k.supplier_sku ?? '']));
    return answer(res, { success: true, version: noVersion ? null : version, spu_name: body.spu_name,
      pre_valid_result: p.warn ? [{ module: 'basic_info', form: 'title', messages: ['Title is close to the length limit'] }] : null,
      filtered_result: p.warn ? { skc_list: [{ skc_name: c0.skc_name, fields: ['competing_product_link'] }] } : null,
      // like SHEIN: EVERY SKU of the SKC, the untouched ones with supplier_sku ""
      skc_list: [{ skc_name: c0.skc_name, sku_list: [...skc.skuInfoList.map((k) => ({ sku_code: k.skuCode, supplier_sku: sent.get(k.skuCode) ?? '' })),
        ...[...sent].filter(([code]) => code.startsWith('NEW-')).map(([sku_code, supplier_sku]) => ({ sku_code, supplier_sku }))] }] });
  }
  // price/save (doc 3001940), as SHEIN behaves: ≤ 100; sku_code exists; USD + shein-us; shopPrice > 0;
  // specialPrice left out on a size that has one ENDS the special (recorded in endedSpecials — no error);
  // special < original; riseReason optional; a rise is refused under a promotion lock (priceLockType 1),
  // else goes to review (2) — and a SECOND price for a SKU whose rise is in review is refused (doc: only
  // after the result). `losePriceAnswer`: SHEIN takes the call but the answer is lost (HTTP 503).
  if (path === '/open-api/openapi-business-backend/product/price/save' && fake.p2) {
    const p = fake.p2; p.priceCalls.push(body);
    if (p.whitelist) return answer(res, null, 200, '10403', 'Request IP 203.0.113.9 is not in the whitelist');
    const list = body.productPriceList;
    if (!Array.isArray(list) || !list.length || list.length > 100) return answer(res, null, 200, '20003', 'productPriceList: 1 to 100 entries');
    const data = [];
    for (const x of list) {
      const spuName = Object.keys(SHEIN).find((n) => SHEIN[n].skcInfoList.some((c) => c.skuInfoList.some((k) => k.skuCode === x.productCode)));
      const sku = spuName && sheinNow(spuName).skcInfoList.flatMap((c) => c.skuInfoList).find((k) => k.skuCode === x.productCode);
      const pr = sku?.priceInfoList?.[0];
      const no = (message) => data.push({ productCode: x.productCode, site: x.site, success: false, status: 0, message });
      if (!sku) { no('sku_code not found'); continue; }
      if (x.currencyCode !== 'USD' || x.site !== 'shein-us' || typeof x.shopPrice !== 'number' || !(x.shopPrice > 0) || Math.round(x.shopPrice * 100) !== x.shopPrice * 100) { no('currency / site / price'); continue; }
      if (p.priceReview[x.productCode] != null) { no('the last price change is still in review — wait for its result'); continue; }
      if (x.specialPrice != null && !(x.specialPrice < x.shopPrice)) { no('the original price must be above the special price'); continue; }
      const rise = x.shopPrice > Number(pr.basePrice);
      if (rise && spuName === 'E2ESPU2') { no('price locked by a promotion'); continue; }
      if (Number(pr.specialPrice) > 0 && x.specialPrice == null) { p.special[x.productCode] = 0; p.endedSpecials.push(x.productCode); }   // SHEIN: 特价不传时，默认特价更新为0
      if (rise) { p.priceReview[x.productCode] = x.shopPrice; data.push({ productCode: x.productCode, site: x.site, success: true, status: 2, message: '待审核' }); }
      else { p.prices[x.productCode] = x.shopPrice; data.push({ productCode: x.productCode, site: x.site, success: true, status: 1, message: '价格调整成功' }); }
    }
    if (p.losePriceAnswer > 0) { p.losePriceAnswer -= 1; return answer(res, null, 503, 'E2E-503', 'gateway timeout (the answer was lost)'); }
    return answer(res, { data });
  }
  if (isSheinWrite(path)) { fake.writes.push(path); return answer(res, null, 500, 'E2E-WRITE', 'The e2e fake SHEIN refuses every write'); }
  switch (path) {
    case '/open-api/goods/product/check-supplierSku-repeated': {
      const known = new Set(Object.values(SHEIN).flatMap((x) => x.skcInfoList.flatMap((c) => c.skuInfoList.map((k) => k.supplierSku))));
      for (const sku of fake.p2?.pending.keys() || []) known.add(sku);
      if (!fake.p4?.lag) for (const sku of fake.p4?.pending.keys() || []) known.add(sku);
      for (const v of Object.values(fake.p2?.relinked || {})) known.add(v);
      return answer(res, (body.supplierSkuList || []).map((supplierSku) => ({ supplierSku, repeated: known.has(supplierSku) })));
    }
    case '/open-api/goods/query-publish-fill-in-standard':
      return answer(res, { fill_in_standard_list: fake.p2?.fill[body.category_id] || [], default_language: 'en', currency: 'USD', support_sale_attribute_sort: fake.p2 ? fake.p2.sort : true });
    case '/open-api/msc/warehouse/list':
      return answer(res, { list: [{ warehouseCode: 'PSE2E1', warehouseName: 'E2E US Warehouse', warehouseType: 1, saleCountryList: ['US'], countrySiteDefaultList: [{ countrySiteCode: 'shein-us', defaultFlag: 1 }] }] });
    case '/open-api/openapi-business-backend/product/query': {
      const page = Number(body.pageNum) || 1; const size = Number(body.pageSize) || 50;
      return answer(res, { data: SPU_ORDER.slice((page - 1) * size, page * size).map((spuName) => ({ spuName, skcName: `${spuName}-c`, skuCodeList: [] })) });
    }
    case '/open-api/goods/searchProduct': {
      const all = SPU_ORDER.map((spuName) => ({ spuName, categoryId: String(SHEIN[spuName]?.categoryId ?? 1001), skcList: [{ skcName: SHEIN[spuName]?.skcInfoList[0].skcName || `${spuName}-c`, activityLockList: [{ site: 'shein-us', priceLockType: spuName === 'E2ESPU2' ? 1 : 0, shelfLockType: 0 }] }] }));
      const list = body.spuNameList ? all.filter((x) => body.spuNameList.includes(x.spuName)) : all.slice(((Number(body.pageNum) || 1) - 1) * 10, (Number(body.pageNum) || 1) * 10);
      return answer(res, { data: list, meta: { count: all.length } });
    }
    case '/open-api/goods/spu-info': {
      if (fake.gate && fake.gate.spu === body.spuName) { fake.gate.hit(); await fake.gate.open; }
      return answer(res, sheinNow(body.spuName));
    }
    case '/open-api/goods/query-document-state':
      if (fake.p4 && (body.spuList || []).some((x) => fake.p4.docs[x.spuName])) {
        return answer(res, { data: (body.spuList || []).filter((x) => fake.p4.docs[x.spuName]).map((x) => {
          const h = x.version ? fake.p4.hist[`${x.spuName}|${x.version}`] : fake.p4.docs[x.spuName];
          return h ? { spuName: x.spuName, version: x.version || fake.p4.docs[x.spuName].version, skcList: [{ skcName: `${x.spuName}SKC`, documentState: h.state, failedReason: h.reason ? [{ language: 'en', content: h.reason }] : [] }] } : null;
        }).filter(Boolean) });
      }
      return answer(res, { data: (body.spuList || []).filter((x) => SHEIN[x.spuName]).map((x) => {
        // asked for one submission (version): THAT submission's state — not the product's latest
        if (x.version && fake.p2) {
          const h = fake.p2.hist[`${x.spuName}|${x.version}`];
          return h ? { spuName: x.spuName, version: x.version, skcList: [{ skcName: SHEIN[x.spuName].skcInfoList[0].skcName, documentState: h.state, failedReason: h.reason ? [{ language: 'en', content: h.reason }] : [] }] } : null;
        }
        const d = fake.p2?.docs[x.spuName];
        return { spuName: x.spuName, version: d?.version || 'v1', skcList: [{ skcName: SHEIN[x.spuName].skcInfoList[0].skcName, documentState: d?.state ?? DOC_STATE[x.spuName] ?? 2,
          failedReason: d?.reason ? [{ language: 'en', content: d.reason }] : [] }] };
      }).filter(Boolean) });
    case '/open-api/goods/get-custom-attribute-permission-config':
      return answer(res, { data: (body.category_id_list || []).flatMap((c) => [{ last_category_id: c, attribute_id: ATTR, has_permission: PERM[c] ?? 0 }, { last_category_id: c, attribute_id: 27, has_permission: 1 }]) });
    case '/open-api/goods/query-attribute-template':
      return answer(res, { data: (body.product_type_id_list || []).filter((t) => TPL[t]).map((t) => TEMPLATE(t)) });
    default: return answer(res, null, 404, 'E2E-UNKNOWN', `the fake has no ${path}`);
  }
}

const TEST_IDS = "shopify_product_id LIKE 'gid://shopify/Product/77%' OR shopify_product_id LIKE 'shein:E2E%'";
test.beforeAll(async () => {
  server = http.createServer((req, res) => { onShein(req, res).catch((e) => answer(res, null, 500, 'E2E-FAKE', e.message)); });
  await new Promise((ok) => server.listen(FAKE_PORT, '127.0.0.1', ok));
  if (!process.env.DATABASE_URL) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const { rows: [f] } = await pool.query(`SELECT count(*)::int AS n FROM shein_listing_products WHERE NOT (${TEST_IDS})`);
  foreign = f.n > 0;   // a database with real SHEIN Listings data: the snapshot would prune it — skip those tests
  const { secretsConfigured, encryptSecret } = await import('../api/_lib/secrets.js');
  secretsOk = secretsConfigured();
  const get = async (sql, args) => (await pool.query(sql, args)).rows[0] || null;
  saved = {
    auth: await get(`SELECT value FROM app_settings WHERE key = 'shein_auth'`),
    spuList: await get(`SELECT payload FROM shein_listing_cache WHERE kind = 'spu_list' AND key = 'current'`),
    probe: await get(`SELECT payload FROM shein_listing_cache WHERE kind = 'probe' AND key = 'last'`),
  };
  // A crashed earlier run may have left its job active.
  await pool.query(`UPDATE shein_listing_jobs SET status = 'stopped', finished_at = now() WHERE status IN ('queued','running') AND started_by LIKE 'e2e%'`);
  if (secretsOk && !foreign) {
    const { setSetting } = await import('../api/_lib/db.js');
    await setSetting('shein_auth', JSON.stringify({ openKeyId: encryptSecret('e2e-open-key'), secretKey: encryptSecret('e2e-secret-key'), supplierId: 1, connectedBy: 'e2e', connectedAt: new Date().toISOString() }), 'e2e');
  }
});
test.afterAll(async () => {
  await new Promise((ok) => server.close(ok));
  if (!pool) return;
  const { setSetting } = await import('../api/_lib/db.js');
  if (secretsOk && !foreign) {
    if (saved.auth) await setSetting('shein_auth', saved.auth.value, 'e2e');
    else await pool.query(`DELETE FROM app_settings WHERE key = 'shein_auth'`);   // there was none
  }
  await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
  await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
  const ids = [...jobsMade];
  const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e%' OR id = ANY($1::bigint[])`, [ids]);
  const all = rows.map((r) => r.id);
  await pool.query(`DELETE FROM shein_api_log WHERE job_id = ANY($1::bigint[]) OR spu LIKE 'E2E%' OR by LIKE 'e2e%'`, [all]);
  await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [all]);
  await pool.query(`DELETE FROM shein_listing_cache WHERE (kind = 'spu' AND key LIKE 'E2E%') OR (kind IN ('attr_template') AND key IN ('501','502','503','504')) OR (kind IN ('custom_perm', 'fill_standard') AND key IN ('1001','1002','1003','1004'))`);
  await pool.query(`DELETE FROM shein_size_map WHERE category_id IN (1001, 1002, 1003, 1004)`);
  for (const [key, row] of [['current', saved.spuList], ['last', saved.probe]]) {
    const kind = key === 'current' ? 'spu_list' : 'probe';
    if (row) await pool.query(`INSERT INTO shein_listing_cache (kind, key, payload) VALUES ($1, $2, $3) ON CONFLICT (kind, key) DO UPDATE SET payload = EXCLUDED.payload`, [kind, key, JSON.stringify(row.payload)]);
    else await pool.query(`DELETE FROM shein_listing_cache WHERE kind = $1 AND key = $2`, [kind, key]);
  }
  await pool.query(`DELETE FROM users WHERE username = 'e2e_shein_lead'`);
  await pool.end();
});

/* -------------------------- the page, on an empty database -------------------------- */

test.describe('SHEIN Listings — the page before anything was read', () => {
  test('an empty database renders “Nothing read yet” (PH and admin), not a blank page or an error', async ({ page }) => {
    test.skip(!pool || foreign, 'needs the database (and no real SHEIN Listings data)');
    const { rows: [n] } = await pool.query(`SELECT (SELECT count(*) FROM shein_listing_products)::int AS p, (SELECT count(*) FROM shein_listing_jobs WHERE kind = 'snapshot' AND status = 'done')::int AS j`);
    test.skip(n.p > 0 || n.j > 0, 'this database has been read before');
    await loginAs(page, 'ph_team');
    await page.goto('/ph/shein-listings');
    await expect(page.getByRole('heading', { name: 'Nothing read yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check all listings' })).toBeVisible();
    await expect(page.locator('.error')).toHaveCount(0);
    // The probe lives on the Sizes tab and is reachable before any read; a PH account without
    // the privilege sees it disabled, with the reason.
    await page.getByRole('tab', { name: /Sizes/ }).click();
    await expect(page).toHaveURL(/tab=sizes/);
    const ask = page.getByRole('button', { name: 'Ask SHEIN (read-only)' });
    await expect(ask).toBeDisabled();
    await expect(ask).toHaveAttribute('title', /Connect integrations/);
    await expect(page.getByText('Not asked yet.')).toBeVisible();
  });

  test('admin reaches it from /shein-listings', async ({ page }) => {
    test.skip(!pool || foreign, 'needs the database (and no real SHEIN Listings data)');
    await loginAs(page, 'admin');
    await page.goto('/shein-listings?tab=jobs');
    await expect(page.locator('.brand', { hasText: 'SHEIN Listings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  });
});

/* ------------------------------ sheinCall's log hook ------------------------------ */

test.describe('SHEIN Listings — sheinCall logs every call', () => {
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });

  test('a read logs path, code, traceId, ms — no body; without { log } nothing is logged; a refusal carries SHEIN’s trace', async () => {
    const { sheinCall } = await import('../api/_lib/shein.js');
    const log = { source: 'e2e', spu: 'E2ESPU1', by: 'e2e-log' };
    const info = await sheinCall('/open-api/goods/spu-info', { spuName: 'E2ESPU1', languageList: ['en'] }, { log });
    expect(info.spuName).toBe('E2ESPU1');
    expect(log.traceId).toMatch(/^e2e-tr-/);
    const { rows } = await pool.query(`SELECT * FROM shein_api_log WHERE by = 'e2e-log' ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toMatchObject({ path: '/open-api/goods/spu-info', write: false, request: null, response: null, code: '0', trace_id: log.traceId, spu: 'E2ESPU1', http_status: 200 });
    const before = (await pool.query(`SELECT count(*)::int AS n FROM shein_api_log`)).rows[0].n;
    await sheinCall('/open-api/goods/spu-info', { spuName: 'E2ESPU2', languageList: ['en'] });
    expect((await pool.query(`SELECT count(*)::int AS n FROM shein_api_log`)).rows[0].n).toBe(before);
    // A write (the fake refuses it): logged WITH its body, and the error carries SHEIN's trace + message.
    const wlog = { source: 'e2e', by: 'e2e-log' };
    const err = await sheinCall('/open-api/goods/product/partialEdit', { spu_name: 'E2ESPU1' }, { log: wlog }).catch((e) => e);
    expect(err.message).toContain('refuses every write');
    expect(err).toMatchObject({ sheinCode: 'E2E-WRITE', traceId: expect.stringMatching(/^e2e-tr-/), httpStatus: 500 });
    const { rows: [w] } = await pool.query(`SELECT * FROM shein_api_log WHERE by = 'e2e-log' AND write ORDER BY id DESC LIMIT 1`);
    expect(w).toMatchObject({ path: '/open-api/goods/product/partialEdit', request: { spu_name: 'E2ESPU1' }, code: 'E2E-WRITE' });
    fake.writes.length = 0;   // that write was this test's own probe of the fake
  });
});

/* ------------------------------ the snapshot job ------------------------------ */

// Shopify in-process; SHEIN through the real client to the fake.
function testIO(IO, { shopify = SHOPIFY, live = null } = {}) {
  return { ...IO, shopifyConfigured: () => true, sheinStatus: async () => ({ connected: true, configured: true }), walkBusy: async () => false,
    shopifyListingCatalogue: async () => ({ products: shopify() }),
    shopifyListingProduct: async (id) => ({ product: (live || shopify)().find((p) => p.productId === id) || null }),
    lastWalkStock: async () => new Map([['E2E1-07', 2], ['E2E2-07', 1]]), links: async () => LINKS, wait: async () => {}, coalesceMs: 10,
    marketTargets: async () => new Map() };
}
const waitFor = async (fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); } };

test.describe.serial('SHEIN Listings — the snapshot (a server job, read-only)', () => {
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });

  test('a restart mid-run → interrupted; Resume carries on from the first unfinished product; zero SHEIN writes', async () => {
    const L = await import('../api/_lib/shein-listing.js');
    const io = testIO(L.IO);
    fake.calls.length = 0; fake.writes.length = 0;
    let hit; const hitP = new Promise((r) => { hit = r; }); let open; const openP = new Promise((r) => { open = r; });
    fake.gate = { spu: SPU_ORDER[10], hit, open: openP };      // hold the 11th product (batch 2)
    const job = await L.startListingJob({ kind: 'snapshot', by: 'e2e-snapshot', io });
    jobsMade.add(job.id);
    await hitP;                                                 // 10 read, the 11th in flight
    // "The server restarts": the process holding the lease is gone, the lease runs out.
    await pool.query(`UPDATE shein_listing_jobs SET lease_owner = 'dead-process', lease_until = now() - interval '1 minute' WHERE id = $1`, [job.id]);
    const { markStaleListingJobs, getListingJob, listingItemCounts } = await import('../api/_lib/db.js');
    await markStaleListingJobs();
    expect((await getListingJob(job.id)).status).toBe('interrupted');
    fake.gate = null; open();
    await L.listingJobPromise();                                // the dead process's runner gives up (lease lost)
    expect((await getListingJob(job.id)).status).toBe('interrupted');
    const counts = await listingItemCounts(job.id);
    expect((counts.done || 0) + (counts.skipped || 0)).toBeGreaterThanOrEqual(10);
    const readBefore = fake.calls.filter((c) => c.path === '/open-api/goods/spu-info').map((c) => c.body.spuName);

    // A second job can't start while… (nothing is active now) — Resume the same job instead.
    const resumed = await L.resumeJob(job.id, { by: 'e2e-snapshot', io });
    expect(resumed).toMatchObject({ id: job.id, status: 'queued', resumes: 1 });
    await waitFor(() => L.listingJobPromise() || getListingJob(job.id).then((j) => j.status === 'done'));
    await L.listingJobPromise();
    const done = await getListingJob(job.id);
    expect(done.status).toBe('done');
    expect(done.counts).toMatchObject({ shopify_products: 7, shein_products: 5, skipped: 7, products: 8, shein_writes: 0 });   // the 7 fillers: spu-info gives nothing
    // Resume didn't start over: the first batch was read exactly once.
    const reads = fake.calls.filter((c) => c.path === '/open-api/goods/spu-info').map((c) => c.body.spuName);
    for (const spu of SPU_ORDER.slice(0, 10)) expect(reads.filter((x) => x === spu).length, spu).toBe(1);
    expect(reads.length).toBeGreaterThan(readBefore.length);
    // Zero writes: the fake saw none, and the job's log rows are all reads.
    expect(fake.writes).toEqual([]);
    const { rows: log } = await pool.query(`SELECT path, write FROM shein_api_log WHERE job_id = $1`, [job.id]);
    expect(log.length).toBeGreaterThan(12);
    expect(log.filter((l) => l.write)).toEqual([]);
    expect(new Set(log.map((l) => l.path))).toEqual(new Set(['/open-api/openapi-business-backend/product/query', '/open-api/goods/searchProduct', '/open-api/goods/query-document-state',
      '/open-api/goods/spu-info', '/open-api/goods/query-attribute-template', '/open-api/goods/get-custom-attribute-permission-config']));
  });

  test('after the snapshot: every Shopify product once, one status per size, SHEIN’s promotion lock noted', async () => {
    const { rows: prods } = await pool.query(`SELECT shopify_product_id, status, spu FROM shein_listing_products WHERE ${TEST_IDS} ORDER BY 1`);
    expect(prods.map((p) => p.shopify_product_id)).toEqual([...[7701, 7702, 7703, 7704, 7705, 7706, 7707].map(gidP), 'shein:E2ESPU5']);
    const { rows: vars } = await pool.query(`SELECT row_key, status, match, notes FROM shein_listing_variants WHERE ${TEST_IDS}`);
    const v = new Map(vars.map((x) => [x.row_key, x]));
    expect(v.get(gidV(770107))).toMatchObject({ status: 'synced', match: 'sku' });
    expect(v.get(gidV(770110))).toMatchObject({ status: 'out_of_date', match: 'link' });
    expect(v.get(gidV(770112))).toMatchObject({ status: 'not_on_shein', match: 'none' });   // the parent-SKU trap
    expect(v.get(gidV(770404)).status).toBe('in_review');
    expect(v.get(gidV(770207)).notes.map((n) => n.code)).toContain('price_locked');
  });

  test('Shopify webhooks: a price change flips the size to Out of date with no re-read of SHEIN; a stock-only update changes nothing', async () => {
    const L = await import('../api/_lib/shein-listing.js');
    const before = fake.calls.length;
    // stock only (products/update fires on stock changes too)
    const stock = SHOPIFY(); stock[0].variants[0].qty = 0;
    const io1 = testIO(L.IO, { shopify: () => stock });
    const asRest = (p) => ({ id: Number(p.productId.split('/').pop()), admin_graphql_api_id: p.productId, title: p.title, vendor: p.vendor, product_type: p.productType, tags: '', status: p.status.toLowerCase(),
      options: [{ name: 'Size', position: 1 }], variants: p.variants.map((x) => ({ admin_graphql_api_id: x.variantId, sku: x.sku, option1: x.size, price: x.price, compare_at_price: null, inventory_quantity: x.qty, barcode: '' })) });
    expect(await L.recheckProducts([normalizeWebhookProduct(asRest(stock[0]))], { io: io1 })).toMatchObject({ rechecked: 0 });
    // price: through the webhook's own path (coalesce → re-read Shopify → recompute from stored SHEIN rows)
    const priced = SHOPIFY(); priced[0].variants[0].price = '149.00';
    const io2 = testIO(L.IO, { shopify: () => priced });
    L.listingProductChanged(asRest(priced[0]), { io: io2 });
    await L.flushRechecks(io2);
    const { rows: [a7] } = await pool.query(`SELECT status, diffs FROM shein_listing_variants WHERE row_key = $1`, [gidV(770107)]);
    expect(a7.status).toBe('out_of_date');
    expect(a7.diffs).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'price', from: '160.00', to: '149.00' }), expect.objectContaining({ field: 'shein_price', to: '149.00' })]));
    expect(fake.calls.length).toBe(before);   // no SHEIN call at all
    const { rows: [p1] } = await pool.query(`SELECT status FROM shein_listing_products WHERE shopify_product_id = $1`, [gidP(7701)]);
    expect(p1.status).toBe('blocked');        // still the worst size (the swap)
  });

  test('the webhook route: inventory_levels/update → the live push, exactly as before; products/* → SHEIN Listings', async () => {
    const W = await import('../api/shopify/webhook.js');
    const calls = { sku: [], push: [], listing: [], deleted: [] };
    const hook = { shopifySkuForInventoryItem: async (id) => { calls.sku.push(id); return 'SKU-5'; }, queuePush: (s) => calls.push.push(s),
      listingProductChanged: (b) => calls.listing.push(b), listingProductDeleted: async (b) => calls.deleted.push(b) };
    expect(await W.routeShopifyWebhook('inventory_levels/update', { inventory_item_id: 5, available: 2 }, hook)).toEqual({ pushed: 'SKU-5' });
    expect(calls).toMatchObject({ sku: [5], push: [['SKU-5']], listing: [], deleted: [] });
    expect(await W.routeShopifyWebhook('inventory_levels/update', {}, hook)).toEqual({ ignored: true });
    await W.routeShopifyWebhook('products/update', { id: 1 }, hook);
    await W.routeShopifyWebhook('products/delete', { id: 2 }, hook);
    expect(calls.listing).toEqual([{ id: 1 }]); expect(calls.deleted).toEqual([{ id: 2 }]); expect(calls.push).toEqual([['SKU-5']]);
    // …and through the handler, signed: still 200 first, the same push.
    process.env.SHOPIFY_SECRET_KEY = 'shpss_test';
    const saved = { ...W.HOOK }; Object.assign(W.HOOK, hook);
    try {
      const raw = Buffer.from(JSON.stringify({ inventory_item_id: 9, available: 1 }));
      const req = { method: 'POST', url: '/api/shopify/webhook', socket: { remoteAddress: '127.0.0.1' }, rawBody: raw, body: JSON.parse(raw),
        headers: { 'x-shopify-topic': 'inventory_levels/update', 'x-shopify-hmac-sha256': crypto.createHmac('sha256', 'shpss_test').update(raw).digest('base64') } };
      const res = { statusCode: 0, setHeader() {}, end(b) { this.body = b; } };
      await W.default(req, res);
      expect(res.statusCode).toBe(200);
      expect(calls.sku.at(-1)).toBe(9);
      expect(calls.push.at(-1)).toEqual(['SKU-5']);
    } finally { Object.assign(W.HOOK, saved); }
  });

  test('the probe (Phase 0), in-process: one product per category, permission per category, SHEIN’s sizes + the store’s custom values; reads only', async () => {
    const L = await import('../api/_lib/shein-listing.js');
    const io = testIO(L.IO);
    fake.writes.length = 0;
    const job = await L.startListingJob({ kind: 'probe', by: 'e2e-probe', scope: { spu: 'E2ESPU2' }, io });
    jobsMade.add(job.id);
    await L.listingJobPromise();
    const { getListingJob, getListingCache } = await import('../api/_lib/db.js');
    expect((await getListingJob(job.id)).status).toBe('done');
    const probe = (await getListingCache('probe', 'last')).payload;
    const cat = (id) => probe.categories.find((c) => c.categoryId === id);
    expect(cat(1001)).toMatchObject({ productTypeId: 501, sizeAttributeId: ATTR, hasPermission: 1, hasSizeTable: false });
    expect(cat(1003)).toMatchObject({ hasPermission: 0 });
    expect(cat(1002).customValues).toEqual(['US 9.5W']);
    expect(cat(1002).sheinSizes.map((s) => s.label)).toContain('US7W');
    expect(probe.customValues).toEqual(['US 9.5W']);
    expect(probe.spuChecked).toMatchObject({ spu: 'E2ESPU2', categoryId: 1002 });
    expect(probe.writes).toBe(0);
    expect(fake.writes).toEqual([]);
    const { rows } = await pool.query(`SELECT DISTINCT path FROM shein_api_log WHERE job_id = $1`, [job.id]);
    for (const r of rows) expect(isSheinWrite(r.path), r.path).toBe(false);
  });
});

/* -------------------------------- the endpoints -------------------------------- */

test.describe.serial('SHEIN Listings — the endpoints', () => {
  let auth; let tokenFor;
  test.beforeAll(async () => {
    const { signToken } = await import('../api/_lib/util.js');
    tokenFor = (u) => ({ Authorization: `Bearer ${signToken(u)}` });
    auth = {
      ph: tokenFor({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' }),
      admin: tokenFor({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' }),
      wh: tokenFor({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' }),
    };
  });

  test('gates: warehouse 403; PH reads; probe / webhooks need admin or Connect integrations; the log is admin-only', async ({ request }) => {
    expect((await request.get('/api/shein/listings', { headers: auth.wh })).status()).toBe(403);
    expect((await request.get('/api/shein/listings')).status()).toBe(401);
    const r = await request.get('/api/shein/listings', { headers: auth.ph });
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, canWrite: false, isAdmin: false, summary: { tiles: TILE_STATUSES, byStatus: expect.any(Object) } });
    for (const action of ['probe', 'webhooks']) {
      const p = await request.post('/api/shein/listings', { headers: auth.ph, data: { action } });
      expect(p.status(), action).toBe(403);
    }
    expect((await request.get('/api/shein/listing-log', { headers: auth.ph })).status()).toBe(403);
    expect((await request.get('/api/shein/listing-log', { headers: auth.admin })).status()).toBe(200);
    expect((await request.get('/api/shein/listing-jobs', { headers: auth.ph })).status()).toBe(200);
    expect((await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'nope' } })).status()).toBe(400);
    expect((await request.get('/api/shein/listings?status=missing', { headers: auth.ph })).status()).toBe(400);
  });

  test('the list: each tile = its filtered list (a product counts under every status one of its in-stock sizes has); filters; search by seller SKU / SHEIN SKU / SPU / style; ?product= detail', async ({ request }) => {
    test.skip(!pool || !secretsOk || foreign, 'needs the snapshot data from above');
    const get = async (qs) => (await request.get(`/api/shein/listings${qs}`, { headers: auth.ph })).json();
    const all = await get('?pageSize=200');
    // 2026-10-27 decision: a tile / ?status= = products with ANY in-stock size in that status (not only
    // the worst), so the tiles can add up to more than All — but each tile's count IS its list's length.
    for (const st of TILE_STATUSES) {
      const list = await get(`?status=${st}&pageSize=200`);
      expect(list.total, st).toBe(all.summary.byStatus[st].products);
    }
    expect(all.summary.all).toBe(all.total);
    const upd = await get('?status=out_of_date&q=ib7936');
    expect(upd.products.map((p) => [p.shopify_product_id, p.status])).toEqual([[gidP(7701), 'blocked']]);   // worst is Blocked, yet it has a Needs-update size → listed; the chip stays Blocked
    expect(all.summary.lastSnapshot).toMatchObject({ kind: 'snapshot', status: 'done' });
    for (const q of ['A9', 'E2E1-07', 'E2ESPU1', 'IB7936-100', 'e2eskc1']) {
      const r = await get(`?q=${encodeURIComponent(q)}`);
      expect(r.products.map((p) => p.shopify_product_id), q).toContain(gidP(7701));
    }
    const blocked = await get('?status=blocked&q=e2e');
    expect(blocked.products.every((p) => p.status === 'blocked')).toBe(true);
    const off = await get('?status=excluded&q=drf001');
    expect(off.products.map((p) => p.shopify_product_id)).toEqual([gidP(7706)]);
    expect((await get('?q=drf001')).products).toEqual([]);                       // off isn't in "All"
    const dup = await get('?blocker=dup_seller_sku&q=dup001');
    expect(dup.products.map((p) => p.shopify_product_id)).toEqual([gidP(7707)]);
    expect(dup.products[0].worst).toMatchObject({ code: 'dup_seller_sku', title: 'SKU DUP1 is on 2 Shopify variants.' });
    expect((await get('?brand=adidas&q=new001')).products.map((p) => p.shopify_product_id)).toEqual([gidP(7705)]);
    const d = await get(`?product=${encodeURIComponent(gidP(7702))}`);
    expect(d.product).toMatchObject({ shopify_product_id: gidP(7702), spu: 'E2ESPU2', status: 'blocked' });
    const w145 = d.variants.find((v) => v.row_key === gidV(770245));
    expect(w145.blockers[0]).toMatchObject({ code: 'size_needs_map', title: '14.5W isn’t a SHEIN size yet.', action: { label: 'Add 14.5W as a custom size' } });
    expect(d.log.every((l) => l.request === undefined)).toBe(true);              // not an admin: no raw bodies
    expect((await request.get(`/api/shein/listings?product=nope`, { headers: auth.ph })).status()).toBe(404);
  });

  test('a person’s size spelling: refused when full-width / emoji / > 50 / another size; saved (DB only) and the size flips to Not on SHEIN', async ({ request }) => {
    test.skip(!pool || !secretsOk || foreign, 'needs the snapshot data from above');
    const before = fake.calls.length;
    const post = (data) => request.post('/api/shein/listing-maps?type=size', { headers: auth.ph, data: { action: 'set', categoryId: 1002, attributeId: ATTR, sizeKey: '14.5|W', ...data } });
    for (const [text, want] of [['１４.５W', /Full-width/], ['US14.5W 👟', /Emoji/], ['U'.repeat(51), /50/], ['US15W', /doesn’t read as size 14.5W/]]) {
      const r = await post({ customValue: text });
      expect(r.status(), text).toBe(400);
      expect((await r.json()).error).toMatch(want);
    }
    expect((await post({ attributeValueId: 14 })).status()).toBe(400);           // SHEIN's US15W is a different size
    expect((await post({ customValue: 'US14.5W', attributeValueId: 13 })).status()).toBe(400);
    expect((await request.post('/api/shein/listing-maps?type=category', { headers: auth.ph, data: {} })).status()).toBe(400);
    const ok = await post({ customValue: 'US14.5W' });
    expect(ok.status()).toBe(200);
    const saved = await ok.json();
    expect(saved).toMatchObject({ ok: true, map: { custom_value: 'US14.5W', source: 'custom_created', verified: false }, recomputed: true });
    const d = await (await request.get(`/api/shein/listings?product=${encodeURIComponent(gidP(7702))}`, { headers: auth.ph })).json();
    const w145 = d.variants.find((v) => v.row_key === gidV(770245));
    expect(w145).toMatchObject({ status: 'not_on_shein', size_plan: { kind: 'custom', label: 'US14.5W' } });
    expect(w145.notes[0]).toMatchObject({ code: 'custom_size', title: 'Will add US14.5W as a new size.' });
    const maps = await (await request.get('/api/shein/listing-maps?type=size', { headers: auth.ph })).json();
    const u = maps.usage.find((x) => x.category_id === 1002 && x.size_key === '9.5|W');
    expect(u).toMatchObject({ size: '9.5W', hasPermission: 1, suggestion: 'US 9.5W', needs_map: 1 });
    expect(fake.calls.length).toBe(before);                                       // never a SHEIN call
    const cleared = await request.post('/api/shein/listing-maps?type=size', { headers: auth.ph, data: { action: 'clear', id: saved.map.id } });
    expect(await cleared.json()).toMatchObject({ ok: true, cleared: 1 });
  });

  test('“leave off SHEIN” and back (DB only); one job at a time → 409; jobs list + items', async ({ request }) => {
    test.skip(!pool || !secretsOk || foreign, 'needs the snapshot data from above');
    const ex = await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'exclude', variantKeys: [gidV(770145)] } });
    expect(await ex.json()).toMatchObject({ ok: true, n: { variants: 1 }, products: [gidP(7701)] });
    let d = await (await request.get(`/api/shein/listings?product=${encodeURIComponent(gidP(7701))}`, { headers: auth.ph })).json();
    expect(d.variants.find((v) => v.row_key === gidV(770145))).toMatchObject({ status: 'excluded', excluded: true, excluded_by: 'E2E PH' });
    await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'include', variantKeys: [gidV(770145)] } });
    d = await (await request.get(`/api/shein/listings?product=${encodeURIComponent(gidP(7701))}`, { headers: auth.ph })).json();
    expect(d.variants.find((v) => v.row_key === gidV(770145)).status).toBe('blocked');
    // A job is running (another process holds its lease): a second can't start.
    const { rows: [j] } = await pool.query(`INSERT INTO shein_listing_jobs (kind, status, started_by, lease_owner, lease_until, phase) VALUES ('snapshot', 'running', 'e2e-other', 'e2e-other', now() + interval '5 minutes', 'Reading') RETURNING id`);
    jobsMade.add(j.id);
    try {
      const r = await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'snapshot' } });
      expect(r.status()).toBe(409);
      expect((await r.json()).job).toMatchObject({ id: j.id, status: 'running' });
      const list = await (await request.get('/api/shein/listing-jobs', { headers: auth.ph })).json();
      expect(list.active).toMatchObject({ id: j.id });
      expect(list.jobs[0].lease_owner).toBeUndefined();
    } finally {
      await pool.query(`UPDATE shein_listing_jobs SET status = 'stopped', finished_at = now() WHERE id = $1`, [j.id]);
    }
    const snap = [...jobsMade][0];
    const one = await (await request.get(`/api/shein/listing-jobs?id=${snap}`, { headers: auth.ph })).json();
    expect(one.job).toMatchObject({ id: snap, kind: 'snapshot', status: 'done', resumes: 1 });
    expect(one.items.length).toBe(12);
    const csv = await (await request.get(`/api/shein/listing-jobs?id=${snap}&all=1`, { headers: auth.ph })).json();
    expect(csv.items.length).toBe(12);
  });

  test('Ask SHEIN through the endpoint: a PH lead WITH Connect integrations starts it; GET ?probe=1 shows it; reads only', async ({ request }) => {
    test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY');
    const st = await (await request.get('/api/shein/status', { headers: auth.admin })).json();
    test.skip(st.host !== FAKE_HOST, `the test server isn't pointed at the fake SHEIN (host ${st.host}) — never probe a real one`);
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, username, pass_hash, role, status, privileges) VALUES ('E2E SHEIN lead', 'e2e_shein_lead', 'x', 'ph_team', 'approved', '{connect_integrations}')
      ON CONFLICT (username) DO UPDATE SET privileges = '{connect_integrations}' RETURNING id`);
    const lead = tokenFor({ uid: String(u.id), username: 'e2e_shein_lead', name: 'E2E SHEIN lead', role: 'ph_team' });
    fake.writes.length = 0;
    const r = await request.post('/api/shein/listings', { headers: lead, data: { action: 'probe' } });
    if (r.status() === 409) test.skip(true, (await r.json()).error);   // a live walk / job on this database
    expect(r.status()).toBe(200);
    const { job } = await r.json();
    jobsMade.add(job.id);
    const p = await waitFor(async () => { const x = await (await request.get('/api/shein/listings?probe=1', { headers: lead })).json(); return x.probe?.jobId === job.id && x.job?.status === 'done' ? x : null; });
    expect(p.probe.categories.find((c) => c.categoryId === 1002)).toMatchObject({ hasPermission: 1, sizeAttributeId: ATTR });
    expect(p.canWrite).toBe(true);
    expect(fake.writes).toEqual([]);
    const log = await (await request.get(`/api/shein/listing-log?job=${job.id}`, { headers: auth.admin })).json();
    expect(log.log.length).toBeGreaterThan(0);
    expect(log.log.filter((l) => l.write)).toEqual([]);
  });
});

/* ---------------------------------- the page ---------------------------------- */

// Seeded straight into the tables from the same fixtures (computeListings → saveListingProducts),
// so the page tests don't depend on the snapshot tests above having run. One finished snapshot
// job at a FIXED time pins the "Last read" line: 18:44 UTC on 10/27 is 2:44 PM EST — and 2:44 AM
// on 10/28 in Manila, which is where the browser is.
test.describe.serial('SHEIN Listings — the page', () => {
  test.use({ timezoneId: 'Asia/Manila' });
  const P7702 = gidP(7702);
  test.beforeAll(async () => {
    if (!pool || foreign) return;
    const { saveListingProducts } = await import('../api/_lib/db.js');
    await saveListingProducts(compute(), { snapshotAt: true });
    const { rows: [j] } = await pool.query(`INSERT INTO shein_listing_jobs (kind, status, started_by, created_at, started_at, finished_at, phase, total, done, counts)
      VALUES ('snapshot', 'done', 'e2e-ui', '2026-10-27T18:40:00Z', '2026-10-27T18:40:00Z', '2026-10-27T18:44:00Z', 'Finished', 12, 12,
              '{"products": 8, "shopify_products": 7, "shein_products": 5, "shein_calls": 40, "shein_writes": 0}') RETURNING id`);
    jobsMade.add(j.id);
  });
  test.beforeEach(async ({ page }) => {
    test.skip(!pool || foreign, 'needs the database (and no real SHEIN Listings data)');
    await loginAs(page, 'ph_team');
  });

  test('times read EST with the browser in Asia/Manila', async ({ page }) => {
    await page.goto('/ph/shein-listings');
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Manila');
    const strip = page.locator('.shl-strip');
    await expect(strip).toContainText('Last read 10/27, 2:44 PM EST');
    await expect(strip).not.toContainText('10/28');
    await page.getByRole('tab', { name: /Jobs/ }).click();
    await expect(page.locator('.shl-rtable tr', { hasText: 'e2e-ui' })).toContainText('10/27, 2:40 PM EST');
  });

  test('a tile sets ?status= and survives a refresh; the list follows it', async ({ page }) => {
    await page.goto('/ph/shein-listings');
    const blocked = page.locator('.shl-tiles .shc-tile[data-status="blocked"]');
    await blocked.click();
    await expect(page).toHaveURL(/[?&]status=blocked/);
    await expect(page.locator(`.shl-product[data-product="${P7702}"]`)).toBeVisible();
    await expect(page.locator('.shl-product[data-product="shein:E2ESPU5"]')).toHaveCount(0);   // only on SHEIN, not blocked
    await page.reload();
    await expect(page.locator('.shl-tiles .shc-tile[data-status="blocked"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`.shl-product[data-product="${P7702}"]`)).toBeVisible();
    for (const el of await page.locator('.shl-product .shl-rollup > .ebo-chip:first-child').all()) await expect(el).toHaveText('Blocked');   // the roll-up (side chips: "n in review", "n need an update")
    // the same tile again = All
    await page.locator('.shl-tiles .shc-tile[data-status="blocked"]').click();
    await expect(page).not.toHaveURL(/status=/);
    await expect(page.locator('.shl-product[data-product="shein:E2ESPU5"]')).toBeVisible();
  });

  test('?product= reopens the Details drawer after a refresh; Escape closes it', async ({ page }) => {
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(P7702)}`);
    const drawer = page.getByRole('dialog', { name: 'Product details' });
    await expect(drawer).toContainText('Nike Dunk Low Women');
    await expect(drawer).toContainText('14.5W isn’t a SHEIN size yet.');
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Product details' })).toContainText('Nike Dunk Low Women');
    await expect(page.getByRole('dialog', { name: 'Product details' }).getByRole('button', { name: 'Add missing sizes' })).toBeVisible();   // Phase 2: Send is on the dry run’s sheet (Phase 3 renamed it)
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Product details' })).toHaveCount(0);
    await expect(page).not.toHaveURL(/product=/);
  });

  test('ticked products are not restored by a refresh', async ({ page }) => {
    await page.goto('/ph/shein-listings');
    await page.locator(`.shl-product[data-product="${P7702}"] .shl-chk input`).check();
    await expect(page.locator('.shl-bar')).toContainText('1 product');
    await expect(page.locator('.shl-bar').getByRole('button', { name: /^Add missing sizes/ })).toBeEnabled();    // Phase 2: a dry run (reads only)
    expect(page.url()).not.toMatch(/gid|pick|sel=/);
    await page.reload();
    await expect(page.locator(`.shl-product[data-product="${P7702}"]`)).toBeVisible();
    await expect(page.locator(`.shl-product[data-product="${P7702}"] .shl-chk input`)).not.toBeChecked();
    await expect(page.locator('.shl-bar')).toHaveCount(0);
  });

  test('the custom-size form refuses full-width digits and emoji (and a different size) before anything is sent', async ({ page }) => {
    await page.goto('/ph/shein-listings');
    const row = page.locator(`.shl-product[data-product="${P7702}"]`);
    await row.locator('.shl-caret').click();
    const v = row.locator(`tr[data-row="${gidV(770245)}"]`);
    await expect(v).toContainText('14.5W isn’t a SHEIN size yet.');
    const saves = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/shein/listing-maps')) saves.push(r.url()); });
    await v.getByRole('button', { name: 'Add 14.5W as a custom size' }).click();
    const form = page.getByRole('dialog', { name: 'SHEIN size for 14.5W' });
    const input = form.getByLabel('Custom size name');
    await expect(input).toHaveValue('US 14.5W');                                   // D1: the store's own custom pattern
    const confirm = form.getByRole('button', { name: 'Confirm this spelling' });
    await expect(confirm).toBeEnabled();
    for (const [text, want] of [['１４.５W', /Full-width/], ['US14.5W 👟', /Emoji/], ['US14.5W ★', /Emoji/], ['U'.repeat(51), /50/], ['US15W', /doesn’t read as size 14\.5W/],
      ['US\u00a014.5W', /plain keyboard characters/], ['US  14.5W', /One space at a time/]]) {   // review M3: an invisible / doubled space is a second, dead size
      await input.fill(text);
      await expect(form.getByRole('alert')).toHaveText(want);
      await expect(confirm).toBeDisabled();
    }
    await input.fill('US14.5W');
    await expect(form.getByRole('alert')).toHaveCount(0);
    await expect(confirm).toBeEnabled();
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toHaveCount(0);
    expect(saves).toEqual([]);
  });

  test('390 px: no horizontal scroll on Products (a product open), the drawer, Sizes and Jobs; rows are cards', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const noSideScroll = async (where) => {
      const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
      expect(Math.max(w.doc, w.body), where).toBeLessThanOrEqual(w.vw);
    };
    await page.goto('/ph/shein-listings');
    const row = page.locator(`.shl-product[data-product="${gidP(7701)}"]`);
    await row.locator('.shl-caret').click();
    await expect(row.locator('.shl-vtable tbody tr').first()).toBeVisible();
    await expect(row.locator('.shl-vtable thead')).toBeHidden();                  // the size table is cards
    await noSideScroll('products');
    await row.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('dialog', { name: 'Product details' })).toBeVisible();
    const box = await page.getByRole('dialog', { name: 'Product details' }).boundingBox();
    expect(box.width).toBeLessThanOrEqual(390);
    await noSideScroll('drawer');
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /Sizes/ }).click();
    await expect(page.getByRole('heading', { name: /Our sizes/ })).toBeVisible();
    await noSideScroll('sizes');
    await page.getByRole('tab', { name: /Jobs/ }).click();
    await expect(page.locator('.shl-rtable tr', { hasText: 'e2e-ui' })).toBeVisible();
    await noSideScroll('jobs');
  });

  // Not a test of behaviour: `SHL_SHOTS=<dir>` saves the page at 1320 px and 390 px for a person to
  // look at against docs/shein-listings-mockup.html.
  test('screenshots (only with SHL_SHOTS)', async ({ page }) => {
    test.skip(!process.env.SHL_SHOTS, 'set SHL_SHOTS=<dir> to save screenshots');
    const dir = process.env.SHL_SHOTS;
    for (const [w, h, tag] of [[1320, 1000, 'desktop'], [390, 844, 'phone']]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/ph/shein-listings');
      for (const id of [gidP(7702), gidP(7701)]) await page.locator(`.shl-product[data-product="${id}"] .shl-caret`).click();
      await expect(page.locator('.shl-vtable').first()).toBeVisible();
      await page.screenshot({ path: `${dir}/shein-listings-${tag}-products.png`, fullPage: true });
      await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7701))}`);
      await expect(page.getByRole('dialog', { name: 'Product details' })).toContainText('Requirements');
      await page.screenshot({ path: `${dir}/shein-listings-${tag}-drawer.png`, fullPage: false });
      await page.goto('/ph/shein-listings?tab=sizes&sz=all');
      await expect(page.getByRole('heading', { name: /Our sizes/ })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/shein-listings-${tag}-sizes.png`, fullPage: true });
    }
  });
});

/* ------------------------- Phase 2: add sizes to shoes on SHEIN ------------------------- */
// docs/shein-listings-plan.md §3 Phase 2 — every acceptance line has a test below. The fake SHEIN's
// partialEdit is stateful (fake.p2): it records what it was sent, knows the new seller SKUs (in
// review), keeps each SPU's review state, and can refuse / not answer. Nothing reaches a real API.

test.describe('SHEIN Listings Phase 2 — the add-size engine (pure)', () => {
  const values = TPL[502].map((v) => ({ id: v.attribute_value_id, label: v.attribute_value, custom: v.is_custom_attribute_value }));
  const sizes = { attributeId: ATTR, values, status: 3 };
  const product = () => SHOPIFY().find((p) => p.productId === gidP(7702));
  const stored = (status = 'not_on_shein') => [{ row_key: gidV(770245), shopify_variant_id: gidV(770245), seller_sku: 'W145', shopify_size: '14.5W', match: 'none', status, blockers: [], excluded: false }];
  const map = (extra) => ({ id: 1, category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: 'US14.5W', shein_label: 'US14.5W', source: 'custom_created', set_by: 'Kim', ...extra });
  const plan = (o = {}) => planAddSizes({ spu: SHEIN.E2ESPU2, product: product(), stored: stored(), maps: [map()], sizes, permission: 1, customValues: ['US 9.5W'], sortSupported: true, ...o });

  test('a person-confirmed custom size → the A.2 body: custom text + "en", stock 0, the sibling’s box, price per D4 (no sibling rule)', () => {
    const cheap = product(); cheap.variants.find((v) => v.sku === 'W145').price = '100.00';   // Shopify $100, SHEIN's sibling $120 → $100: the sibling rule is gone
    const { body, plan: p } = plan({ product: cheap });
    expect(body.skc_list[0].sku_list).toEqual([{ sale_attribute_list: [{ attribute_id: ATTR, custom_attribute_value: 'US14.5W', language: 'en' }], supplier_sku: 'W145',
      length: '33', width: '21', height: '12', weight: 1400, mall_state: 1, price_info_list: [{ base_price: 100, currency: 'USD', sub_site: 'shein-us' }], stock_info_list: [{ inventory_num: 0 }] }]);
    expect(body.sale_attribute_sort_list).toEqual([{ attribute_id: ATTR, in_order_attribute_value_list: [{ attribute_value_id: 11 }, { attribute_value_id: 12 }, { custom_attribute_value: 'US14.5W' }] }]);
    expect(body.size_attribute_list).toBeUndefined();                           // no size chart on this product
    expect(summarizePlan(p)).toBe('Will add 1 size: US14.5W (custom, new)');
    expect(p.sizes[0]).toMatchObject({ priceFrom: 'shopify', isNew: true });
  });

  test('a custom value is NEVER sent unless a person confirmed it; a bad spelling in the map is refused, not sent', () => {
    for (const m of [map({ set_by: null }), map({ source: 'exact' })]) {
      const { body, plan: p } = plan({ maps: [m] });
      expect(body).toBe(null);
      expect(p.skipped[0].blocker).toMatchObject({ code: 'custom_unconfirmed', params: { text: 'US14.5W' } });
    }
    for (const [text, why] of [['US１４.５W', /Full-width/], ['US14.5W 👟', /Emoji/], ['U'.repeat(51), /50/]]) {
      const { body, plan: p } = plan({ maps: [map({ custom_value: text })] });
      expect(body, text).toBe(null);
      expect(p.skipped[0].blocker, text).toMatchObject({ code: 'custom_text_invalid' });
      expect(p.skipped[0].blocker.params.why).toMatch(why);
    }
  });

  test('D4 price: ONE target — market + 15 % rounded UP, else Shopify (no sibling rule); marketOnly = no fallback (D8a)', () => {
    expect(sheinNewSizePrice({ marketCents: 10435, shopifyPrice: '120.00', siblingPrice: 999 })).toEqual({ price: 121, from: 'market' });   // 120.0025 → 121; a sibling price is ignored
    expect(sheinNewSizePrice({ shopifyPrice: '160.00', siblingPrice: 999 })).toEqual({ price: 160, from: 'shopify' });
    expect(sheinNewSizePrice({ shopifyPrice: '160.00', marketOnly: true })).toBe(null);
    expect(sheinNewSizePrice({ shopifyPrice: '0' })).toBe(null);
    expect(Object.keys(PRICE_FROM)).toEqual(['market', 'shopify']);   // the "sibling" label is gone too
    const { plan: p } = plan({ market: new Map([[gidV(770245), 20000]]) });
    expect(p.sizes[0]).toMatchObject({ price: 230, priceFrom: 'market' });
  });

  test('blocked before sending: taken seller SKU, a size SHEIN already has, multi-colour SPU, size chart without a foot length (and with one)', () => {
    expect(plan({ taken: new Set(['W145']) }).plan.skipped[0].blocker.code).toBe('seller_sku_taken');
    const two = JSON.parse(JSON.stringify(SHEIN.E2ESPU2)); two.skcInfoList.push({ ...two.skcInfoList[0], skcName: 'E2ESKC2B' });
    expect(plan({ spu: two }).plan.blockers[0].code).toBe('multi_skc_size');
    const chart = JSON.parse(JSON.stringify(SHEIN.E2ESPU2));
    chart.dimensionAttributeInfoList = [{ attributeId: 400, attributeMultiList: [{ language: 'en', attributeName: 'Foot Length' }],
      dimensionAttributeAdditionList: [{ additionValue: '24', relateSaleAttributeId: ATTR, relateSaleAttributeValueId: 11 }, { additionValue: '25', relateSaleAttributeId: ATTR, relateSaleAttributeValueId: 12 }] }];
    // M4: a size chart must be re-sent whole — not supported yet: the PRODUCT is blocked, nothing is built (never a ""/null row)
    for (const m of [[map()], [map({ foot_length: 31.5 })]]) {
      const c = plan({ spu: chart, maps: m });
      expect(c.body).toBe(null);
      expect(c.plan.blockers).toEqual([expect.objectContaining({ code: 'size_table_not_yet' })]);
    }
    expect(renderBlocker({ code: 'size_table_not_yet' }).title).toMatch(/size chart/);
    const again = planAddSizes({ spu: SHEIN.E2ESPU2, product: { ...product(), variants: [...product().variants, { variantId: gidV(770299), sku: 'W7B', size: '7W', price: '120', qty: 1 }] },
      stored: [{ row_key: gidV(770299), shopify_variant_id: gidV(770299), seller_sku: 'W7B', shopify_size: '7W', match: 'none', status: 'not_on_shein', blockers: [], excluded: false }], maps: [], sizes, permission: 1 });
    expect(again.plan.skipped[0].blocker).toMatchObject({ code: 'size_already_on_shein', params: { sheinSize: 'US7W', sellerSku: 'W7' } });
  });

  test('review verdicts, and what counts as "no answer" (retried) vs a refusal (never retried)', async () => {
    expect(reviewVerdict([2])).toBe('approved'); expect(reviewVerdict([1])).toBe('waiting'); expect(reviewVerdict([5])).toBe('waiting');
    expect(reviewVerdict([3])).toBe('rejected'); expect(reviewVerdict([4])).toBe('rejected'); expect(reviewVerdict([])).toBe('waiting');
    const { isTransport, PHASE2 } = await import('../api/_lib/shein-listing.js');
    expect(PHASE2).toMatchObject({ DEFER_SEC: 1800, RETRY_SEC: [300, 900, 1800], MAX_RETRIES: 5, POLL_SEC: 300 });
    expect(isTransport(new Error('fetch failed'))).toBe(true);
    expect(isTransport({ httpStatus: 503, sheinCode: 'x' })).toBe(true);
    expect(isTransport({ httpStatus: 429, sheinCode: 'x' })).toBe(true);
    expect(isTransport({ httpStatus: 200, sheinCode: '20021', sheinMsg: 'Request too frequent' })).toBe(true);
    expect(isTransport({ httpStatus: 200, sheinCode: '1001', sheinMsg: 'Title contains forbidden words' })).toBe(false);
  });
});

function p2IO(IO, { shopify = SHOPIFY, market = new Map(), stock = [] } = {}) {
  return { ...testIO(IO, { shopify }), stockStep: async (spu) => { stock.push(spu); return { pushed: 1, products: 1 }; },
    marketPrices: async (style, sizes) => new Map(sizes.filter((z) => market.has(`${style}|${z}`)).map((z) => [z, market.get(`${style}|${z}`)])),
    marketTargets: async (products) => new Map(products.flatMap((p) => (p.variants || []).filter((v) => market.has(`${p.style}|${v.size}`)).map((v) => [v.variantId, market.get(`${p.style}|${v.size}`)]))) };
}

test.describe.serial('SHEIN Listings Phase 2 — dry run, run, review (server jobs vs the fake SHEIN)', () => {
  let L; let D; let previewId; let runId; let auth;
  const stocked = [];
  const items = async (jobId) => new Map((await D.listListingJobItems(jobId, { limit: 1000 })).map((i) => [Number(i.shopify_product_id.split('/').pop()), i]));
  const edits = (spu) => fake.p2.edits.filter((e) => e.body.spu_name === spu);
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const preview = async (ids, io) => { const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p2', scope: { productIds: ids.map(gidP) }, io }); jobsMade.add(j.id); return finished(j.id); };
  const run = async (pid, io, extra = {}) => { const j = await L.startRunJob({ previewJobId: pid, by: 'e2e-p2', io, ...extra }); jobsMade.add(j.id); return finished(j.id); };
  const variant = async (n) => (await pool.query(`SELECT * FROM shein_listing_variants WHERE row_key = $1`, [gidV(n)])).rows[0];

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    const { signToken } = await import('../api/_lib/util.js');
    auth = { ph: { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` },
      admin: { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` } };
    fake.p2 = P2();
    // A person confirmed: 14.5W → the custom "US14.5W"; 9.5W → SHEIN's existing custom value 15 ("US 9.5W").
    await pool.query(`DELETE FROM shein_size_map WHERE category_id IN (1001, 1002, 1003, 1004)`);
    await D.saveSizeMap({ category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: 'US14.5W', shein_label: 'US14.5W', source: 'custom_created' }, 'E2E PH');
    await D.saveSizeMap({ category_id: 1002, attribute_id: ATTR, size_key: '9.5|W', attribute_value_id: 15, shein_label: 'US 9.5W', source: 'custom_created' }, 'E2E PH');
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p2', io: testIO(L.IO) });
    jobsMade.add(snap.id);
    await finished(snap.id);
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });

  test('the dry run: the exact partialEdit body per product, saved with its hash — and ZERO writes', async ({ request }) => {
    fake.writes.length = 0;
    const io = p2IO(L.IO, { market: new Map([['IB7936-100|12', 15000]]) });
    const job = await preview([7701, 7702, 7703, 7704, 7705], io);
    previewId = job.id;
    expect(job).toMatchObject({ kind: 'preview', mode: 'dry', status: 'awaiting_confirm' });
    expect(job.counts).toMatchObject({ products: 5, sendable: 3, skipped: 2, sizes: 4, custom_sizes: 1, new_custom_values: 1, relinks: 1, review_open: 1, shein_writes: 0 });
    const it = await items(job.id);
    // Women's Dunk: both sizes in ONE body, in size order, at stock 0, the sibling's box + price
    expect(summarizePlan(it.get(7702).plan)).toBe('Will add 2 sizes: US 9.5W (custom), US14.5W (custom, new)');
    // stock 0 in OUR warehouse code (S1: supplier_warehouse_id = msc/warehouse/list warehouseCode)
    const sku = (attr, sellerSku, price) => ({ sale_attribute_list: [{ attribute_id: ATTR, ...attr }], supplier_sku: sellerSku, length: '33', width: '21', height: '12', weight: 1400, mall_state: 1,
      price_info_list: [{ base_price: price, currency: 'USD', sub_site: 'shein-us' }], stock_info_list: [{ inventory_num: 0, supplier_warehouse_id: 'PSE2E1' }] });
    // M5: the store may carry an SKC title here (fill-in-standard skc_title show) — re-sent as SHEIN has it, else the edit clears it
    expect(it.get(7702).body).toEqual({ spu_name: 'E2ESPU2', skc_list: [{ skc_name: 'E2ESKC2', skc_title: 'Dunk Low Women White', skc_multi_language_name_list: [{ language: 'en', name: 'Dunk Low Women White' }],
      sku_list: [sku({ attribute_value_id: 15 }, 'W95', 120), sku({ custom_attribute_value: 'US14.5W', language: 'en' }, 'W145', 120)] }],
      sale_attribute_sort_list: [{ attribute_id: ATTR, in_order_attribute_value_list: [{ attribute_value_id: 11 }, { attribute_value_id: 12 }, { attribute_value_id: 15 }, { custom_attribute_value: 'US14.5W' }] }] });
    expect(it.get(7702).body_hash).toMatch(/^[0-9a-f]{64}$/);
    // Air Max: the new size AND the pending relink in the same body; 14.5 needs a spelling → skipped
    const am = it.get(7701);
    expect(am.body.skc_list[0].sku_list[0]).toEqual({ sku_code: 'E2E1-10', supplier_sku: 'A10' });
    expect(am.body.skc_list[0].sku_list[1]).toEqual(sku({ attribute_value_id: 6 }, 'A12', 173));   // market 150 + 15 % = 172.5 → 173
    expect(am.plan.sizes[0]).toMatchObject({ priceFrom: 'market' });
    expect(summarizePlan(am.plan)).toBe('Will add 1 size: US12 (SHEIN size) · change 1 SKU SHEIN has wrong: OLD10 → A10 · 1 size skipped: 14.5 (14.5 isn’t a SHEIN size yet)');
    expect(am.variant_ids.sort()).toEqual([gidV(770110), gidV(770112)].sort());
    // GS: SHEIN is reviewing it — shown, sent later; toddler: nothing SHEIN will take; a shoe not on SHEIN
    expect(it.get(7704)).toMatchObject({ status: 'done', plan: { reviewOpen: true } });
    expect(it.get(7703)).toMatchObject({ status: 'skipped', body: null });
    expect(summarizePlan(it.get(7703).plan)).toMatch(/^No size to add.*3\.5C \(This size can’t be listed on SHEIN: SHEIN has no 3\.5C and won’t take a custom size/);
    expect(it.get(7705)).toMatchObject({ status: 'skipped', blockers: [expect.objectContaining({ code: 'not_on_shein_product' })] });
    // zero writes: the fake saw none, and every log row of the job is a read
    expect(fake.writes).toEqual([]); expect(fake.p2.edits).toEqual([]);
    const { rows: log } = await pool.query(`SELECT DISTINCT path, write FROM shein_api_log WHERE job_id = $1`, [job.id]);
    expect(log.filter((l) => l.write)).toEqual([]);
    expect(new Set(log.map((l) => l.path))).toEqual(new Set(['/open-api/msc/warehouse/list', '/open-api/goods/spu-info', '/open-api/goods/query-publish-fill-in-standard',
      '/open-api/goods/query-document-state', '/open-api/goods/product/check-supplierSku-repeated']));
    // the sheet: PH sees the summary, not the raw request; an admin sees both
    const ph = await (await request.get(`/api/shein/listing-jobs?id=${job.id}`, { headers: auth.ph })).json();
    const phDunk = ph.items.find((i) => i.shopify_product_id === gidP(7702));
    expect(phDunk).toMatchObject({ summary: 'Will add 2 sizes: US 9.5W (custom), US14.5W (custom, new)', status: 'done' });
    expect(phDunk.body).toBeUndefined();
    const ad = await (await request.get(`/api/shein/listing-jobs?id=${job.id}`, { headers: auth.admin })).json();
    expect(ad.items.find((i) => i.shopify_product_id === gidP(7702)).body.spu_name).toBe('E2ESPU2');
  });

  test('Run: 403 without admin / Connect integrations, 400 without a dry-run id (retry too)', async ({ request }) => {
    const post = (h, data) => request.post('/api/shein/listings', { headers: h, data });
    expect((await post(auth.ph, { action: 'run', previewJobId: previewId })).status()).toBe(403);
    expect((await post(auth.ph, { action: 'retry', itemIds: [1] })).status()).toBe(403);
    const r = await post(auth.admin, { action: 'run' });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toMatch(/dry run first/);
    expect((await post(auth.admin, { action: 'run', previewJobId: 'abc' })).status()).toBe(400);
    expect((await post(auth.ph, { action: 'preview', productIds: [] })).status()).toBe(400);
    expect((await D.getListingJob(previewId)).status).toBe('awaiting_confirm');      // nothing above touched it
  });

  test('the run: ONE partialEdit per product (sizes + relink), stock 0; Shopify changed → skipped, nothing sent; review open → deferred +30 min', async () => {
    const live = SHOPIFY(); live.find((p) => p.productId === gidP(7702)).variants.find((v) => v.sku === 'W145').sku = 'W145B';   // Shopify changed after the dry run
    const io = p2IO(L.IO, { shopify: () => live, market: new Map([['IB7936-100|12', 15000]]), stock: stocked });
    const job = await run(previewId, io);
    runId = job.id;
    expect(job).toMatchObject({ kind: 'run', mode: 'run', status: 'done', preview_job_id: previewId, confirmed_by: 'e2e-p2' });
    const it = await items(job.id);
    expect([...it.keys()].sort()).toEqual([7701, 7702, 7704]);                     // only the dry run's sendable items
    // Air Max: sent once, both changes in the one call, new size at stock 0 → In review with SHEIN's version + new SKU code
    expect(edits('E2ESPU1')).toHaveLength(1);
    expect(edits('E2ESPU1')[0].body).toEqual(it.get(7701).body);
    expect(it.get(7701)).toMatchObject({ status: 'in_review', version: 'E2EV1', document_state: 1, idem_key: `${gidP(7701)}|add_sku|${it.get(7701).body_hash}` });
    expect(it.get(7701).sku_codes).toEqual(expect.arrayContaining([{ skc: 'E2ESKC1', skuCode: 'NEW-A12', sellerSku: 'A12' }]));
    expect(it.get(7701).body.skc_list[0].sku_list[1].stock_info_list).toEqual([{ inventory_num: 0, supplier_warehouse_id: 'PSE2E1' }]);
    expect(it.get(7701).sku_codes).toEqual([{ skc: 'E2ESKC1', skuCode: 'NEW-A12', sellerSku: 'A12' }]);   // S5: only OUR new size, not every SKU SHEIN listed
    const { rows: [w] } = await pool.query(`SELECT * FROM shein_api_log WHERE job_id = $1 AND write`, [job.id]);
    expect(w).toMatchObject({ path: '/open-api/goods/product/partialEdit', dry: false, code: '0', request: it.get(7701).body, trace_id: expect.stringMatching(/^e2e-tr-/) });
    expect(w.response).toMatchObject({ code: '0', info: { version: 'E2EV1', success: true } });   // SHEIN's whole answer
    expect((await variant(770112)).status).toBe('in_review');
    expect((await variant(770110)).status).toBe('in_review');
    // Women's: Shopify changed since the dry run → skipped, NOTHING sent for it
    expect(it.get(7702)).toMatchObject({ status: 'changed', error: 'Shopify changed since the dry run — dry run again. Nothing was sent.', idem_key: null });
    expect(edits('E2ESPU2')).toEqual([]);
    // GS: SHEIN reviewing an earlier edit → deferred 30 min, never sent
    const gs = it.get(7704);
    expect(gs).toMatchObject({ status: 'deferred', idem_key: null, blockers: [expect.objectContaining({ code: 'review_open' })] });
    const mins = (new Date(gs.next_attempt_at) - new Date(gs.updated_at)) / 60000;
    expect(mins).toBeGreaterThan(29); expect(mins).toBeLessThan(31);
    expect(edits('E2ESPU3')).toEqual([]);
    expect(job.phase).toMatch(/1 waiting, next try .* EST$/);
    // a dry run is run once
    await expect(L.startRunJob({ previewJobId: previewId, by: 'e2e-p2', io })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already run/) });
  });

  test('a deferred product is retried by itself after 30 min — and still not sent while SHEIN reviews it', async () => {
    const io = p2IO(L.IO);
    expect((await L.listingFollowUp({ io })).requeued).toEqual([]);              // not due yet
    await pool.query(`UPDATE shein_listing_job_items SET next_attempt_at = now() - interval '1 minute' WHERE job_id = $1 AND status = 'deferred'`, [runId]);
    const f = await L.listingFollowUp({ io });
    expect(f.requeued).toEqual([runId]);
    await finished(runId);
    const gs = (await items(runId)).get(7704);
    expect(gs.status).toBe('deferred');
    expect(new Date(gs.next_attempt_at) > new Date()).toBe(true);
    expect(edits('E2ESPU3')).toEqual([]);
  });

  test('SHEIN approves (poll): done, the new size is “published” + synced, the size map verified, ONE stock-only step; the live push can reach it', async () => {
    approveOnFake('E2ESPU1');
    const io = p2IO(L.IO, { stock: stocked, market: new Map([['IB7936-100|12', 15000]]) });   // SHEIN now shows 173 = the D4 target
    stocked.length = 0;
    const f = await L.listingFollowUp({ io, force: true });
    expect(f.verdicts).toEqual(expect.arrayContaining([expect.objectContaining({ verdict: 'approved' })]));
    const am = (await items(runId)).get(7701);
    expect(am).toMatchObject({ status: 'done', document_state: 2 });
    expect(stocked).toEqual(['E2ESPU1']);
    expect(am.response.stock_step).toEqual({ pushed: 1, products: 1 });
    expect(await variant(770112)).toMatchObject({ match: 'published', shein_sku: 'NEW-A12', status: 'synced', last_error: null });
    expect(await variant(770110)).toMatchObject({ match: 'sku', status: 'synced', shein_seller_sku: 'A10' });   // the relink, now on SHEIN
    const { rows: [m] } = await pool.query(`SELECT * FROM shein_size_map WHERE category_id = 1001 AND size_key = '12|M'`);
    expect(m).toMatchObject({ verified: true, attribute_value_id: '6', source: 'exact' });
    const facts = await D.sheinLastWalkFacts();
    expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ spu: 'E2ESPU1', shein_sku: 'NEW-A12', seller_sku: 'A12', reason: 'ok' })]));
    expect((await D.listingInflightSpus()).has('E2ESPU1')).toBe(false);
  });

  test('SHEIN refuses: Error with SHEIN’s message verbatim + its traceId; never retried', async ({ request }) => {
    const MSG = 'Size chart: foot length must be an integer';
    fake.p2.refuse.E2ESPU2 = MSG;
    const io = p2IO(L.IO);
    const pv = await preview([7702], io);
    const job = await run(pv.id, io);
    const it = (await items(job.id)).get(7702);
    expect(it).toMatchObject({ status: 'failed', error: MSG, blockers: [{ code: 'shein_prevalid', field: null, params: expect.objectContaining({ sheinMessage: MSG, module: 'sales_info' }) }] });
    const { rows: [w] } = await pool.query(`SELECT * FROM shein_api_log WHERE job_id = $1 AND write`, [job.id]);
    expect(w.trace_id).toMatch(/^e2e-tr-/);
    expect(w.response.info.pre_valid_result[0].messages).toEqual([MSG]);
    expect(it.trace_id).toBe(w.trace_id);
    const d = await (await request.get(`/api/shein/listings?product=${encodeURIComponent(gidP(7702))}`, { headers: auth.ph })).json();
    const v = d.variants.find((x) => x.row_key === gidV(770245));
    expect(v.status).toBe('error');
    expect(v.blockers[0]).toMatchObject({ code: 'shein_prevalid', title: `SHEIN pre-check: sales_info: ${MSG}.`, sheinSaid: MSG });
    expect((await L.listingFollowUp({ io })).requeued).toEqual([]);              // a refusal is never retried
    expect(edits('E2ESPU2')).toHaveLength(1);
    delete fake.p2.refuse.E2ESPU2;
  });

  test('a fixed listing goes again; SHEIN’s audit WEBHOOK approves it: the custom value’s id is read back, the map verified', async () => {
    process.env.SHEIN_APP_ID = 'APPID1'; process.env.SHEIN_APP_SECRET = 'APPSECRET1234567890';
    const io = p2IO(L.IO, { market: new Map([['DD1503-101|14.5W', 20000]]), stock: stocked });
    stocked.length = 0;
    const pv = await preview([7702], io);
    expect((await items(pv.id)).get(7702).plan.sizes.find((z) => z.sku === 'W145')).toMatchObject({ price: 230, priceFrom: 'market' });
    const job = await run(pv.id, io);
    const it = (await items(job.id)).get(7702);
    expect(it.status).toBe('in_review');
    approveOnFake('E2ESPU2');
    // SHEIN's push, signed + encrypted exactly as SHEIN sends it, through the real handler.
    const { sheinSignature } = await import('../api/_lib/shein.js');
    const W = await import('../api/shein/webhook.js');
    const key = Buffer.alloc(16); Buffer.from('APPSECRET1234567890').copy(key, 0, 0, 16);
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.from('space-station-de'));
    const event = { spu_name: 'E2ESPU2', skc_name: 'E2ESKC2', version: it.version, audit_state: 2, failed_reason: null, document_sn: 'DOC1', audit_time: '2026-10-27 12:00:00' };
    const enc = Buffer.concat([c.update(JSON.stringify(event)), c.final()]).toString('base64');
    const ts = String(Date.now());
    const raw = Buffer.from(`--E2EB\r\nContent-Disposition: form-data; name="eventData"\r\n\r\n${enc}\r\n--E2EB--\r\n`);   // multipart, as SHEIN sends it
    const req = { method: 'POST', url: '/api/shein/webhook', socket: { remoteAddress: '127.0.0.1' }, rawBody: raw, body: {},
      headers: { 'content-type': 'multipart/form-data; boundary=E2EB', 'x-lt-appid': 'APPID1', 'x-lt-timestamp': ts, 'x-lt-eventcode': 'product_document_audit_status_notice',
        'x-lt-signature': sheinSignature('APPID1', 'APPSECRET1234567890', '/api/shein/webhook', ts, 'r4nd0') } };
    const res = { statusCode: 0, setHeader() {}, end(b) { this.body = b; } };
    const saved = { ...W.HOOK }; W.HOOK.listingReviewEvent = (e, code) => L.listingReviewEvent(e, code, { io });
    try { await W.default(req, res); } finally { Object.assign(W.HOOK, saved); }
    expect(res.statusCode).toBe(200);
    expect((await items(job.id)).get(7702)).toMatchObject({ status: 'done', document_state: 2 });
    expect(stocked).toEqual(['E2ESPU2']);
    const { rows: maps } = await pool.query(`SELECT size_key, custom_value, attribute_value_id, verified FROM shein_size_map WHERE category_id = 1002 ORDER BY size_key`);
    expect(maps).toEqual([{ size_key: '14.5|W', custom_value: 'US14.5W', attribute_value_id: '9901', verified: true }, { size_key: '9.5|W', custom_value: null, attribute_value_id: '15', verified: true }]);
    expect(await variant(770245)).toMatchObject({ match: 'published', shein_sku: 'NEW-W145', status: 'synced', last_error: null });
    // a rejection webhook for a product with nothing of ours in flight does nothing
    expect(await L.listingReviewEvent({ spu_name: 'E2ESPU5', audit_state: 3 }, '', { io })).toMatchObject({ handled: 0 });
  });

  test('a custom spelling no person confirmed is skipped by the dry run (and never reaches SHEIN)', async () => {
    await pool.query(`INSERT INTO shein_size_map (category_id, attribute_id, size_key, custom_value, shein_label, source, set_by) VALUES (1001, $1, '14.5|M', 'US14.5', 'US14.5', 'custom_created', NULL)`, [ATTR]);
    await L.recomputeStored({ io: testIO(L.IO) });
    const pv = await preview([7701], p2IO(L.IO));
    const am = (await items(pv.id)).get(7701);
    expect(am).toMatchObject({ status: 'skipped', body: null });
    expect(am.plan.skipped).toEqual([expect.objectContaining({ sku: 'A145', blocker: expect.objectContaining({ code: 'custom_unconfirmed', params: expect.objectContaining({ text: 'US14.5' }) }) })]);
  });

  test('the server dies while a product is being SENT: on resume it looks first (seller-SKU check + spu-info) and never sends twice', async () => {
    fake.p2.docs.E2ESPU3 = { state: 2 };                                         // SHEIN's earlier review of the GS shoe closed
    await pool.query(`UPDATE shein_listing_job_items SET next_attempt_at = now() - interval '1 minute' WHERE job_id = $1 AND status = 'deferred'`, [runId]);
    let hit; const hitP = new Promise((r) => { hit = r; }); let open; const openP = new Promise((r) => { open = r; });
    const io = p2IO(L.IO);
    const dying = { ...io, sheinPartialEdit: async (body, log) => { await L.IO.sheinPartialEdit(body, log); hit(); await openP; throw Object.assign(new Error('SHEIN is not connected (the process died)'), { notConnected: true }); } };
    expect((await L.listingFollowUp({ io: dying })).requeued).toEqual([runId]);
    await hitP;                                                                   // SHEIN has it; we never heard back
    expect((await items(runId)).get(7704).status).toBe('sending');
    await pool.query(`UPDATE shein_listing_jobs SET lease_owner = 'dead-process', lease_until = now() - interval '1 minute' WHERE id = $1`, [runId]);
    await D.markStaleListingJobs();
    open(); await L.listingJobPromise();
    expect((await D.getListingJob(runId)).status).toBe('interrupted');
    expect((await items(runId)).get(7704).status).toBe('sending');
    expect(edits('E2ESPU3')).toHaveLength(1);
    // the restart: the tick resumes the run; the item is looked up before anything is resent
    const before = fake.calls.length;
    expect((await L.listingFollowUp({ io })).requeued).toEqual([runId]);
    await finished(runId);
    const gs = (await items(runId)).get(7704);
    expect(gs).toMatchObject({ status: 'in_review', error: expect.stringMatching(/not sent twice/) });
    expect(edits('E2ESPU3')).toHaveLength(1);
    const looked = fake.calls.slice(before).map((x) => x.path);
    expect(looked).toContain('/open-api/goods/product/check-supplierSku-repeated');
    expect(looked).toContain('/open-api/goods/spu-info');
    expect(looked).not.toContain('/open-api/goods/product/partialEdit');
    expect((await D.getListingJob(runId)).resumes).toBeGreaterThanOrEqual(1);
  });

  test('no answer (503): retried after 5 min, looked up first, then sent once; the walk leaves an SPU being sent alone', async () => {
    await pool.query(`UPDATE shein_size_map SET set_by = 'E2E PH' WHERE category_id = 1001 AND size_key = '14.5|M'`);   // now a person confirmed it
    await L.recomputeStored({ io: testIO(L.IO) });
    const io = p2IO(L.IO);
    const pv = await preview([7701], io);
    expect(summarizePlan((await items(pv.id)).get(7701).plan)).toBe('Will add 1 size: US14.5 (custom, new)');
    fake.p2.fail503 = 1;
    const job = await run(pv.id, io);
    let it = (await items(job.id)).get(7701);
    expect(it).toMatchObject({ status: 'deferred', retries: 1, blockers: [expect.objectContaining({ code: 'api_error' })] });
    expect(it.error).toMatch(/try 2 of 5/);
    const secs = (new Date(it.next_attempt_at) - new Date(it.updated_at)) / 1000;
    expect(secs).toBeGreaterThan(295); expect(secs).toBeLessThan(305);   // S2: the first look waits 5 min (SHEIN receives asynchronously)
    const sent = edits('E2ESPU1').length;
    await pool.query(`UPDATE shein_listing_job_items SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [it.id]);
    expect((await L.listingFollowUp({ io })).requeued).toEqual([job.id]);
    await finished(job.id);
    it = (await items(job.id)).get(7701);
    expect(it.status).toBe('in_review');
    expect(edits('E2ESPU1')).toHaveLength(sent + 1);
    // the live walk: an SPU with a listing item being sent is skipped; one in review only gets stock
    expect((await D.listingInflightSpus()).get('E2ESPU1')).toBe('in_review');
    await pool.query(`UPDATE shein_listing_job_items SET status = 'sending' WHERE id = $1`, [it.id]);
    expect((await D.listingInflightSpus()).get('E2ESPU1')).toBe('sending');
    await pool.query(`UPDATE shein_listing_job_items SET status = 'in_review' WHERE id = $1`, [it.id]);
  });
});

/* ---------------- Phase 2: the page — dry run → review sheet → confirm → job card ---------------- */
// The browser's POST preview / run / retry are answered by THIS process (page.route): the job runs
// in-process with the fake SHEIN + a fake Shopify (p2IO), exactly like the server tests above, and
// the page reads it back from the real endpoints (GET) — so no test server job can ever reach a
// real Shopify or SHEIN. Everything else the page does goes to the real server.
test.describe.serial('SHEIN Listings Phase 2 — the page (dry run, confirm, progress)', () => {
  test.use({ timezoneId: 'Asia/Manila' });
  let L; let D;
  const posted = [];
  let shopifyNow = SHOPIFY;
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const io = () => p2IO(L.IO, { shopify: () => shopifyNow() });
  const shot = async (page, name) => { if (process.env.SHL_SHOTS) await page.screenshot({ path: `${process.env.SHL_SHOTS}/shein-listings-${name}.png`, fullPage: false }); };
  // POST /api/shein/listings preview | run | retry → answered here; the rest goes to the server.
  async function routeWrites(page) {
    await page.route((u) => u.pathname === '/api/shein/listings', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      const b = req.postDataJSON() || {};
      posted.push(b);
      const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      try {
        if (b.action === 'preview') {
          const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p2ui', scope: { productIds: b.productIds }, io: io() });
          jobsMade.add(j.id); await finished(j.id);
          return json(200, { ok: true, job: j });
        }
        if (b.action === 'run') {
          const j = await L.startRunJob({ previewJobId: b.previewJobId, by: 'e2e-p2ui', io: io() });
          jobsMade.add(j.id); await finished(j.id);
          return json(200, { ok: true, job: j });
        }
        if (b.action === 'retry') return json(200, { ok: true, retried: b.itemIds.length, refused: [], job: null });
      } catch (e) { return json(e.status || 500, { ok: false, error: e.message }); }
      return route.continue();
    });
  }
  const sheet = (page) => page.getByRole('dialog', { name: 'Dry run and send' });
  const item = (page, n) => sheet(page).locator(`.shl-ditem[data-product="${gidP(n)}"]`);
  async function dryRun(page, ids, path = '/ph/shein-listings') {
    await page.goto(path);
    for (const n of ids) await page.locator(`.shl-product[data-product="${gidP(n)}"] .shl-chk input`).check();
    await page.locator('.shl-bar').getByRole('button', { name: /^Add missing sizes/ }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
  }

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    // A clean slate: the server tests above left sends in review and sizes published.
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e-p2%'`);
    const old = rows.map((r) => r.id);
    await pool.query(`DELETE FROM shein_listing_job_items WHERE job_id = ANY($1::bigint[])`, [old]);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [old]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_size_map WHERE category_id IN (1001, 1002, 1003, 1004)`);
    fake.p2 = P2();
    await D.saveSizeMap({ category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: 'US14.5W', shein_label: 'US14.5W', source: 'custom_created' }, 'E2E PH');
    await D.saveSizeMap({ category_id: 1002, attribute_id: ATTR, size_key: '9.5|W', attribute_value_id: 15, shein_label: 'US 9.5W', source: 'custom_created' }, 'E2E PH');
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p2ui', io: testIO(L.IO) });
    jobsMade.add(snap.id);
    await finished(snap.id);
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); shopifyNow = SHOPIFY; });
  test.afterAll(() => { fake.p2 = null; });

  test('PH: Dry run opens the review sheet — counts, “0 SHEIN writes”, one line per product, the plan; Confirm disabled without the privilege; no raw request', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await routeWrites(page);
    fake.writes.length = 0;
    await dryRun(page, [7701, 7702, 7704]);
    const s = sheet(page);
    await expect(s.locator('[data-proof]')).toContainText('0 SHEIN writes');
    await expect(s.locator('.er-stat', { hasText: 'products to send' })).toContainText('3');
    await expect(s.locator('.er-stat', { hasText: 'sizes to add' })).toContainText('4');
    await expect(s.locator('.er-stat', { hasText: 'custom sizes' })).toContainText('1 new to SHEIN');
    await expect(s.locator('.er-stat', { hasText: 'SKUs SHEIN has wrong' })).toContainText('1');
    await expect(s.locator('.er-stat', { hasText: 'wait for a SHEIN review' })).toContainText('1');
    await expect(item(page, 7702)).toContainText('Will add 2 sizes: US 9.5W (custom), US14.5W (custom, new)');
    await expect(item(page, 7701)).toContainText('change 1 SKU SHEIN has wrong: OLD10 → A10');
    await expect(item(page, 7704)).toContainText('SHEIN is reviewing an earlier edit');
    // the plan: our size → SHEIN size, seller SKU, price + where from, stock 0; skipped sizes say why
    await item(page, 7701).getByRole('button', { name: /What is sent/ }).click();
    const row12 = item(page, 7701).locator('.shl-plan tr', { hasText: 'A12' });
    await expect(row12).toContainText('✓ US12');
    await expect(row12).toContainText('SHEIN size');
    await expect(row12).toContainText('Shopify price');
    await expect(item(page, 7701)).toContainText('SHEIN has the wrong SKU: OLD10 → will change to A10');
    await expect(item(page, 7701)).toContainText('14.5 — 14.5 isn’t a SHEIN size yet.');
    await item(page, 7702).getByRole('button', { name: /What is sent/ }).click();
    await expect(item(page, 7702).locator('.shl-plan tr', { hasText: 'W145' })).toContainText('✚ US14.5W custom size (new');
    await expect(s.getByText(/Exact request to SHEIN/)).toHaveCount(0);           // admin only — and not even in the answer
    const confirm = s.getByRole('button', { name: 'Add sizes to 3 products' });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('title', /Needs an admin/);
    expect(fake.writes).toEqual([]); expect(fake.p2.edits).toEqual([]);
    expect(posted.filter((b) => b.action === 'run')).toEqual([]);
    await shot(page, 'desktop-dryrun-ph');
    // closing the sheet doesn't touch the job; the Jobs tab lists it, waiting for a person
    await s.getByRole('button', { name: 'Not now' }).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.getByRole('tab', { name: /Jobs/ }).click();
    await expect(page.locator('.shl-rtable tr', { hasText: 'e2e-p2ui' }).filter({ hasText: 'Dry run' }).first()).toContainText('Waiting for you');
  });

  test('admin: confirms → the sheet becomes the job card: In review, Shopify-changed “dry run again”, waiting; SHEIN approves → Done', async ({ page }) => {
    await loginAs(page, 'admin');
    await routeWrites(page);
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto('/shein-listings');
    for (const n of [7701, 7702, 7704]) await page.locator(`.shl-product[data-product="${gidP(n)}"] .shl-chk input`).check();
    await page.locator('.shl-bar').getByRole('button', { name: 'Add missing sizes 3' }).click();
    await expect(sheet(page).locator('[data-proof]')).toContainText('0 SHEIN writes', { timeout: 20_000 });
    await item(page, 7702).getByRole('button', { name: /What is sent/ }).click();
    await item(page, 7702).getByText('Exact request to SHEIN (admin)').click();
    await expect(item(page, 7702).locator('.shl-json')).toContainText('"custom_attribute_value": "US14.5W"');
    await shot(page, 'desktop-dryrun-admin');
    // Shopify changes the Air Max after the dry run → that product is not sent
    shopifyNow = () => { const l = SHOPIFY(); l.find((p) => p.productId === gidP(7701)).variants.find((v) => v.sku === 'A12').sku = 'A12B'; return l; };
    await sheet(page).getByRole('button', { name: 'Add sizes to 3 products' }).click();
    const run = posted.filter((b) => b.action === 'run').pop();
    await expect(sheet(page).locator('.shl-pname')).toContainText('Send to SHEIN #', { timeout: 20_000 });
    expect(run.previewJobId).toBeGreaterThan(0);
    await expect(item(page, 7702).locator('.ebo-chip')).toHaveText('In review');
    await expect(item(page, 7701).locator('.ebo-chip')).toHaveText('Not sent');
    await expect(item(page, 7701)).toContainText('Shopify changed since the dry run — dry run again');
    await expect(item(page, 7701).getByRole('button', { name: 'Dry run again' })).toBeEnabled();
    await expect(item(page, 7704).locator('.ebo-chip')).toHaveText('Waiting');
    await expect(item(page, 7704)).toContainText(/(Next try|try again at) .* EST/);
    expect(edits('E2ESPU2')).toHaveLength(1); expect(edits('E2ESPU1')).toEqual([]);
    await shot(page, 'desktop-dryrun-jobcard');
    // SHEIN approves the Dunk → the card follows it live (no refresh)
    approveOnFake('E2ESPU2');
    await L.listingFollowUp({ io: io(), force: true });
    await expect(item(page, 7702).locator('.ebo-chip')).toHaveText('Done', { timeout: 15_000 });
    await expect(item(page, 7702)).toContainText('SHEIN approved it');
    await sheet(page).getByRole('button', { name: 'Close', exact: true }).last().click();
    // the drawer's history: this product's dry run + send, with the summary and status
    await page.goto(`/shein-listings?product=${encodeURIComponent(gidP(7702))}`);
    const drawer = page.getByRole('dialog', { name: 'Product details' });
    const sent = drawer.locator('.shl-hist-item[data-hist="run"]').first();
    await expect(sent).toContainText('Done');
    await expect(sent).toContainText('Will add 2 sizes: US 9.5W (custom), US14.5W (custom, new)');
    await expect(drawer.locator('.shl-hist-item[data-hist="preview"]').first()).toContainText('Ready to send');
  });
  const edits = (spu) => fake.p2.edits.filter((e) => e.body.spu_name === spu);

  test('a refusal shows SHEIN’s words verbatim (+ Dry run again); a no-answer failure has Retry (admin) — in the Jobs tab too', async ({ page }) => {
    await loginAs(page, 'admin');
    await routeWrites(page);
    const MSG = 'Size chart: foot length must be an integer';
    fake.p2.refuse.E2ESPU1 = MSG;
    await dryRun(page, [7701], '/shein-listings');
    await sheet(page).getByRole('button', { name: 'Add sizes to 1 product' }).click();
    await expect(item(page, 7701).locator('.ebo-chip')).toHaveText('Error', { timeout: 20_000 });
    await expect(item(page, 7701)).toContainText(`SHEIN said: “${MSG}”`);
    await expect(item(page, 7701).getByRole('button', { name: 'Dry run again' })).toBeVisible();
    await expect(item(page, 7701).getByRole('button', { name: 'Retry' })).toHaveCount(0);   // SHEIN refused: retrying sends the same refusal
    delete fake.p2.refuse.E2ESPU1;
    // a product SHEIN never answered (5 tries) → Retry
    const runId = (await pool.query(`SELECT id FROM shein_listing_jobs WHERE kind = 'run' AND started_by = 'e2e-p2ui' ORDER BY id DESC LIMIT 1`)).rows[0].id;
    const { rows: [it] } = await pool.query(`UPDATE shein_listing_job_items SET status = 'failed', error = 'No answer from SHEIN after 5 tries: Service Unavailable',
      blockers = '[{"code":"api_error","field":null,"params":{"message":"Service Unavailable"}}]'::jsonb WHERE job_id = $1 RETURNING id`, [runId]);
    await expect(item(page, 7701)).toContainText('No answer from SHEIN after 5 tries: Service Unavailable');
    await item(page, 7701).getByRole('button', { name: 'Retry' }).click();
    await expect(sheet(page)).toContainText('Sent again on the server');
    expect(posted.filter((b) => b.action === 'retry').pop()).toEqual({ action: 'retry', itemIds: [Number(it.id)] });
    // the same job in the Jobs tab (?job=): the same card, inline
    await page.goto(`/shein-listings?tab=jobs&job=${runId}`);
    await expect(page.locator('.shl-dinline')).toContainText(`Send to SHEIN #${runId}`);
    await expect(page.locator('.shl-dinline .shl-ditem').first().getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('390 px: the sheet is full-screen, no horizontal scroll (review and job card); the PH job card has Retry disabled', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await routeWrites(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const noSideScroll = async (where) => {
      const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth,
        sheet: document.querySelector('.shl-sheet')?.scrollWidth || 0, sheetW: document.querySelector('.shl-sheet')?.clientWidth || 0 }));
      expect(Math.max(w.doc, w.body), where).toBeLessThanOrEqual(w.vw);
      expect(w.sheet, `${where} (inside the sheet)`).toBeLessThanOrEqual(w.sheetW);
    };
    await dryRun(page, [7702, 7704]);
    expect((await sheet(page).boundingBox()).width).toBeLessThanOrEqual(390);
    for (const n of [7702, 7704]) await item(page, n).getByRole('button', { name: /What is sent/ }).click().catch(() => {});
    await noSideScroll('review');
    await shot(page, 'phone-dryrun');
    await expect(sheet(page).getByRole('button', { name: /^Add sizes to/ })).toBeDisabled();
    await sheet(page).getByRole('button', { name: 'Not now' }).click();
    // the earlier send, opened from the drawer's history: the job card
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7701))}`);
    await page.getByRole('dialog', { name: 'Product details' }).locator('.shl-hist-item[data-hist="run"]').first().getByRole('button', { name: 'Open' }).click();
    await expect(sheet(page).locator('.shl-pname')).toContainText('Send to SHEIN #');
    await expect(item(page, 7701).getByRole('button', { name: 'Retry' })).toBeDisabled();
    await expect(item(page, 7701).getByRole('button', { name: 'Retry' })).toHaveAttribute('title', /Needs an admin/);
    await noSideScroll('job card');
    await shot(page, 'phone-dryrun-jobcard');
  });
});

/* ------------------- Phase 2 — the API review's fixes (plan/phase2-review.md) ------------------- */

test.describe('SHEIN Listings Phase 2 — the API review fixes (pure)', () => {
  const values = TPL[502].map((v) => ({ id: v.attribute_value_id, label: v.attribute_value, custom: v.is_custom_attribute_value }));
  const sizes = { attributeId: ATTR, values, status: 3, type: 1, label: 0 };
  const product = (over = {}) => { const p = SHOPIFY().find((x) => x.productId === gidP(7702)); for (const v of p.variants) Object.assign(v, over[v.sku] || {}); return p; };
  const row = (n, sku, size, extra = {}) => ({ row_key: gidV(n), shopify_variant_id: gidV(n), seller_sku: sku, shopify_size: size, match: 'none', status: 'not_on_shein', blockers: [], excluded: false, ...extra });
  const map = (extra) => ({ id: 1, category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: 'US14.5W', shein_label: 'US14.5W', source: 'custom_created', set_by: 'Kim', ...extra });
  const plan = (o = {}) => planAddSizes({ spu: SHEIN.E2ESPU2, product: product(), stored: [row(770245, 'W145', '14.5W')], maps: [map()], sizes, permission: 1, customValues: ['US 9.5W'], ...o });
  const clone = (x) => JSON.parse(JSON.stringify(x));

  test('M1: a custom value only where SHEIN allows custom sizes for THIS category + size field', () => {
    for (const o of [{ permission: 0 }, { permission: null }, { permission: 0, maps: [map({ category_id: 0, attribute_id: 0 })] }]) {
      const r = plan(o);
      expect(r.body, JSON.stringify(o)).toBe(null);
      expect(['size_not_on_shein', 'size_unchecked']).toContain(r.plan.skipped[0].blocker.code);
    }
    const ctx = { categoryId: 1002, attributeId: ATTR, values, maps: [map()] };
    expect(resolveSize('14.5W', { ...ctx, permission: 0 }).blocker.code).toBe('size_not_on_shein');
    expect(resolveSize('14.5W', { ...ctx, permission: null })).toMatchObject({ kind: null, note: { code: 'size_unchecked' } });
    expect(resolveSize('14.5W', { ...ctx, permission: 1 }).kind).toBe('custom');
  });

  test('M2: the size field is the template’s SKU-level size attribute, and every SKU carries exactly that one', () => {
    const two = clone(SHEIN.E2ESPU2);
    for (const k of two.skcInfoList[0].skuInfoList) k.saleAttributeList.unshift({ attributeId: 55, attributeValueId: 501, attributeValueMultiList: [{ language: 'en', attributeValueName: 'Wide' }] });
    expect(plan({ spu: two })).toMatchObject({ body: null, plan: { blockers: [expect.objectContaining({ code: 'size_field_unclear', params: expect.objectContaining({ why: 'two_attrs' }) })] } });
    expect(plan({ sizes: { ...sizes, attributeId: 99 } }).plan.blockers[0]).toMatchObject({ code: 'size_field_unclear', params: { why: 'mismatch' } });
    expect(plan({ sizes: { ...sizes, label: 1 } }).plan.blockers[0]).toMatchObject({ code: 'size_field_unclear', params: { why: 'not_sku_level' } });
    // the template read: a width field named first (and hinted by spu-info) never beats the size field
    const tpl = { product_type_id: 502, attribute_infos: [{ attribute_id: 55, attribute_name_en: 'Width', attribute_type: 1, attribute_label: 0, attribute_value_info_list: [val(501, 'Wide')] }, ...TEMPLATE(502).attribute_infos] };
    expect(templateSizes([tpl], 502, 55)).toMatchObject({ attributeId: ATTR, type: 1, label: 0 });
  });

  test('M3: custom text = printable ASCII with single spaces; no look-alike of a store value; not one of SHEIN’s own sizes', () => {
    for (const t of ['US 14.5W', 'US 14.5W​', 'US 14.5’W', 'US 14½', 'Ü 14', 'US  14.5W']) expect(validateCustomText(t), JSON.stringify(t)).not.toBe(null);
    for (const t of ['US 14.5W', 'US14.5W', 'US 14.5 W', 'Size-14.5/W']) expect(validateCustomText(t), t).toBe(null);
    expect(customTextConflict('us 9.5w', { values })).toMatch(/already has “US 9\.5W”/);
    expect(customTextConflict('US9.5W', { values, customValues: ['US 9.5W'] })).toMatch(/already has/);
    expect(customTextConflict('US 9.5W', { values })).toBe(null);                // the existing value, exactly: fine
    expect(customTextConflict('US7W', { values })).toMatch(/SHEIN has this size: “US7W”/);
    expect(customTextConflict('US 7 W', { values })).toMatch(/SHEIN has this size/);
    const r = plan({ stored: [row(770295, 'W95', '9.5W')], maps: [map({ size_key: '9.5|W', custom_value: 'us 9.5w' })] });
    expect(r.body).toBe(null);
    expect(r.plan.skipped[0].blocker).toMatchObject({ code: 'custom_text_invalid', params: { text: 'us 9.5w' } });
  });

  test('M5: the SKC title is re-sent as SHEIN has it; a title / reference link we can’t copy blocks the product', () => {
    const fill = (list) => ({ fill_in_standard_list: list });
    const t = plan({ fill: fill([{ field_key: 'skc_title', show: true, required: false }]) });
    expect(t.body.skc_list[0]).toMatchObject({ skc_title: 'Dunk Low Women White', skc_multi_language_name_list: [{ language: 'en', name: 'Dunk Low Women White' }] });
    expect(plan({ fill: fill([{ field_key: 'skc_title', show: false, required: false }]) }).body.skc_list[0].skc_title).toBeUndefined();
    const bare = clone(SHEIN.E2ESPU2); bare.skcInfoList[0].productMultiNameList = [];
    expect(plan({ spu: bare, fill: fill([{ field_key: 'skc_title', show: true, required: true }]) }).plan.blockers[0]).toMatchObject({ code: 'skc_field_uncopyable', params: { field: 'skc_title' } });
    expect(plan({ fill: fill([{ field_key: 'reference_product_link', show: true, required: true }]) }).plan.blockers[0]).toMatchObject({ code: 'skc_field_uncopyable', params: { field: 'competing_product_link' } });
    // a relink would edit a SKU whose reference link we can't read back → blocked
    const relink = plan({ product: product({ W7: { sku: 'W7NEW' } }), stored: [row(770245, 'W145', '14.5W'), row(770207, 'W7NEW', '7W', { match: 'link', shein_sku: 'E2E2-07', shein_seller_sku: 'W7' })],
      fill: fill([{ field_key: 'reference_product_link', show: true, required: false }]) });
    expect(relink).toMatchObject({ body: null, plan: { blockers: [expect.objectContaining({ code: 'skc_field_uncopyable' })] } });
  });

  test('S3: a size already on the product under the same TEXT (an approved custom value) is not added twice', () => {
    const has = clone(SHEIN.E2ESPU2);
    has.skcInfoList[0].skuInfoList.push({ ...has.skcInfoList[0].skuInfoList[0], skuCode: 'E2E2-145', supplierSku: 'OLD145',
      saleAttributeList: [{ attributeId: ATTR, attributeValueId: 9988, attributeValueMultiList: [{ language: 'en', attributeValueName: 'US14.5W' }] }] });
    expect(plan({ spu: has }).plan.skipped[0].blocker).toMatchObject({ code: 'size_already_on_shein', params: { sheinSize: 'US14.5W', sellerSku: 'OLD145' } });
  });

  test('M6 / S5 / S6: what partialEdit’s answer means — sent only with success:true AND a version; warnings + filtered_result kept; only OUR new SKU codes', async () => {
    const { readSendAnswer } = await import('../api/_lib/shein-listing.js');
    const p = { sizes: [{ sku: 'W145' }] };
    expect(readSendAnswer({ success: false, pre_valid_result: [{ module: 'sales_info', messages: ['Price too low'] }] }, p)).toMatchObject({ kind: 'refused', message: 'Price too low', module: 'sales_info' });
    expect(readSendAnswer({}, p)).toMatchObject({ kind: 'refused' });                         // success missing = not a success
    expect(readSendAnswer({ success: true, version: null }, p)).toMatchObject({ kind: 'unknown' });
    const ok = readSendAnswer({ success: true, version: 'SPMP1', pre_valid_result: [{ module: 'basic_info', messages: ['Title near the limit'] }],
      mcc_valid_result: [{ type: 1, message: 'Category watched' }], filtered_result: { skc: ['competing_product_link'] },
      skc_list: [{ skc_name: 'S1', sku_list: [{ sku_code: 'a', supplier_sku: '' }, { sku_code: 'b', supplier_sku: 'W145' }] }] }, p);
    expect(ok).toMatchObject({ kind: 'sent', version: 'SPMP1', skuCodes: [{ skc: 'S1', skuCode: 'b', sellerSku: 'W145' }] });
    expect(ok.notes.map((n) => [n.code, n.params.module])).toEqual([['shein_note', 'basic_info'], ['shein_note', 'mcc (warning)'], ['shein_note', 'filtered_result']]);
  });

  test('M7: the IP whitelist / auth STOP the job (never “SHEIN refused it”); “system busy” is retried', async () => {
    const { isFatal, isTransport } = await import('../api/_lib/shein-listing.js');
    const wl = { sheinCode: '10403', sheinMsg: 'Request IP 203.0.113.9 is not in the whitelist', httpStatus: 200, message: 'SHEIN …: Request IP …' };
    expect(isFatal(wl)).toBe(true); expect(isTransport(wl)).toBe(false);
    expect(isFatal({ httpStatus: 403, sheinCode: 'x' })).toBe(true);
    expect(isFatal({ httpStatus: 200, sheinCode: '1', sheinMsg: '签名错误' })).toBe(true);
    expect(isTransport({ httpStatus: 200, sheinCode: '20999', sheinMsg: 'System busy, please try again later' })).toBe(true);
    expect(isTransport({ httpStatus: 200, unknownAnswer: true })).toBe(true);
    const refusal = { httpStatus: 200, sheinCode: '20003', sheinMsg: 'Product verification failed' };
    expect(isFatal(refusal)).toBe(false); expect(isTransport(refusal)).toBe(false);
    expect(isFatal({ httpStatus: 200, sheinCode: '1', sheinMsg: 'ip_character_list is invalid' })).toBe(false);   // a field name, not the whitelist
    // re-review N3: a validation message about the product's IP field is a refusal (Error), not a job stop
    for (const m of ['IP character is required for this brand', 'Product IP 123 is not authorised', 'The IP field is invalid']) expect(isFatal({ httpStatus: 200, sheinCode: '20003', sheinMsg: m }), m).toBe(false);
    for (const m of ['Request IP 1.2.3.4 is not in the whitelist', 'IP 1.2.3.4 not allowed', '请求IP不在白名单']) expect(isFatal({ httpStatus: 200, sheinCode: '10403', sheinMsg: m }), m).toBe(true);
  });
});

test.describe.serial('SHEIN Listings Phase 2 — the API review fixes, end to end', () => {
  let L; let D; let auth;
  const stocked = [];
  const items = async (jobId) => new Map((await D.listListingJobItems(jobId, { limit: 1000 })).map((i) => [Number(i.shopify_product_id.split('/').pop()), i]));
  const edits = (spu) => fake.p2.edits.filter((e) => e.body.spu_name === spu);
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const preview = async (ids, io) => { const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p2', scope: { productIds: ids.map(gidP) }, io }); jobsMade.add(j.id); return finished(j.id); };
  const run = async (pid, io) => { const j = await L.startRunJob({ previewJobId: pid, by: 'e2e-p2', io }); jobsMade.add(j.id); return finished(j.id); };
  // One more Shopify size on three shoes: 7701 15 (SHEIN's US15), 7702 15W (US15W), 7703 5C (US5C).
  const MORE = () => { const list = SHOPIFY(); const add = (n, v) => list.find((p) => p.productId === gidP(n)).variants.push(v);
    add(7701, { variantId: gidV(770115), sku: 'A15', size: '15', price: '160', compareAt: null, qty: 1, barcode: null, weightG: null });
    add(7702, { variantId: gidV(770215), sku: 'W15', size: '15W', price: '120', compareAt: null, qty: 1, barcode: null, weightG: null });
    add(7703, { variantId: gidV(770305), sku: 'T5', size: '5C', price: '60', compareAt: null, qty: 1, barcode: null, weightG: null });
    return list; };
  const io = () => p2IO(L.IO, { shopify: MORE, stock: stocked });

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    const { signToken } = await import('../api/_lib/util.js');
    auth = { ph: { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` } };
    // A clean slate (the blocks above left sends in review), a fresh fake, the person-confirmed maps.
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e-p2%'`);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_size_map WHERE category_id IN (1001, 1002, 1003, 1004)`);
    fake.p2 = P2();
    await D.saveSizeMap({ category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: 'US14.5W', shein_label: 'US14.5W', source: 'custom_created' }, 'E2E PH');
    await D.saveSizeMap({ category_id: 1002, attribute_id: ATTR, size_key: '9.5|W', attribute_value_id: 15, shein_label: 'US 9.5W', source: 'custom_created' }, 'E2E PH');
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p2', io: testIO(L.IO, { shopify: MORE }) });
    jobsMade.add(snap.id);
    await finished(snap.id);
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });
  test.afterAll(() => { fake.p2 = null; });

  test('M7 + S4: a CODED refusal → Error with the reason from info.pre_valid_result; the key is released, so a later dry run sends again; S5/S6 on the answer', async () => {
    const MSG = 'Toddler sizes need an insole length';
    fake.p2.refuseCoded.E2ESPU4 = MSG;
    let job = await run((await preview([7703], io())).id, io());
    let it = (await items(job.id)).get(7703);
    expect(it).toMatchObject({ status: 'failed', error: MSG, idem_key: null, blockers: [expect.objectContaining({ code: 'shein_prevalid', params: expect.objectContaining({ sheinMessage: MSG, code: '20003' }) })] });
    expect(it.response).toMatchObject({ code: '20003', msg: 'Product verification failed', info: { success: false } });
    delete fake.p2.refuseCoded.E2ESPU4;
    fake.p2.warn = true;
    job = await run((await preview([7703], io())).id, io());                    // the SAME body again — not "already sent"
    it = (await items(job.id)).get(7703);
    fake.p2.warn = false;
    expect(it.status).toBe('in_review');
    expect(edits('E2ESPU4')).toHaveLength(2);
    expect(it.sku_codes).toEqual([{ skc: 'E2ESKC4', skuCode: 'NEW-T5', sellerSku: 'T5' }]);   // not the siblings SHEIN listed with ""
    expect(it.blockers.map((b) => b.params.sheinMessage)).toEqual(['Title is close to the length limit', expect.stringMatching(/^fields SHEIN filtered out: .*competing_product_link/)]);
  });

  test('M7: “IP not in the whitelist” STOPS the run with a clear message — nothing marked refused; Resume looks first, then sends once (with the SKC title, M5)', async () => {
    fake.p2.whitelist = true;
    const pv = await preview([7702], io());
    const job = await run(pv.id, io());
    fake.p2.whitelist = false;
    expect(job).toMatchObject({ status: 'failed', phase: 'Stopped — SHEIN refused the connection' });
    expect(job.error).toMatch(/whitelist.*Railway/);
    const it = (await items(job.id)).get(7702);
    expect(it).toMatchObject({ status: 'deferred' });                           // re-review N2: never left 'sending'
    expect(it.idem_key).toBeTruthy();                                            // …but still looked up before any resend
    expect((await D.listingInflightSpus()).get('E2ESPU2')).toBe('deferred');     // N4: a keyed wait counts as in flight
    expect((it.blockers || []).map((b) => b.code)).not.toContain('shein_prevalid');
    expect(edits('E2ESPU2').filter((e) => e.body.skc_list[0].sku_list.some((k) => k.supplier_sku === 'W15'))).toHaveLength(0);
    await L.resumeJob(job.id, { by: 'e2e-p2', io: io() });
    await finished(job.id);
    const after = (await items(job.id)).get(7702);
    expect(after.status).toBe('in_review');
    const sent = edits('E2ESPU2').filter((e) => e.body.skc_list[0].sku_list.some((k) => k.supplier_sku === 'W15'));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.skc_list[0].skc_title).toBe('Dunk Low Women White');
  });

  test('S2 + M6: busy → first look after 5 min; success WITHOUT a version → “unknown”, looked up later; a lagging seller-SKU check is caught by the new document version — sent once', async () => {
    fake.p2.busy = 1;
    const job = await run((await preview([7701], io())).id, io());
    let it = (await items(job.id)).get(7701);
    expect(it).toMatchObject({ status: 'deferred', retries: 1 });
    expect((new Date(it.next_attempt_at) - new Date(it.updated_at)) / 1000).toBeGreaterThan(295);
    const before = edits('E2ESPU1').length;
    fake.p2.noVersion = 1; fake.p2.lag = true;
    await pool.query(`UPDATE shein_listing_job_items SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [it.id]);
    await L.listingFollowUp({ io: io() });
    await finished(job.id);
    it = (await items(job.id)).get(7701);
    expect(it).toMatchObject({ status: 'deferred', retries: 2, version: null });           // SHEIN took it but gave no version: never "in review" blind
    expect(it.idem_key).toBeTruthy();
    expect(edits('E2ESPU1')).toHaveLength(before + 1);
    await pool.query(`UPDATE shein_listing_job_items SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [it.id]);
    await L.listingFollowUp({ io: io() });
    await finished(job.id);
    it = (await items(job.id)).get(7701);
    fake.p2.lag = false;
    expect(it).toMatchObject({ status: 'in_review', version: fake.p2.docs.E2ESPU1.version, error: expect.stringMatching(/not sent twice/) });
    expect(edits('E2ESPU1')).toHaveLength(before + 1);                                  // the seller-SKU check lagged; the new version said "arrived"
  });

  test('M6 + S9: the poll asks about OUR version; another submission’s rejection, or a webhook without a version, changes nothing; −1 = “SHEIN didn’t receive it”', async () => {
    const it0 = [...(await items((await D.listListingJobs({ kind: 'run', limit: 1 }))[0].id)).values()][0];
    expect(it0).toMatchObject({ spu: 'E2ESPU1', status: 'in_review' });
    const mine = it0.version;
    fake.p2.docs.E2ESPU1 = { version: 'E2EOTHER', state: 3, reason: 'someone else’s edit' };   // the product's LATEST document is another one, rejected
    fake.p2.hist['E2ESPU1|E2EOTHER'] = { state: 3, reason: 'someone else’s edit' };
    await L.listingFollowUp({ io: io(), force: true });
    expect((await D.getListingItems([it0.id]))[0].status).toBe('in_review');
    const asked = fake.calls.filter((c) => c.path === '/open-api/goods/query-document-state').at(-1).body.spuList;
    expect(asked).toEqual(expect.arrayContaining([{ spuName: 'E2ESPU1', version: mine }]));
    expect(await L.listingReviewEvent({ spu_name: 'E2ESPU1', version: 'E2EOTHER', audit_state: 3, failed_reason: [{ content: 'x' }] }, '', { io: io() })).toMatchObject({ handled: 0 });
    expect(await L.listingReviewEvent({ spu_name: 'E2ESPU1', audit_state: 3, failed_reason: [{ content: 'x' }] }, '', { io: io() })).toMatchObject({ handled: 0, why: expect.stringMatching(/poll decides/) });
    expect((await D.getListingItems([it0.id]))[0].status).toBe('in_review');
    fake.p2.hist[`E2ESPU1|${mine}`] = { state: -1 };
    await L.listingFollowUp({ io: io(), force: true });
    expect((await D.getListingItems([it0.id]))[0]).toMatchObject({ status: 'failed', blockers: [expect.objectContaining({ code: 'shein_prevalid', params: { sheinMessage: 'SHEIN didn’t receive it' } })] });
  });

  test('N4: “approved, but the new sizes don’t show on SHEIN” waits — but not for ever: after 24 h it is an Error', async () => {
    const { rows: [it] } = await pool.query(`SELECT i.* FROM shein_listing_job_items i JOIN shein_listing_jobs j ON j.id = i.job_id
      WHERE j.kind = 'run' AND i.shopify_product_id = $1 AND i.status = 'in_review' ORDER BY i.id DESC LIMIT 1`, [gidP(7703)]);
    expect(it).toBeTruthy();
    fake.p2.hist[`E2ESPU4|${it.version}`] = { state: 2 };                       // SHEIN says approved… but spu-info never shows NEW-T5
    await L.listingFollowUp({ io: io(), force: true });
    let now = (await D.getListingItems([it.id]))[0];
    expect(now).toMatchObject({ status: 'in_review', error: expect.stringMatching(/waiting for SHEIN to show the new sizes/) });
    expect(now.response.approved_seen_at).toBeTruthy();
    await pool.query(`UPDATE shein_listing_job_items SET response = jsonb_set(response, '{approved_seen_at}', to_jsonb((now() - interval '25 hours')::text)) WHERE id = $1`, [it.id]);
    await L.listingFollowUp({ io: io(), force: true });
    now = (await D.getListingItems([it.id]))[0];
    expect(now).toMatchObject({ status: 'failed', error: expect.stringMatching(/never showed on SHEIN in 24 h/) });
  });

  test('M1 + M3 on the Sizes form’s endpoint: no “any category” custom size, none where SHEIN says no, no look-alikes, not SHEIN’s own size, plain ASCII only', async ({ request }) => {
    const post = (data) => request.post('/api/shein/listing-maps?type=size', { headers: auth.ph, data: { action: 'set', attributeId: ATTR, ...data } });
    const cases = [
      [{ categoryId: 0, attributeId: 0, sizeKey: '14.5|W', customValue: 'US14.5W' }, /per SHEIN category/],
      [{ categoryId: 1003, sizeKey: '3.5|C', customValue: 'US3.5C' }, /doesn’t allow custom sizes in category 1003/],
      [{ categoryId: 1002, sizeKey: '9.5|W', customValue: 'us 9.5w' }, /already has “US 9\.5W”/],
      [{ categoryId: 1002, sizeKey: '7|W', customValue: 'US 7W' }, /SHEIN has this size: “US7W”/],
      [{ categoryId: 1002, sizeKey: '14.5|W', customValue: 'US 14.5W' }, /plain keyboard characters/],
    ];
    for (const [data, want] of cases) {
      const r = await post(data);
      expect(r.status(), JSON.stringify(data)).toBe(400);
      expect((await r.json()).error).toMatch(want);
    }
  });
});

/* --------------------------- Phase 2 — the re-review (N1–N4) --------------------------- */
test.describe('SHEIN Listings Phase 2 — the re-review fixes (pure)', () => {
  test('N1: SHEIN’s listing rules couldn’t be read → the product is blocked, never sent without its SKC title', () => {
    const values = TPL[502].map((v) => ({ id: v.attribute_value_id, label: v.attribute_value, custom: v.is_custom_attribute_value }));
    const r = planAddSizes({ spu: SHEIN.E2ESPU2, product: SHOPIFY().find((p) => p.productId === gidP(7702)), sizes: { attributeId: ATTR, values, status: 3, type: 1, label: 0 }, permission: 1,
      stored: [{ row_key: gidV(770245), shopify_variant_id: gidV(770245), seller_sku: 'W145', shopify_size: '14.5W', match: 'none', status: 'not_on_shein', blockers: [], excluded: false }],
      maps: [{ id: 1, category_id: 1002, attribute_id: ATTR, size_key: '14.5|W', custom_value: 'US14.5W', source: 'custom_created', set_by: 'Kim' }], fill: null, fillUnread: true });
    expect(r.body).toBe(null);
    expect(r.plan.blockers[0]).toMatchObject({ code: 'skc_field_uncopyable', params: { why: 'fill_unread' } });
    expect(renderBlocker(r.plan.blockers[0]).title).toMatch(/couldn’t read SHEIN’s listing rules/);
  });
  test('N2: the live walk never skips STOCK for a product with a listing edit in flight — only its seller-SKU edits', async () => {
    const { walkModeFor } = await import('../api/_lib/shein-live.js');
    for (const flight of ['sending', 'sent', 'in_review', 'deferred']) {
      expect(walkModeFor(flight, 'full')).toBe('stock');
      expect(walkModeFor(flight, 'stock')).toBe('stock');
      expect(walkModeFor(flight, 'dry')).toBe('dry');
    }
    expect(walkModeFor(undefined, 'full')).toBe('full');
  });
});


/* ------------------- Phase 3: Needs update → Synced (price · sizes on · SKUs · title) ------------------- */
// docs/shein-listings-plan.md §3 Phase 3 — a test per acceptance line.

test.describe('SHEIN Listings Phase 3 — the engine (pure)', () => {
  test('D4 drives “Needs update”: SHEIN’s price more than $0.50 off the target (market + 15 % up, else Shopify) — not 50 cents', () => {
    const base = { shopify: { variantId: 'v', sku: 'A7', size: '7', price: '160', qty: 1 }, match: 'sku', product: { shopifyStatus: 'ACTIVE', onShein: true }, skuCount: 1 };
    const shein = (b) => ({ sheinSku: 's', sellerSku: 'A7', size: 'US7', basePrice: b, mallState: 1 });
    expect(variantReadiness({ ...base, shein: shein(159.6), targetPrice: { price: 160, from: 'shopify' } }).status).toBe('synced');
    const off = variantReadiness({ ...base, shein: shein(159.4), targetPrice: { price: 160, from: 'shopify' } });
    expect(off.status).toBe('out_of_date');
    expect(off.diffs).toEqual([expect.objectContaining({ field: 'shein_price', from: '159.40', to: '160.00' })]);
    // market $130 + 15 % = 149.50 → $150 (always up) — the Shopify price isn't used when there is a market price
    expect(variantReadiness({ ...base, shein: shein(140), targetPrice: sheinNewSizePrice({ marketCents: 13000, shopifyPrice: '160' }) }).diffs[0]).toMatchObject({ to: '150.00', why: 'market + 15 %, rounded up' });
  });
  test('the price planner: compared with what the shopper PAYS; a live special is left alone (note) unless a person ends it; a rise carries riseReason; locks', async () => {
    const spu = JSON.parse(JSON.stringify(SHEIN.E2ESPU1));
    spu.skcInfoList[0].skuInfoList[0].priceInfoList[0].specialPrice = 150;   // E2E1-07: original $160, special $150 live
    const stored = [{ shopify_variant_id: gidV(770107), shein_sku: 'E2E1-07', match: 'sku', status: 'out_of_date', seller_sku: 'A7', shein_size: 'US7' },
      { shopify_variant_id: gidV(770110), shein_sku: 'E2E1-10', match: 'link', status: 'out_of_date', seller_sku: 'A10', shein_size: 'US10' }];
    const targets = new Map([[gidV(770107), { price: 170, from: 'shopify' }], [gidV(770110), { price: 170, from: 'market' }]]);
    const { body, plan } = planPrice({ spu, stored, targets });
    expect(body.productPriceList).toEqual([{ productCode: 'E2E1-10', currencyCode: 'USD', shopPrice: 170, site: 'shein-us', riseReason: '4' }]);
    expect(plan.skipped).toEqual([expect.objectContaining({ size: 'US7', blocker: expect.objectContaining({ code: 'special_live', params: { special: 150, base: 160, to: 170 } }) })]);
    expect(summarizePlan(plan)).toBe('Will change 1 price: US10 $160 → $170 (up: SHEIN may review it) · 1 size skipped: US7 (SHEIN special $150 is live (original $160) — the target is $170)');
    // the shopper pays $150 = a $150 target → in step, nothing to do (it used to read "200 → 150" for ever)
    expect(planPrice({ spu, stored: stored.slice(0, 1), targets: new Map([[gidV(770107), { price: 150.4, from: 'shopify' }]]) }).body).toBe(null);
    // a person chose to END the special: shopPrice = target with specialPrice LEFT OUT (that is what ends it)
    const ends = planPrice({ spu, stored: stored.slice(0, 1), targets, endSpecials: true });
    expect(ends.body.productPriceList).toEqual([{ productCode: 'E2E1-07', currencyCode: 'USD', shopPrice: 170, site: 'shein-us', riseReason: '4' }]);
    expect(summarizePlan(ends.plan)).toBe('Will change 1 price: US7 $150 → $170 (ends the $150 special: shoppers pay $170, SHEIN may review it)');
    // promotion lock: no RISE (a cut still goes); lock unread → no rise either; "warn only" → a note
    const cut = new Map([[gidV(770110), { price: 140, from: 'market' }], [gidV(770107), { price: 170, from: 'shopify' }]]);
    const spu2 = JSON.parse(JSON.stringify(SHEIN.E2ESPU1));
    const locked = planPrice({ spu: spu2, stored, targets: new Map([[gidV(770107), { price: 170, from: 'shopify' }], [gidV(770110), { price: 140, from: 'market' }]]), locks: new Map([['E2ESKC1', { price: true }]]) });
    expect(locked.body.productPriceList.map((x) => x.productCode)).toEqual(['E2E1-10']);
    expect(locked.plan.skipped[0].blocker.code).toBe('price_locked');
    expect(renderBlocker(locked.plan.skipped[0].blocker).title).toBe('In a SHEIN promotion: price can’t go up.');
    const unread = planPrice({ spu: spu2, stored, targets: cut, locksUnread: true });
    expect(unread.body.productPriceList.map((x) => x.productCode)).toEqual(['E2E1-10']);
    expect(unread.plan.skipped[0].blocker.code).toBe('price_lock_unread');
    const warn = planPrice({ spu: spu2, stored, targets: cut, locks: new Map([['E2ESKC1', { warn: true }]]) });
    expect(warn.plan.notes.map((n) => n.code)).toContain('price_lock_warn');
  });
  test('R1: ending a special that makes the shopper pay MORE is a rise — even below the original: locks, riseReason, the copy', () => {
    const spu = JSON.parse(JSON.stringify(SHEIN.E2ESPU1));
    Object.assign(spu.skcInfoList[0].skuInfoList[0].priceInfoList[0], { basePrice: 200, specialPrice: 150 });
    const stored = [{ shopify_variant_id: gidV(770107), shein_sku: 'E2E1-07', match: 'sku', status: 'out_of_date', seller_sku: 'A7', shein_size: 'US7' }];
    const targets = new Map([[gidV(770107), { price: 165, from: 'shopify' }]]);
    const free = planPrice({ spu, stored, targets, endSpecials: true });
    expect(free.body.productPriceList).toEqual([{ productCode: 'E2E1-07', currencyCode: 'USD', shopPrice: 165, site: 'shein-us', riseReason: '4' }]);
    expect(free.plan.prices[0]).toMatchObject({ rise: true, from: 150, base: 200, endsSpecial: 150 });
    expect(summarizePlan(free.plan)).toBe('Will change 1 price: US7 $150 → $165 (ends the $150 special: shoppers pay $165, SHEIN may review it)');
    expect(planPrice({ spu, stored, targets, endSpecials: true, locks: new Map([['E2ESKC1', { price: true }]]) }).plan.skipped[0].blocker.code).toBe('price_locked');
    expect(planPrice({ spu, stored, targets, endSpecials: true, locksUnread: true }).plan.skipped[0].blocker.code).toBe('price_lock_unread');
    // ending it to a LOWER shopper price (140 < 150) is a cut: no riseReason, goes under a lock
    const cut = planPrice({ spu, stored, targets: new Map([[gidV(770107), { price: 140, from: 'shopify' }]]), endSpecials: true, locks: new Map([['E2ESKC1', { price: true }]]) });
    expect(cut.body.productPriceList).toEqual([{ productCode: 'E2E1-07', currencyCode: 'USD', shopPrice: 140, site: 'shein-us' }]);
  });
  test('R2: a live special off the target is NOT Synced — Needs update with its own diff (shein_special) + the note; never picked by the auto re-sync', () => {
    const base = { shopify: { variantId: 'v', sku: 'A7', size: '7', price: '170', qty: 1 }, match: 'sku', product: { shopifyStatus: 'ACTIVE', onShein: true }, skuCount: 1 };
    const r = variantReadiness({ ...base, shein: { sheinSku: 's', sellerSku: 'A7', size: 'US7', basePrice: 200, specialPrice: 150, mallState: 1 }, targetPrice: { price: 170, from: 'market' } });
    expect(r.status).toBe('out_of_date');
    expect(r.diffs).toEqual([expect.objectContaining({ field: 'shein_special', from: '150.00', to: '170.00', special: '150.00', base: '200.00' })]);
    expect(r.diffs.some((d) => d.field === 'shein_price')).toBe(false);         // listingPriceOffProducts reads shein_price only
    expect(r.notes.map((n) => n.code)).toContain('special_live');
    expect(variantReadiness({ ...base, shein: { sheinSku: 's', sellerSku: 'A7', size: 'US7', basePrice: 200, specialPrice: 170, mallState: 1 }, targetPrice: { price: 170, from: 'market' } }).status).toBe('synced');
  });
  test('R3 + rounding: the automatic re-sync caps rises at 15 % a day too; capped prices are whole dollars rounded UP', () => {
    const spu = JSON.parse(JSON.stringify(SHEIN.E2ESPU1));
    const stored = [{ shopify_variant_id: gidV(770107), shein_sku: 'E2E1-07', match: 'sku', status: 'out_of_date', seller_sku: 'A7', shein_size: 'US7' }];
    const up = planPrice({ spu, stored, targets: new Map([[gidV(770107), { price: 300, from: 'market' }]]), auto: true });
    expect(up.body.productPriceList[0]).toMatchObject({ shopPrice: 184, riseReason: '4' });   // $160 + 15 % = $184
    expect(up.plan.prices[0].capped).toBe(true);
    Object.assign(spu.skcInfoList[0].skuInfoList[0].priceInfoList[0], { basePrice: 133.33 });
    const down = planPrice({ spu, stored, targets: new Map([[gidV(770107), { price: 50, from: 'market' }]]), auto: true, shopifyFloor: new Map([[gidV(770107), 80.2]]) });
    expect(down.body.productPriceList[0].shopPrice).toBe(114);                  // 133.33 − 15 % = 113.33 → $114 (up)
    const shop = planPrice({ spu, stored, targets: new Map([[gidV(770107), { price: 50, from: 'market' }]]), auto: true, shopifyFloor: new Map([[gidV(770107), 120.2]]) });
    expect(shop.body.productPriceList[0].shopPrice).toBe(121);                  // never below Shopify $120.20 → $121
    expect(planPrice({ spu, stored, targets: new Map([[gidV(770107), { price: 300, from: 'market' }]]) }).body.productPriceList[0].shopPrice).toBe(300);   // a person's dry run: no cap
  });
  test('D8a: the automatic re-sync cuts at most 15 % a day and never below the Shopify price; market targets only', () => {
    const spu = JSON.parse(JSON.stringify(SHEIN.E2ESPU1));
    const stored = [{ shopify_variant_id: gidV(770107), shein_sku: 'E2E1-07', match: 'sku', status: 'out_of_date', seller_sku: 'A7', shein_size: 'US7' }];
    const t = new Map([[gidV(770107), { price: 100, from: 'market' }]]);
    const a = planPrice({ spu, stored, targets: t, auto: true, shopifyFloor: new Map([[gidV(770107), 120]]) });
    expect(a.body.productPriceList[0].shopPrice).toBe(136);                     // $160 − 15 % = $136 (above Shopify $120)
    expect(a.plan.prices[0]).toMatchObject({ capped: true });
    expect(a.plan.notes.map((n) => n.code)).toContain('auto_capped');
    const b = planPrice({ spu, stored, targets: t, auto: true, shopifyFloor: new Map([[gidV(770107), 150]]) });
    expect(b.body.productPriceList[0].shopPrice).toBe(150);                     // never below the Shopify price
    expect(planPrice({ spu, stored, targets: t, auto: false }).body.productPriceList[0].shopPrice).toBe(100);   // a person's dry run: unchanged
    expect(sheinNewSizePrice({ shopifyPrice: '120', marketOnly: true })).toBe(null);
  });
  test('the idempotency key includes SHEIN’s state before the send: the same price later is a new send, the same intent twice is not', async () => {
    const { idemKey, sendState } = await import('../api/_lib/shein-listing.js');
    const plan = (base) => ({ prices: [{ skuCode: 'E2E1-07', site: 'shein-us', from: base, base, to: 149 }] });
    expect(idemKey('p', 'price', 'h', sendState('price', plan(160)))).toBe(idemKey('p', 'price', 'h', sendState('price', plan(160))));
    expect(idemKey('p', 'price', 'h', sendState('price', plan(160)))).not.toBe(idemKey('p', 'price', 'h', sendState('price', plan(155))));
    const e = (v) => ({ preVersion: v, mallOn: [{ skuCode: 'E2E1-07' }], relinks: [] });
    expect(idemKey('p', 'edit', 'h', sendState('edit', e('V1')))).not.toBe(idemKey('p', 'edit', 'h', sendState('edit', e('V2'))));
    expect(itemRetryable({ status: 'failed', blockers: [{ code: 'price_review_stuck' }] })).toBe(false);   // S4: never a resend
  });
  test('S8: a product re-check refusal like “brand unauthorized” is an Error, not a job stop', async () => {
    const { isFatal } = await import('../api/_lib/shein-listing.js');
    for (const m of ['Brand unauthorized', '品牌未授权', 'This brand is unauthorized for the store']) expect(isFatal({ httpStatus: 200, sheinCode: '20003', sheinMsg: m }), m).toBe(false);
    for (const m of ['Unauthorized request', 'unauthorised access']) expect(isFatal({ httpStatus: 200, sheinCode: '1', sheinMsg: m }), m).toBe(true);
    expect(isFatal({ httpStatus: 401 })).toBe(true);
  });
  test('tiles: a product counts under every status one of its counted sizes has; the roll-up chip is unchanged', () => {
    const v = [{ status: 'blocked', qty: 1, shopifyVariantId: 'a' }, { status: 'out_of_date', qty: 2, shopifyVariantId: 'b' }, { status: 'synced', qty: 0, shopifyVariantId: 'c' }];
    expect(productReadiness({}, v)).toMatchObject({ status: 'blocked', sizeStatuses: ['blocked', 'out_of_date'] });   // a zero-stock size doesn't count
    expect(productReadiness({ excluded: true }, v).sizeStatuses).toEqual([]);
  });
  test('the edit planner: title ONLY on a product we published (synced_hash) — never a 4seller one; reference link / unread rules block', () => {
    const product = { ...SHOPIFY().find((p) => p.productId === gidP(7704)), title: 'Jordan 1 GS Retro (GS0001-001)' };
    // S6: the WHOLE multi-language list goes (object[] = replaced whole), the default language replaced
    const names = [{ language: 'en', name: 'Jordan 1 GS (GS0001-001)' }, { language: 'fr', name: 'Jordan 1 GS (FR)' }];
    const ours = planEdit({ spu: SHEIN.E2ESPU3, product, stored: [], productRow: { synced_hash: 'x' }, fill: { fill_in_standard_list: [], default_language: 'en' }, names });
    expect(ours.body).toEqual({ spu_name: 'E2ESPU3', multi_language_name_list: [{ language: 'en', name: 'Jordan 1 GS Retro (GS0001-001)' }, { language: 'fr', name: 'Jordan 1 GS (FR)' }] });
    // without every language read, no title is sent (never drop a language)
    expect(planEdit({ spu: SHEIN.E2ESPU3, product, stored: [], productRow: { synced_hash: 'x' }, fill: { fill_in_standard_list: [] } }).body).toBe(null);
    // cut at a word boundary to SHEIN's limit
    const long = planEdit({ spu: SHEIN.E2ESPU3, product: { ...product, title: 'Jordan 1 GS Retro High OG Chicago Lost and Found' }, stored: [], productRow: { synced_hash: 'x' }, names,
      fill: { fill_in_standard_list: [], default_language: 'en', default_language_title_max_length: 30 } });
    expect(long.plan.title).toMatchObject({ to: 'Jordan 1 GS Retro High OG', cut: true });
    // S7: SHEIN's CURRENT title over today's limit (a 4seller one) fails every edit → blocked early
    const tooLong = planEdit({ spu: SHEIN.E2ESPU3, product, stored: [], productRow: null, fill: { fill_in_standard_list: [], default_language_title_max_length: 10 } });
    expect(tooLong.plan.blockers[0]).toMatchObject({ code: 'shein_title_too_long', params: { length: 'Jordan 1 GS (GS0001-001)'.length, max: 10 } });
    const theirs = planEdit({ spu: SHEIN.E2ESPU3, product, stored: [], productRow: { synced_hash: null }, fill: { fill_in_standard_list: [] } });
    expect(theirs.body).toBe(null);
    expect(theirs.plan.notes.map((n) => n.code)).toEqual(['title_not_ours', 'nothing_to_edit']);
    expect(planEdit({ spu: SHEIN.E2ESPU3, product, productRow: { synced_hash: 'x' }, fillUnread: true }).plan.blockers[0]).toMatchObject({ code: 'skc_field_uncopyable', params: { why: 'fill_unread' } });
  });
});

// Shopify after the listings went up: Air Max 7 now $149 (+ a new title — a 4seller product), Women's 7 $130 (a rise
// under a promotion lock) and 8 $110 (below SHEIN's special $115), Toddler 4C $70 (a rise; SHEIN has a $55
// special), the GS — a product WE published — has a new title.
const P3 = () => {
  const list = SHOPIFY(); const p = (n) => list.find((x) => x.productId === gidP(n)); const v = (n, sku) => p(n).variants.find((x) => x.sku === sku);
  v(7701, 'A7').price = '149.00'; p(7701).title = 'Nike Air Max 95 OG (IB7936-100)';
  v(7702, 'W7').price = '130.00'; v(7702, 'W8').price = '110.00';
  v(7703, 'T4').price = '70.00';
  p(7704).title = 'Jordan 1 GS Retro (GS0001-001)';
  return list;
};
test.describe.serial('SHEIN Listings Phase 3 — dry run, run, review (server jobs vs the fake SHEIN)', () => {
  let L; let D; let auth; let previewId; let runId; let savedAuto;
  const stocked = [];
  const items = async (jobId) => (await D.listListingJobItems(jobId, { limit: 1000 })).map((i) => ({ ...i, n: Number(i.shopify_product_id.split('/').pop()) }));
  const one = async (jobId, n, op) => (await items(jobId)).find((i) => i.n === n && i.op === op);
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const variant = async (n) => (await pool.query(`SELECT * FROM shein_listing_variants WHERE row_key = $1`, [gidV(n)])).rows[0];
  let shelf = new Set();
  const io = () => ({ ...p2IO(L.IO, { shopify: P3, stock: stocked }), recentShelf: async () => shelf });

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    const { signToken } = await import('../api/_lib/util.js');
    auth = { ph: { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` },
      admin: { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` } };
    savedAuto = (await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_listing_auto_price'`)).rows[0] || null;
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_listing_auto_price'`);
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e-p%' OR started_by = $1`, [L.AUTO_PRICE_BY]);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_size_map WHERE category_id IN (1001, 1002, 1003, 1004)`);
    fake.p2 = P2();
    fake.p2.mall['E2E1-07'] = 2;                  // Air Max US7 stopped on SHEIN while Shopify sells it
    fake.p2.special['E2E2-08'] = 115;             // Women's US8W: SHEIN special $115
    fake.p2.docs.E2ESPU3 = { state: 2 };          // the GS shoe's earlier review closed
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p3', io: { ...testIO(L.IO, { shopify: P3 }) } });
    jobsMade.add(snap.id);
    await finished(snap.id);
    await pool.query(`UPDATE shein_listing_products SET synced_hash = 'published-by-us' WHERE shopify_product_id = $1`, [gidP(7704)]);   // WE published the GS shoe
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });
  test.afterAll(async () => {
    fake.p2 = null;
    if (!pool) return;
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_listing_auto_price'`);
    if (savedAuto) await pool.query(`INSERT INTO app_settings (key, value) VALUES ('shein_listing_auto_price', $1)`, [savedAuto.value]);
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by = $1`, [L?.AUTO_PRICE_BY || 'auto (price re-sync)']);
    for (const r of rows) jobsMade.add(r.id);
  });

  test('after the read: SHEIN’s price off the D4 target → Needs update with the diff; in step → Synced', async () => {
    const a7 = await variant(770107);
    expect(a7.status).toBe('out_of_date');
    expect(a7.diffs).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'shein_price', from: '160.00', to: '149.00' }), expect.objectContaining({ field: 'mall_state' })]));
    expect((await variant(770404)).diffs).toEqual([]);                          // GS 4Y: $110 = $110
  });

  test('the dry run (ops price + edit): price/save bodies and ONE partialEdit per product — zero writes', async ({ request }) => {
    fake.writes.length = 0; fake.p2.priceCalls.length = 0;
    const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p3', scope: { productIds: [7701, 7702, 7703, 7704].map(gidP), ops: ['price', 'edit'] }, io: io() });
    jobsMade.add(j.id);
    const job = await finished(j.id);
    previewId = job.id;
    expect(job).toMatchObject({ status: 'awaiting_confirm', counts: expect.objectContaining({ products: 8, sendable: 4, prices: 2, price_rises: 1, sizes_on: 1, relinks: 1, titles: 1, shein_writes: 0 }) });
    const p71 = await one(job.id, 7701, 'price');
    expect(p71.body).toEqual({ productPriceList: [{ productCode: 'E2E1-07', currencyCode: 'USD', shopPrice: 149, site: 'shein-us' }] });
    expect(summarizePlan(p71.plan)).toBe('Will change 1 price: US7 $160 → $149');
    const e71 = await one(job.id, 7701, 'edit');
    expect(e71.body).toEqual({ spu_name: 'E2ESPU1', skc_list: [{ skc_name: 'E2ESKC1', sku_list: [{ sku_code: 'E2E1-07', mall_state: 1 }, { sku_code: 'E2E1-10', supplier_sku: 'A10' }] }] });
    expect(e71.plan.notes.map((n) => n.code)).toContain('title_not_ours');      // a 4seller product: never its title (D11)
    expect(summarizePlan(e71.plan)).toBe('Will turn 1 size back on: US7 · change 1 SKU SHEIN has wrong: OLD10 → A10');
    const p73 = await one(job.id, 7703, 'price');
    expect(p73.body.productPriceList).toEqual([{ productCode: 'E2E4-4C', currencyCode: 'USD', shopPrice: 70, site: 'shein-us', riseReason: '4' }]);
    // Women's 8W: SHEIN's $115 special is live and the target is $110 — left alone (sending would END the special)
    expect((await one(job.id, 7702, 'price')).plan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ size: 'US8W', blocker: expect.objectContaining({ code: 'special_live' }) })]));
    const p72 = await one(job.id, 7702, 'price');
    expect(p72).toMatchObject({ status: 'skipped', body: null });
    expect(p72.plan.skipped.map((x) => [x.size, x.blocker.code])).toEqual([['US7W', 'price_locked'], ['US8W', 'special_live']]);
    const e74 = await one(job.id, 7704, 'edit');
    expect(e74.body).toEqual({ spu_name: 'E2ESPU3', multi_language_name_list: [{ language: 'en', name: 'Jordan 1 GS Retro (GS0001-001)' }] });
    expect(fake.writes).toEqual([]); expect(fake.p2.priceCalls).toEqual([]); expect(fake.p2.edits).toEqual([]);
    const { rows: log } = await pool.query(`SELECT DISTINCT path, write FROM shein_api_log WHERE job_id = $1`, [job.id]);
    expect(log.filter((l) => l.write)).toEqual([]);
    // the endpoint: ops are checked; mixing add sizes with an edit is refused
    const bad = await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'preview', productIds: [gidP(7701)], ops: ['add_sku', 'edit'] } });
    expect(bad.status()).toBe(400);
  });

  test('the run: prices via price/save only (never publishOrEdit); a cut is done at once, a rise goes to SHEIN’s price review; edits go in review', async () => {
    const job = await L.startRunJob({ previewJobId: previewId, by: 'e2e-p3', io: io() });
    jobsMade.add(job.id); runId = job.id;
    await finished(job.id);
    expect(fake.calls.some((c) => c.path === '/open-api/goods/product/publishOrEdit')).toBe(false);
    expect(fake.p2.priceCalls).toHaveLength(2);
    expect(await one(runId, 7701, 'price')).toMatchObject({ status: 'done', sku_codes: [expect.objectContaining({ skuCode: 'E2E1-07', status: 1, to: 149 })] });
    expect(await one(runId, 7703, 'price')).toMatchObject({ status: 'in_review', sku_codes: [expect.objectContaining({ skuCode: 'E2E4-4C', status: 2, to: 70 })] });
    expect((await variant(770304)).status).toBe('in_review');
    expect((await D.listingInflightSpus()).has('E2ESPU4')).toBe(false);         // S10: a price review never holds the walk's seller-SKU edits
    expect((await variant(770107)).shein_price).toBe('149.00');                 // read back from SHEIN after the cut
    expect(await one(runId, 7701, 'edit')).toMatchObject({ status: 'in_review', version: expect.stringMatching(/^E2EV/) });
    { const x = await one(runId, 7704, 'edit'); expect(x, x.error).toMatchObject({ status: 'in_review' }); }
    expect(fake.p2.edits.map((e) => e.body.spu_name).sort()).toEqual(['E2ESPU1', 'E2ESPU3']);
  });

  test('a rise stays In review until SHEIN’s price-audit answer (webhook); then Synced', async () => {
    const W = await import('../api/shein/webhook.js');
    expect(W.isPriceAuditEvent({ spu_name: 'E2ESPU4', sku_code: 'E2E4-4C', audit_state: 1, site: 'shein-us' }, '')).toBe(true);
    expect(W.isProductReviewEvent({ spu_name: 'E2ESPU4', sku_code: 'E2E4-4C', audit_state: 1 }, 'product_price_audit_status_notice')).toBe(false);
    await L.listingFollowUp({ io: io(), force: true });
    expect((await one(runId, 7703, 'price')).status).toBe('in_review');          // SHEIN still shows $60
    fake.p2.prices['E2E4-4C'] = 70;                                             // SHEIN approves the rise…
    // S2: doc 3000912 has 1 = passed, 2 = rejected — anything else is ignored, never read as a rejection
    expect(await L.listingPriceAuditEvent({ spu_name: 'E2ESPU4', sku_code: 'E2E4-4C', audit_state: 3, site: 'shein-us' }, { io: io() })).toMatchObject({ handled: 0 });
    expect((await one(runId, 7703, 'price')).status).toBe('in_review');
    const r = await L.listingPriceAuditEvent({ spu_name: 'E2ESPU4', skc_name: 'E2ESKC4', sku_code: 'E2E4-4C', audit_state: 1, site: 'shein-us', currency: 'USD' }, { io: io() });
    expect(r.handled).toBe(1);
    expect(await one(runId, 7703, 'price')).toMatchObject({ status: 'done', sku_codes: [expect.objectContaining({ status: 1 })] });
    expect(await variant(770304)).toMatchObject({ status: 'synced', shein_price: '70.00', diffs: [] });
  });

  test('SHEIN approves the edits: the stopped size is on sale again, the relink shows, OUR product has its new title — all Synced', async () => {
    approveOnFake('E2ESPU1'); approveOnFake('E2ESPU3');
    stocked.length = 0;
    await L.listingFollowUp({ io: io(), force: true });
    expect(stocked).toEqual(['E2ESPU1']);                                        // S5: the size back on sale gets its stock (a stopped SKU kept none); the title-only edit doesn't
    expect((await one(runId, 7701, 'edit')).status).toBe('done');
    expect((await one(runId, 7704, 'edit')).status).toBe('done');
    expect(await variant(770107)).toMatchObject({ status: 'synced', shein_mall_state: 1, shein_price: '149.00' });
    expect(await variant(770110)).toMatchObject({ status: 'synced', shein_seller_sku: 'A10' });
    expect(fake.p2.title.E2ESPU3[0].productName).toBe('Jordan 1 GS Retro (GS0001-001)');
    expect(fake.p2.title.E2ESPU1).toBeUndefined();                              // the 4seller product's title was never touched
  });

  test('the 20-minute shelf rule: a size isn’t turned back on within 20 min of a shelf change on that shoe', async () => {
    fake.p2.mall['E2E1-07'] = 2; shelf = new Set(['E2ESKC1']);
    const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p3', scope: { productIds: [gidP(7701)], ops: ['edit'] }, io: io() });
    jobsMade.add(j.id);
    await finished(j.id);
    const e = await one(j.id, 7701, 'edit');
    expect(e).toMatchObject({ status: 'skipped', body: null });
    expect(e.plan.skipped[0].blocker.code).toBe('shelf_wait');
    shelf = new Set(); fake.p2.mall['E2E1-07'] = 1;
  });

  test('D8 “auto re-sync price”: OFF by default (nothing happens); only an admin / Connect integrations turns it on; ON it runs the SAME dry run → run', async ({ request }) => {
    expect(await L.readAutoPrice()).toMatchObject({ on: false });
    expect(await L.autoPriceTick({ io: io() })).toEqual({ why: 'off' });
    expect((await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'auto_price', on: true } })).status()).toBe(403);
    const on = await request.post('/api/shein/listings', { headers: auth.admin, data: { action: 'auto_price', on: true } });
    expect(await on.json()).toMatchObject({ ok: true, autoPrice: { on: true, by: 'Alex' } });
    expect((await (await request.get('/api/shein/listings', { headers: auth.ph })).json()).summary.autoPrice).toMatchObject({ on: true });
    // D8a: the automatic re-sync uses MARKET targets only. Women's 8W without a market price: nothing.
    fake.p2.special['E2E2-08'] = 0;                                              // the special ended: SHEIN $120, Shopify $110
    expect(await L.autoPriceTick({ io: io() })).toEqual({ why: 'no price is off' });
    // with a market price ($95.65 + 15 % → $110), read again: Needs update from the MARKET
    const market = new Map([['DD1503-101|8W', 9565]]);
    const ioM = () => ({ ...p2IO(L.IO, { shopify: P3, stock: stocked, market }), recentShelf: async () => shelf });
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p3', io: ioM() }); jobsMade.add(snap.id); await finished(snap.id);
    expect((await variant(770208)).diffs).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'shein_price', source: 'market', to: '110.00' })]));
    const calls = fake.p2.priceCalls.length;
    const first = await L.autoPriceTick({ io: ioM() });
    expect(first.previewed).toBeTruthy();                                        // a DRY RUN first — nothing sent
    const pv = await finished(first.previewed);
    expect(pv).toMatchObject({ kind: 'preview', status: 'awaiting_confirm', started_by: L.AUTO_PRICE_BY, scope: expect.objectContaining({ ops: ['price'] }) });
    expect(fake.p2.priceCalls.length).toBe(calls);
    const second = await L.autoPriceTick({ io: ioM() });
    const run = await finished(second.ran);
    expect(run).toMatchObject({ kind: 'run', preview_job_id: pv.id, started_by: L.AUTO_PRICE_BY });
    expect(fake.p2.priceCalls.at(-1).productPriceList).toEqual([{ productCode: 'E2E2-08', currencyCode: 'USD', shopPrice: 110, site: 'shein-us' }]);
    expect(await L.autoPriceTick({ io: ioM() })).toEqual({ why: 'already ran today' });
    await request.post('/api/shein/listings', { headers: auth.admin, data: { action: 'auto_price', on: false } });
    expect(await L.autoPriceTick({ io: io() })).toEqual({ why: 'off' });
  });

  test('P1: the same price again LATER (SHEIN’s price moved meanwhile) is a new send — not “already sent” for ever; price goes before edit', async () => {
    fake.p2.prices['E2E1-07'] = 160;                                            // SHEIN's US7 went back up to $160 (the cut to $149 was done earlier)
    const before = fake.p2.priceCalls.length;
    const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p3', scope: { productIds: [gidP(7701)], ops: ['edit', 'price'] }, io: io() });
    jobsMade.add(j.id);
    await finished(j.id);
    const its = await items(j.id);
    expect(its.filter((i) => i.n === 7701).sort((a, b) => a.seq - b.seq).map((i) => i.op)).toEqual(['price', 'edit']);   // S11
    const pv = its.find((i) => i.op === 'price');
    expect(pv.body).toEqual({ productPriceList: [{ productCode: 'E2E1-07', currencyCode: 'USD', shopPrice: 149, site: 'shein-us' }] });   // byte-identical to the first cut
    const run = await L.startRunJob({ previewJobId: j.id, by: 'e2e-p3', io: io() });
    jobsMade.add(run.id);
    await finished(run.id);
    { const x = await one(run.id, 7701, 'price'); expect(x, x.error).toMatchObject({ status: 'done' }); }
    expect(fake.p2.priceCalls.length).toBe(before + 1);
  });

  test('P4 + S4: a RISE whose answer was lost is never sent again — it waits In review; after 7 days it is an Error that can’t be retried', async () => {
    const P3b = () => { const l = P3(); l.find((x) => x.productId === gidP(7704)).variants.find((v) => v.sku === 'Y5').price = '130.00'; return l; };
    const ioB = () => ({ ...p2IO(L.IO, { shopify: P3b, stock: stocked }), recentShelf: async () => shelf });
    const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p3', scope: { productIds: [gidP(7704)], ops: ['price'] }, io: ioB() });
    jobsMade.add(j.id); await finished(j.id);
    expect((await one(j.id, 7704, 'price')).body.productPriceList).toEqual([{ productCode: 'E2E3-5Y', currencyCode: 'USD', shopPrice: 130, site: 'shein-us', riseReason: '4' }]);
    fake.p2.losePriceAnswer = 1;                                                // SHEIN takes it (the rise is in its review) — the answer is lost
    const before = fake.p2.priceCalls.length;
    const run = await L.startRunJob({ previewJobId: j.id, by: 'e2e-p3', io: ioB() });
    jobsMade.add(run.id); await finished(run.id);
    let it = await one(run.id, 7704, 'price');
    expect(it).toMatchObject({ status: 'deferred' });
    expect(it.idem_key).toBeTruthy();
    await pool.query(`UPDATE shein_listing_job_items SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [it.id]);
    await L.listingFollowUp({ io: ioB() });
    await finished(run.id);
    it = await one(run.id, 7704, 'price');
    expect(it).toMatchObject({ status: 'in_review', sku_codes: [expect.objectContaining({ skuCode: 'E2E3-5Y', status: 2 })], error: expect.stringMatching(/not sent again/) });
    expect(fake.p2.priceCalls.length).toBe(before + 1);                         // never resent
    await pool.query(`UPDATE shein_listing_job_items SET sent_at = now() - interval '8 days' WHERE id = $1`, [it.id]);
    await L.listingFollowUp({ io: ioB(), force: true });
    it = await one(run.id, 7704, 'price');
    expect(it).toMatchObject({ status: 'failed', blockers: [expect.objectContaining({ code: 'price_review_stuck' })] });
    expect(itemRetryable(it)).toBe(false);
    delete fake.p2.priceReview['E2E3-5Y'];
  });

  test('the fake plays price/save like SHEIN: leaving out the special price ENDS it (no error); a 2nd price while a rise is in review is refused', async () => {
    fake.p2.special['E2E4-5C'] = 0; fake.p2.special['E2E2-07'] = 99;
    const info = await L.IO.sheinPriceSave({ productPriceList: [{ productCode: 'E2E2-07', currencyCode: 'USD', shopPrice: 110, site: 'shein-us' }] }, { source: 'e2e', by: 'e2e-p3' });
    expect(info.data[0]).toMatchObject({ success: true, status: 1 });
    expect(fake.p2.endedSpecials).toContain('E2E2-07');                        // what a missing specialPrice really does
    fake.p2.priceReview['E2E1-08'] = 170;
    const again = await L.IO.sheinPriceSave({ productPriceList: [{ productCode: 'E2E1-08', currencyCode: 'USD', shopPrice: 175, site: 'shein-us', riseReason: '4' }] }, { source: 'e2e', by: 'e2e-p3' });
    expect(again.data[0]).toMatchObject({ success: false, status: 0, message: expect.stringMatching(/still in review/) });
    delete fake.p2.priceReview['E2E1-08'];
  });
});

/* ------------------- Phase 3 — the page (Needs update → Synced) ------------------- */

test.describe.serial('SHEIN Listings Phase 3 — the page (diffs, Update prices & sizes, auto re-sync price)', () => {
  test.use({ timezoneId: 'Asia/Manila' });
  let L; let D; let savedAuto;
  const posted = [];
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const io = () => ({ ...p2IO(L.IO, { shopify: P3 }), recentShelf: async () => new Set() });
  const shot = async (page, name) => { if (process.env.SHL_SHOTS) await page.screenshot({ path: `${process.env.SHL_SHOTS}/shein-listings-${name}.png`, fullPage: false }); };
  // POST preview / run → answered here, in-process, against the fake SHEIN; auto_price goes to the server.
  async function routeWrites(page) {
    await page.route((u) => u.pathname === '/api/shein/listings', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      const b = req.postDataJSON() || {};
      posted.push(b);
      const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      try {
        if (b.action === 'preview') {
          const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p3ui', scope: { productIds: b.productIds, ...(b.ops ? { ops: b.ops } : {}) }, io: io() });
          jobsMade.add(j.id); await finished(j.id);
          return json(200, { ok: true, job: j });
        }
        if (b.action === 'run') {
          const j = await L.startRunJob({ previewJobId: b.previewJobId, by: 'e2e-p3ui', io: io() });
          jobsMade.add(j.id); await finished(j.id);
          return json(200, { ok: true, job: j });
        }
      } catch (e) { return json(e.status || 500, { ok: false, error: e.message }); }
      return route.continue();
    });
  }
  const sheet = (page) => page.getByRole('dialog', { name: 'Dry run and send' });
  const item = (page, n, op) => sheet(page).locator(`.shl-ditem[data-product="${gidP(n)}"][data-op="${op}"]`);
  async function updateDryRun(page, ids, path = '/ph/shein-listings') {
    await page.goto(path);
    for (const n of ids) await page.locator(`.shl-product[data-product="${gidP(n)}"] .shl-chk input`).check();
    await page.locator('.shl-bar').getByRole('button', { name: /^Update prices & sizes/ }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
  }
  const noSideScroll = async (page, where) => {
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth,
      sheet: document.querySelector('.shl-drawer')?.scrollWidth || 0, sheetW: document.querySelector('.shl-drawer')?.clientWidth || 0 }));
    expect(Math.max(w.doc, w.body), where).toBeLessThanOrEqual(w.vw);
    expect(w.sheet, `${where} (inside the sheet / drawer)`).toBeLessThanOrEqual(w.sheetW);
  };

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    savedAuto = (await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_listing_auto_price'`)).rows[0] || null;
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_listing_auto_price'`);
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e-p%' OR started_by = $1`, [L.AUTO_PRICE_BY]);
    await pool.query(`DELETE FROM shein_listing_job_items WHERE job_id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_size_map WHERE category_id IN (1001, 1002, 1003, 1004)`);
    fake.p2 = P2();
    fake.p2.mall['E2E1-07'] = 2;                  // Air Max US7 turned off on SHEIN while Shopify sells it
    fake.p2.special['E2E2-08'] = 115;             // Women's US8W: special $115 ≥ the new $110 → skipped
    fake.p2.docs.E2ESPU3 = { state: 2 };
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p3ui', io: testIO(L.IO, { shopify: P3 }) });
    jobsMade.add(snap.id);
    await finished(snap.id);
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });
  test.afterAll(async () => {
    fake.p2 = null;
    if (!pool) return;
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_listing_auto_price'`);
    if (savedAuto) await pool.query(`INSERT INTO app_settings (key, value) VALUES ('shein_listing_auto_price', $1)`, [savedAuto.value]);
  });

  test('PH: a Needs update size says what changes — SHEIN $160 → $149, turned off → back on, the wrong SKU; ↑ rises flagged; the drawer shows “was …”; auto re-sync is read-only', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    // 2026-10-27 decision: the Needs update tile lists every product with a Needs-update size, even one
    // whose worst size is Blocked (its roll-up chip stays Blocked)
    await page.goto('/ph/shein-listings?status=out_of_date');
    const air = page.locator(`.shl-product[data-product="${gidP(7701)}"]`);
    await expect(air).toBeVisible();
    await expect(air.locator('.shl-rollup .ebo-chip').first()).toHaveText('Blocked');
    await page.goto('/ph/shein-listings');
    await expect(air.locator('[data-needs-update]')).toContainText('need an update');
    await air.locator('.shl-caret').click();
    const a7 = air.locator(`tr[data-row="${gidV(770107)}"]`);
    await expect(a7).toContainText('SHEIN $160 → $149');
    await expect(a7).toContainText('Turned off on SHEIN — will turn back on');
    await expect(a7.getByRole('button', { name: 'Dry run the update' })).toBeEnabled();
    await expect(air.locator(`tr[data-row="${gidV(770110)}"]`)).toContainText('SHEIN has the wrong SKU: OLD10 → will change to A10');
    const tod = page.locator(`.shl-product[data-product="${gidP(7703)}"]`);
    await tod.locator('.shl-caret').click();
    await expect(tod.locator(`tr[data-row="${gidV(770304)}"]`)).toContainText('SHEIN $60 → $70 ↑ SHEIN may review it');
    // D8: PH sees the state, can't change it
    const auto = page.locator('.shl-auto');
    await expect(auto).toHaveAttribute('data-auto', 'off');
    await expect(auto).toContainText('Auto re-sync price: Off');
    await expect(auto).toContainText('An admin (or the Connect integrations privilege) can change this.');
    await expect(auto.getByRole('button')).toHaveCount(0);
    await shot(page, 'desktop-update-row');
    // the drawer: "was …" next to what it will be; the two dry runs, named apart
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7701))}`);
    const drawer = page.getByRole('dialog', { name: 'Product details' });
    const r7 = drawer.locator('.shl-plan tr', { hasText: 'US7' }).first();
    await expect(r7).toContainText('was $160 → $149');
    await expect(r7).toContainText('was turned off → back on');
    await expect(drawer.locator('.shl-plan tr', { hasText: 'OLD10' })).toContainText('was OLD10 → will change to A10');
    await expect(drawer.getByRole('button', { name: 'Update prices & sizes' })).toBeEnabled();
    await expect(drawer.getByRole('button', { name: 'Add missing sizes' })).toBeVisible();
    await shot(page, 'desktop-update-drawer');
  });

  test('PH: “Update prices & sizes” opens a dry run with the price lines — SHEIN now → will be, the rise flagged, where the price came from, skipped with the reason; Confirm needs the privilege', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await routeWrites(page);
    fake.writes.length = 0; fake.p2.priceCalls.length = 0;
    await updateDryRun(page, [7701, 7702, 7703]);
    expect(posted.at(-1)).toMatchObject({ action: 'preview', ops: ['price', 'edit'] });
    const s = sheet(page);
    await expect(s.locator('.shl-sheet-head')).toContainText('Update prices & sizes — what WOULD be sent');
    await expect(s.locator('[data-proof]')).toContainText('0 SHEIN writes');
    const stat = (t) => s.locator('[data-stats="update"] .er-stat', { hasText: t });
    await expect(stat('products checked')).toContainText('3');
    await expect(stat('products to update')).toContainText('2');
    await expect(stat('prices to change')).toContainText('2');
    await expect(stat('price rises')).toContainText('1');
    await expect(stat('sizes turned back on')).toContainText('1');
    await expect(stat('SKUs SHEIN has wrong')).toContainText('1');
    // the rise: flagged, where the price came from, the special price kept
    const p73 = item(page, 7703, 'price');
    await expect(p73).toContainText('Prices');
    await expect(p73).toContainText('Will change 1 price: US4C $60 → $70 (up: SHEIN may review it)');
    await p73.getByRole('button', { name: /What is sent/ }).click();
    const row = p73.locator('[data-plan="price"] tr', { hasText: 'US4C' });
    await expect(row).toContainText('$60');
    await expect(row).toContainText('↑ up — SHEIN may review it');
    await expect(row).toContainText('Shopify price (no recent market price)');
    // the cut + the edit of the same shoe, side by side
    const p71 = item(page, 7701, 'price');
    await p71.getByRole('button', { name: /What is sent/ }).click();
    await expect(p71.locator('[data-plan="price"] tr', { hasText: 'US7' })).toContainText('↓ down — applies at once');
    const e71 = item(page, 7701, 'edit');
    await expect(e71).toContainText('Sizes & SKUs');
    await e71.getByRole('button', { name: /What is sent/ }).click();
    await expect(e71.locator('[data-plan="mall"]')).toContainText('US7: turned off on SHEIN → will turn back on');
    await expect(e71).toContainText('SHEIN has the wrong SKU: OLD10 → will change to A10');
    await expect(e71).toContainText('4seller listed this product');
    // skipped sizes say why
    const p72 = item(page, 7702, 'price');
    await expect(p72.locator('.ebo-chip')).toHaveText('Nothing to send');
    await p72.getByRole('button', { name: /What is sent/ }).click();
    await expect(p72).toContainText('US7W — In a SHEIN promotion: price can’t go up.');
    await expect(p72).toContainText('SHEIN special $115 is live (original $120) — the target is $110.');
    const confirm = s.getByRole('button', { name: 'Update 2 products' });
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute('title', /Needs an admin/);
    expect(fake.writes).toEqual([]); expect(fake.p2.priceCalls).toEqual([]);
    await shot(page, 'desktop-update-dryrun');
    await s.getByRole('button', { name: 'Not now' }).click();
    await page.getByRole('tab', { name: /Jobs/ }).click();
    await expect(page.locator('.shl-rtable tr', { hasText: 'e2e-p3ui' }).filter({ hasText: 'Dry run · update prices & sizes' }).first()).toContainText('Waiting for you');
  });

  test('390 px: the Needs update rows, the update dry run and the drawer — no horizontal scroll', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await routeWrites(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/ph/shein-listings');
    await page.locator(`.shl-product[data-product="${gidP(7701)}"] .shl-caret`).click();
    await expect(page.locator(`tr[data-row="${gidV(770107)}"]`)).toContainText('SHEIN $160 → $149');
    await page.locator(`.shl-product[data-product="${gidP(7701)}"] .shl-chk input`).check();
    await noSideScroll(page, 'rows');
    await shot(page, 'phone-update-row');
    await page.locator('.shl-bar').getByRole('button', { name: /^Update prices & sizes/ }).click();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
    for (const op of ['price', 'edit']) await item(page, 7701, op).getByRole('button', { name: /What is sent/ }).click();
    await noSideScroll(page, 'update dry run');
    await expect(sheet(page).getByRole('button', { name: 'Update 1 product' })).toBeDisabled();
    await shot(page, 'phone-update-dryrun');
    await sheet(page).getByRole('button', { name: 'Not now' }).click();
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7701))}`);
    await expect(page.getByRole('dialog', { name: 'Product details' }).locator('.shl-plan')).toContainText('was $160');
    await noSideScroll(page, 'drawer');
    await shot(page, 'phone-update-drawer');
  });

  test('admin: auto re-sync price round trip (confirm says what it does, who/when shows); Update → the job card: a cut Approved, a rise In review per size', async ({ page }) => {
    await loginAs(page, 'admin');
    await routeWrites(page);
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto('/shein-listings');
    const auto = page.locator('.shl-auto');
    await expect(auto).toContainText('never turned on');
    await auto.getByRole('button', { name: 'Turn on…' }).click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Turn on auto re-sync price?' });
    await expect(dlg).toContainText('Once a day (EST)');
    await expect(dlg).toContainText('dry run');
    await page.waitForTimeout(300);                                          // the modal's fade-in, for the screenshot
    await shot(page, 'desktop-update-autoprice');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(auto).toHaveAttribute('data-auto', 'off');                  // Cancel changes nothing
    expect((await pool.query(`SELECT 1 FROM app_settings WHERE key = 'shein_listing_auto_price'`)).rowCount).toBe(0);
    await auto.getByRole('button', { name: 'Turn on…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn on auto re-sync' }).click();
    await expect(auto).toHaveAttribute('data-auto', 'on');
    await expect(auto).toContainText('turned on by Alex');
    await expect(auto).toContainText('EST');
    expect(JSON.parse((await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_listing_auto_price'`)).rows[0].value)).toMatchObject({ on: true, by: 'Alex' });
    await auto.getByRole('button', { name: 'Turn off' }).click();
    await expect(auto).toHaveAttribute('data-auto', 'off');
    await expect(auto).toContainText('turned off by Alex');
    expect(JSON.parse((await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_listing_auto_price'`)).rows[0].value)).toMatchObject({ on: false });
    // confirm an update → the job card
    await updateDryRun(page, [7701, 7703], '/shein-listings');
    await sheet(page).getByRole('button', { name: 'Update 2 products' }).click();
    await expect(sheet(page).locator('.shl-pname')).toContainText('Send to SHEIN #', { timeout: 20_000 });
    await expect(sheet(page).locator('.shl-sheet-head')).toContainText('Updating prices, sizes turned off and wrong SKUs on SHEIN');
    const p71 = item(page, 7701, 'price');
    await expect(p71.locator('.shl-ditem-head .ebo-chip')).toHaveText('Done');
    await expect(p71).toContainText('Done — SHEIN shows the new price.');
    await p71.getByRole('button', { name: /What is sent/ }).click();
    await expect(p71.locator('[data-plan="price"] tr', { hasText: 'US7' })).toContainText('Approved');
    const p73 = item(page, 7703, 'price');
    await expect(p73.locator('.shl-ditem-head .ebo-chip')).toHaveText('In review');
    await expect(p73).toContainText('waits for SHEIN’s price review');
    await p73.getByRole('button', { name: /What is sent/ }).click();
    await expect(p73.locator('[data-plan="price"] tr', { hasText: 'US4C' })).toContainText('In review');
    await expect(item(page, 7701, 'edit').locator('.shl-ditem-head .ebo-chip')).toHaveText('In review');
    expect(fake.p2.priceCalls).toHaveLength(2);
    await shot(page, 'desktop-update-jobcard');
  });
});

/* ------------------------- Phase 4: publish brand-new products ------------------------- */
// docs/shein-listings-plan.md §3 Phase 4 acceptance + scratchpad plan/phase4-spec.md. The fake SHEIN's
// publishOrEdit VALIDATES the body (validatePublish); transform-pic is an ASSET call; photos are made
// in-process (canvas) and "hosted" on a fake R2.

test.describe('SHEIN Listings Phase 4 — the planner (pure)', () => {
  test('size groups, title / description cleaning, the picture plan by the spu_image_detail_show key, D6 validation', async () => {
    const { sizeGroupOf, cleanTitle, cleanDescription, imagePlan, imageConversions, validateBoxDefaults, BOX_PLACEHOLDERS } = await import('../src/lib/sheinPublish.js');
    expect(['9', '9.5W', '5Y', '4C', '11C'].map(sizeGroupOf)).toEqual(['adult', 'women', 'youth', 'toddler', 'child']);
    expect(cleanTitle('  Nike   Air Max 👟 1  ')).toBe('Nike Air Max 1');
    expect(cleanDescription('<p>Classic <b>leather</b> &amp; suede.</p><ul><li>Rubber sole</li></ul>')).toBe('Classic leather & suede.\n• Rubber sole');
    expect(imagePlan({ picture_config_list: [{ field_key: 'switch_spu_picture', is_true: false }, { field_key: 'sku_image_required', is_true: false }] })).toMatchObject({ newPlan: false, need: 2 });
    const np = imagePlan({ picture_config_list: [{ field_key: 'spu_image_detail_show', is_true: true }, { field_key: 'spu_image_detail_single', is_true: true }, { field_key: 'skc_image_square_required', is_true: true }] });
    expect(np).toMatchObject({ newPlan: true, spu: [{ type: 1, photo: 0 }], skc: [{ type: 1, photo: 0 }, { type: 5, photo: 0 }] });
    expect(imageConversions(imagePlan({}), 3)).toEqual([{ photo: 0, type: 1 }, { photo: 1, type: 2 }, { photo: 2, type: 2 }, { photo: 0, type: 5 }]);   // the square is its own conversion (type is part of the key)
    expect(validateBoxDefaults(BOX_PLACEHOLDERS)).toBe(null);
    expect(validateBoxDefaults({ ...BOX_PLACEHOLDERS, adult: { ...BOX_PLACEHOLDERS.adult, weight: 0 } })).toMatch(/weight/);
    // 30 in / 30 lb limits (2026-10-28: a toddler length saved as 166 in = 421.64 cm)
    expect(validateBoxDefaults({ ...BOX_PLACEHOLDERS, toddler: { ...BOX_PLACEHOLDERS.toddler, length: '421.64' } })).toBe('toddler length: 166 in is over 30 in — check for a typo.');
    expect(validateBoxDefaults({ ...BOX_PLACEHOLDERS, adult: { ...BOX_PLACEHOLDERS.adult, weight: 14000 } })).toMatch(/^adult weight: 30\.86 lb is over 30 lb/);
    const { validateImperialBox } = await import('../src/lib/sheinPublish.js');
    const ok = { adult: { length: '16', width: '12', height: '6', weight: '4' }, youth: { length: '16', width: '12', height: '6', weight: '4' }, child: { length: '16', width: '12', height: '6', weight: '4' }, toddler: { length: '16', width: '12', height: '6', weight: '4' } };
    expect(validateImperialBox(ok)).toBe(null);
    expect(validateImperialBox({ ...ok, adult: { ...ok.adult, length: '30' } })).toBe(null);                    // the limit itself is allowed
    expect(validateImperialBox({ ...ok, toddler: { ...ok.toddler, length: '166' } })).toBe('toddler length: 166 in is over 30 in — check for a typo.');
    expect(validateImperialBox({ ...ok, child: { ...ok.child, weight: '40' } })).toBe('child weight: 40 lb is over 30 lb — check for a typo.');
  });
  test('attributes are never automatic: a required one without a person’s default blocks; assoc rules add requirements; values must be in the template', async () => {
    const { templateParts, buildAttributes } = await import('../src/lib/sheinPublish.js');
    const parts = templateParts(P4TEMPLATE);
    expect(parts).toMatchObject({ main: { attribute_id: 27 }, size: { attributeId: ATTR }, mainStatus: 2 });
    expect(buildAttributes({ parts, defaults: [] }).problems).toEqual([expect.objectContaining({ code: 'missing_attr', params: expect.objectContaining({ attributeId: 7000, attribute: 'Upper Material' }) })]);
    const d = [{ attribute_id: 7000, value_ids: [7001], extra_values: [] }];
    expect(buildAttributes({ parts, defaults: d })).toMatchObject({ rows: [{ attribute_id: 7000, attribute_value_id: 7001 }], problems: [] });
    expect(buildAttributes({ parts, defaults: d, assoc: [{ attribute_id: 7200, allowed: [7201] }] }).problems[0]).toMatchObject({ code: 'missing_attr', params: { attributeId: 7200 } });
    expect(buildAttributes({ parts, defaults: [{ attribute_id: 7000, value_ids: [9999] }] }).problems[0].params.why).toBe('value_not_in_template');
    expect(buildAttributes({ parts, defaults: [{ ...d[0], stale: true }] }).problems[0].params.why).toBe('template_changed');
    expect(buildAttributes({ parts, defaults: [...d, { attribute_id: 7100, value_ids: [7101, 7102] }] }).rows).toEqual([{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: 7100, attribute_value_id: 7101 }, { attribute_id: 7100, attribute_value_id: 7102 }]);   // multi-select: a row per value
  });
});

test.describe.serial('SHEIN Listings Phase 4 — publish (server jobs vs the fake SHEIN)', () => {
  let L; let D; let auth; let png; let small; const hosted = []; const stocked = []; const savedRows = {}; let started;
  const items = async (jobId) => (await D.listListingJobItems(jobId, { limit: 1000 })).map((i) => ({ ...i, n: Number(i.shopify_product_id.split('/').pop()) }));
  const one = async (jobId, n) => (await items(jobId)).find((i) => i.n === n);
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const img = (n) => [1, 2, 3].map((i) => ({ url: `https://cdn.e2e.test/${n}-${i}.png`, width: 1200, height: 800 }));
  const prod = (n, title, style, variants) => ({ productId: gidP(n), title, handle: `e2e-${n}`, vendor: 'E2E Nike', productType: 'E2E Sneakers', tags: [], status: 'ACTIVE', updatedAt: '2026-10-27T12:00:00Z',
    image: img(n)[0].url, imageCount: 3, style, descriptionHtml: '<p>Classic <b>leather</b> sneaker.</p><ul><li>Rubber sole</li></ul>', images: img(n),
    variants: variants.map(([v, sku, size, price, qty]) => ({ variantId: gidV(v), sku, size, price: String(price), compareAt: null, qty, barcode: null, weightG: null })) });
  const P4SHOP = () => [...SHOPIFY(),
    prod(7708, 'Nike Air Force 1 Low White (CW2288-111)', 'CW2288-111', [[770809, 'CW-9', '9', 110, 1], [770810, 'CW-10', '10', 110, 2], [770811, 'CW-11', '11', 115, 1], [770814, 'CW-14', '14', 120, 0]]),
    prod(7709, 'Nike Dunk Low Panda (DD1391-100)', 'DD1391-100', [[770909, 'DK-9', '9', 120, 1], [770910, 'DK-10', '10', 120, 1]])];
  const io = () => ({ ...p2IO(L.IO, { shopify: P4SHOP, stock: stocked }), recentShelf: async () => new Set(),
    fetchImage: async (url) => (/small/.test(url) ? small : png), hostImage: async (key) => { hosted.push(key); return `https://r2.e2e.test/${key}`; } });
  const preview = async (ids) => { const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p4', scope: { productIds: ids.map(gidP), ops: ['publish'], convertPhotos: true }, io: io() }); jobsMade.add(j.id); return finished(j.id); };
  const run = async (pid) => { const j = await L.startRunJob({ previewJobId: pid, by: 'e2e-p4', io: io() }); jobsMade.add(j.id); return finished(j.id); };
  const STORE_KINDS = ['publish_perm', 'publish_quota', 'shelf_quota', 'site_list', 'brands', 'category_tree'];
  const clearGates = () => pool.query(`DELETE FROM shein_listing_cache WHERE kind IN ('publish_perm','publish_quota','shelf_quota','site_list')`);

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    const { createCanvas } = await import('@napi-rs/canvas');
    const mk = (w, h) => { const c = createCanvas(w, h); const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, w, h); return c.encode('png'); };
    png = await mk(1200, 800); small = await mk(400, 300);
    const { signToken } = await import('../api/_lib/util.js');
    auth = { ph: { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` },
      admin: { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` } };
    started = new Date();
    for (const k of STORE_KINDS) savedRows[k] = (await pool.query(`SELECT payload FROM shein_listing_cache WHERE kind = $1 AND key = 'store'`, [k])).rows[0] || null;
    savedRows.box = (await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_box_defaults'`)).rows[0] || null;
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_box_defaults'`);
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = ANY($1::text[]) AND key = 'store'`, [STORE_KINDS]);
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e-p%'`);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_category_map WHERE shopify_product_type LIKE 'E2E%'`);
    await pool.query(`DELETE FROM shein_brand_map WHERE vendor LIKE 'e2e%'`);
    await pool.query(`DELETE FROM shein_attr_defaults WHERE product_type_id = $1`, [P4TYPE]);
    fake.p2 = P2(); fake.p4 = P4();
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p4', io: testIO(L.IO, { shopify: P4SHOP }) });
    jobsMade.add(snap.id); await finished(snap.id);
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });
  test.afterAll(async () => {
    fake.p4 = null; fake.p2 = null;
    for (const k of Object.keys(SHEIN)) if (k.startsWith('E2ENEW')) delete SHEIN[k];
    if (!pool || !started) return;
    await pool.query(`DELETE FROM shein_listing_cache WHERE fetched_at >= $1 AND kind IN ('pic','assoc_rules','fill_standard','attr_template','custom_perm','spu')`, [started]);
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = ANY($1::text[]) AND key = 'store'`, [STORE_KINDS]);
    for (const k of STORE_KINDS) if (savedRows[k]) await pool.query(`INSERT INTO shein_listing_cache (kind, key, payload) VALUES ($1, 'store', $2)`, [k, JSON.stringify(savedRows[k].payload)]);
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_box_defaults'`);
    if (savedRows.box) await pool.query(`INSERT INTO app_settings (key, value) VALUES ('shein_box_defaults', $1)`, [savedRows.box.value]);
    await pool.query(`DELETE FROM shein_category_map WHERE shopify_product_type LIKE 'E2E%'`);
    await pool.query(`DELETE FROM shein_brand_map WHERE vendor LIKE 'e2e%'`);
    await pool.query(`DELETE FROM shein_attr_defaults WHERE product_type_id = $1`, [P4TYPE]);
  });

  test('readiness (no SHEIN call): a shoe not on SHEIN is Blocked with what publishing needs — no category, box sizes unconfirmed; the drawer’s checklist comes from the server', async ({ request }) => {
    const v = (await pool.query(`SELECT status, blockers FROM shein_listing_variants WHERE row_key = $1`, [gidV(770809)])).rows[0];
    expect(v.status).toBe('blocked');
    expect(v.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['no_category', 'box_unconfirmed']));
    const d = await (await request.get(`/api/shein/listings?product=${encodeURIComponent(gidP(7708))}`, { headers: auth.ph })).json();
    expect(d.checklist).toHaveLength(18);
    const line = (k) => d.checklist.find((l) => l.key === k);
    expect(line('category')).toMatchObject({ n: 6, ok: false });
    expect(line('box')).toMatchObject({ n: 15, ok: false });
    expect(line('store').ok).toBe(null);                                         // store gates: only a dry run reads them
    expect(d.checklistFrom).toEqual({ readiness: true });
  });

  test('a dry run refuses a product while any line is ✕ — “skipped” with the reason; SHEIN suggests a category; zero writes', async () => {
    fake.writes.length = 0;
    const job = await preview([7708]);
    expect(job.status).toBe('done');                                             // nothing sendable
    const it = await one(job.id, 7708);
    expect(it).toMatchObject({ status: 'skipped', op: 'publish', body: null });
    expect(it.plan.checklist.find((l) => l.key === 'category')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'no_category', title: `No SHEIN category picked. We suggest ${P4CAT}.` })] });
    expect(it.error).toMatch(/^Can’t publish yet: No SHEIN category picked/);
    expect(job.counts).toMatchObject({ shein_writes: 0 });
    expect(fake.writes).toEqual([]); expect(fake.p4.transforms).toEqual([]);      // no photo converted while something else blocks
  });

  test('the person-set maps (DB only): category = a LEAF of SHEIN’s tree, brand from SHEIN’s list, attribute values from the template; D6 box sizes confirmed by an admin', async ({ request }) => {
    const ph = (type, data) => request.post(`/api/shein/listing-maps?type=${type}`, { headers: auth.ph, data });
    expect((await ph('category', { action: 'set', productType: 'E2E Sneakers', sizeGroup: 'adult', categoryId: P4CAT })).status()).toBe(409);   // the tree isn't read yet
    expect((await request.get('/api/shein/listing-meta?tree=1&refresh=1', { headers: auth.ph })).status()).toBe(403);
    const tree = await (await request.get('/api/shein/listing-meta?tree=1&refresh=1', { headers: auth.admin })).json();
    expect(tree.leaves).toEqual(expect.arrayContaining([{ categoryId: P4CAT, productTypeId: P4TYPE, path: 'E2E Shoes › E2E Men’s Sneakers' }]));
    expect((await ph('category', { action: 'set', productType: 'E2E Sneakers', sizeGroup: 'adult', categoryId: 9960000 })).status()).toBe(400);   // not a leaf
    const cat = await (await ph('category', { action: 'set', productType: 'E2E Sneakers', sizeGroup: 'adult', categoryId: P4CAT })).json();
    expect(cat.map).toMatchObject({ category_id: String(P4CAT), product_type_id: String(P4TYPE), category_path: 'E2E Shoes › E2E Men’s Sneakers', set_by: 'E2E PH' });
    const meta = await (await request.get(`/api/shein/listing-meta?category=${P4CAT}&refresh=1`, { headers: auth.admin })).json();
    expect(meta).toMatchObject({ category: { productTypeId: P4TYPE }, fill: { default_language: 'en' }, parts: { required: [7000], sizeAttributeId: ATTR } });
    await request.get('/api/shein/listing-meta?brands=1&refresh=1', { headers: auth.admin });
    expect((await ph('brand', { action: 'set', vendor: 'E2E Nike', brandCode: 'ADIDAS' })).status()).toBe(400);
    expect((await (await ph('brand', { action: 'set', vendor: 'E2E Nike', brandCode: 'NIKE01' })).json()).map).toMatchObject({ vendor: 'e2e nike', brand_code: 'NIKE01' });
    expect((await ph('attr', { action: 'set', productTypeId: P4TYPE, attributeId: 7000, valueIds: [7001, 7002] })).status()).toBe(400);   // single select
    expect((await ph('attr', { action: 'set', productTypeId: P4TYPE, attributeId: 7000, valueIds: [9999] })).status()).toBe(400);
    expect((await ph('attr', { action: 'set', productTypeId: P4TYPE, attributeId: 7000, valueIds: [7001] })).status()).toBe(200);
    const attrs = await (await request.get(`/api/shein/listing-maps?type=attr&productTypeId=${P4TYPE}`, { headers: auth.ph })).json();
    expect(attrs.template.attributes.map((a) => [a.attributeId, a.status])).toEqual([[7000, 3], [7100, 2], [7200, 2]]);
    // seeding reads one of OUR approved SHEIN products (spu-info) and proposes — never saves
    const seed = await (await ph('attr', { action: 'seed', productTypeId: P4TYPE, spu: 'E2ESPU1' })).json();
    expect(seed).toMatchObject({ ok: false, error: expect.stringMatching(/product type 501, not/) });
    // D6: placeholders until a person (admin / Connect integrations) saves them
    expect((await (await request.get('/api/shein/listing-maps?type=box', { headers: auth.ph })).json()).box).toMatchObject({ confirmed: false, groups: { adult: { length: '33', weight: 1400 } } });
    const groups = { adult: { length: '34', width: '22', height: '13', weight: 1450 }, youth: { length: '30', width: '19', height: '11', weight: 1000 }, child: { length: '27', width: '17', height: '10', weight: 800 }, toddler: { length: '24', width: '16', height: '9', weight: 600 } };
    expect((await ph('box', { groups })).status()).toBe(403);
    expect((await request.post('/api/shein/listing-maps?type=box', { headers: auth.admin, data: { groups: { ...groups, adult: { ...groups.adult, width: 'x' } } } })).status()).toBe(400);
    expect((await request.post('/api/shein/listing-maps?type=box', { headers: auth.admin, data: { groups: { ...groups, toddler: { ...groups.toddler, length: '421.64' } } } })).status()).toBe(400);   // 166 in
    expect((await (await request.post('/api/shein/listing-maps?type=box', { headers: auth.admin, data: { groups } })).json()).box).toMatchObject({ confirmed: true, by: 'Alex', groups: { adult: { length: '34', weight: 1450 } } });
    // saving recounts at once (DB only): box_unconfirmed is gone from the shoe without a Re-read
    const codes = async () => (await pool.query(`SELECT blockers FROM shein_listing_variants WHERE row_key = $1`, [gidV(770809)])).rows[0].blockers.map((b) => b.code);
    expect(await codes()).not.toContain('box_unconfirmed');
    // a box saved BEFORE the limit (166 in) reads unconfirmed with the reason — it blocks publishing
    const good = (await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_box_defaults'`)).rows[0].value;
    const badBox = JSON.parse(good); badBox.groups.toddler.length = '421.64';
    await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'shein_box_defaults'`, [JSON.stringify(badBox)]);
    expect((await (await request.get('/api/shein/listing-maps?type=box', { headers: auth.ph })).json()).box).toMatchObject({ confirmed: false, problem: 'toddler length: 166 in is over 30 in — check for a typo.' });
    await L.recomputeStored();
    expect(await codes()).toContain('box_unconfirmed');
    expect((await request.post('/api/shein/listing-maps?type=box', { headers: auth.admin, data: { groups } })).status()).toBe(200);   // fixed → confirmed again, recounted
    expect(await codes()).not.toContain('box_unconfirmed');
  });

  test('associated rules add a requirement (a leather upper needs a lining) → blocked until a person sets it; then the EXACT body, photos converted (assets), 0 writes', async ({ request }) => {
    let job = await preview([7708]);
    let it = await one(job.id, 7708);
    expect(it.plan.checklist.find((l) => l.key === 'attributes')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'missing_attr', params: expect.objectContaining({ attributeId: 7200 }) })] });
    await request.post('/api/shein/listing-maps?type=attr', { headers: auth.ph, data: { action: 'set', productTypeId: P4TYPE, attributeId: 7200, valueIds: [7201] } });
    fake.writes.length = 0; const before = fake.p4.transforms.length;
    job = await preview([7708]);
    it = await one(job.id, 7708);
    expect(job).toMatchObject({ status: 'awaiting_confirm', counts: expect.objectContaining({ publishable: 1, publish_sizes: 4, shein_writes: 0 }) });
    const { rows: [lg] } = await pool.query(`SELECT count(*) FILTER (WHERE write)::int AS writes, count(*) FILTER (WHERE asset)::int AS assets FROM shein_api_log WHERE job_id = $1`, [job.id]);
    expect(lg).toEqual({ writes: 0, assets: 4 });                              // main + 2 details + square — "0 SHEIN writes · 4 photos converted"
    expect(fake.p4.transforms.length - before).toBe(4);
    expect(fake.p4.transforms.slice(-4).map((t) => t.image_type)).toEqual([1, 2, 2, 5]);
    const u = (n) => it.body.skc_list[0].image_info.image_info_list[n].image_url;
    const sku = (size, valueId, price) => ({ sale_attribute_list: [{ attribute_id: ATTR, attribute_value_id: valueId }], supplier_sku: `CW-${size}`, mall_state: 1, length: '34', width: '22', height: '13', weight: 1450,
      price_info_list: [{ base_price: price, currency: 'USD', sub_site: 'shein-us' }], stock_info_list: [{ inventory_num: 0, supplier_warehouse_id: 'PSE2E1' }] });
    expect(it.body).toEqual({
      category_id: P4CAT, product_type_id: P4TYPE, source_system: 'OpenAPI', suit_flag: '0', is_spu_pic: false, brand_code: 'NIKE01',
      multi_language_name_list: [{ language: 'en', name: 'Nike Air Force 1 Low White (CW2288-111)' }],
      multi_language_desc_list: [{ language: 'en', name: 'Classic leather sneaker.\n• Rubber sole' }],
      site_list: [{ main_site: 'shein', sub_site_list: ['shein-us'] }],
      product_attribute_list: [{ attribute_id: 7000, attribute_value_id: 7001 }, { attribute_id: 7200, attribute_value_id: 7201 }],
      skc_list: [{ supplier_code: 'SB12-P7708', sale_attribute: { attribute_id: 27, attribute_value_id: 900 },
        image_info: { image_info_list: [{ image_sort: 1, image_type: 1, image_url: u(0) }, { image_sort: 2, image_type: 2, image_url: u(1) }, { image_sort: 3, image_type: 2, image_url: u(2) }, { image_sort: 4, image_type: 5, image_url: u(3) }] },
        sku_list: [sku(9, 6009, 110), sku(10, 6010, 110), sku(11, 6011, 115), sku(14, 6014, 120)] }],
      sale_attribute_sort_list: [{ attribute_id: ATTR, in_order_attribute_value_list: [{ attribute_value_id: '6009' }, { attribute_value_id: '6010' }, { attribute_value_id: '6011' }, { attribute_value_id: '6014' }] }],
    });
    expect(u(0)).toMatch(/^https:\/\/img\.ltwebstatic\.com\//);
    expect(it.plan.checklist.every((l) => l.ok === true)).toBe(true);
    expect(it.plan).toMatchObject({ quota: { controlled: true, available: 5, uses: 1 }, photos: { source: 'shopify', count: 3, converted: 4 } });
    expect(summarizePlan(it.plan)).toBe('Will publish “Nike Air Force 1 Low White (CW2288-111)” with 4 sizes: US9 $110, US10 $110, US11 $115, US14 $120 · 4 photos · uses 1 of 5 publish quota');
    // photos are cached by source + render + IMAGE TYPE: a second dry run converts nothing
    const again = fake.p4.transforms.length;
    await preview([7708]);
    expect(fake.p4.transforms.length).toBe(again);
  });

  test('store gates are checked before anything: SHEIN can’t take listings / the monthly quota is used → nothing sendable, for every product', async () => {
    fake.p4.canPublish = false; fake.p4.reason = 'KYC not finished'; await clearGates();
    let it = await one((await preview([7708, 7709])).id, 7708);
    expect(it.plan.checklist[0]).toMatchObject({ key: 'store', ok: false, blockers: [expect.objectContaining({ code: 'store_cannot_publish', sheinSaid: 'KYC not finished' })] });
    fake.p4.canPublish = true; fake.p4.quota = { isControlled: true, availableQuota: 0, totalQuota: 10, usedCount: 10 }; await clearGates();
    it = await one((await preview([7708])).id, 7708);
    expect(it.plan.checklist.find((l) => l.key === 'quota')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'publish_quota_used' })] });
    fake.p4.quota = { isControlled: true, availableQuota: 5, totalQuota: 10, usedCount: 5 }; await clearGates();
  });

  test('a photo SHEIN refuses (transformed "") → “Photo rejected: <SHEIN’s reason>”; a photo under 600 px is refused before SHEIN sees it', async () => {
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'pic'`);
    fake.p4.rejectNext = 1;
    const it = await one((await preview([7709])).id, 7709);
    expect(it.status).toBe('skipped');
    expect(it.plan.checklist.find((l) => l.key === 'photos')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'image_rejected', title: 'Photo rejected: 图片下载异常.' })] });
    const { padPhoto } = await import('../api/_lib/shein-publish.js');
    await expect(padPhoto(small)).rejects.toMatchObject({ tooSmall: true });
    const { loadImage } = await import('@napi-rs/canvas');
    const out = await loadImage(await padPhoto(png));
    expect([out.width, out.height]).toEqual([1500, 1500]);                     // padded on white, never cropped
  });

  test('the run: ONE publishOrEdit (the fake validates it); spu_name + version saved at once; In review though spu-info shows nothing yet', async () => {
    const pv = await preview([7708]);
    const job = await run(pv.id);
    const it = await one(job.id, 7708);
    expect(it, JSON.stringify({ s: it.status, e: it.error, b: it.blockers })).toMatchObject({ status: 'in_review', spu: 'E2ENEW1', version: 'E2EPV1', sku_codes: expect.arrayContaining([{ skc: 'E2ENEW1SKC', skuCode: 'E2ENEW1-K1', sellerSku: 'CW-9' }]) });
    expect(fake.p4.published).toHaveLength(1);
    expect(fake.p4.published[0].body.skc_list[0].supplier_code).toBe('SB12-P7708');
    const { rows: [p] } = await pool.query(`SELECT spu, review_version, synced_hash FROM shein_listing_products WHERE shopify_product_id = $1`, [gidP(7708)]);
    expect(p).toEqual({ spu: 'E2ENEW1', review_version: 'E2EPV1', synced_hash: null });
    expect((await pool.query(`SELECT status FROM shein_listing_variants WHERE row_key = $1`, [gidV(770809)])).rows[0].status).toBe('in_review');
    const { rows: [w] } = await pool.query(`SELECT path, request FROM shein_api_log WHERE job_id = $1 AND write`, [job.id]);
    expect(w.path).toBe('/open-api/goods/product/publishOrEdit');
    expect(w.request).toEqual(it.body);
  });

  test('SHEIN approves: Synced, the product is OURS (synced_hash), one stock step, compliance noted', async () => {
    approvePublishOnFake('E2ENEW1');
    stocked.length = 0;
    await L.listingFollowUp({ io: io(), force: true });
    const it = (await D.listListingJobItems((await D.listListingJobs({ kind: 'run', limit: 1 }))[0].id)).find((x) => x.shopify_product_id === gidP(7708));
    expect(it).toMatchObject({ status: 'done', blockers: [expect.objectContaining({ code: 'compliance_missing', params: { name: 'CPC' } })] });
    expect(stocked).toEqual(['E2ENEW1']);
    expect((await pool.query(`SELECT synced_hash FROM shein_listing_products WHERE shopify_product_id = $1`, [gidP(7708)])).rows[0].synced_hash).toBeTruthy();
    expect((await pool.query(`SELECT match, shein_sku, status FROM shein_listing_variants WHERE row_key = $1`, [gidV(770809)])).rows[0]).toEqual({ match: 'published', shein_sku: 'E2ENEW1-K1', status: 'synced' });
  });

  test('F1: a lost answer is NEVER sent again by itself — “SHEIN didn’t confirm”; Look again finds it (In review); the receive webhook gives the SPU', async () => {
    fake.p4.noAnswer = 1;
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'pic'`);
    const job = await run((await preview([7709])).id);
    let it = await one(job.id, 7709);
    expect(it).toMatchObject({ status: 'failed', blockers: [expect.objectContaining({ code: 'publish_unconfirmed' })], error: expect.stringMatching(/never sent again by itself/) });
    expect(it.idem_key).toBeTruthy();                                           // the key is KEPT
    expect(it.sent_at).toBeTruthy();
    const sent = fake.p4.published.length;
    await L.listingFollowUp({ io: io(), force: true });                         // the tick never re-queues it
    expect((await one(job.id, 7709)).status).toBe('failed');
    expect(fake.p4.published.length).toBe(sent);
    const r = await L.lookAgainPublish([it.id], { io: io(), by: 'E2E PH' });   // SHEIN has our SKUs → found
    expect(r).toEqual([{ id: it.id, found: true }]);
    it = await one(job.id, 7709);
    expect(it).toMatchObject({ status: 'in_review', spu: null });
    expect(fake.p4.published.length).toBe(sent);
    const pub = fake.p4.published.at(-1);
    await L.listingReviewEvent({ spu_name: pub.spu, version: pub.version, received_success: true, document_details: [{ skc_name: `${pub.spu}SKC`, sku_list: pub.body.skc_list[0].sku_list.map((k) => ({ seller_sku: k.supplier_sku })) }] }, 'product_document_receive_status_notice', { io: io() });
    expect(await one(job.id, 7709)).toMatchObject({ status: 'in_review', spu: pub.spu, version: pub.version });
  });

  test('rejected in review → Error with SHEIN’s reason; publishing again needs an admin’s “Publish again”', async ({ request }) => {
    const pub = fake.p4.published.at(-1);
    fake.p4.hist[`${pub.spu}|${pub.version}`] = { state: 3, reason: 'Main image has a watermark' };
    await L.listingFollowUp({ io: io(), force: true });
    const last = await D.lastPublishItem(gidP(7709));
    expect(last).toMatchObject({ status: 'failed', blockers: [expect.objectContaining({ code: 'review_rejected', params: { failedReason: 'Main image has a watermark' } })] });
    fake.p4.pending.clear();                                                    // SHEIN no longer counts the rejected SKUs (L5 unknown — the person decides)
    let it = await one((await preview([7709])).id, 7709);
    expect(it.plan.checklist.find((l) => l.key === 'flight')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'publish_rejected' })] });
    expect((await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'publish_again', productIds: [gidP(7709)] } })).status()).toBe(403);
    expect(await (await request.post('/api/shein/listings', { headers: auth.admin, data: { action: 'publish_again', productIds: [gidP(7709)] } })).json()).toMatchObject({ ok: true, products: [gidP(7709)] });
    it = await one((await preview([7709])).id, 7709);
    expect(it.status).toBe('done');                                             // ready to send again
  });

  test('SHEIN refuses (pre-check): Error with SHEIN’s words, mapped to a better blocker; the key released; ops are never mixed', async ({ request }) => {
    fake.p4.refuse = 'Detail image must be at least 900 px';
    const job = await run((await preview([7709])).id);
    const it = await one(job.id, 7709);
    expect(it).toMatchObject({ status: 'failed', idem_key: null, error: 'Detail image must be at least 900 px' });
    expect(it.blockers.map((b) => b.code)).toEqual(['shein_prevalid', 'image_rejected']);
    expect((await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'preview', productIds: [gidP(7709)], ops: ['publish', 'price'] } })).status()).toBe(400);
    await expect(L.startListingJob({ kind: 'preview', by: 'e2e-p4', scope: { productIds: [gidP(7709)], ops: ['publish', 'edit'] }, io: io() })).rejects.toMatchObject({ status: 400 });
  });

  test('the fake checks publishOrEdit like the spec: a body with spu_name / a missing required attribute is refused with a code', async () => {
    const good = fake.p4.published[0].body;
    for (const [mut, want] of [[(b) => { b.spu_name = 'X'; }, /spu_name can’t be sent/], [(b) => { b.product_attribute_list = []; }, /Upper Material is required/], [(b) => { b.suit_flag = 0; }, /suit_flag/]]) {
      const b = JSON.parse(JSON.stringify(good)); mut(b); b.skc_list[0].sku_list.forEach((k, i) => { k.supplier_sku = `NEW-${i}-${Date.now()}`; });
      const e = await L.IO.sheinPublish(b, { source: 'e2e', by: 'e2e-p4' }).catch((x) => x);
      expect(e).toMatchObject({ sheinCode: '20003', info: { pre_valid_result: [{ messages: [expect.stringMatching(want)] }] } });
    }
  });
});

/* ------------------------- Phase 4: the page (publish brand-new products) ------------------------- */
// The drawer's 18-line checklist (✓ / ✕ / not read yet, each ✕ with its fix inline), the category pick
// (DB only), the D6 box banner (UNCONFIRMED blocks; only admin / Connect integrations save it), the publish
// dry run sheet, the job card (In review → Rejected with SHEIN's reason → Publish again), the store-gate
// banner, 390 px. Dry runs / runs are answered in-process against the fake SHEIN (routeWrites).
test.describe.serial('SHEIN Listings Phase 4 — the page (checklist, Setup, Publish new products)', () => {
  test.use({ timezoneId: 'Asia/Manila' });
  let L; let D; let auth; let png; let small; let runId = 0; let started; const savedRows = {}; let verifyTok;
  const posted = [];
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const img = (n) => [1, 2, 3].map((i) => ({ url: `https://cdn.e2e.test/${n}-${i}.png`, width: 1200, height: 800 }));
  const prod = (n, title, style, variants) => ({ productId: gidP(n), title, handle: `e2e-${n}`, vendor: 'E2E Nike', productType: 'E2E Sneakers', tags: [], status: 'ACTIVE', updatedAt: '2026-10-27T12:00:00Z',
    image: img(n)[0].url, imageCount: 3, style, descriptionHtml: '<p>Classic <b>leather</b> sneaker.</p>', images: img(n),
    variants: variants.map(([v, sku, size, price, qty]) => ({ variantId: gidV(v), sku, size, price: String(price), compareAt: null, qty, barcode: null, weightG: null })) });
  const P4UI = () => [...SHOPIFY(),
    prod(7708, 'Nike Air Force 1 Low White (CW2288-111)', 'CW2288-111', [[770809, 'CW-9', '9', 110, 1], [770810, 'CW-10', '10', 110, 2], [770811, 'CW-11', '11', 115, 1], [770814, 'CW-14', '14', 120, 0]]),
    prod(7709, 'Nike Dunk Low Panda (DD1391-100)', 'DD1391-100', [[770909, 'DK-9', '9', 120, 1], [770910, 'DK-10', '10', 120, 1]])];
  const io = () => ({ ...p2IO(L.IO, { shopify: P4UI }), recentShelf: async () => new Set(),
    fetchImage: async (url) => (/small/.test(url) ? small : png), hostImage: async (key) => `https://r2.e2e.test/${key}` });
  const STORE_KINDS = ['publish_perm', 'publish_quota', 'shelf_quota', 'site_list', 'brands', 'category_tree'];
  const shot = async (page, name) => { if (process.env.SHL_SHOTS) await page.screenshot({ path: `${process.env.SHL_SHOTS}/shein-listings-${name}.png`, fullPage: false }); };
  async function routeWrites(page) {
    await page.route((u) => u.pathname === '/api/shein/listings', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.continue();
      const b = req.postDataJSON() || {};
      posted.push(b);
      const json = (status, data) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      try {
        if (b.action === 'preview') {
          // as the endpoint does (security H2): photos are converted only when the starter may write to SHEIN
          const role = verifyTok(String(req.headers().authorization || '').replace(/^Bearer /, ''))?.role;
          const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p4ui', scope: { productIds: b.productIds, ...(b.ops ? { ops: b.ops } : {}), convertPhotos: role === 'admin' || role === 'superadmin' }, io: io() });
          jobsMade.add(j.id); await finished(j.id);
          return json(200, { ok: true, job: j });
        }
        if (b.action === 'run') {
          const j = await L.startRunJob({ previewJobId: b.previewJobId, by: 'e2e-p4ui', io: io() });
          jobsMade.add(j.id); await finished(j.id); runId = Number(j.id);
          return json(200, { ok: true, job: j });
        }
      } catch (e) { return json(e.status || 500, { ok: false, error: e.message }); }
      return route.continue();
    });
  }
  const drawer = (page) => page.getByRole('dialog', { name: 'Product details' });
  const sheet = (page) => page.getByRole('dialog', { name: 'Dry run and send' });
  const line = (page, key) => drawer(page).locator(`.shl-pub-line[data-line="${key}"]`);
  const item = (page, n) => sheet(page).locator(`.shl-ditem[data-product="${gidP(n)}"][data-op="publish"]`);
  const noSideScroll = async (page, where) => {
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth,
      sheet: document.querySelector('.shl-drawer')?.scrollWidth || 0, sheetW: document.querySelector('.shl-drawer')?.clientWidth || 0 }));
    expect(Math.max(w.doc, w.body), where).toBeLessThanOrEqual(w.vw);
    expect(w.sheet, `${where} (inside the sheet / drawer)`).toBeLessThanOrEqual(w.sheetW);
  };
  const post = (request, type, data, who = 'ph') => request.post(`/api/shein/listing-maps?type=${type}`, { headers: auth[who], data });

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    const { createCanvas } = await import('@napi-rs/canvas');
    const mk = (w, h) => { const c = createCanvas(w, h); const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, w, h); return c.encode('png'); };
    png = await mk(1200, 800); small = await mk(400, 300);
    const { signToken, verifyToken } = await import('../api/_lib/util.js'); verifyTok = verifyToken;
    auth = { ph: { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` },
      admin: { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` } };
    started = new Date();
    for (const k of STORE_KINDS) savedRows[k] = (await pool.query(`SELECT payload FROM shein_listing_cache WHERE kind = $1 AND key = 'store'`, [k])).rows[0] || null;
    savedRows.box = (await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_box_defaults'`)).rows[0] || null;
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_box_defaults'`);
    await pool.query(`DELETE FROM shein_listing_cache WHERE (kind = ANY($1::text[]) AND key = 'store') OR kind = 'pic'`, [STORE_KINDS]);
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e-p%'`);
    await pool.query(`DELETE FROM shein_listing_job_items WHERE job_id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_category_map WHERE shopify_product_type LIKE 'E2E%'`);
    await pool.query(`DELETE FROM shein_brand_map WHERE vendor LIKE 'e2e%'`);
    await pool.query(`DELETE FROM shein_attr_defaults WHERE product_type_id = $1`, [P4TYPE]);
    fake.p2 = P2(); fake.p4 = P4();
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p4ui', io: testIO(L.IO, { shopify: P4UI }) });
    jobsMade.add(snap.id); await finished(snap.id);
    // SHEIN's category tree + brand list, as an admin reads them once (reads; cached)
    const PUB = await import('../api/_lib/shein-publish.js');
    const lg = { source: 'e2e-p4ui', by: 'e2e-p4ui', dry: true };
    await PUB.categoryTree(L.IO, lg, true); await PUB.brandList(L.IO, lg, true);
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });
  test.afterAll(async () => {
    fake.p4 = null; fake.p2 = null;
    if (!pool || !started) return;
    await pool.query(`DELETE FROM shein_listing_cache WHERE fetched_at >= $1 AND kind IN ('pic','assoc_rules','fill_standard','attr_template','custom_perm','spu')`, [started]);
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = ANY($1::text[]) AND key = 'store'`, [STORE_KINDS]);
    for (const k of STORE_KINDS) if (savedRows[k]) await pool.query(`INSERT INTO shein_listing_cache (kind, key, payload) VALUES ($1, 'store', $2)`, [k, JSON.stringify(savedRows[k].payload)]);
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_box_defaults'`);
    if (savedRows.box) await pool.query(`INSERT INTO app_settings (key, value) VALUES ('shein_box_defaults', $1)`, [savedRows.box.value]);
    await pool.query(`DELETE FROM shein_category_map WHERE shopify_product_type LIKE 'E2E%'`);
    await pool.query(`DELETE FROM shein_brand_map WHERE vendor LIKE 'e2e%'`);
    await pool.query(`DELETE FROM shein_attr_defaults WHERE product_type_id = $1`, [P4TYPE]);
  });

  test('PH: a new shoe’s drawer shows the 18-line checklist — ✓ / ✕ / not read yet, each ✕ with its fix; the category pick (SHEIN’s suggestion first) saves, DB only', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7708))}`);
    const dr = drawer(page);
    await expect(dr.locator('[data-checklist]')).toContainText('What publishing needs');
    await expect(dr.locator('.shl-pub-line')).toHaveCount(18);
    await expect(line(page, 'shopify')).toHaveAttribute('data-ok', 'yes');
    await expect(line(page, 'store')).toHaveAttribute('data-ok', 'unread');
    await expect(line(page, 'store')).toContainText('Not read yet — the dry run checks it');
    await expect(line(page, 'category')).toHaveAttribute('data-ok', 'no');
    await expect(line(page, 'category')).toContainText('No SHEIN category picked.');
    await expect(line(page, 'box')).toHaveAttribute('data-ok', 'no');
    await expect(line(page, 'box')).toContainText('placeholders nobody confirmed');
    await expect(line(page, 'box').getByRole('button', { name: 'Confirm box sizes' })).toBeVisible();
    await expect(line(page, 'photos').getByRole('checkbox', { name: /Use PH edited photos/ })).not.toBeChecked();
    await expect(dr.getByRole('button', { name: 'Publish new product' })).toBeEnabled();
    await expect(dr.getByRole('button', { name: 'Add missing sizes' })).toHaveCount(0);
    await shot(page, 'desktop-publish-drawer');
    // Choose category: SHEIN suggests one from the photo (a read); searchable by path; saved per Shopify type + size group
    await line(page, 'category').getByRole('button', { name: 'Choose category' }).click();
    const panel = line(page, 'category').locator('[data-panel="category"]');
    await expect(panel).toContainText('For every Shopify “E2E Sneakers” shoe in Men’s / adult');
    await expect(panel.locator('.shl-cat-sug')).toContainText('SHEIN’s pick');
    await panel.getByRole('searchbox', { name: 'Search SHEIN categories' }).fill('women');
    await expect(panel.locator('.shl-cat-list .shl-cat-opt')).toHaveCount(1);
    await expect(panel.locator('.shl-cat-list')).toContainText('E2E Women’s Sneakers');
    await panel.getByRole('searchbox', { name: 'Search SHEIN categories' }).fill('e2e men');
    await panel.locator(`.shl-cat-list .shl-cat-opt[data-cat="${P4CAT}"] input`).check();
    await shot(page, 'desktop-publish-category');
    await panel.getByRole('button', { name: 'Use “E2E Men’s Sneakers”' }).click();
    await expect(dr.locator('[data-checklist]')).toContainText('Saved: every “E2E Sneakers” shoe in Men’s / adult goes to E2E Shoes › E2E Men’s Sneakers');
    // the server's checklist is computed live from the cache now: the category line turns ✓ at once
    await expect(line(page, 'category')).toContainText('E2E Shoes › E2E Men’s Sneakers');
    await expect(line(page, 'brand')).toHaveAttribute('data-ok', 'unread');     // SHEIN's rules for it not read yet → never ✓ by default
    const { rows: [m] } = await pool.query(`SELECT category_id, product_type_id, set_by FROM shein_category_map WHERE shopify_product_type = 'E2E Sneakers' AND size_group = 'adult'`);
    expect(m).toEqual({ category_id: String(P4CAT), product_type_id: String(P4TYPE), set_by: 'E2E PH' });
    expect(fake.writes).toEqual([]);
  });

  test('the box banner: UNCONFIRMED placeholders, PH can’t save them; a publish dry run lists the shoe as “Can’t publish yet” with each ✕ line', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await routeWrites(page);
    await page.goto('/ph/shein-listings?tab=setup');
    const box = page.locator('[data-setup="box"] [data-panel="box"]');
    await expect(box).toHaveAttribute('data-box', 'unconfirmed');
    await expect(box).toContainText('UNCONFIRMED — placeholders, publishing is blocked until someone confirms');
    await expect(box.locator('[data-box-save]')).toBeDisabled();
    await expect(box.locator('[data-box-save]')).toHaveAttribute('title', /Needs an admin/);
    await expect(box.getByRole('textbox', { name: /Adult — men’s and women’s Length/ })).toBeDisabled();
    await expect(page.locator('[data-setup="categories"] [data-type="E2E Sneakers"] tr[data-group="adult"]')).toContainText('E2E Shoes › E2E Men’s Sneakers');
    await shot(page, 'desktop-publish-setup');
    // the dry run from the selection bar — separate from Add missing sizes / Update prices & sizes
    await page.goto('/ph/shein-listings');
    await page.locator(`.shl-product[data-product="${gidP(7708)}"] .shl-chk input`).check();
    await expect(page.locator('.shl-bar [data-dry="add"]')).toBeDisabled();
    await page.locator('.shl-bar').getByRole('button', { name: /^Publish new products/ }).click();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
    expect(posted.at(-1)).toMatchObject({ action: 'preview', ops: ['publish'], productIds: [gidP(7708)] });
    await expect(sheet(page).locator('.shl-sheet-head')).toContainText('Publish new products — what WOULD be sent');
    await expect(sheet(page).locator('[data-proof]')).toContainText('0 SHEIN writes · 0 photos converted');
    const it = item(page, 7708);
    await expect(it.locator('.shl-ditem-head .ebo-chip')).toHaveText('Can’t publish yet');
    await expect(it).toContainText('Can’t publish yet:');
    await expect(it.locator('[data-plan="cant"]')).toBeVisible();   // one item → open
    await expect(it.locator('[data-plan="cant"] [data-line="box"]')).toContainText('placeholders nobody confirmed');
    await expect(it.locator('[data-plan="cant"] [data-line="attributes"]')).toContainText('Missing SHEIN detail: Upper Material.');
    await expect(sheet(page).getByRole('button', { name: /^Publish \d/ })).toHaveCount(0);   // nothing to confirm
    expect(fake.writes).toEqual([]);
    await shot(page, 'desktop-publish-blocked');
  });

  test('everything set (brand + details in the drawer, box by an admin) → a PH dry run converts no photos (says who does); the admin’s dry run sheet: title, category path, brand, photos converted, sizes, price, quota', async ({ page, request }) => {
    expect((await post(request, 'box', { groups: { adult: { length: '34', width: '22', height: '13', weight: 1450 }, youth: { length: '30', width: '19', height: '11', weight: 1000 }, child: { length: '27', width: '17', height: '10', weight: 800 }, toddler: { length: '24', width: '16', height: '9', weight: 600 } } })).status()).toBe(403);
    expect((await post(request, 'box', { groups: { adult: { length: '34', width: '22', height: '13', weight: 1450 }, youth: { length: '30', width: '19', height: '11', weight: 1000 }, child: { length: '27', width: '17', height: '10', weight: 800 }, toddler: { length: '24', width: '16', height: '9', weight: 600 } } }, 'admin')).status()).toBe(200);
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await routeWrites(page);
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7708))}`);
    // brand: vendor → SHEIN brand (only the store's authorised list)
    await line(page, 'brand').getByRole('button', { name: 'Map to a SHEIN brand' }).click();
    const bp = line(page, 'brand').locator('[data-panel="brand"]');
    await bp.getByRole('combobox', { name: /SHEIN brand for E2E Nike/ }).selectOption('NIKE01');
    await bp.getByRole('button', { name: 'Save brand' }).click();
    await expect(line(page, 'brand')).toContainText('Saved — checked again by the next dry run.');
    // SHEIN details: the per-type defaults editor (Required first); the attribute SHEIN adds with leather goes in by API
    await line(page, 'attributes').getByRole('button', { name: 'Set SHEIN details' }).click();
    const ap = line(page, 'attributes').locator('[data-panel="attributes"]');
    await expect(ap).toContainText('required still missing');           // the last dry run read SHEIN's template for this type
    const upper = ap.locator('.shl-attr[data-attr="7000"]');
    await expect(upper).toContainText('Required');
    await upper.getByRole('combobox', { name: 'Upper Material' }).selectOption('7001');
    await upper.getByRole('button', { name: 'Save' }).click();
    await expect(upper.locator('.ebo-chip.ok')).toHaveText('Saved');
    expect((await post(request, 'attr', { action: 'set', productTypeId: P4TYPE, attributeId: 7200, valueIds: [7201] })).status()).toBe(200);
    await shot(page, 'desktop-publish-details');
    // security H2: a PH dry run converts NO photos (no R2 upload, no SHEIN transform-pic) — the plan says who does
    const pics = async () => (await pool.query(`SELECT count(*)::int AS n FROM shein_api_log WHERE path = '/open-api/goods/transform-pic' AND at >= $1`, [started])).rows[0].n;
    const picsBefore = await pics();
    await drawer(page).getByRole('button', { name: 'Publish new product' }).click();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
    await expect(item(page, 7708)).toContainText('Photos are converted when an admin or Connect integrations holder runs the dry run');
    await expect(sheet(page).getByRole('button', { name: 'Publish 1 product' })).toHaveCount(0);
    expect(await pics()).toBe(picsBefore);
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7708))}`);
    await expect(line(page, 'photos')).toContainText('Not read yet — the dry run checks it.');
    // the admin's dry run converts them
    await loginAs(page, 'admin');
    await routeWrites(page);
    await page.goto(`/shein-listings?product=${encodeURIComponent(gidP(7708))}`);
    await drawer(page).getByRole('button', { name: 'Publish new product' }).click();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
    const s = sheet(page);
    await expect(s.locator('[data-proof]')).toContainText('0 SHEIN writes · 4 photos converted');
    const stat = (t) => s.locator('[data-stats="publish"] .er-stat', { hasText: t });
    await expect(stat('ready to publish')).toContainText('1');
    await expect(stat('sizes')).toContainText('4');
    await expect(s.locator('[data-quota]')).toContainText(/uses 1 of 5\s*publish quota left this month/);
    const it = item(page, 7708);
    await expect(it.locator('.shl-ditem-head .ebo-chip')).toHaveText('Ready to publish');
    await expect(it).toContainText('Will publish “Nike Air Force 1 Low White (CW2288-111)” with 4 sizes: US9 $110, US10 $110, US11 $115, US14 $120 · 4 photos · uses 1 of 5 publish quota');
    const pl = it.locator('[data-plan="publish"]');
    await expect(pl).toContainText('E2E Shoes › E2E Men’s Sneakers');
    await expect(pl).toContainText('Nike');
    await expect(pl).toContainText('13.39 × 8.66 × 5.12 in · 3.2 lb');          // the saved 34 × 22 × 13 cm / 1,450 g, shown in in / lb
    await expect(pl).toContainText('uses 1 of 5 left this month');
    await expect(pl).toContainText('SB12-P7708');
    await expect(pl.locator('.shl-pthumb-w')).toHaveCount(4);
    await expect(pl.locator('[data-photos]')).toContainText('3 source photos from Shopify · 4 converted for SHEIN in this dry run');
    await expect(pl.locator('[data-plan="sizes"] tr', { hasText: 'US9' })).toContainText('$110');
    await expect(pl.locator('[data-plan="sizes"] tr', { hasText: 'US9' })).toContainText('SHEIN size');
    await expect(pl.locator('[data-plan="cant"]')).toHaveCount(0);
    await expect(s.getByRole('button', { name: 'Publish 1 product' })).toBeEnabled();   // an admin may confirm (not pressed here)
    expect(fake.writes).toEqual([]); expect(fake.p4.published || []).toEqual([]);
    await shot(page, 'desktop-publish-dryrun');
    await s.getByRole('button', { name: 'Not now' }).click();
    await page.getByRole('tab', { name: /Jobs/ }).click();
    await expect(page.locator('.shl-rtable tr', { hasText: 'e2e_ph' }).or(page.locator('.shl-rtable tr', { hasText: 'e2e-p4ui' })).filter({ hasText: 'Dry run · publish new products' }).first()).toContainText('Waiting for you');
  });

  test('admin: “Publish 1 product” → the job card: In review; SHEIN rejects → Rejected with SHEIN’s reason + Publish again', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await routeWrites(page);
    await page.goto(`/shein-listings?product=${encodeURIComponent(gidP(7708))}`);
    await drawer(page).getByRole('button', { name: 'Publish new product' }).click();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
    await sheet(page).getByRole('button', { name: 'Publish 1 product' }).click();
    await expect(sheet(page).locator('.shl-pname')).toContainText('Send to SHEIN #', { timeout: 20_000 });
    await expect(sheet(page).locator('.shl-sheet-head')).toContainText('Publishing new products on SHEIN');
    const it = item(page, 7708);
    await expect(it.locator('.shl-ditem-head .ebo-chip')).toHaveText('In review');
    await expect(it).toContainText('SHEIN is reviewing the new product');
    expect(fake.p4.published).toHaveLength(1);
    // SHEIN's review says no
    const pub = fake.p4.published.at(-1);
    fake.p4.hist[`${pub.spu}|${pub.version}`] = { state: 3, reason: 'Main image has a watermark' };
    await L.listingFollowUp({ io: io(), force: true });
    await expect(it.locator('.shl-ditem-head .ebo-chip')).toHaveText('Rejected', { timeout: 15_000 });
    await expect(it.locator('[data-said]')).toContainText('SHEIN said: “Main image has a watermark”');
    await expect(it.getByRole('button', { name: 'Publish again' })).toBeEnabled();
    await shot(page, 'desktop-publish-jobcard');
  });

  test('PH can’t Publish again, confirm, or save the box sizes (each says who can)', async ({ page }) => {
    expect(runId).toBeGreaterThan(0);
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto(`/ph/shein-listings?tab=jobs&job=${runId}`);
    const again = page.locator(`.shl-ditem[data-product="${gidP(7708)}"]`).getByRole('button', { name: 'Publish again' });
    await expect(again).toBeDisabled();
    await expect(again).toHaveAttribute('title', /Needs an admin/);
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7708))}`);
    const pubd = drawer(page).locator('[data-published="failed"]');                // it has an SPU now: the publish's own section
    await expect(pubd).toContainText('SHEIN rejected the new product in its review: “Main image has a watermark”');
    await expect(pubd.getByRole('button', { name: 'Publish again' })).toBeDisabled();
    await page.goto('/ph/shein-listings?tab=setup');
    const box = page.locator('[data-setup="box"] [data-panel="box"]');
    await expect(box).toHaveAttribute('data-box', 'confirmed');
    await expect(box).toContainText('Confirmed by Alex');
    await expect(box.locator('[data-box-save]')).toBeDisabled();
    const { status } = await page.request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'publish_again', productIds: [gidP(7708)] } }).then((r) => ({ status: r.status() }));
    expect(status).toBe(403);
  });

  test('box sizes are shown and typed in inches / pounds, and saved for SHEIN in cm / grams', async ({ page }) => {
    const before = (await (await page.request.get('/api/shein/listing-maps?type=box', { headers: auth.admin })).json()).box.groups;
    await loginAs(page, 'admin');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto('/shein-listings?tab=setup');
    const box = page.locator('[data-setup="box"] [data-panel="box"]');
    const adultLen = box.getByLabel('Adult — men’s and women’s Length (in)');
    await expect(adultLen).toHaveValue(String(Math.round((before.adult.length / 2.54) * 100) / 100));   // the stored cm, shown in inches
    await expect(box.getByLabel('Adult — men’s and women’s Weight (lb)')).toHaveValue(String(Math.round((before.adult.weight / 453.59237) * 100) / 100));
    for (const g of ['Adult — men’s and women’s', 'GS / youth', 'Kids (PS)', 'Toddler (TD)']) {
      for (const [k, v] of [['Length (in)', '16'], ['Width (in)', '12'], ['Height (in)', '6'], ['Weight (lb)', '4']]) await box.getByLabel(`${g} ${k}`).fill(v);
    }
    await box.locator('[data-box-save]').click();
    await expect(box).toContainText('Confirmed by');
    const saved = await (await page.request.get('/api/shein/listing-maps?type=box', { headers: auth.admin })).json();
    expect(saved.box.groups.adult).toMatchObject({ length: '40.64', width: '30.48', height: '15.24', weight: 1814 });
    expect(saved.box.groups.toddler).toMatchObject({ length: '40.64', weight: 1814 });
    await expect(adultLen).toHaveValue('16');                                    // read back in inches, same as typed
    await box.getByLabel('GS / youth Weight (lb)').fill('4.123');
    await expect(box).toContainText('youth weight: a positive number of lb, at most 2 decimals.');
    await expect(box.locator('[data-box-save]')).toBeDisabled();
    // Put the earlier box back, exactly, for the tests after this one.
    expect((await page.request.post('/api/shein/listing-maps?type=box', { headers: auth.admin, data: { groups: before } })).status()).toBe(200);
  });

  test('admin: Publish again → recorded, and a fresh dry run opens (ready to publish again)', async ({ page }) => {
    fake.p4.pending.clear();                                                    // SHEIN no longer counts the rejected SKUs
    await loginAs(page, 'admin');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await routeWrites(page);
    await page.goto(`/shein-listings?tab=jobs&job=${runId}`);
    await page.locator(`.shl-ditem[data-product="${gidP(7708)}"]`).getByRole('button', { name: 'Publish again' }).click();
    await expect(page.locator('.shl-dinline [data-proof]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.shl-dinline h3')).toContainText('Dry run #');
    await expect(page.locator(`.shl-ditem[data-product="${gidP(7708)}"] .shl-ditem-head .ebo-chip`)).toHaveText('Ready to publish');
    expect((await pool.query(`SELECT publish_again_by FROM shein_listing_products WHERE shopify_product_id = $1`, [gidP(7708)])).rows[0].publish_again_by).toBe('Alex');
  });

  test('the store-gate banner: SHEIN refuses new listings → a banner for everyone, dry runs still allowed', async ({ page }) => {
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'publish_perm' AND key = 'store'`);
    await pool.query(`INSERT INTO shein_listing_cache (kind, key, payload) VALUES ('publish_perm', 'store', $1)`, [JSON.stringify({ canPublishProduct: false, reason: 'KYC not finished' })]);
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto('/ph/shein-listings');
    const b = page.locator('[data-gates="closed"]');
    await expect(b).toContainText('SHEIN isn’t taking new products right now');
    await expect(b).toContainText('SHEIN won’t take new listings: KYC not finished.');
    await expect(b).toContainText('Dry runs still work');
    await page.locator(`.shl-product[data-product="${gidP(7709)}"] .shl-chk input`).check();
    await expect(page.locator('.shl-bar').getByRole('button', { name: /^Publish new products/ })).toBeEnabled();
    await page.getByRole('tab', { name: /Setup/ }).click();
    await expect(page.locator('[data-setup="gates"]')).toContainText('SHEIN said: “KYC not finished”');
    await shot(page, 'desktop-publish-gates');
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'publish_perm' AND key = 'store'`);
  });

  test('390 px: the checklist with a fix open, Setup, and the publish dry run sheet — no horizontal scroll', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await routeWrites(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/ph/shein-listings?product=${encodeURIComponent(gidP(7709))}`);
    await expect(drawer(page).locator('.shl-pub-line')).toHaveCount(18);
    await line(page, 'title').getByRole('button', { name: /title/ }).click();
    await expect(line(page, 'title').locator('[data-count]')).toContainText('characters');
    await noSideScroll(page, 'drawer checklist');
    await shot(page, 'phone-publish-drawer');
    await line(page, 'category').getByRole('button', { name: /Change|Choose category/ }).click();
    await expect(line(page, 'category').locator('.shl-cat-list')).toBeVisible();
    await noSideScroll(page, 'category picker');
    await page.goto('/ph/shein-listings?tab=setup');
    await expect(page.locator('[data-setup="box"] [data-panel="box"]')).toBeVisible();
    await noSideScroll(page, 'setup');
    await page.locator('[data-setup="box"]').scrollIntoViewIfNeeded();
    await shot(page, 'phone-publish-setup');
    await page.goto('/ph/shein-listings');
    await page.locator(`.shl-product[data-product="${gidP(7709)}"] .shl-chk input`).check();
    await noSideScroll(page, 'bar');
    await page.locator('.shl-bar').getByRole('button', { name: /^Publish new products/ }).click();
    await expect(sheet(page).locator('[data-proof]')).toBeVisible({ timeout: 20_000 });
    await expect(item(page, 7709).locator('[data-plan="publish"]')).toBeVisible();
    await noSideScroll(page, 'publish dry run');
    await shot(page, 'phone-publish-dryrun');
  });
});

/* --------------------- Phase 4 — the API review's fixes (plan/phase4-review.md) --------------------- */
const p4input = (o = {}) => {
  const product = { productId: gidP(7710), title: 'Nike Air Force 1 Low White (CW2288-111)', vendor: 'E2E Nike', productType: 'E2E Sneakers', status: 'ACTIVE', descriptionHtml: '<p>Leather.</p>', imageCount: 3,
    variants: [{ variantId: gidV(771009), sku: 'RV-9', size: '9', price: '110', qty: 1 }, { variantId: gidV(771010), sku: 'RV-10', size: '10', price: '110', qty: 1 }] };
  return {
    product, productRow: {}, category: { categoryId: P4CAT, productTypeId: P4TYPE, path: 'x' }, fill: P4FILL, template: P4TEMPLATE,
    attrDefaults: [{ attribute_id: 7000, value_ids: [7002], extra_values: [] }], brand: { code: 'NIKE01', name: 'Nike', listed: true }, maps: [], permission: 1, customValues: [],
    box: { confirmed: true, groups: { adult: { length: '33', width: '21', height: '12', weight: 1400 } } }, takenChecked: true, taken: new Set(),
    gates: { perm: { canPublishProduct: true }, quota: { isControlled: true, availableQuota: 3 }, shelf: { need: false }, site: { main_site: 'shein' }, warehouse: { code: 'PSE2E1' }, need: 1 },
    images: { photoCount: 3, errors: [], converted: { '0:1': 'https://img.ltwebstatic.com/a-1.jpg', '1:2': 'https://img.ltwebstatic.com/b-2.jpg', '2:2': 'https://img.ltwebstatic.com/c-2.jpg', '0:5': 'https://img.ltwebstatic.com/a-5.jpg' } },
    ...o,
  };
};
test.describe('SHEIN Listings Phase 4 review fixes — the planner (pure)', () => {
  test('F2: an unmapped vendor BLOCKS; “no brand” only for a generic vendor (never a known brand); a brand hidden by SHEIN’s rules blocks', async () => {
    const { planPublish, isKnownBrand } = await import('../src/lib/sheinPublish.js');
    const optional = { ...P4FILL, fill_in_standard_list: [{ field_key: 'brand_code', required: false, show: true }] };
    const line = (r) => r.checklist.find((l) => l.key === 'brand');
    let r = planPublish(p4input({ brand: null, fill: optional }));
    expect(r.body).toBe(null);
    expect(line(r)).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'brand_unset', params: expect.objectContaining({ known: true }) })] });
    r = planPublish(p4input({ brand: { noBrand: true }, fill: optional }));                                       // "E2E Nike" is a known brand: no-brand ignored
    expect(line(r).ok).toBe(false);
    const generic = p4input({ brand: { noBrand: true }, fill: optional }); generic.product.vendor = 'E2E Workshop'; generic.product.title = 'Workshop Leather Slide';   // N1: a title naming Nike would block
    r = planPublish(generic);
    expect(r.body).toBeTruthy(); expect(r.body.brand_code).toBeUndefined();
    expect(line(r)).toMatchObject({ ok: true, blockers: [expect.objectContaining({ code: 'brand_none' })] });
    r = planPublish(p4input({ fill: { ...P4FILL, fill_in_standard_list: [{ field_key: 'brand_code', required: false, show: false }] } }));
    expect(line(r)).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'brand_not_authorized', params: expect.objectContaining({ why: 'hidden_by_rules' }) })] });
    expect([isKnownBrand('Nike'), isKnownBrand('NEW BALANCE'), isKnownBrand('On Running'), isKnownBrand('Acme Footwear')]).toEqual([true, true, true, false]);
  });
  test('the checklist: a line not read from SHEIN is null (“not read yet”) — never ✓ by default', async () => {
    const { planPublish } = await import('../src/lib/sheinPublish.js');
    const r = planPublish(p4input({ fill: null, template: null, gates: {}, images: null, takenChecked: false, readiness: true }));
    const st = Object.fromEntries(r.checklist.map((l) => [l.key, l.ok]));
    expect(st).toMatchObject({ store: null, quota: null, shelf: null, site: null, brand: null, title: null, fields: null, colour: null, attributes: null, size_chart: null, sizes: null, prices: null, photos: null, skus: null, shopify: true, box: true, category: true });
  });
  test('S1/S2/S3/S6/S7/S9: no empty image_info; unit strings parsed (grams allowed); SHEIN’s emoji range; 1Y–3Y = PS; a brand’s own quota; the SKC title limit', async () => {
    const { planPublish, sizeGroupOf, cleanTitle, fillRules } = await import('../src/lib/sheinPublish.js');
    // S1: new plan with nothing at SPU level → no image_info at all (never an empty list)
    const r1 = planPublish(p4input({ fill: { ...P4FILL, picture_config_list: [{ field_key: 'spu_image_detail_show', is_true: false }, { field_key: 'skc_image_detail_required', is_true: true }, { field_key: 'skc_image_square_required', is_true: true }] } }));
    expect(r1.body.is_spu_pic).toBe(true); expect(r1.body.image_info).toBeUndefined();
    // S2
    expect(fillRules({ weight_config: { unit_list: ['g', 'lb'] } }).problems).toEqual([]);
    expect(fillRules({ weight_config: { unit_list: ['lb', 'oz'] } }).problems[0]).toMatchObject({ code: 'no_weight', params: { why: 'unit' } });
    expect(fillRules({ weight_config: { something: 7 } }).notes[0].code).toBe('unit_unverified');
    // S3
    expect(cleanTitle('Jordan ⟿ 1 ✔ Retro')).toBe('Jordan 1 Retro');
    // S6
    expect(['1Y', '3Y', '3.5Y', '6Y'].map(sizeGroupOf)).toEqual(['child', 'child', 'youth', 'youth']);
    // S7: the store's quota is used up, but the brand is quota-exempt
    const r7 = planPublish(p4input({ gates: { ...p4input().gates, quota: { isControlled: true, availableQuota: 0 } }, brandQuota: { isControlled: false } }));
    expect(r7.body).toBeTruthy(); expect(r7.plan.quota).toMatchObject({ controlled: false, brandExempt: true });
    expect(planPublish(p4input({ gates: { ...p4input().gates, quota: { isControlled: true, availableQuota: 0 } } })).checklist.find((l) => l.key === 'quota').ok).toBe(false);
    // S9: SHEIN requires an SKC title with a shorter English limit
    const r9 = planPublish(p4input({ fill: { ...P4FILL, fill_in_standard_list: [...P4FILL.fill_in_standard_list.filter((f) => f.field_key !== 'skc_title'), { field_key: 'skc_title', required: true, show: true }], language_title_max_length_list: [{ language: 'en', max_length: 20 }] } }));
    expect(r9.checklist.find((l) => l.key === 'title')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'title_too_long', params: expect.objectContaining({ why: 'skc_title', max: 20 }) })] });
  });
});

test.describe.serial('SHEIN Listings Phase 4 review fixes — publish end to end', () => {
  let L; let D; let auth; let png; const stocked = []; const savedRows = {}; let started;
  const STORE_KINDS = ['publish_perm', 'publish_quota', 'shelf_quota', 'site_list', 'brands', 'category_tree'];
  const img = (n) => [1, 2, 3].map((i) => ({ url: `https://cdn.e2e.test/r${n}-${i}.png`, width: 1200, height: 800 }));
  const prod = (n, title, vendor, variants) => ({ productId: gidP(n), title, handle: `e2e-${n}`, vendor, productType: 'E2E Sneakers', tags: [], status: 'ACTIVE', updatedAt: '2026-10-27T12:00:00Z',
    image: img(n)[0].url, imageCount: 3, style: null, descriptionHtml: '<p>Leather.</p>', images: img(n),
    variants: variants.map(([v, sku, size, price, qty]) => ({ variantId: gidV(v), sku, size, price: String(price), compareAt: null, qty, barcode: null, weightG: null })) });
  const SHOP = () => [...SHOPIFY(),
    prod(7711, 'Nike Air Max 1 (RV0001-001)', 'E2E Nike', [[771109, 'RA-9', '9', 130, 1]]),
    prod(7712, 'Nike Air Max 90 (RV0002-001)', 'E2E Nike', [[771209, 'RB-9', '9', 130, 1]]),
    prod(7713, 'Workshop Slide (RV0003-001)', 'E2E Workshop', [[771309, 'RC-9', '9', 40, 1]])];
  const io = () => ({ ...p2IO(L.IO, { shopify: SHOP, stock: stocked }), recentShelf: async () => new Set(), fetchImage: async () => png, hostImage: async (key) => `https://r2.e2e.test/${key}` });
  const finished = async (id) => { await waitFor(async () => { const j = await D.getListingJob(id); return !['queued', 'running'].includes(j.status) && !L.listingJobRunning(); }); return D.getListingJob(id); };
  const preview = async (ns) => { const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p4r', scope: { productIds: ns.map(gidP), ops: ['publish'], convertPhotos: true }, io: io() }); jobsMade.add(j.id); return finished(j.id); };
  const run = async (pid) => { const j = await L.startRunJob({ previewJobId: pid, by: 'e2e-p4r', io: io() }); jobsMade.add(j.id); return finished(j.id); };
  const items = async (jobId) => (await D.listListingJobItems(jobId, { limit: 1000 })).map((i) => ({ ...i, n: Number(i.shopify_product_id.split('/').pop()) }));
  const one = async (jobId, n) => (await items(jobId)).find((i) => i.n === n);
  const reset = async () => { fake.p4.pending.clear(); await pool.query(`UPDATE shein_listing_products SET spu = NULL, review_version = NULL WHERE shopify_product_id = ANY($1::text[])`, [[7711, 7712, 7713].map(gidP)]);
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by = 'e2e-p4r' AND kind = 'run'`); await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind IN ('publish_perm','publish_quota','shelf_quota','site_list')`); };

  test.beforeAll(async () => {
    if (!pool || !secretsOk || foreign) return;
    L = await import('../api/_lib/shein-listing.js'); D = await import('../api/_lib/db.js');
    const { createCanvas } = await import('@napi-rs/canvas');
    const c = createCanvas(1200, 800); c.getContext('2d').fillRect(0, 0, 1200, 800); png = await c.encode('png');
    const { signToken } = await import('../api/_lib/util.js');
    auth = { ph: { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` },
      admin: { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` } };
    started = new Date();
    for (const k of STORE_KINDS) savedRows[k] = (await pool.query(`SELECT payload FROM shein_listing_cache WHERE kind = $1 AND key = 'store'`, [k])).rows[0] || null;
    savedRows.box = (await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_box_defaults'`)).rows[0] || null;
    const { rows } = await pool.query(`SELECT id FROM shein_listing_jobs WHERE started_by LIKE 'e2e-p%'`);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id)]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`); await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_category_map WHERE shopify_product_type LIKE 'E2E%'`); await pool.query(`DELETE FROM shein_brand_map WHERE vendor LIKE 'e2e%'`);
    await pool.query(`DELETE FROM shein_attr_defaults WHERE product_type_id = $1`, [P4TYPE]);
    fake.p2 = P2(); fake.p4 = P4();
    const snap = await L.startListingJob({ kind: 'snapshot', by: 'e2e-p4r', io: testIO(L.IO, { shopify: SHOP }) }); jobsMade.add(snap.id); await finished(snap.id);
    // everything a person sets once, so the products are sendable
    const { categoryTree, saveBoxDefaults, brandList } = await import('../api/_lib/shein-publish.js');
    await categoryTree(io(), { source: 'e2e' }, true); await brandList(io(), { source: 'e2e' }, true);
    await D.saveCategoryMap({ productType: 'E2E Sneakers', sizeGroup: 'adult', categoryId: P4CAT, productTypeId: P4TYPE, categoryPath: 'E2E' }, 'E2E PH');
    await D.saveBrandMap({ vendor: 'E2E Nike', brandCode: 'NIKE01', brandName: 'Nike' }, 'E2E PH');
    await D.saveAttrDefault({ productTypeId: P4TYPE, attributeId: 7000, valueIds: [7002] }, 'E2E PH');
    await saveBoxDefaults({ adult: { length: '33', width: '21', height: '12', weight: 1400 }, youth: { length: '30', width: '19', height: '11', weight: 1000 }, child: { length: '27', width: '17', height: '10', weight: 800 }, toddler: { length: '24', width: '16', height: '9', weight: 600 } }, 'Alex');
  });
  test.beforeEach(() => { test.skip(!pool || !secretsOk || foreign, 'needs the database + BUY_GC_KEY (and no real SHEIN Listings data)'); });
  test.afterAll(async () => {
    fake.p4 = null; fake.p2 = null;
    if (!pool || !started) return;
    await pool.query(`DELETE FROM shein_listing_cache WHERE fetched_at >= $1 AND kind IN ('pic','assoc_rules','fill_standard','attr_template','custom_perm','spu','cat_suggest')`, [started]);
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = ANY($1::text[]) AND key = 'store'`, [STORE_KINDS]);
    for (const k of STORE_KINDS) if (savedRows[k]) await pool.query(`INSERT INTO shein_listing_cache (kind, key, payload) VALUES ($1, 'store', $2)`, [k, JSON.stringify(savedRows[k].payload)]);
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_box_defaults'`);
    if (savedRows.box) await pool.query(`INSERT INTO app_settings (key, value) VALUES ('shein_box_defaults', $1)`, [savedRows.box.value]);
    await pool.query(`DELETE FROM shein_category_map WHERE shopify_product_type LIKE 'E2E%'`); await pool.query(`DELETE FROM shein_brand_map WHERE vendor LIKE 'e2e%'`);
    await pool.query(`DELETE FROM shein_attr_defaults WHERE product_type_id = $1`, [P4TYPE]);
  });

  test('F1: a request that never reached SHEIN — two looks (the second ≥ 30 min after the send) find nothing → only then an admin may Send again; it goes once', async ({ request }) => {
    await reset();
    fake.p4.drop = 1;
    const pv0 = await preview([7711]);
    expect(await one(pv0.id, 7711), JSON.stringify((await one(pv0.id, 7711))?.blockers)).toMatchObject({ status: 'done' });
    const job = await run(pv0.id);
    let it = await one(job.id, 7711);
    expect(it).toMatchObject({ status: 'failed', blockers: [expect.objectContaining({ code: 'publish_unconfirmed' })] });
    expect(fake.p4.dropped).toBe(1); expect(fake.p4.published || []).toHaveLength(0);
    // PH may look (read-only, through the endpoint); nothing found, Send again stays locked
    const look1 = await (await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'look_again', itemIds: [it.id] } })).json();
    expect(look1.results).toEqual([expect.objectContaining({ found: false, sendAgainOk: false, looks: 1 })]);
    expect((await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'send_again', itemIds: [it.id] } })).status()).toBe(403);
    expect(await L.sendAgainPublish([it.id], { io: io(), by: 'Alex' })).toEqual([expect.objectContaining({ refused: expect.stringMatching(/Look again first/) })]);
    // a second look too soon still doesn't unlock it
    expect((await L.lookAgainPublish([it.id], { io: io(), by: 'E2E PH' }))[0]).toMatchObject({ found: false, sendAgainOk: false, looks: 2 });
    await pool.query(`UPDATE shein_listing_job_items SET sent_at = now() - interval '31 minutes' WHERE id = $1`, [it.id]);
    expect((await L.lookAgainPublish([it.id], { io: io(), by: 'E2E PH' }))[0]).toMatchObject({ found: false, sendAgainOk: true, looks: 3 });
    it = await one(job.id, 7711);
    expect(it.blockers[0]).toMatchObject({ code: 'publish_unconfirmed', params: expect.objectContaining({ sendAgainOk: true }) });
    expect(await L.sendAgainPublish([it.id], { io: io(), by: 'Alex' })).toEqual([expect.objectContaining({ sent: true })]);
    await finished(job.id);
    expect(await one(job.id, 7711)).toMatchObject({ status: 'in_review', spu: expect.stringMatching(/^E2ENEW/) });
    expect(fake.p4.published).toHaveLength(1);                                  // sent exactly once
  });

  test('F1: with a lagging seller-SKU check a look finds nothing — still never resent by itself; once SHEIN shows it, Look again → In review', async () => {
    await reset();
    fake.p4.noAnswer = 1; fake.p4.lag = true;
    const before = fake.p4.published.length;
    const job = await run((await preview([7712])).id);
    const it = await one(job.id, 7712);
    expect(it.status).toBe('failed');
    expect((await L.lookAgainPublish([it.id], { io: io(), by: 'E2E PH' }))[0]).toMatchObject({ found: false });
    await L.listingFollowUp({ io: io(), force: true });
    expect(fake.p4.published.length).toBe(before + 1);                          // one publish, never a second
    fake.p4.lag = false;
    expect((await L.lookAgainPublish([it.id], { io: io(), by: 'E2E PH' }))[0]).toMatchObject({ found: true });
    expect((await one(job.id, 7712)).status).toBe('in_review');
  });

  test('F2 end to end: a generic vendor marked “no brand” goes up without brand_code; a known one can’t be marked', async ({ request }) => {
    await reset();
    const post = (data) => request.post('/api/shein/listing-maps?type=brand', { headers: auth.ph, data });
    expect((await post({ action: 'no_brand', vendor: 'E2E Nike' })).status()).toBe(400);
    fake.p4.fill = { ...P4FILL, fill_in_standard_list: [{ field_key: 'brand_code', required: false, show: true }] };
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'fill_standard' AND key = $1`, [String(P4CAT)]);
    let it = await one((await preview([7713])).id, 7713);
    expect(it.plan.checklist.find((l) => l.key === 'brand')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'brand_unset' })] });
    expect((await (await post({ action: 'no_brand', vendor: 'E2E Workshop' })).json()).map).toMatchObject({ vendor: 'e2e workshop', no_brand: true, brand_code: null });
    it = await one((await preview([7713])).id, 7713);
    expect(it.status).toBe('done');
    expect(it.body.brand_code).toBeUndefined();
    const job = await run((await preview([7713])).id);
    expect((await one(job.id, 7713)).status).toBe('in_review');                // the fake accepts it: brand optional here
    fake.p4.fill = null; await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'fill_standard' AND key = $1`, [String(P4CAT)]);
  });

  test('S4 + S8: a dry run judges each product alone (quota 1, 2 products → both ready; uses 2); the category suggestion is cached per product', async () => {
    await reset();
    fake.p4.quota = { isControlled: true, availableQuota: 1, totalQuota: 10, usedCount: 9 };
    const pv = await preview([7711, 7712]);
    expect((await items(pv.id)).map((i) => i.status)).toEqual(['done', 'done']);
    expect(pv.counts).toMatchObject({ quota_uses: 2, quota_available: 1 });
    fake.p4.quota = { isControlled: true, availableQuota: 5, totalQuota: 10, usedCount: 5 };
    await pool.query(`DELETE FROM shein_category_map WHERE shopify_product_type = 'E2E Sneakers'`);
    const before = fake.p4.calls.filter((c) => c === '/open-api/goods/image-category-suggestion').length;
    await preview([7711]); await preview([7711]);
    expect(fake.p4.calls.filter((c) => c === '/open-api/goods/image-category-suggestion').length - before).toBe(1);
    await D.saveCategoryMap({ productType: 'E2E Sneakers', sizeGroup: 'adult', categoryId: P4CAT, productTypeId: P4TYPE, categoryPath: 'E2E' }, 'E2E PH');
  });

  test('S10 + S5: new picture plans A and B, supplier_code at SPU level, filtered_result and an mcc block as SHEIN answers them; approved-but-not-shown is capped', async () => {
    for (const [plan, extra] of [[P4PLAN_A, {}], [P4PLAN_B, { supplier_code_in_spu_dimension: true }]]) {
      await reset();
      fake.p4.fill = { ...P4FILL, picture_config_list: plan, ...extra };
      await pool.query(`DELETE FROM shein_listing_cache WHERE kind IN ('fill_standard','pic')`);
      fake.p4.answer = 'filtered';
      const job = await run((await preview([7711])).id);
      const it = await one(job.id, 7711);
      expect(it, `${it.error}`).toMatchObject({ status: 'in_review' });          // the fake validated the image layout for the plan
      expect(it.body.is_spu_pic).toBe(true);
      if (extra.supplier_code_in_spu_dimension) expect(it.body.supplier_code).toBe('SB12-P7711');
      expect(it.blockers.map((b) => b.params?.sheinMessage)).toEqual([expect.stringMatching(/SHEIN dropped: skc: competing_product_link dropped/)]);
    }
    fake.p4.fill = null; await pool.query(`DELETE FROM shein_listing_cache WHERE kind IN ('fill_standard','pic')`);
    await reset();
    fake.p4.answer = 'mcc2';
    let job = await run((await preview([7712])).id);
    expect(await one(job.id, 7712)).toMatchObject({ status: 'failed', idem_key: null, error: 'Governance: this brand is blocked for the store' });
    // S5: approved, but spu-info never shows the product → an Error after 24 h (not a wait for ever)
    await reset();
    job = await run((await preview([7712])).id);
    const it = await one(job.id, 7712);
    fake.p4.hist[`${it.spu}|${it.version}`] = { state: 2 };                      // approved; SHEIN[spu] never appears
    await L.listingFollowUp({ io: io(), force: true });
    expect((await one(job.id, 7712)).response.approved_seen_at).toBeTruthy();
    await pool.query(`UPDATE shein_listing_job_items SET response = jsonb_set(response, '{approved_seen_at}', to_jsonb((now() - interval '25 hours')::text)) WHERE id = $1`, [it.id]);
    await L.listingFollowUp({ io: io(), force: true });
    expect(await one(job.id, 7712)).toMatchObject({ status: 'failed', error: expect.stringMatching(/never showed on SHEIN in 24 h/) });
  });

  // ---- final fix batch: security review H1/H2 + Phase 4 re-review G1/G2 ----
  test('G1: while a publish of a product is unconfirmed, a NEW dry run (even with a changed body) can’t publish it, and its readiness says so', async () => {
    await reset();
    fake.p4.drop = 1;
    const sent0 = (fake.p4.published || []).length;
    const job = await run((await preview([7711])).id);
    const first = await one(job.id, 7711);
    expect(first).toMatchObject({ status: 'failed', blockers: [expect.objectContaining({ code: 'publish_unconfirmed' })] });
    await pool.query(`UPDATE shein_listing_products SET title_override = 'Nike Air Max 1 For SHEIN' WHERE shopify_product_id = $1`, [gidP(7711)]);   // the body changes
    const it = await one((await preview([7711])).id, 7711);
    expect(it).toMatchObject({ status: 'skipped', body: null });
    expect(it.plan.checklist.find((l) => l.key === 'flight')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'publish_unconfirmed', params: expect.objectContaining({ itemId: Number(first.id), other: true }) })] });
    await L.recomputeStored({ io: io() });
    const row = (await D.getListingProduct(gidP(7711))).product;
    expect((row.blockers || []).map((b) => b.code)).toContain('publish_unconfirmed');
    expect((fake.p4.published || []).length).toBe(sent0);                     // nothing reached SHEIN
    await pool.query(`UPDATE shein_listing_products SET title_override = NULL WHERE shopify_product_id = $1`, [gidP(7711)]);
  });

  test('G2: a coded “系统异常” after the publish is unconfirmed (key kept, never resent) — not a refusal; Look again finds it', async () => {
    await reset();
    fake.p4.sysError = true;
    const before = (fake.p4.published || []).length;
    const job = await run((await preview([7712])).id);
    const it = await one(job.id, 7712);
    expect(it).toMatchObject({ status: 'failed', blockers: [expect.objectContaining({ code: 'publish_unconfirmed' })] });
    expect(it.idem_key).toBeTruthy();
    expect(it.error).toMatch(/system error/);
    expect(fake.p4.published.length).toBe(before + 1);
    expect((await L.lookAgainPublish([it.id], { io: io(), by: 'E2E PH' }))[0]).toMatchObject({ found: true });
    expect((await one(job.id, 7712)).status).toBe('in_review');
    expect(fake.p4.published.length).toBe(before + 1);                          // one publish, never a second
  });

  test('H2: a dry run a PH user starts converts NO photos (no R2, no transform-pic) and sends nothing; the photo line stays “not read yet”', async () => {
    await reset();
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'pic'`);
    const hosted = []; const t0 = fake.p4.calls.filter((c) => c === '/open-api/goods/transform-pic').length;
    const j = await L.startListingJob({ kind: 'preview', by: 'e2e-p4r', scope: { productIds: [gidP(7711)], ops: ['publish'], convertPhotos: false },
      io: { ...io(), hostImage: async (key) => { hosted.push(key); return `https://r2.e2e.test/${key}`; } } });
    jobsMade.add(j.id); await finished(j.id);
    const it = await one(j.id, 7711);
    expect(it).toMatchObject({ status: 'skipped', body: null });
    expect(it.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'photos_need_priv' })]));
    expect(it.plan.checklist.find((l) => l.key === 'photos').ok).toBe(null);
    expect(it.plan.photos).toMatchObject({ converted: false, why: 'needs_priv' });
    expect(hosted).toEqual([]);
    expect(fake.p4.calls.filter((c) => c === '/open-api/goods/transform-pic').length).toBe(t0);
    const { renderBlocker } = await import('../src/lib/sheinListings.js');
    expect(renderBlocker({ code: 'photos_need_priv' }).fix).toBe('Photos are converted when an admin or Connect integrations holder runs the dry run.');
  });

  test('H2: the daily transform-pic cap (setting shein_transform_cap, EST day) → “photo limit used up”, nothing more converted', async () => {
    await reset();
    await pool.query(`DELETE FROM shein_listing_cache WHERE kind = 'pic'`);
    const saved = (await pool.query(`SELECT value FROM app_settings WHERE key = 'shein_transform_cap'`)).rows[0] || null;
    const { countTransformPicToday } = D;
    const { readTransformCap } = await import('../api/_lib/shein-publish.js');
    await pool.query(`DELETE FROM app_settings WHERE key = 'shein_transform_cap'`);
    expect(await readTransformCap()).toBe(500);                                  // unset = the default (never 0)
    const used = await countTransformPicToday();
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('shein_transform_cap', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(used)]);
    try {
      const t0 = fake.p4.calls.filter((c) => c === '/open-api/goods/transform-pic').length;
      const it = await one((await preview([7711])).id, 7711);
      expect(it).toMatchObject({ status: 'skipped', body: null });
      expect(it.plan.checklist.find((l) => l.key === 'photos')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'photo_cap_reached', params: { cap: used, used } })] });
      expect(fake.p4.calls.filter((c) => c === '/open-api/goods/transform-pic').length).toBe(t0);
    } finally {
      await pool.query(`DELETE FROM app_settings WHERE key = 'shein_transform_cap'`);
      if (saved) await pool.query(`INSERT INTO app_settings (key, value) VALUES ('shein_transform_cap', $1)`, [saved.value]);
    }
  });

  test('H1: stopping or resuming a RUN needs an admin / Connect integrations (403 for PH); a resume never overwrites confirmed_by', async ({ request }) => {
    const mk = async (status) => (await pool.query(`INSERT INTO shein_listing_jobs (kind, mode, status, scope, started_by, confirmed_by, phase, lease_owner, lease_until)
      VALUES ('run', 'run', $1, '{}'::jsonb, 'e2e-p4r', 'Alex', 'e2e', $2, $3) RETURNING id`, [status, status === 'running' ? 'e2e-other-proc' : null, status === 'running' ? new Date(Date.now() + 120_000) : null])).rows[0].id;
    const stopped = await mk('stopped');
    const r1 = await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'resume', jobId: Number(stopped) } });
    expect(r1.status()).toBe(403); expect((await r1.json()).error).toMatch(/Connect integrations/);
    const running = await mk('running');
    try {
      const r2 = await request.post('/api/shein/listings', { headers: auth.ph, data: { action: 'stop', jobId: Number(running) } });
      expect(r2.status()).toBe(403);
      expect((await D.getListingJob(running)).stop_requested).toBe(false);
    } finally { await pool.query(`DELETE FROM shein_listing_jobs WHERE id = $1`, [running]); }
    const resumed = await D.resumeListingJob(Number(stopped), 'E2E Lead');
    expect(resumed).toMatchObject({ status: 'queued', confirmed_by: 'Alex', resumed_by: 'E2E Lead' });
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = $1`, [stopped]);
    // a snapshot / preview job: the resumer is recorded as before (PH may resume those)
    const pv = (await pool.query(`INSERT INTO shein_listing_jobs (kind, mode, status, scope, started_by, phase) VALUES ('preview', 'dry', 'stopped', '{}'::jsonb, 'e2e-p4r', 'e2e') RETURNING id`)).rows[0].id;
    expect(await D.resumeListingJob(Number(pv), 'E2E PH')).toMatchObject({ confirmed_by: 'E2E PH', resumed_by: 'E2E PH' });
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = $1`, [pv]);
  });
});

test.describe('SHEIN Listings final fixes — security + re-review (pure)', () => {
  test('N1: “no brand” is refused when the Shopify TITLE names a known brand (vendor is a shop name)', async () => {
    const { planPublish, titleBrand } = await import('../src/lib/sheinPublish.js');
    expect([titleBrand('Nike Air Max 90'), titleBrand('Retro Air Jordan 1 High'), titleBrand('On Cloud 5'), titleBrand('Slip on canvas shoe'), titleBrand('Workshop Slide')]).toEqual(['nike', 'air jordan', 'on', null, null]);
    const optional = { ...P4FILL, fill_in_standard_list: [{ field_key: 'brand_code', required: false, show: true }] };
    const shop = p4input({ brand: { noBrand: true }, fill: optional }); shop.product.vendor = 'E2E Kicks Shop';   // title: "Nike Air Force 1 …"
    let r = planPublish(shop);
    expect(r.body).toBe(null);
    expect(r.checklist.find((l) => l.key === 'brand')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'brand_unset', params: expect.objectContaining({ why: 'title_brand', titleBrand: 'nike', known: true }) })] });
    shop.product.title = 'Workshop Slide (RV0003-001)';
    r = planPublish(shop);
    expect(r.body).toBeTruthy(); expect(r.body.brand_code).toBeUndefined();
  });
  test('N2: SHEIN’s brand list unread → the Brand line is “not read yet” (never authorised) and nothing is sendable', async () => {
    const { planPublish } = await import('../src/lib/sheinPublish.js');
    const r = planPublish(p4input({ brand: { code: 'NIKE01', name: 'Nike', listed: null } }));
    expect(r.body).toBe(null);
    expect(r.checklist.find((l) => l.key === 'brand')).toMatchObject({ ok: null, blockers: [expect.objectContaining({ code: 'brand_list_unread' })] });
    expect(planPublish(p4input({ brand: { code: 'NIKE01', name: 'Nike', listed: null }, readiness: true })).checklist.find((l) => l.key === 'brand').ok).toBe(null);
  });
  test('N3 + G1 + the photo cap: a non-English store blocks; another unconfirmed publish blocks (line 18); the daily cap blocks photos', async () => {
    const { planPublish } = await import('../src/lib/sheinPublish.js');
    let r = planPublish(p4input({ fill: { ...P4FILL, default_language: 'de' } }));
    expect(r.body).toBe(null);
    expect(r.checklist.find((l) => l.key === 'title')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'language_not_en', params: { language: 'de' } })] });
    r = planPublish(p4input({ unconfirmed: { itemId: 9, jobId: 3 } }));
    expect(r.body).toBe(null);
    expect(r.checklist.find((l) => l.key === 'flight')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'publish_unconfirmed', params: expect.objectContaining({ itemId: 9, jobId: 3 }) })] });
    r = planPublish(p4input({ images: { ...p4input().images, capReached: { cap: 500, used: 500 } } }));
    expect(r.body).toBe(null);
    expect(r.checklist.find((l) => l.key === 'photos')).toMatchObject({ ok: false, blockers: [expect.objectContaining({ code: 'photo_cap_reached' })] });
    expect(planPublish(p4input()).body).toBeTruthy();                                       // the baseline still publishes
  });
  test('M2: photos are fetched only over https from the Shopify CDN / our R2 host; no redirect to another host; 15 MB cap while streaming', async () => {
    const { fetchImage, photoSourceAllowed } = await import('../api/_lib/shein-publish.js');
    expect(['https://cdn.shopify.com/s/files/1/x.jpg', 'http://cdn.shopify.com/x.jpg', 'https://evil.example/x.jpg', 'https://cdn.shopify.com:8443/x.jpg', 'https://u:p@cdn.shopify.com/x.jpg', 'file:///etc/passwd'].map(photoSourceAllowed))
      .toEqual([true, false, false, false, false, false]);
    const res = (status, { headers = {}, body = Buffer.from('img') } = {}) => new Response(status >= 300 && status < 400 ? null : body, { status, headers });
    await expect(fetchImage('https://evil.example/x.jpg', { fetchFn: async () => res(200) })).rejects.toThrow(/not downloaded/);
    await expect(fetchImage('https://cdn.shopify.com/a.jpg', { fetchFn: async () => res(302, { headers: { location: 'https://169.254.169.254/latest' } }) })).rejects.toThrow(/redirected away/);
    const seen = [];
    expect(String(await fetchImage('https://cdn.shopify.com/a.jpg', { fetchFn: async (u, o) => { seen.push([u, o.redirect]); return seen.length === 1 ? res(301, { headers: { location: '/b.jpg' } }) : res(200); } }))).toBe('img');
    expect(seen).toEqual([['https://cdn.shopify.com/a.jpg', 'manual'], ['https://cdn.shopify.com/b.jpg', 'manual']]);
    await expect(fetchImage('https://cdn.shopify.com/a.jpg', { maxBytes: 10, fetchFn: async () => res(200, { headers: { 'content-length': '999' } }) })).rejects.toThrow(/too large/);
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(8)); c.close(); } });
    await expect(fetchImage('https://cdn.shopify.com/a.jpg', { maxBytes: 20, fetchFn: async () => new Response(stream, { status: 200 }) })).rejects.toThrow(/too large/);
  });
  test('G2 + M3 helpers: SHEIN “system error” answers are told apart from refusals; the per-user throttle', async () => {
    const { isSystemError, userThrottle } = await import('../api/_lib/shein-listing.js');
    expect(['系统异常', 'System error, please retry', 'internal server problem', '服务异常'].map((m) => isSystemError({ sheinMsg: m }))).toEqual([true, true, true, true]);
    expect(['Detail image must be at least 900 px', 'Product verification failed'].map((m) => isSystemError({ sheinMsg: m }))).toEqual([false, false]);
    const u = { id: `e2e-throttle-${Date.now()}` }; const now = 1_000_000;
    for (let i = 0; i < 3; i++) expect(userThrottle(u, 't', { max: 3, now }).ok).toBe(true);
    expect(userThrottle(u, 't', { max: 3, now: now + 1000 })).toEqual({ ok: false, retryInSec: 59 });
    expect(userThrottle({ id: 'someone-else' }, 't', { max: 3, now }).ok).toBe(true);       // per user
    expect(userThrottle(u, 't', { max: 3, now: now + 60_001 }).ok).toBe(true);             // the window passes
  });
});

/* ------------------------- Phase 5 — the 4seller cut-over + go-live ------------------------- */

test.describe('SHEIN Listings Phase 5 — the cut-over checks (pure)', () => {
  const at = (s) => new Date(s);
  const nights = (from, to) => { const out = []; for (let d = Date.parse(`${from}T12:00:00Z`); d <= Date.parse(`${to}T12:00:00Z`); d += 86_400_000) out.push({ id: out.length + 1, status: 'done', created_at: new Date(d - 4 * 3600_000).toISOString() }); return out; };   // 08:00 UTC = 03:00/04:00 EST that day
  test('a shoe is answered by Synced / In review / a blocker with a reason / a person’s “Don’t list” — not by Not on SHEIN or a Shopify draft', async () => {
    const { productAnswered } = await import('../src/lib/sheinCutover.js');
    const lvl = (c) => BLOCKERS[c]?.level || 'blocked';
    expect(productAnswered({ status: 'synced' }, lvl)).toBe(true);
    expect(productAnswered({ status: 'in_review' }, lvl)).toBe(true);
    expect(productAnswered({ status: 'blocked', blockers: [{ code: 'no_category' }] }, lvl)).toBe(true);
    expect(productAnswered({ status: 'blocked', blockers: [{ code: 'custom_size' }] }, lvl)).toBe(false);   // a note names nothing
    expect(productAnswered({ status: 'not_on_shein', blockers: [] }, lvl)).toBe(false);
    expect(productAnswered({ status: 'excluded', excluded: true }, lvl)).toBe(true);
    expect(productAnswered({ status: 'excluded', excluded: false }, lvl)).toBe(false);
  });
  test('not started: every line ✕ but (d); the 30 days, nights and shoes start with the “4seller paused” tick', async () => {
    const { evaluateCutover } = await import('../src/lib/sheinCutover.js');
    const c = evaluateCutover({ ticks: {}, facts: { interrupted: [], sizes: { snapshot: true, toAdd: 0, sheinBlocked: 0 } }, now: at('2026-11-20T15:00:00Z') });
    expect(c).toMatchObject({ started: false, ready: false, daysLeft: 30 });
    expect(c.items.map((i) => [i.key, i.ok])).toEqual([['a', false], ['b', false], ['c', false], ['d', true], ['e', true]]);
  });
  test('day 12: a missed night, a late shoe and sizes we could still add are ✕; a shoe inside its 2 days is still counting', async () => {
    const { evaluateCutover } = await import('../src/lib/sheinCutover.js');
    const now = at('2026-11-20T15:00:00Z');   // 10:00 EST
    const c = evaluateCutover({ now,
      ticks: { paused_4seller: { by: 'Alex', at: '2026-11-08T14:00:00Z', date: '2026-11-08' }, last_action_4seller: { by: 'Alex', at: '2026-11-08T15:00:00Z', date: '2026-11-10' } },
      facts: {
        newProducts: [
          { shopify_product_id: 'p1', title: 'On time', status: 'synced', first_seen_at: '2026-11-10T12:00:00Z', settled_at: '2026-11-11T12:00:00Z' },
          { shopify_product_id: 'p2', title: 'Late', status: 'blocked', first_seen_at: '2026-11-10T12:00:00Z', settled_at: '2026-11-13T13:00:00Z' },
          { shopify_product_id: 'p3', title: 'Fresh', status: 'not_on_shein', first_seen_at: '2026-11-20T10:00:00Z', settled_at: null },
        ],
        nightly: nights('2026-11-09', '2026-11-20').filter((j) => !j.created_at.startsWith('2026-11-15')),
        interrupted: [{ id: 9, kind: 'snapshot', done: 4, total: 12 }],
        sizes: { snapshot: true, toAdd: 5, sheinBlocked: 2, leftOff: 1, byCode: [{ code: 'size_not_on_shein', sizes: 2 }] },
      } });
    expect(c).toMatchObject({ started: true, startDay: '2026-11-08', dayN: 12, daysLeft: 18, complete: false, ready: false });
    const by = Object.fromEntries(c.items.map((i) => [i.key, i]));
    expect(by.a.ok).toBe(null);   // quiet 10 days of 14
    expect(by.a.detail).toContain('10 days ago (2026-11-10) — 4 more to go');
    expect(by.b.ok).toBe(false);
    expect(by.b.shoes.map((s) => [s.id, s.state])).toEqual([['p2', 'late'], ['p3', 'waiting']]);
    expect(by.c).toMatchObject({ ok: false, nights: { needed: 30, ran: 11, missed: ['2026-11-15'] } });
    expect(by.d.ok).toBe(false);
    expect(by.e.ok).toBe(false);
    expect(by.e.detail).toContain('5 sizes to add · 2 blocked by SHEIN — 3 we could still add');
  });
  test('“Ready to cancel 4seller” only when all five pass after 30 days; before 04:00 EST tonight’s read isn’t owed yet', async () => {
    const { evaluateCutover } = await import('../src/lib/sheinCutover.js');
    const ticks = { paused_4seller: { by: 'Alex', at: '2026-11-08T14:00:00Z', date: '2026-11-08' }, last_action_4seller: { by: 'Alex', at: '2026-11-08T15:00:00Z', date: '2026-11-01' } };
    const facts = { newProducts: [{ shopify_product_id: 'p1', status: 'synced', first_seen_at: '2026-11-10T12:00:00Z', settled_at: '2026-11-10T13:00:00Z' }],
      nightly: nights('2026-11-09', '2026-12-08'), interrupted: [], sizes: { snapshot: true, toAdd: 3, sheinBlocked: 3 } };
    const ok = evaluateCutover({ ticks, facts, now: at('2026-12-10T15:00:00Z') });
    expect(ok).toMatchObject({ complete: true, ready: true, passing: 5, daysLeft: 0 });
    expect(ok.items.find((i) => i.key === 'c').nights).toMatchObject({ ran: 30, missed: [] });
    // day 20, 02:00 EST: last night (the 27th's 03:00) isn't due until 04:00 — counting, not ✕
    const early = evaluateCutover({ ticks, facts: { ...facts, nightly: nights('2026-11-09', '2026-11-27') }, now: at('2026-11-28T07:00:00Z') });
    expect(early.items.find((i) => i.key === 'c').ok).toBe(null);
    expect(early.ready).toBe(false);
  });
  test('go-live: 4seller paused before the first Phase-2 run is read from the two dates; tick dates are EST and never in the future', async () => {
    const { evaluateGolive, validTickDate } = await import('../src/lib/sheinCutover.js');
    const g = (paused, run) => evaluateGolive({ ticks: paused ? { paused_4seller: { at: '2026-11-08T14:00:00Z', date: paused } } : {}, facts: { firstRun: run } }).items.find((i) => i.key === 'paused_first');
    expect(g(null, null).ok).toBe(false);
    expect(g('2026-11-08', null).ok).toBe(true);
    expect(g('2026-11-08', { id: 4, created_at: '2026-11-09T15:00:00Z' }).ok).toBe(true);
    expect(g('2026-11-10', { id: 4, created_at: '2026-11-09T15:00:00Z' })).toMatchObject({ ok: false, detail: expect.stringContaining('before 4seller was paused') });
    const now = at('2026-11-21T03:00:00Z');   // 22:00 EST on the 20th — the 21st in Manila
    expect(validTickDate('2026-11-20', now)).toBe(null);
    expect(validTickDate('2026-11-21', now)).toMatch(/future/);
    expect(validTickDate('11/20/2026', now)).toMatch(/Pick a date/);
  });
});

test.describe.serial('SHEIN Listings Phase 5 — the cut-over + go-live cards (endpoint + page)', () => {
  test.use({ timezoneId: 'Asia/Manila' });
  let auth; let savedTicks = null; let jobId = null; let snapId = null;
  const KEY = 'shein_cutover_ticks';
  const IDS = [gidP(7790), gidP(7791), gidP(7792)];
  const shot = async (page, name) => { if (process.env.SHL_SHOTS) await page.screenshot({ path: `${process.env.SHL_SHOTS}/shein-listings-${name}.png`, fullPage: true }); };
  const card = (page, k) => page.locator(`[data-setup="${k}"]`);
  const line = (page, k, key) => card(page, k).locator(`.shl-co-line[data-line="${key}"]`);
  test.beforeAll(async () => {
    if (!pool || foreign) return;
    const { signToken } = await import('../api/_lib/util.js');
    const tok = (u) => ({ Authorization: `Bearer ${signToken(u)}` });
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, username, pass_hash, role, status, privileges) VALUES ('E2E SHEIN lead', 'e2e_shein_lead', 'x', 'ph_team', 'approved', '{connect_integrations}')
      ON CONFLICT (username) DO UPDATE SET privileges = '{connect_integrations}' RETURNING id`);
    auth = { ph: tok({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' }), wh: tok({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E Warehouse', role: 'warehouse' }),
      lead: tok({ uid: String(u.id), username: 'e2e_shein_lead', name: 'E2E SHEIN lead', role: 'ph_team' }) };
    savedTicks = (await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [KEY])).rows[0] || null;
    await pool.query(`DELETE FROM app_settings WHERE key = $1`, [KEY]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE ${TEST_IDS}`);
    await pool.query(`DELETE FROM shein_listing_products WHERE ${TEST_IDS}`);
    // a new ACTIVE shoe nobody answered (5 days), one answered in an hour, and a shoe on SHEIN with 2 sizes to add (1 SHEIN won't take)
    await pool.query(`INSERT INTO shein_listing_products (shopify_product_id, title, style, shopify_status, status, blockers, first_seen_at, settled_at, spu) VALUES
      ($1, 'E2E Cutover Missed Shoe (CUT001-001)', 'CUT001-001', 'ACTIVE', 'not_on_shein', '[]', now() - interval '5 days', NULL, NULL),
      ($2, 'E2E Cutover Answered (CUT002-001)', 'CUT002-001', 'ACTIVE', 'blocked', '[{"code":"no_category"}]', now() - interval '4 days', now() - interval '4 days' + interval '1 hour', NULL),
      ($3, 'E2E Cutover On SHEIN (CUT003-001)', 'CUT003-001', 'ACTIVE', 'blocked', '[]', NULL, NULL, 'E2ECUT')`, IDS);
    await pool.query(`INSERT INTO shein_listing_variants (row_key, shopify_variant_id, shopify_product_id, seller_sku, shopify_size, shopify_qty, status, blockers) VALUES
      ($1, $1, $3, 'CUT3-4C', '3.5C', 1, 'blocked', '[{"code":"size_not_on_shein"}]'), ($2, $2, $3, 'CUT3-145', '14.5', 1, 'blocked', '[{"code":"size_needs_map"}]')`, [gidV(779201), gidV(779202), IDS[2]]);
    const { rows: [j] } = await pool.query(`INSERT INTO shein_listing_jobs (kind, status, started_by, total, done, phase, finished_at) VALUES ('probe', 'interrupted', 'e2e-p5', 12, 4, 'reading', now()) RETURNING id`);
    jobId = Number(j.id); jobsMade.add(jobId);
    if (!(await pool.query(`SELECT 1 FROM shein_listing_jobs WHERE kind = 'snapshot' AND status = 'done' LIMIT 1`)).rows.length) {
      const { rows: [sj] } = await pool.query(`INSERT INTO shein_listing_jobs (kind, status, started_by, finished_at) VALUES ('snapshot', 'done', 'e2e-p5', now()) RETURNING id`);
      snapId = Number(sj.id); jobsMade.add(snapId);
    }
  });
  test.beforeEach(() => { test.skip(!pool || foreign, 'needs the database (and no real SHEIN Listings data)'); });
  test.afterAll(async () => {
    if (!pool || foreign) return;
    await pool.query(`DELETE FROM app_settings WHERE key = $1`, [KEY]);
    if (savedTicks) await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)`, [KEY, savedTicks.value]);
    await pool.query(`DELETE FROM shein_listing_variants WHERE shopify_product_id = ANY($1::text[])`, [IDS]);
    await pool.query(`DELETE FROM shein_listing_products WHERE shopify_product_id = ANY($1::text[])`, [IDS]);
    await pool.query(`DELETE FROM shein_listing_jobs WHERE id = ANY($1::bigint[])`, [[jobId, snapId].filter(Boolean)]);
  });

  test('saving a product stamps first_seen_at once and settled_at the first time it reads as an answer — never moved after', async () => {
    const D = await import('../api/_lib/db.js');
    const row = (status, blockers) => ({ shopify_product_id: gidP(7793), title: 'E2E settle', shopify_status: 'ACTIVE', status, blockers, counts: {}, variants: [] });
    const get = async () => (await pool.query(`SELECT first_seen_at, settled_at FROM shein_listing_products WHERE shopify_product_id = $1`, [gidP(7793)])).rows[0];
    try {
      await D.saveListingProducts([row('not_on_shein', [])]);
      const a = await get();
      expect(a.first_seen_at).toBeTruthy(); expect(a.settled_at).toBe(null);
      await D.saveListingProducts([row('blocked', [{ code: 'no_category' }])]);
      const b = await get();
      expect(b.first_seen_at).toEqual(a.first_seen_at); expect(b.settled_at).toBeTruthy();
      await D.saveListingProducts([row('not_on_shein', [])]);
      expect((await get()).settled_at).toEqual(b.settled_at);
    } finally { await pool.query(`DELETE FROM shein_listing_products WHERE shopify_product_id = $1`, [gidP(7793)]); }
  });

  test('the endpoint: PH reads (canWrite false), ticks are 403; a lead with Connect integrations ticks — who + when kept, the date checked', async ({ request }) => {
    expect((await request.get('/api/shein/listing-cutover', { headers: auth.wh })).status()).toBe(403);
    const r = await (await request.get('/api/shein/listing-cutover', { headers: auth.ph })).json();
    expect(r).toMatchObject({ ok: true, canWrite: false, cutover: { started: false }, golive: { items: expect.any(Array) } });
    expect(r.golive.items.find((i) => i.key === 'db').ok).toBe(true);
    expect((await request.post('/api/shein/listing-cutover', { headers: auth.ph, data: { action: 'tick', key: 'paused_4seller' } })).status()).toBe(403);
    expect((await request.post('/api/shein/listing-cutover', { headers: auth.lead, data: { action: 'tick', key: 'last_action_4seller', date: '2026-10-01' } })).status()).toBe(400);   // paused first
    expect((await request.post('/api/shein/listing-cutover', { headers: auth.lead, data: { action: 'tick', key: 'nope' } })).status()).toBe(400);
    expect((await request.post('/api/shein/listing-cutover', { headers: auth.lead, data: { action: 'tick', key: 'pilot_phase2', date: '2099-01-01' } })).status()).toBe(400);
    const t = await (await request.post('/api/shein/listing-cutover', { headers: auth.lead, data: { action: 'tick', key: 'pilot_phase2', date: '2026-10-20', note: 'Dunk Low Panda' } })).json();
    expect(t.ticks.pilot_phase2).toMatchObject({ by: 'E2E SHEIN lead', date: '2026-10-20', note: 'Dunk Low Panda', at: expect.any(String) });
    expect(t.golive.items.find((i) => i.key === 'pilot_phase2').ok).toBe(true);
    const u = await (await request.post('/api/shein/listing-cutover', { headers: auth.lead, data: { action: 'untick', key: 'pilot_phase2' } })).json();
    expect(u.ticks.pilot_phase2).toBeUndefined();
  });

  test('PH: both cards render on Setup with the computed lines; every Tick is disabled with the reason', async ({ page }) => {
    await loginAs(page, 'ph_team');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto('/ph/shein-listings?tab=setup');
    await expect(card(page, 'golive')).toContainText('Go-live checklist');
    await expect(line(page, 'golive', 'db')).toHaveAttribute('data-ok', 'yes');
    await expect(line(page, 'golive', 'shein_console_hooks')).toContainText('product_price_audit_status_notice');
    await expect(line(page, 'golive', 'paused_first')).toHaveAttribute('data-ok', 'no');
    await expect(card(page, 'cutover').locator('[data-cutover-sum]')).toContainText('Not started');
    await expect(line(page, 'cutover', 'd')).toHaveAttribute('data-ok', 'no');
    await expect(line(page, 'cutover', 'd').getByRole('button', { name: new RegExp(`Job #${jobId}`) })).toBeVisible();
    await expect(line(page, 'cutover', 'e')).toContainText('2 sizes to add · 1 blocked by SHEIN — 1 we could still add');
    const tick = card(page, 'cutover').locator('[data-tick="paused_4seller"] button', { hasText: 'Tick' });
    await expect(tick).toBeDisabled();
    await expect(tick).toHaveAttribute('title', /Needs an admin/);
    await expect(card(page, 'cutover')).toContainText('An admin, or someone with the Connect integrations privilege, ticks these lines');
    await expect(page.locator('[data-cutover-line]')).toHaveCount(0);   // not started → no strip line
    await shot(page, 'desktop-cutover-ph');
  });

  test('admin ticks “4seller paused” → the strip line + day count; 10 days on, the missed shoe and the 14-day quiet tick read right; links open the shoe / the job', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto('/shein-listings?tab=setup');
    await card(page, 'cutover').locator('[data-tick="paused_4seller"] button', { hasText: 'Tick' }).click();
    await expect(card(page, 'cutover').locator('[data-tick="paused_4seller"]')).toHaveAttribute('data-ticked', 'yes');
    await expect(card(page, 'cutover').locator('[data-tick="paused_4seller"]')).toContainText('Ticked by Alex');
    await expect(card(page, 'cutover').locator('[data-cutover-sum]')).toContainText('Day 0 of 30');
    await expect(page.locator('[data-cutover-line]')).toContainText('4seller cut-over: day 0 of 30');
    // the shoes first seen 4–5 days ago are before the start → not counted yet
    await expect(line(page, 'cutover', 'b')).not.toContainText('E2E Cutover Missed Shoe');
    // move the start back 10 days (as if ticked then) — the window now covers both shoes
    await pool.query(`UPDATE app_settings SET value = jsonb_set(value::jsonb, '{paused_4seller,at}', to_jsonb((now() - interval '10 days')::text))::text WHERE key = $1`, [KEY]);
    await page.reload();
    await expect(card(page, 'cutover').locator('[data-cutover-sum]')).toContainText('Day 10 of 30');
    await expect(card(page, 'cutover').locator('[data-cutover-sum]')).toContainText('20 days left');
    await expect(line(page, 'cutover', 'b')).toHaveAttribute('data-ok', 'no');
    await expect(line(page, 'cutover', 'b').locator(`[data-shoe="${IDS[0]}"]`)).toContainText('no answer for 5 days');
    await expect(line(page, 'cutover', 'b').locator(`[data-shoe="${IDS[1]}"]`)).toHaveCount(0);   // answered in an hour
    await expect(line(page, 'cutover', 'c')).toHaveAttribute('data-ok', 'no');   // no nightly ran here
    await expect(card(page, 'cutover').getByRole('button', { name: 'Start the 30 days again' })).toBeEnabled();
    // 4seller's last action, read off Seller Center's operation log: 20 days ago → ✓ (14 needed)
    const ago = (await pool.query(`SELECT to_char((now() AT TIME ZONE 'America/New_York') - interval '20 days', 'YYYY-MM-DD') AS d`)).rows[0].d;
    const lastTick = card(page, 'cutover').locator('[data-tick="last_action_4seller"]');
    await lastTick.locator('input[type="date"]').fill(ago);
    await lastTick.getByRole('button', { name: 'Tick' }).click();
    await expect(line(page, 'cutover', 'a')).toHaveAttribute('data-ok', 'yes');
    await expect(line(page, 'cutover', 'a')).toContainText(`20 days ago (${ago})`);
    await expect(card(page, 'cutover')).not.toContainText('Ready to cancel 4seller');
    await expect(line(page, 'golive', 'paused_first')).toHaveAttribute('data-ok', 'yes');
    await shot(page, 'desktop-cutover-admin');
    await line(page, 'cutover', 'b').locator(`[data-shoe="${IDS[0]}"] button`).click();
    await expect(page.getByRole('dialog', { name: 'Product details' })).toBeVisible();
    await expect(page).toHaveURL(/product=/);
    await page.goto('/shein-listings?tab=setup');
    await line(page, 'cutover', 'd').getByRole('button', { name: new RegExp(`Job #${jobId}`) }).click();
    await expect(page).toHaveURL(new RegExp(`tab=jobs.*job=${jobId}|job=${jobId}.*tab=jobs`));
  });

  test('390 px: the cards stack, Tick forms go full width, no horizontal scroll', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/shein-listings?tab=setup');
    await expect(card(page, 'cutover').locator('[data-cutover-sum]')).toContainText('Day 10 of 30');
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
    expect(Math.max(w.doc, w.body)).toBeLessThanOrEqual(w.vw);
    const btn = await card(page, 'golive').locator('[data-tick="pilot_phase2"] button', { hasText: 'Tick' }).boundingBox();
    expect(btn.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'phone-cutover');
    if (process.env.SHL_SHOTS) await card(page, 'cutover').screenshot({ path: `${process.env.SHL_SHOTS}/shein-listings-phone-cutover-card.png` });
  });
});
