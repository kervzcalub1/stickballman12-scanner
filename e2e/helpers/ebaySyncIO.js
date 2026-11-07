// A mocked IO for the eBay Sync engine: nothing reaches eBay, Shopify or the database. Every writer records
// what it was called with (or throws when `live` is off), and the "database" is a few arrays.
import { saveSettings, readSettings } from '../../api/_lib/ebay-sync.js';

export const NOW = new Date('2026-11-08T15:00:00Z');
export const OLD = '2026-11-08T12:00:00Z';
export const TITLE = 'Nike Dunk Low Retro Panda (DD1391-100)';
export const PROFILE = {
  categoryId: '15709', conditionId: 1000, listingType: 'FixedPriceItem', duration: 'GTC', dispatchDays: 1, location: 'Manheim, Pennsylvania', postalCode: '17545',
  country: 'US', currency: 'USD', site: 'US', policies: { shipping: '325744987021', return: '325744597021', payment: '325744328021' },
  package: { length: 16, width: 12, depth: 6, weightLbs: 4, weightOz: 0, type: 'PackageThickEnvelope' },
  specifics: { Color: 'Multicolor', Department: 'Unisex Adults', Style: 'Sneaker', 'Upper Material': 'Leather', Type: 'Sneaker' },
  sizeName: 'Size', collection: 'Footwear', uplift: 0, maxPictures: 12,
};
export const ALL_LIVE = { switches: { stock: 'live', price: 'live', content: 'live', create: 'live', end: 'live' }, blastPct: 100 };

export function mkIO(over = {}) {
  const calls = [];
  const dbCalls = [];     // database-side calls that are not eBay writes
  const logs = [];
  const alerts = [];
  const patches = [];
  const store = new Map();       // app_settings
  const state = new Map();       // ebay_sync_state
  const stateWrites = [];
  const forbid = (name) => async (...a) => { calls.push([name, a]); throw new Error(`WRITE CALLED: ${name}`); };
  const allow = (name, result) => async (...a) => { calls.push([name, a]); return typeof result === 'function' ? result(...a) : result; };
  const ebayRows = over.ebayRows || [
    { item_id: '111', variation_key: 'A', sku: 'A', size: '8', price: 100, qty_available: 1, title: TITLE, view_url: 'https://www.ebay.com/itm/111' },
    { item_id: '111', variation_key: 'B', sku: 'B', size: '9', price: 110, qty_available: 2, title: TITLE, view_url: 'https://www.ebay.com/itm/111' },
    { item_id: '222', variation_key: 'L', sku: 'L', size: '10', price: 200, qty_available: 1, title: 'Locked Shoe (HQ1234-001)', view_url: 'https://www.ebay.com/itm/222' },
  ];
  const variants = over.variants || [
    { variantId: 'v-A', productId: 'P1', sku: 'A', size: '8', price: '100.00', qty: 0, status: 'ACTIVE', productTitle: TITLE },
    { variantId: 'v-B', productId: 'P1', sku: 'B', size: '9', price: '130.00', qty: 2, status: 'ACTIVE', productTitle: TITLE },
    { variantId: 'v-L', productId: 'P2', sku: 'L', size: '10', price: '90.00', qty: 1, status: 'ACTIVE', productTitle: 'Locked Shoe (HQ1234-001)' },
  ];
  const light = over.light || [
    { id: 'P1', title: TITLE, handle: 'p1', vendor: 'nike', status: 'ACTIVE', updatedAt: '2026-11-01T00:00:00Z', image: null },
    { id: 'P2', title: 'Locked Shoe (HQ1234-001)', handle: 'p2', vendor: 'nike', status: 'ACTIVE', updatedAt: '2026-11-01T00:00:00Z', image: null },
  ];
  const saved = { links: null, products: null };
  let lockCalls = 0;
  const io = {
    getSetting: async (k) => store.get(k) ?? null,
    patchSettings: async (patch) => {
      const cur = JSON.parse(store.get('ebay_sync') || '{}');
      store.set('ebay_sync', JSON.stringify({ ...cur, ...patch, switches: { ...(cur.switches || {}), ...(patch.switches || {}) } }));
    },
    getState: async (k) => state.get(k) ?? null, setState: async (k, v) => { stateWrites.push(k); state.set(k, v); },
    now: over.now || (() => NOW), dbReady: () => true, ebayReady: async () => true, shopifyReady: () => true,
    budget: async () => ({ used: over.used ?? 10, limit: 5000, readStop: 3000, writeStop: 4500, resetAt: '2026-11-09T08:00:00Z' }), flushBudget: async () => {},
    fetchActiveListings: async () => ({ rows: over.ebayRowsFn ? over.ebayRowsFn() : ebayRows }),
    fetchEbayItemContent: over.fetchEbayItemContent || (async (itemId) => ({
      status: 'Active', title: TITLE, description: '', pictureCount: 1, specificsSet: { name: 'Size', values: [] },
      variations: ebayRows.filter((r) => r.item_id === itemId).map((r) => ({ sku: r.sku, size: r.size, price: r.price, quantity: r.qty_available, sold: 0 })),
    })),
    verifyAddFixedPriceItem: over.verify || (async () => ({ ok: true })),
    allVariants: over.allVariants || (async () => ({ variants })),
    productsLight: over.productsLight || (async () => ({ products: light })),
    collectionIds: async () => ({ ids: new Set(over.collection || ['P1', 'P2']) }),
    productsFull: over.productsFull || (async (ids) => ({ products: ids.map((id) => over.fullProduct?.(id)).filter(Boolean), missing: [] })),
    stockForSku: over.stockForSku || (async (sku) => {
      const v = variants.find((x) => x.sku === sku);
      return v ? { levels: [{ available: v.qty }], tracked: true, productStatus: 'DRAFT' } : { error: 'No variant', code: 'missing' };
    }),
    productsState: over.productsState || (async (ids) => ({ products: new Map(ids.map((id) => [id, { status: 'ACTIVE' }])) })),
    lockedItemIds: async (ids) => { lockCalls++; return new Set(over.lockedFn ? over.lockedFn(lockCalls) : (over.locked || [])); },
    repricedKeys: async () => new Set(over.repriced || []),
    profile: async () => ({ config: over.profile || PROFILE }),
    db: {
      logAdd: async (r) => { logs.push(r); }, loggedRecently: async () => false, liveToday: async (d, a) => (over.liveTodayBy ? over.liveTodayBy[a] || 0 : (a === 'add' ? over.liveToday || 0 : 0)),
      liveCount: async (domain, action) => logs.filter((l) => l.domain === domain && l.action === action && l.mode === 'live' && l.ok !== false).length + (over.window?.[`${domain}.${action}`] || 0),
      listingCount: async () => over.listingCount ?? 3,
      claimQueue: async () => over.queue || [], queueDone: async (ids) => { dbCalls.push(['queueDone', ids]); },
      linkPrev: async () => over.prev || [
        { link_key: '111|A', qty_drift_since: OLD, price_drift_since: null, ebay_price: 100, shopify_price: 100, price_rule: 'follows_shopify' },
        { link_key: '111|B', qty_drift_since: null, price_drift_since: OLD, ebay_price: 110, shopify_price: 130, price_rule: 'follows_shopify' },
        { link_key: '222|L', qty_drift_since: null, price_drift_since: OLD, ebay_price: 200, shopify_price: 90, price_rule: 'kept_lock' },
      ],
      replaceLinks: async (rows) => { saved.links = rows; },
      linksBySku: async (sku) => (over.linksBySku ? over.linksBySku(sku) : []),
      setLinkQty: async () => {}, linksByItem: async (id) => (saved.links || over.links || []).filter((l) => l.item_id === id),
      itemsOfProducts: async () => over.itemsOfProducts || [], ebaySkus: async () => new Set(over.ebaySkus || []), productPrev: async () => over.productPrev || [],
      endedByApp: async () => new Set(over.endedByApp || []),
      upsertProducts: async (rows) => { saved.products = rows; }, patchProduct: async (id, p) => { patches.push([id, p]); },
      toVerify: async () => over.toVerify || [], toAdd: async (n) => { dbCalls.push(['toAdd', n]); return (over.toAdd || []).slice(0, n); },
      toCheck: async (n, sweep) => { dbCalls.push(['toCheck', n, sweep]); return over.toCheck || []; },
      prune: async () => {}, linkCount: async () => over.linkCount ?? 3, productTabs: async () => ({ uploaded: over.uploaded ?? 100 }),
      moveItemId: async (a, b) => { dbCalls.push(['moveItemId', a, b]); }, dropListing: async (id) => { dbCalls.push(['dropListing', id]); },
    },
    write: {
      reviseEbayQuantities: over.live ? allow('reviseEbayQuantities', (c) => { over.onQty?.(c); return c.map((x) => ({ key: x.key, ok: true })); }) : forbid('reviseEbayQuantities'),
      reviseEbayPrices: over.live ? allow('reviseEbayPrices', (c) => c.map((x) => ({ key: x.key, ok: true }))) : forbid('reviseEbayPrices'),
      addFixedPriceItem: over.live ? allow('addFixedPriceItem', over.addResult || { ok: true, itemId: '999' }) : forbid('addFixedPriceItem'),
      reviseFixedPriceItem: over.live ? allow('reviseFixedPriceItem', { ok: true }) : forbid('reviseFixedPriceItem'),
      relistFixedPriceItem: over.live ? allow('relistFixedPriceItem', { ok: true, itemId: '998' }) : forbid('relistFixedPriceItem'),
      endEbayItem: over.live ? allow('endEbayItem', { ok: true }) : forbid('endEbayItem'),
      logEbayEnd: over.live ? allow('logEbayEnd', {}) : forbid('logEbayEnd'),
    },
    alert: async (ref, title, body) => { alerts.push({ ref, title, body }); },
  };
  return { io, calls, dbCalls, logs, alerts, patches, saved, store, state, stateWrites };
}
export const ctxOf = async (t, settingsPatch = {}, extra = {}) => {
  await saveSettings(settingsPatch, 'tester', t.io);
  return { io: t.io, settings: await readSettings(t.io), by: 'tester', ...extra };
};
