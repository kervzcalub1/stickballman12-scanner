// SHEIN live sync (docs/context/shein-live-fix.md). What this pins:
//   · SHEIN's API rows read like the export rows did: size, seller SKU, sellable, held;
//   · per product: stock = Shopify (live) − SHEIN sales not yet off Shopify; the write is an
//     OVERWRITE of the TOTAL (sellable + what SHEIN holds); a stopped size isn't written;
//   · seller-SKU fixes: only proven links, never onto a SKU used elsewhere, a swap parks the
//     size that loses its SKU, an AI link writes only at ≥ 0.8;
//   · one step end to end with fake SHEIN + Shopify: dry writes nothing, stock writes and
//     reads back, full edits seller SKUs and remembers them, a product in review isn't edited;
//   · SHEIN sales → Shopify: one unit = −1, never twice (the key carries the goodsId), a sale
//     elsewhere in between makes us re-read, a cancel before shipping puts it back, units sold
//     before the switch-on aren't touched;
//   · webhooks: SHEIN's signature + AES, Shopify's HMAC — a forged one is refused.
import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { rowsFromSpu, planProduct, ownersFrom, indexRows, unitsFromOrders, unitAction, pickLocation, toSheinTime, fromSheinTime, AI_WRITE_MIN } from '../src/lib/sheinLive.js';

/* ------------------------------ fixtures ------------------------------ */

const sizeAttr = (v) => ({ attributeId: 87, attributeMultiList: [{ attributeName: 'Size', language: 'en' }], attributeValueId: 1, attributeValueMultiList: [{ attributeValueName: v, language: 'en' }] });
const SKU = (code, seller, size, extra = {}) => ({ skuCode: code, supplierSku: seller, mallState: 1, saleAttributeList: [sizeAttr(size)], priceInfoList: [{ basePrice: 120, specialPrice: 99, currency: 'USD', subSite: 'shein-us' }], ...extra });
const SPU = (spuName, skus, name = 'Nike Air Max 95 (IB7936-100)') => ({ spuName, productMultiNameList: [{ productName: name, language: 'en' }], skcInfoList: [{ skcName: `${spuName}-c`, skuInfoList: skus }] });
const STOCK = (rows) => [{ spuName: 'x', skcName: 'x', skuList: rows.map(([code, usable, locked = 0, wh = 'W1']) => ({ skuCode: code, warehouseInventoryList: [{ warehouseCode: wh, inventoryQuantity: usable + locked, usableInventory: usable, lockedQuantity: locked, tempLockQuantity: 0 }] })) }];
const V = (sku, size, qty, productId = 'P1', extra = {}) => ({ sku, size, qty, productId, status: 'ACTIVE', productTitle: 'Nike Air Max 95 (IB7936-100)', style: 'IB7936-100', ...extra });

test.describe('SHEIN live — reading the API', () => {
  test('spu-info + stock → rows: size, seller SKU, sellable, held for orders, only our warehouses', () => {
    const spu = SPU('spu1', [SKU('s7', 'A7', 'US7'), SKU('s8', 'A8', 'US8', { mallState: 2 })]);
    const rows = rowsFromSpu(spu, STOCK([['s7', 3, 1], ['s8', 0]]).concat([{ skuList: [{ skuCode: 's7', warehouseInventoryList: [{ warehouseCode: 'SHEINWH', inventoryQuantity: 9, usableInventory: 9 }] }] }]), { merchant: new Set(['W1']) });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ spu: 'spu1', sheinSku: 's7', sellerSku: 'A7', size: 'US7', qty: 3, held: 1, name: 'Nike Air Max 95 (IB7936-100)', mallState: 1 });
    expect(rows[0].price).toMatchObject({ base: 120, special: 99, site: 'shein-us' });
    expect(rows[1]).toMatchObject({ sheinSku: 's8', mallState: 2, qty: 0 });
  });
});

test.describe('SHEIN live — SHEIN’s answer shapes', () => {
  test('stock-query’s info comes wrapped in a list on prod — read either way (it once read every size as 0)', async () => {
    const { listOf } = await import('../api/_lib/shein.js');
    // Exactly what prod returned for the Dunk Low Silver Surfer (2026-10-17), trimmed.
    const prod = [{ goodsInventory: [{ spuName: 't2608250006402089', skcName: 'st260825000640208958169', skuList: [
      { skuCode: 'I8mt7fhl8wq5gn', totalInventoryQuantity: 3, totalUsableInventory: 3, warehouseInventoryList: [{ warehouseCode: 'PS111731028586', warehouseType: '2', inventoryQuantity: 3, lockedQuantity: 0, usableInventory: 3, tempLockQuantity: 0 }] }] }] }];
    expect(listOf(prod, 'goodsInventory')).toHaveLength(1);
    expect(listOf({ goodsInventory: [1, 2] }, 'goodsInventory')).toEqual([1, 2]);
    expect(listOf(null, 'goodsInventory')).toEqual([]);
    const spu = SPU('t2608250006402089', [SKU('I8mt7fhl8wq5gn', '10102780', 'US8')]);
    const rows = rowsFromSpu(spu, listOf(prod, 'goodsInventory'), { merchant: new Set(['PS111731028586']) });
    expect(rows[0]).toMatchObject({ sellerSku: '10102780', size: 'US8', qty: 3, held: 0 });
  });
});

test.describe('SHEIN live — the plan for one product', () => {
  const VARS = [V('A7', '7', 5), V('A8', '8', 2), V('A9', '9', 4)];
  const rows = (list) => rowsFromSpu(SPU('spu1', list.map(([code, seller, size]) => SKU(code, seller, size))), STOCK(list.map(([code, , , usable, locked]) => [code, usable, locked])), {});

  test('stock = live Shopify − SHEIN sales not yet off Shopify; the write is the TOTAL incl. what SHEIN holds', () => {
    const r = rows([['s7', 'A7', 'US7', 9, 1]]);
    const all = r; const { holders } = indexRows(all);
    const p = planProduct({ rows: r, variants: VARS, owners: ownersFrom(all, VARS), holders, heldBySku: new Map([['A7', 1]]), target: 'W1' });
    expect(p.rows[0]).toMatchObject({ newQty: 4, reason: 'ok' });           // 5 in Shopify, 1 sold on SHEIN not yet off Shopify
    expect(p.writes).toEqual([{ sheinSku: 's7', warehouseCode: 'W1', total: 5, sellable: 4, before: 9 }]);   // 4 sellable + 1 SHEIN holds
    // With the sale already off Shopify (sales sync on): nothing to hold back → sellable = Shopify.
    const q = planProduct({ rows: r, variants: [V('A7', '7', 4)], owners: ownersFrom(all, VARS), holders, heldBySku: new Map(), target: 'W1' });
    expect(q.writes[0]).toMatchObject({ sellable: 4, total: 5 });
  });

  test('nothing written when SHEIN already matches; a size stopped on SHEIN is never written', () => {
    const r = rows([['s7', 'A7', 'US7', 5, 0], ['s8', 'A8', 'US8', 7, 0]]);
    r[1].mallState = 2;
    const p = planProduct({ rows: r, variants: VARS, owners: ownersFrom(r, VARS), holders: indexRows(r).holders, target: 'W1' });
    expect(p.writes).toEqual([]);
  });

  test('a swap: the size gets 0 now, its seller SKU is changed, the size losing that SKU is parked', () => {
    // SHEIN US8 carries A9 (Shopify 9); SHEIN US7.5 carries A8 (Shopify 8) — Shopify has no 7.5.
    const r = rows([['s8', 'A9', 'US8', 3, 0], ['s75', 'A8', 'US7.5', 2, 0]]);
    const p = planProduct({ rows: r, variants: VARS, owners: ownersFrom(r, VARS), holders: indexRows(r).holders, target: 'W1', links: true });
    const by = Object.fromEntries(p.rows.map((x) => [x.sheinSku, x]));
    expect(by.s8).toMatchObject({ newQty: 0, reason: 'swap', linkTo: { sku: 'A8' } });
    expect(by.s75).toMatchObject({ newQty: 0, reason: 'wrong_size' });
    expect(p.edits).toEqual([
      { skc: 'spu1-c', skuCode: 's8', supplierSku: 'A8', from: 'A9', by: 'rule', why: 'swap' },
      { skc: 'spu1-c', skuCode: 's75', supplierSku: 'A8-off', from: 'A8', by: 'rule', why: 'frees', frees: 'A8' },
    ]);
    expect(p.writes.map((w) => [w.sheinSku, w.total])).toEqual([['s8', 0], ['s75', 0]]);
    // Without links (stock mode) nothing is edited — and the sizes still sell nothing.
    expect(planProduct({ rows: r, variants: VARS, owners: ownersFrom(r, VARS), holders: indexRows(r).holders, target: 'W1', links: false }).edits).toEqual([]);
  });

  test('a link onto a SKU another SHEIN product uses is not written; nor onto one a size already sells right', () => {
    const r = rows([['s8', 'A9', 'US8', 3, 0]]);
    const other = { spu: 'spu2', sheinSku: 'x8', sellerSku: 'A8', size: 'US8' };
    const holders = indexRows([...r, other]).holders;
    const p = planProduct({ rows: r, variants: VARS, owners: ownersFrom([...r, other], VARS), holders, target: 'W1' });
    expect(p.edits).toEqual([]);
    expect(p.skipped[0].why).toContain('another SHEIN product (spu2)');
    const r2 = rows([['s8', 'A9', 'US8', 3, 0], ['t8', 'A8', 'US8', 1, 0]]);   // t8 sells A8 correctly
    const p2 = planProduct({ rows: r2, variants: VARS, owners: ownersFrom(r2, VARS), holders: indexRows(r2).holders, target: 'W1' });
    expect(p2.edits).toEqual([]);
    expect(p2.skipped[0].why).toContain('already sells A8 correctly');
  });

  test('the same seller SKU on two SHEIN products: only the right-size owner sells it', () => {
    const r = rows([['s7', 'A7', 'US7', 2, 0]]);
    const elsewhere = { spu: 'spu9', sheinSku: 'z7', sellerSku: 'A7', size: 'US7', held: 0 };
    const owners = ownersFrom([elsewhere, ...r], VARS);   // both fit; the first seen owns it
    const p = planProduct({ rows: r, variants: VARS, owners, holders: indexRows([elsewhere, ...r]).holders, target: 'W1' });
    expect(p.rows[0]).toMatchObject({ newQty: 0, reason: 'duplicate' });
    expect(p.rows[0].action).toContain('another SHEIN product, spu9');
  });

  test(`an AI link is written only at ≥ ${AI_WRITE_MIN}; below that it waits for a person`, () => {
    const r = rowsFromSpu(SPU('spu3', [SKU('d9', 'GONE', 'US9')], 'Some sneaker'), STOCK([['d9', 2]]), {});
    const vars = [V('N9', '9', 3, 'P2', { productTitle: 'Nike Dunk Low', style: null })];
    const base = { rows: r, variants: vars, owners: ownersFrom(r, vars), holders: indexRows(r).holders, target: 'W1' };
    const low = planProduct({ ...base, aiLinks: { 1: { sku: 'N9', size: '9', by: 'ai', confidence: 0.7 } } });
    expect(low.edits).toEqual([]);
    expect(low.skipped[0].why).toContain('confirm it on Match sizes');
    const high = planProduct({ ...base, aiLinks: { 1: { sku: 'N9', size: '9', by: 'ai', confidence: 0.9 } } });
    expect(high.edits).toEqual([{ skc: 'spu3-c', skuCode: 'd9', supplierSku: 'N9', from: 'GONE', by: 'ai', why: 'no_shopify' }]);
    expect(high.writes[0]).toMatchObject({ sheinSku: 'd9', total: 0 });   // still 0 until SHEIN shows N9
  });
});

/* ------------------------- one step, fake SHEIN + Shopify ------------------------- */

function fakeIO({ spu, stock, shopify, inReview = false, taken = [], ordersOn = false, open = new Map() }) {
  const calls = { stock: [], edits: [], links: [], items: [] };
  const sheinQty = new Map(stock.map(([c, u, l = 0]) => [c, { u, l }]));
  return {
    calls,
    io: {
      sheinSpuInfo: async () => spu,
      sheinStock: async (codes) => STOCK(codes.map((c) => [c, sheinQty.get(c)?.u ?? 0, sheinQty.get(c)?.l ?? 0])),
      sheinSetStock: async (writes) => { calls.stock.push(...writes); for (const w of writes) { const s = sheinQty.get(w.skuCode); s.u = w.total - s.l; } return { failed: [] }; },
      sheinInReview: async () => inReview,
      sheinSellerSkusTaken: async (skus) => new Set(skus.filter((s) => taken.includes(s))),
      sheinSetSellerSkus: async (spuName, edits) => { calls.edits.push(...edits); return { ok: true, version: 'v1', messages: [] }; },
      shopifyProductsLive: async (ids) => ({ variants: shopify.filter((v) => ids.includes(v.productId)) }),
      shopifyProductIdsForSkus: async (skus) => ({ found: new Map(shopify.filter((v) => skus.includes(v.sku)).map((v) => [v.sku, v.productId])) }),
      saveSheinLinks: async (links) => { calls.links.push(...links); },
      addSheinLiveItems: async (items) => { calls.items.push(...items); },
      sheinOpenNotDeducted: async () => open,
      readSync: async () => ({ orders: ordersOn ? 'on' : 'off' }),
      sheinAiMatch: async () => [], sheinAiConfigured: () => false,
    },
  };
}
const ctxFor = (io, mode, rows) => ({ mode, io, runId: 1, target: 'W1', merchant: new Set(['W1']), catalogue: null, decisions: {},
  owners: ownersFrom(rows, []), holders: indexRows(rows).holders, sheinHeld: indexRows(rows).held, scanRowHeld: new Map(rows.map((r) => [r.sheinSku, r.held])) });

test.describe('SHEIN live — one product, end to end (fakes)', () => {
  const spu = SPU('spu1', [SKU('s7', 'A7', 'US7'), SKU('s8', 'A9', 'US8'), SKU('s75', 'A8', 'US7.5')]);
  const stock = [['s7', 9, 1], ['s8', 3], ['s75', 2]];
  const shopify = [V('A7', '7', 5), V('A8', '8', 2), V('A9', '9', 4)];
  const scan = () => rowsFromSpu(spu, STOCK(stock), {});

  test('dry run: decides and logs every size, writes nothing', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify });
    const r = await stepProduct('spu1', ctxFor(f.io, 'dry', scan()));
    expect(f.calls.stock).toEqual([]); expect(f.calls.edits).toEqual([]);
    expect(f.calls.items).toHaveLength(3);
    const s7 = f.calls.items.find((i) => i.shein_sku === 's7');
    expect(s7).toMatchObject({ before_qty: 9, target_qty: 4, shopify_qty: 5, held: 1, wrote: 'dry', reason: 'ok' });
    expect(s7.action).toContain('would set 9 → 4');
    // …and it shows the seller-SKU fix full mode would send (checked, not sent).
    expect(f.calls.items.find((i) => i.shein_sku === 's8').action).toContain('would change A9 → A8');
    expect(r.counts).toMatchObject({ sizes: 3, links_changed: 1 });
  });

  test('stock mode: SHEIN gets Shopify’s live number (total incl. held), read back; seller SKUs untouched', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify });
    const r = await stepProduct('spu1', ctxFor(f.io, 'stock', scan()));
    expect(f.calls.stock.map((w) => [w.skuCode, w.warehouseCode, w.total])).toEqual([['s7', 'W1', 5], ['s8', 'W1', 0], ['s75', 'W1', 0]]);
    expect(f.calls.stock.every((w) => w.key && w.key.startsWith(`sb12-${w.skuCode}-`))).toBe(true);
    expect(f.calls.edits).toEqual([]);
    const s7 = f.calls.items.find((i) => i.shein_sku === 's7');
    expect(s7).toMatchObject({ after_qty: 4, result: 'changed', wrote: 'stock' });
    expect(r.counts).toMatchObject({ stock_changed: 3, zeroed: 2, errors: 0, mismatch: 0 });
  });

  test('full mode: the swap is sent to SHEIN and remembered (the size sells once SHEIN shows it)', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify });
    await stepProduct('spu1', ctxFor(f.io, 'full', scan()));
    expect(f.calls.edits.map((e) => [e.skuCode, e.supplierSku])).toEqual([['s8', 'A8'], ['s75', 'A8-off']]);
    expect(f.calls.links).toEqual([
      expect.objectContaining({ shein_sku: 's8', link_sku: 'A8', decision: 'link', source: 'swap', seller_sku_was: 'A9' }),
      expect.objectContaining({ shein_sku: 's75', link_sku: null, decision: 'delist' }),
    ]);
    expect(f.calls.items.find((i) => i.shein_sku === 's8')).toMatchObject({ wrote: 'stock+link', target_qty: 0 });
  });

  test('full mode: a product SHEIN is still reviewing gets stock fixed but no edit', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify, inReview: true });
    await stepProduct('spu1', ctxFor(f.io, 'full', scan()));
    expect(f.calls.edits).toEqual([]);
    expect(f.calls.stock.length).toBe(3);
    expect(f.calls.items.find((i) => i.shein_sku === 's8').action).toContain('still reviewing');
  });

  test('a Shopify sale a second ago is counted: the step reads Shopify live, not the scan', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const live = [V('A7', '7', 1), V('A8', '8', 2), V('A9', '9', 4)];   // 5 → 1 since the catalogue read
    const f = fakeIO({ spu, stock, shopify: live });
    const ctx = { ...ctxFor(f.io, 'stock', scan()), catalogue: shopify };
    await stepProduct('spu1', ctx);
    expect(f.calls.stock.find((w) => w.skuCode === 's7')).toMatchObject({ total: 1 });   // 0 sellable + 1 held
  });

  test('sales sync ON: only SHEIN sales not yet off Shopify are held back', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify: [V('A7', '7', 4), V('A8', '8', 2), V('A9', '9', 4)], ordersOn: true, open: new Map() });
    await stepProduct('spu1', ctxFor(f.io, 'stock', scan()));
    expect(f.calls.stock.find((w) => w.skuCode === 's7')).toMatchObject({ sellable: 4, total: 5 });
  });
});

/* ----------------------------- SHEIN sales → Shopify ----------------------------- */

test.describe('SHEIN sales → Shopify', () => {
  const order = (goods, extra = {}) => ({ orderNo: 'GSU1', orderStatus: 2, stockMode: 3, orderAllocateTime: '2026-10-16 22:00:00', orderGoodsInfoList: goods, ...extra });
  const g = (id, sku, status = 2, extra = {}) => ({ goodsId: id, sellerSku: sku, skuCode: `s-${sku}`, newGoodsStatus: status, goodsExchangeTag: 1, goodsTitle: 'Gazelle', ...extra });

  test('SHEIN time is Beijing time, both ways', () => {
    expect(toSheinTime('2026-10-16T14:00:00Z')).toBe('2026-10-16 22:00:00');
    expect(fromSheinTime('2026-10-16 22:00:00')).toBe('2026-10-16T14:00:00.000Z');
  });

  test('one unit per pair; sold before the switch-on is not ours unless the person said so; known units keep their call', () => {
    const before = order([g('1', '10091348', 2), g('2', '10091348', 4)], { orderAllocateTime: '2026-10-15 10:00:00' });
    const after = order([g('3', '10091348', 1)], { orderNo: 'GSU2' });
    const since = '2026-10-16T12:00:00Z';
    const u = unitsFromOrders([before, after], { since });
    expect(u.map((x) => [x.goods_id, x.due, x.shipped_seen])).toEqual([['1', false, false], ['2', false, true], ['3', true, false]]);
    const open = unitsFromOrders([before], { since, openAtStart: true });
    expect(open.map((x) => [x.goods_id, x.due])).toEqual([['1', true], ['2', false]]);   // the open one only
    expect(unitsFromOrders([after], { since, known: new Set(['3']) })[0].due).toBe(false);
  });

  test('what Shopify must do: deduct once; put back only a cancel before shipping', () => {
    const base = { due: true, stock_mode: 3, exchange_tag: 1, unit_status: 2, deducted_at: null, restocked_at: null, shipped_seen: false };
    expect(unitAction(base)).toBe('deduct');
    expect(unitAction({ ...base, unit_status: 6 })).toBe(null);                     // refunded before we saw it
    expect(unitAction({ ...base, stock_mode: 2 })).toBe(null);                      // SHEIN's warehouse ships it
    expect(unitAction({ ...base, due: false })).toBe(null);
    const done = { ...base, deducted_at: '2026-10-16' };
    expect(unitAction(done)).toBe(null);
    expect(unitAction({ ...done, unit_status: 6 })).toBe('restock');
    expect(unitAction({ ...done, unit_status: 6, shipped_seen: true })).toBe(null);  // a return, not a cancel
    expect(unitAction({ ...done, exchange_tag: 2 })).toBe('restock');                // swapped out in an exchange
  });

  test('the location: the named one, else the only one, else the clear leader — never a coin toss', () => {
    const L = (id, name, available) => ({ locationId: `gid://shopify/Location/${id}`, location: name, available });
    expect(pickLocation([L(1, 'Warehouse', 3)])).toMatchObject({ location: 'Warehouse' });
    expect(pickLocation([L(1, 'Warehouse', 3), L(2, 'Store', 1)])).toMatchObject({ location: 'Warehouse' });
    expect(pickLocation([L(1, 'Warehouse', 1), L(2, 'Store', 1)])).toBe(null);
    expect(pickLocation([L(1, 'Warehouse', 1), L(2, 'Store', 1)], 'store')).toMatchObject({ location: 'Store' });
    expect(pickLocation([L(1, 'Warehouse', 1), L(2, 'Store', 1)], '2')).toMatchObject({ location: 'Store' });
  });

  test('taking a unit off Shopify: compare-and-set, re-read when a sale elsewhere got there first, key = goodsId + definite refusals', async () => {
    const { applyToShopify } = await import('../api/_lib/shein-orders.js');
    let available = 3; const adjusts = []; const marks = [];
    const io = {
      shopifyStockForSku: async () => ({ variantId: 'V1', inventoryItemId: 'I1', levels: [{ locationId: 'L1', location: 'Warehouse', available }] }),
      shopifyAdjustAvailable: async (a) => {
        adjusts.push(a);
        if (adjusts.length === 1) { available = 2; return { error: 'changeFromQuantity does not match', code: 'stale' }; }   // eBay sold one meanwhile
        available += a.delta; return { ok: true, after: available };
      },
      markSheinUnit: async (id, m) => { marks.push([id, m]); },
    };
    const r = await applyToShopify({ goods_id: 'G9', order_no: 'GSU1', seller_sku: '10091348' }, 'deduct', io);
    expect(r.ok).toBe(true);
    expect(adjusts.map((a) => [a.delta, a.from, a.key])).toEqual([[-1, 3, 'shein-G9-deduct-0-0'], [-1, 2, 'shein-G9-deduct-0-1']]);
    expect(available).toBe(1);
    expect(marks.at(-1)[1]).toMatchObject({ deducted: true, before: 2, error: null });
    expect(marks.at(-1)[1].note).toContain('Shopify 2 → 1');
  });

  test('a SHEIN sale Shopify had none of is still taken off — and flagged OVERSOLD', async () => {
    const { applyToShopify } = await import('../api/_lib/shein-orders.js');
    const marks = [];
    const io = {
      shopifyStockForSku: async () => ({ variantId: 'V1', inventoryItemId: 'I1', levels: [{ locationId: 'L1', location: 'Warehouse', available: 0 }] }),
      shopifyAdjustAvailable: async (a) => ({ ok: true, after: a.from + a.delta }),
      markSheinUnit: async (id, m) => { marks.push(m); },
    };
    await applyToShopify({ goods_id: 'G1', order_no: 'GSU1', seller_sku: 'X' }, 'deduct', io);
    expect(marks[0].note).toContain('OVERSOLD');
  });

  test('two locations and nothing to tell them apart: refused with what to set, not guessed', async () => {
    const { applyToShopify } = await import('../api/_lib/shein-orders.js');
    const marks = [];
    const io = {
      shopifyStockForSku: async () => ({ variantId: 'V1', inventoryItemId: 'I1', levels: [{ locationId: 'L1', location: 'A', available: 1 }, { locationId: 'L2', location: 'B', available: 1 }] }),
      shopifyAdjustAvailable: async () => { throw new Error('must not write'); },
      markSheinUnit: async (id, m) => { marks.push(m); },
    };
    const r = await applyToShopify({ goods_id: 'G1', order_no: 'GSU1', seller_sku: 'X' }, 'deduct', io);
    expect(r.error).toBeTruthy();
    expect(marks[0]).toMatchObject({ failed: true });
    expect(marks[0].error).toContain('SHOPIFY_SHEIN_LOCATION');
  });
});

/* ---------------------------------- webhooks ---------------------------------- */

test.describe('SHEIN live — webhooks', () => {
  test('SHEIN: signed with the APP id + secret over the path, AES body — a forged or stale one is refused', async () => {
    process.env.SHEIN_APP_ID = 'APPID1'; process.env.SHEIN_APP_SECRET = 'APPSECRET1234567890';
    const { sheinOpenWebhook, sheinSignature } = await import('../api/_lib/shein.js');
    const { eventDataFrom } = await import('../api/shein/webhook.js');
    const key = Buffer.alloc(16); Buffer.from('APPSECRET1234567890').copy(key, 0, 0, 16);
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.from('space-station-de'));
    const enc = Buffer.concat([c.update(JSON.stringify({ orderNo: 'GSU19432500N8SL', orderStatus: 1 })), c.final()]).toString('base64');
    const ts = String(Date.now());
    const headers = { 'x-lt-appid': 'APPID1', 'x-lt-timestamp': ts, 'x-lt-signature': sheinSignature('APPID1', 'APPSECRET1234567890', '/api/shein/webhook', ts, 'r4nd0') };
    const body = Buffer.from(`--XX\r\nContent-Disposition: form-data; name="eventData"\r\n\r\n${enc}\r\n--XX--\r\n`);
    const ev = eventDataFrom('multipart/form-data; boundary=XX', body);
    expect(ev).toBe(enc);
    expect(sheinOpenWebhook({ headers, path: '/api/shein/webhook', eventData: ev })).toEqual({ orderNo: 'GSU19432500N8SL', orderStatus: 1 });
    expect(sheinOpenWebhook({ headers: { ...headers, 'x-lt-signature': `r4nd0${'A'.repeat(88)}` }, path: '/api/shein/webhook', eventData: ev })).toBe(null);
    expect(sheinOpenWebhook({ headers, path: '/api/other', eventData: ev })).toBe(null);
    expect(sheinOpenWebhook({ headers, path: '/api/shein/webhook', eventData: ev, now: Date.now() + 3600_000 })).toBe(null);
  });

  test('Shopify: HMAC over the raw body with the app secret', async () => {
    process.env.SHOPIFY_SECRET_KEY = 'shpss_test';
    const { shopifyWebhookValid } = await import('../api/_lib/shopify.js');
    const raw = Buffer.from('{"inventory_item_id":123,"available":2}');
    const good = crypto.createHmac('sha256', 'shpss_test').update(raw).digest('base64');
    expect(shopifyWebhookValid(raw, good)).toBe(true);
    expect(shopifyWebhookValid(Buffer.from('{"inventory_item_id":123,"available":9}'), good)).toBe(false);
  });

  test('webhooks: SHEIN’s URL check is answered, an unverified push ignored (on /callback and /callback. too); Shopify unsigned refused', async ({ request }) => {
    for (const url of ['/api/shein/webhook', '/api/shein/callback']) {
      const probe = await request.post(url, { multipart: { eventData: 'x' } });
      expect(probe.status()).toBe(200);
      expect(await probe.json()).toMatchObject({ ignored: true });
      const forged = await request.post(url, { multipart: { eventData: 'x' }, headers: { 'x-lt-appid': 'nope', 'x-lt-timestamp': String(Date.now()), 'x-lt-signature': 'abcdeXXXX' } });
      expect(forged.status()).toBe(200);                                   // answered, but…
      expect(await forged.json()).toMatchObject({ ignored: 'unverified' });  // …nothing is done with it
    }
    // The URL as SHEIN's console has it saved — with a trailing dot — reaches the same handler.
    const dotted = await request.post('/api/shein/callback.', { multipart: { eventData: 'x' } });
    expect(dotted.status()).toBe(200);
    const b = await request.post('/api/shopify/webhook', { data: { inventory_item_id: 1 } });
    expect(b.status()).toBe(401);
  });
});

test.describe('SHEIN live — the page', () => {
  test('connected: sync switches, a live fix needs “4seller paused”, the run’s sizes filter', async ({ page }) => {
    const { loginAs } = await import('./helpers/auth.js');
    const posted = [];
    const live = {
      ok: true, connected: true, configured: true, worker: true, active: null, modes: ['dry', 'stock', 'full'],
      sync: { orders: 'off' }, unitCounts: { last24: 0, failing: 0 }, units: [], pushes: [],
      run: { id: 7, mode: 'dry', status: 'done', phase: 'Finished', started_at: '2026-10-16T14:00:00Z', finished_at: '2026-10-16T14:20:00Z', total: 2, done: 2,
        counts: { products: 2, sizes: 3, stock_changed: 2, zeroed: 1, links_changed: 1, needs_person: 1 } },
      items: [
        { id: 1, spu: 'spu1', shein_sku: 's7', product_name: 'Air Max 95', shein_size: 'US7', seller_sku: 'A7', shopify_size: '7', shopify_qty: 5, held: 1, before_qty: 9, target_qty: 4, reason: 'ok', result: 'changed', wrote: 'dry', action: 'would set 9 → 4' },
        { id: 2, spu: 'spu1', shein_sku: 's8', product_name: 'Air Max 95', shein_size: 'US8', seller_sku: 'A9', shopify_size: '9', shopify_qty: 4, held: 0, before_qty: 3, target_qty: 0, reason: 'swap', link_to: 'A8', link_by: 'rule', result: 'changed', wrote: 'dry', action: 'would change A9 → A8' },
        { id: 3, spu: 'spu2', shein_sku: 'd9', product_name: 'Mystery shoe', shein_size: 'US9', seller_sku: 'GONE', shopify_size: null, shopify_qty: null, held: 0, before_qty: 0, target_qty: 0, reason: 'no_shopify', result: 'ok', wrote: 'none', action: 'Delist this size' },
      ],
    };
    await page.route('**/api/shein/status', (r) => r.fulfill({ json: { ok: true, configured: true, connected: true } }));
    await page.route('**/api/shein/live', (r) => {
      if (r.request().method() === 'POST') { posted.push(r.request().postDataJSON()); return r.fulfill({ json: { ok: true } }); }
      return r.fulfill({ json: live });
    });
    await loginAs(page, 'admin');
    await page.goto('/shein-check');
    await expect(page.getByRole('heading', { name: 'Live sync' })).toBeVisible();
    await expect(page.getByText('SHEIN sales → Shopify', { exact: false }).first()).toBeVisible();
    // Turning the sales sync on asks about the orders already sold but not shipped.
    await page.getByRole('button', { name: 'Turn on SHEIN sales → Shopify…' }).click();
    await expect(page.getByText('already sold but not shipped yet')).toBeVisible();
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect.poll(() => posted.at(-1)).toEqual({ action: 'orders_on', openAtStart: true });
    // A live fix can't start until 4seller is said to be paused.
    await page.getByRole('button', { name: 'Fix stock', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start: Fix stock' });
    await expect(start).toBeDisabled();
    await page.getByLabel('4seller’s SHEIN sync is paused', { exact: false }).check();
    await expect(start).toBeEnabled();
    page.once('dialog', (d) => d.accept());
    await start.click();
    await expect.poll(() => posted.at(-1)).toEqual({ action: 'start', mode: 'stock', ai: true });
    // The run: changed sizes by default; "Needs a person" shows the dead SKU.
    await expect(page.getByText('would set 9 → 4')).toBeVisible();
    await expect(page.getByText('Mystery shoe')).toHaveCount(0);
    await page.getByRole('button', { name: 'Needs a person' }).click();
    await expect(page.getByText('Mystery shoe')).toBeVisible();
    await expect(page.getByText('would set 9 → 4')).toHaveCount(0);
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  });

  test('a run bigger than the live list: the page says so, and the CSV fetches every row', async ({ page }) => {
    const { loginAs } = await import('./helpers/auth.js');
    const row = (i) => ({ id: i, spu: `spu${i}`, shein_sku: `s${i}`, product_name: `Shoe ${i}`, shein_size: 'US9', seller_sku: `K${i}`, shopify_size: '9', shopify_qty: 1, held: 0, before_qty: 2, target_qty: 1, reason: 'ok', result: 'changed', wrote: 'dry', action: 'would set 2 → 1' });
    const all = Array.from({ length: 3005 }, (_, i) => row(i + 1));
    const live = {
      ok: true, connected: true, configured: true, worker: true, active: null, modes: ['dry', 'stock', 'full'],
      sync: { orders: 'on' }, unitCounts: { last24: 0, failing: 0 }, units: [], pushes: [],
      run: { id: 9, mode: 'dry', status: 'done', phase: 'Finished', started_at: '2026-10-22T14:00:00Z', finished_at: '2026-10-22T14:40:00Z', total: 3005, done: 3005,
        counts: { products: 3005, sizes: 3005, stock_changed: 3005 } },
      items: all.slice(0, 3000), itemsTotal: 3005,
    };
    const asked = [];
    await page.route('**/api/shein/status', (r) => r.fulfill({ json: { ok: true, configured: true, connected: true } }));
    await page.route(/\/api\/shein\/live(\?.*)?$/, (r) => {
      const u = new URL(r.request().url());
      if (u.searchParams.get('all') === '1') { asked.push(u.searchParams.get('run')); return r.fulfill({ json: { ok: true, items: all } }); }
      return r.fulfill({ json: live });
    });
    await loginAs(page, 'admin');
    await page.goto('/shein-check');
    await expect(page.getByText('Showing the first 3,000 of 3,005 sizes', { exact: false })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /This run \(CSV · 3,005\)/ }).click();
    const file = await download;
    const text = await (await import('node:fs/promises')).readFile(await file.path(), 'utf8');
    expect(asked).toEqual(['9']);
    expect(text.trim().split('\n')).toHaveLength(3006);   // header + every row, not the 3,000 on screen
    expect(text).toContain('Shoe 3005');
  });
});
