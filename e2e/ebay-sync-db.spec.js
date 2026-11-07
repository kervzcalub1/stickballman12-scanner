// eBay Sync against the REAL local database (the SQL in api/_lib/db.js ran in no other test), with eBay and
// Shopify mocked: every pass runs for real, and the rows it leaves in ebay_sync_links / _products / _log / _queue /
// _state are read back. Nothing here can reach eBay or Shopify, and DATABASE_URL is the local one from .env.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { IO, reconcilePass, contentPass, createPass, queuePass, runPass, saveSettings, readSettings, buildStatus } from '../api/_lib/ebay-sync.js';
import * as db from '../api/_lib/db.js';
import { TITLE, PROFILE } from './helpers/ebaySyncIO.js';

process.env.EBAY_SYNC_WRITES = 'on';
// It truncates tables, so only ever on this machine's database.
test.skip(!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || ''), 'needs the local database');

const POOL = () => new pg.Pool({ connectionString: process.env.DATABASE_URL });
const BY = 'sqltest';
const T = (id) => `gid://shopify/Product/${id}`;
const rows = [
  { item_id: '9990111', variation_key: 'SQ-A', sku: 'SQ-A', size: '8', price: 100, qty_available: 1, title: TITLE, view_url: 'https://www.ebay.com/itm/9990111' },
  { item_id: '9990111', variation_key: 'SQ-B', sku: 'SQ-B', size: '9', price: 110, qty_available: 2, title: TITLE, view_url: 'https://www.ebay.com/itm/9990111' },
];
const variants = [
  { variantId: 'v-A', productId: T(1), sku: 'SQ-A', size: '8', price: '100.00', qty: 0, status: 'ACTIVE', productTitle: TITLE },
  { variantId: 'v-B', productId: T(1), sku: 'SQ-B', size: '9', price: '130.00', qty: 2, status: 'ACTIVE', productTitle: TITLE },
  { variantId: 'v-N', productId: T(3), sku: 'SQ-N', size: '10', price: '90.00', qty: 3, status: 'ACTIVE', productTitle: 'New Shoe (HQ9999-001)' },
];
const light = [
  { id: T(1), title: TITLE, handle: 'p1', vendor: 'nike', status: 'ACTIVE', updatedAt: '2026-11-01T00:00:00Z', image: null },
  { id: T(3), title: 'New Shoe (HQ9999-001)', handle: 'p3', vendor: 'nike', status: 'ACTIVE', updatedAt: '2026-11-01T00:00:00Z', image: null },
];
const fullProduct = (id) => (id === T(3)
  ? { id, title: 'New Shoe (HQ9999-001)', status: 'ACTIVE', vendor: 'nike', descriptionHtml: '<p>new</p>', images: [{ url: 'u', width: 900, height: 900 }], variants: [{ sku: 'SQ-N', size: '10', barcode: '', price: '90', qty: 3 }] }
  : { id, title: TITLE, status: 'ACTIVE', vendor: 'nike', descriptionHtml: '<p>x</p>', images: [{ url: 'u', width: 900, height: 900 }], variants: [{ sku: 'SQ-A', size: '8', barcode: '', price: '100', qty: 0 }, { sku: 'SQ-B', size: '9', barcode: '', price: '130', qty: 2 }] });

test.describe.serial('eBay Sync: the real SQL', () => {
  let pool; let saved; const calls = []; const alerts = [];
  const stateKeys = ['reconcile', 'content', 'create', 'queue'].map((p) => `ebay_sync_state_${p}`);
  const io = {
    ...IO,
    ebayReady: async () => true, shopifyReady: () => true, flushBudget: async () => {}, budget: async () => ({ used: 10, limit: 5000 }),
    fetchActiveListings: async () => ({ rows }),
    fetchEbayItemContent: async () => ({ status: 'Active', title: 'Old title', description: '<p>x</p>', pictureCount: 1, specificsSet: { name: 'Size', values: ['8', '9'] }, variations: [{ sku: 'SQ-A', quantity: 1, sold: 0 }, { sku: 'SQ-B', quantity: 2, sold: 0 }] }),
    verifyAddFixedPriceItem: async () => ({ ok: true }),
    allVariants: async () => ({ variants }), productsLight: async () => ({ products: light }), collectionIds: async () => ({ ids: new Set([T(1), T(3)]) }),
    productsFull: async (ids) => ({ products: ids.map(fullProduct), missing: [] }),
    stockForSku: async (sku) => ({ levels: [{ available: sku === 'SQ-A' ? 0 : 2 }], tracked: true, productStatus: 'ACTIVE' }),
    productsState: async (ids) => ({ products: new Map(ids.map((i) => [i, { status: 'ACTIVE' }])) }),
    write: {
      reviseEbayQuantities: async (c) => { calls.push(['qty', c]); return c.map((x) => ({ key: x.key, ok: true })); },
      reviseEbayPrices: async (c) => { calls.push(['price', c]); return c.map((x) => ({ key: x.key, ok: true })); },
      addFixedPriceItem: async (d) => { calls.push(['add', d]); return { ok: true, itemId: '9990999' }; },
      reviseFixedPriceItem: async (id, d) => { calls.push(['revise', id, d]); return { ok: true }; },
      relistFixedPriceItem: async (id, d) => { calls.push(['relist', id, d]); return { ok: true, itemId: '9990998' }; },
      endEbayItem: async (id) => { calls.push(['end', id]); return { ok: true }; }, logEbayEnd: async () => {},
    },
    alert: async (ref, title) => { alerts.push([ref, title]); },
  };
  const ctx = async () => ({ io, settings: await readSettings(io), by: BY });
  const q = async (text, params) => (await pool.query(text, params)).rows;

  test.beforeAll(async () => {
    pool = POOL();
    saved = {
      settings: (await q(`SELECT value FROM app_settings WHERE key = 'ebay_sync'`))[0]?.value ?? null,
      state: await q(`SELECT key, value FROM ebay_sync_state WHERE key = ANY($1)`, [stateKeys]),
      profile: await q(`SELECT config FROM ebay_sync_profiles WHERE is_default LIMIT 1`),
    };
    await pool.query(`TRUNCATE ebay_sync_links, ebay_sync_products, ebay_sync_queue`);
    await pool.query(`DELETE FROM ebay_sync_state WHERE key = ANY($1)`, [stateKeys]);
    await pool.query(`DELETE FROM app_settings WHERE key = 'ebay_sync'`);
  });
  test.afterAll(async () => {
    await pool.query(`TRUNCATE ebay_sync_links, ebay_sync_products, ebay_sync_queue`);
    await pool.query(`DELETE FROM ebay_sync_log WHERE by = $1`, [BY]);
    await pool.query(`DELETE FROM ebay_sync_state WHERE key = ANY($1)`, [stateKeys]);
    for (const r of saved.state) await pool.query(`INSERT INTO ebay_sync_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [r.key, r.value]);
    await pool.query(`DELETE FROM app_settings WHERE key = 'ebay_sync'`);
    if (saved.settings != null) await pool.query(`INSERT INTO app_settings (key, value) VALUES ('ebay_sync', $1)`, [saved.settings]);
    await pool.query(`DELETE FROM ebay_price_locks WHERE item_id IN ('9990001', '9990002')`);
    await pool.query(`DELETE FROM ebay_price_edits WHERE item_id IN ('9990001', '9990002')`);
    await pool.query(`DELETE FROM ebay_listing_ends WHERE item_id = '9990111'`);
    await pool.end();
  });

  test('settings merge atomically: a kill and a switch saved at the same moment both stick', async () => {
    await Promise.all([db.ebaySyncPatchSettings({ kill: true }, BY), db.ebaySyncPatchSettings({ switches: { stock: 'live' } }, BY), db.ebaySyncPatchSettings({ blastPct: 100 }, BY), db.ebaySyncPatchSettings({ switches: { price: 'live' } }, BY)]);
    const s = await readSettings(io);
    expect(s).toMatchObject({ kill: true, blastPct: 100 });
    expect(s.switches).toMatchObject({ stock: 'live', price: 'live', content: 'shadow' });
    await saveSettings({ kill: false, switches: { stock: 'shadow', price: 'shadow' } }, BY, io);   // back to shadow, through the real save + log
    expect((await readSettings(io)).kill).toBe(false);
    expect(await q(`SELECT count(*)::int AS n FROM ebay_sync_log WHERE by = $1 AND domain = 'settings'`, [BY])).toEqual([{ n: 3 }]);
  });

  test('reconcile (shadow): links, products and a shadow log row land in the database, and nothing is written to eBay', async () => {
    await saveSettings({ blastPct: 100 }, BY, io);
    const r = await reconcilePass(await ctx());
    expect(r.aborted).toBeUndefined();
    expect(calls).toEqual([]);
    const links = await q(`SELECT sku, item_id, state, price_rule, ebay_qty, shopify_qty FROM ebay_sync_links ORDER BY sku`);
    expect(links.map((l) => [l.sku, l.state])).toEqual([['SQ-A', 'qty_drift'], ['SQ-B', 'price_kept'], ['SQ-N', 'not_on_ebay']]);
    expect(links.find((l) => l.sku === 'SQ-B').price_rule).toBe('kept_manual');   // no history for a price that differs
    const prod = await q(`SELECT shopify_product_id, status, eligible, item_id FROM ebay_sync_products ORDER BY shopify_product_id`);
    expect(prod).toEqual([{ shopify_product_id: T(1), status: 'uploaded', eligible: true, item_id: '9990111' }, { shopify_product_id: T(3), status: 'not_uploaded', eligible: true, item_id: null }]);
    expect((await q(`SELECT mode, action FROM ebay_sync_log WHERE by = $1 AND domain = 'stock'`, [BY])).length).toBe(0);   // drift is first seen: nothing due yet
    const state = JSON.parse((await q(`SELECT value FROM ebay_sync_state WHERE key = 'ebay_sync_state_reconcile'`))[0].value);
    expect(state).toMatchObject({ lastShopifyCount: 3, lastProductCount: 2, aborted: null });
    expect((await q(`SELECT 1 FROM app_settings WHERE key = 'ebay_sync_state_reconcile'`)).length).toBe(0);   // D1: not a live table
  });

  test('the endpoints\' queries read those rows back (listings, inventory, products, tabs, log)', async () => {
    const l = await db.ebaySyncListings({ filter: 'qty_drift' });
    expect(l.rows.map((r) => r.sku)).toEqual(['SQ-A']);
    expect((await db.ebaySyncListings({ filter: 'price_kept' })).rows.map((r) => r.price_rule)).toEqual(['kept_manual']);
    expect(await db.ebaySyncListingTabs()).toMatchObject({ all: 2, qty_drift: 1, price_kept: 1 });
    expect((await db.ebaySyncInventory({})).rows.map((r) => [r.sku, r.listing_count])).toEqual([['SQ-A', 1], ['SQ-B', 1], ['SQ-N', 0]]);
    expect((await db.ebaySyncProducts({ tab: 'uploaded' })).total).toBe(1);
    expect(await db.ebaySyncProductTabs()).toMatchObject({ uploaded: 1, not_uploaded: 1 });
    expect((await db.ebaySyncLogList({ domain: 'settings' })).total).toBeGreaterThan(0);
  });

  test('reconcile (live): drift that persisted is sent, logged live, and the link row follows', async () => {
    await pool.query(`UPDATE ebay_sync_links SET qty_drift_since = now() - interval '1 hour'`);
    await saveSettings({ switches: { stock: 'live' } }, BY, io);
    const r = await reconcilePass(await ctx());
    expect(r.stock.sent).toBe(1);
    expect(calls.find((c) => c[0] === 'qty')[1]).toEqual([{ key: '9990111|SQ-A', itemId: '9990111', sku: 'SQ-A', qty: 0 }]);
    expect(calls.some((c) => c[0] === 'price')).toBe(false);   // SQ-B is kept_manual
    const log = await q(`SELECT mode, action, ok, item_id FROM ebay_sync_log WHERE by = $1 AND domain = 'stock' ORDER BY id`, [BY]);
    expect(log).toContainEqual({ mode: 'live', action: 'set_qty', ok: true, item_id: '9990111' });
    expect((await q(`SELECT ebay_qty FROM ebay_sync_links WHERE sku = 'SQ-A'`))[0].ebay_qty).toBe(0);
    await saveSettings({ switches: { stock: 'shadow' } }, BY, io);
  });

  test('content: a changed product is checked once (drift stored), then left alone', async () => {
    calls.length = 0;
    const r = await contentPass(await ctx());
    expect(r.note).toMatch(/1 listing/);
    const p = (await q(`SELECT drift, content_key, shopify_key FROM ebay_sync_products WHERE shopify_product_id = $1`, [T(1)]))[0];
    expect(p.drift.fields).toEqual(['title']);
    expect(p.content_key).toBe(p.shopify_key);
    const again = await runPass('content', { io });
    expect(again.note).toMatch(/Nothing to check/);
    expect(calls).toEqual([]);   // content is in shadow
    await saveSettings({ switches: { content: 'live' } }, BY, io);
    await pool.query(`UPDATE ebay_sync_products SET content_key = NULL WHERE shopify_product_id = $1`, [T(1)]);
    await contentPass(await ctx());
    const rev = calls.find((c) => c[0] === 'revise');
    expect(rev[1]).toBe('9990111');
    expect(rev[2].title).toBe(TITLE);
    expect(rev[2].variations).toBeUndefined();
    await saveSettings({ switches: { content: 'shadow' } }, BY, io);
  });

  test('create: verify stores the result; only a verified product that has waited 60 minutes is added; a prior listing needs ended_by_stock to relist', async () => {
    calls.length = 0;
    await saveSettings({ switches: { create: 'live' } }, BY, io);
    await createPass(await ctx());
    expect(calls.filter((c) => c[0] === 'add')).toEqual([]);   // verified now, but not 60 minutes yet
    const v = (await q(`SELECT verify_ok, verified_at FROM ebay_sync_products WHERE shopify_product_id = $1`, [T(3)]))[0];
    expect(v.verify_ok).toBe(true);
    await pool.query(`UPDATE ebay_sync_products SET not_on_ebay_since = now() - interval '2 hours' WHERE shopify_product_id = $1`, [T(3)]);
    await createPass(await ctx());
    const add = calls.find((c) => c[0] === 'add');
    expect(add[1].uuid).toMatch(/^[0-9A-F]{32}$/);
    expect((await q(`SELECT status, item_id FROM ebay_sync_products WHERE shopify_product_id = $1`, [T(3)]))[0]).toEqual({ status: 'uploaded', item_id: '9990999' });
    expect((await q(`SELECT count(*)::int AS n FROM ebay_sync_log WHERE by = $1 AND domain = 'create' AND mode = 'live' AND action = 'add'`, [BY]))[0].n).toBe(1);
    expect(await db.ebaySyncLiveToday('create', 'add')).toBeGreaterThanOrEqual(1);
    // relist rule, in the SQL: a stored item id is only relisted when the sync saw eBay end it
    await pool.query(`UPDATE ebay_sync_products SET status = 'not_uploaded', item_id = '9990555', ended_by_stock = false, verify_ok = true, verify_key = shopify_key, verified_at = now(),
      not_on_ebay_since = now() - interval '2 hours', eligible = true WHERE shopify_product_id = $1`, [T(3)]);
    expect((await db.ebaySyncProductsToAdd(10)).length).toBe(0);
    await pool.query(`UPDATE ebay_sync_products SET ended_by_stock = true WHERE shopify_product_id = $1`, [T(3)]);
    expect((await db.ebaySyncProductsToAdd(10)).map((r) => r.item_id)).toEqual(['9990555']);
    await saveSettings({ switches: { create: 'shadow' } }, BY, io);
  });

  test('queue: a webhook SKU is read live and sent; a webhook that arrives while it runs is not lost (D12)', async () => {
    calls.length = 0;
    await saveSettings({ switches: { stock: 'live' } }, BY, io);
    await pool.query(`UPDATE ebay_sync_links SET ebay_qty = 5 WHERE sku = 'SQ-B'`);
    await db.ebaySyncEnqueue([{ kind: 'sku', key: 'SQ-B' }, { kind: 'sku', key: 'SQ-B' }]);
    const r = await queuePass(await ctx());
    expect(r.note).toMatch(/1 stock change/);
    expect(calls.find((c) => c[0] === 'qty')[1]).toEqual([{ key: '9990111|SQ-B', itemId: '9990111', sku: 'SQ-B', qty: 2 }]);
    expect(await db.ebaySyncQueueCount()).toBe(0);
    // D12: claimed, then the webhook fires again, then the pass finishes
    await db.ebaySyncEnqueue([{ kind: 'sku', key: 'SQ-Z' }]);
    const claimed = await db.ebaySyncClaimQueue(10);
    await db.ebaySyncEnqueue([{ kind: 'sku', key: 'SQ-Z' }]);
    await db.ebaySyncQueueDone(claimed.map((c) => c.id));
    expect(await db.ebaySyncQueueCount()).toBe(1);
    await pool.query(`TRUNCATE ebay_sync_queue`);
    await saveSettings({ switches: { stock: 'shadow' } }, BY, io);
  });

  test('relisting moves a lock and the reprice history to the new id; an item ended through the app is recognised', async () => {
    await pool.query(`INSERT INTO ebay_price_locks (item_id, note, locked_by) VALUES ('9990001', 't', 'sqltest') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO ebay_price_edits (item_id, variation_key, sku, new_price, ok, changed_by) VALUES ('9990001', 'X', 'X', 5, true, 'sqltest')`);
    await db.ebaySyncMoveItemId('9990001', '9990002');
    expect(await q(`SELECT item_id FROM ebay_price_locks WHERE item_id IN ('9990001', '9990002')`)).toEqual([{ item_id: '9990002' }]);
    expect((await db.ebaySyncRepricedKeys()).has('9990002|X')).toBe(true);
    await pool.query(`INSERT INTO ebay_listing_ends (item_id, title, ok, ended_by) VALUES ('9990111', 't', true, 'sqltest')`);
    expect([...(await db.ebaySyncEndedByApp(['9990111', '9990112']))]).toEqual(['9990111']);
  });

  test('status reads it all back, with the aborted reason once the shrink guard has tripped', async () => {
    await db.ebaySyncStateSet('ebay_sync_state_reconcile', JSON.stringify({ lastShopifyCount: 100000, lastProductCount: 2, lastEbayRows: 2 }));
    const aborted = await reconcilePass(await ctx());
    expect(aborted.aborted).toBe(true);
    const st = await buildStatus(io);
    expect(st.passes.reconcile.aborted).toMatchObject({ shrank: true });
    expect(st.counts.products).toMatchObject({ uploaded: expect.any(Number) });
    expect(st.writes_enabled).toBe(true);
    expect(Object.keys(st.settings.switches).sort()).toEqual(['content', 'create', 'end', 'price', 'stock']);
    expect(alerts.length).toBeGreaterThan(0);
  });
});
