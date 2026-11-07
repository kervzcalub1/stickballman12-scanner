// SHEIN automatic sync (docs/context/shein-live-fix.md). What this pins:
//   · SHEIN's API rows read like the export rows did: size, SKU, sellable, held;
//   · per product: stock = Shopify (live) − SHEIN sales not yet off Shopify; the write is an
//     OVERWRITE of the TOTAL (sellable + what SHEIN holds); a stopped size isn't written;
//   · SKU fixes: only proven links, never onto a SKU used elsewhere, a swap parks the
//     size that loses its SKU, an AI link writes only at ≥ 0.8;
//   · one step end to end with fake SHEIN + Shopify: dry writes nothing, stock writes and
//     reads back, full edits SKUs and remembers them, a product in review isn't edited;
//   · SHEIN sales → Shopify: one unit = −1, never twice (the key carries the goodsId), a sale
//     elsewhere in between makes us refresh, a cancel before shipping puts it back, units sold
//     before the switch-on aren't touched;
//   · webhooks: SHEIN's signature + AES, Shopify's HMAC — a forged one is refused.
import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { rowsFromSpu, planProduct, ownersFrom, indexRows, unitsFromOrders, unitAction, pickLocation, toSheinTime, fromSheinTime, AI_WRITE_MIN, shelfFrom, shelfPlan, sheinOrderState, sheinLinePrice, shopifyOrderInput } from '../src/lib/sheinLive.js';
import { addOrderToShopify, actOnUnits, releaseClaimedOrder, fulfilShippedOrders, checkNewOrders, NEW_ORDER_LOOKBACK_MS } from '../api/_lib/shein-orders.js';

/* ------------------------------ fixtures ------------------------------ */

const sizeAttr = (v) => ({ attributeId: 87, attributeMultiList: [{ attributeName: 'Size', language: 'en' }], attributeValueId: 1, attributeValueMultiList: [{ attributeValueName: v, language: 'en' }] });
const SKU = (code, seller, size, extra = {}) => ({ skuCode: code, supplierSku: seller, mallState: 1, saleAttributeList: [sizeAttr(size)], priceInfoList: [{ basePrice: 120, specialPrice: 99, currency: 'USD', subSite: 'shein-us' }], ...extra });
const SPU = (spuName, skus, name = 'Nike Air Max 95 (IB7936-100)') => ({ spuName, productMultiNameList: [{ productName: name, language: 'en' }], skcInfoList: [{ skcName: `${spuName}-c`, skuInfoList: skus }] });
const STOCK = (rows) => [{ spuName: 'x', skcName: 'x', skuList: rows.map(([code, usable, locked = 0, wh = 'W1']) => ({ skuCode: code, warehouseInventoryList: [{ warehouseCode: wh, inventoryQuantity: usable + locked, usableInventory: usable, lockedQuantity: locked, tempLockQuantity: 0 }] })) }];
const V = (sku, size, qty, productId = 'P1', extra = {}) => ({ sku, size, qty, productId, status: 'ACTIVE', productTitle: 'Nike Air Max 95 (IB7936-100)', style: 'IB7936-100', ...extra });

test.describe('SHEIN live — reading the API', () => {
  test('spu-info + stock → rows: size, SKU, sellable, held for orders, only our warehouses', () => {
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

  test('a swap: the size gets 0 now, its SKU is changed, the size losing that SKU is parked', () => {
    // SHEIN US8 carries A9 (Shopify 9); SHEIN US7.5 carries A8 (Shopify 8) — Shopify has no 7.5.
    const r = rows([['s8', 'A9', 'US8', 3, 0], ['s75', 'A8', 'US7.5', 2, 0]]);
    const p = planProduct({ rows: r, variants: VARS, owners: ownersFrom(r, VARS), holders: indexRows(r).holders, target: 'W1', links: true });
    const by = Object.fromEntries(p.rows.map((x) => [x.sheinSku, x]));
    expect(by.s8).toMatchObject({ newQty: 0, reason: 'swap', linkTo: { sku: 'A8' } });
    expect(by.s75).toMatchObject({ newQty: 0, reason: 'wrong_size' });
    // Two edits: SHEIN refuses A8 on s8 while s75 still shows it, even in one edit that moves it away.
    expect(p.edits).toEqual([{ skc: 'spu1-c', skuCode: 's75', supplierSku: 'A8-off', from: 'A8', by: 'rule', why: 'frees', frees: 'A8' }]);
    expect(p.skipped).toEqual([{ sheinSku: 's8', why: expect.stringContaining('step 2 of 2: A8 is still on SHEIN size US7.5') }]);
    expect(p.writes.map((w) => [w.sheinSku, w.total])).toEqual([['s8', 0], ['s75', 0]]);
    // Without links (stock mode) nothing is edited — and the sizes still sell nothing.
    expect(planProduct({ rows: r, variants: VARS, owners: ownersFrom(r, VARS), holders: indexRows(r).holders, target: 'W1', links: false }).edits).toEqual([]);
  });

  test('a swap, step 2: once SHEIN shows the parked SKU, the move goes out on the next full fix', () => {
    const r = rows([['s8', 'A9', 'US8', 0, 0], ['s75', 'A8-off', 'US7.5', 0, 0]]);
    const p = planProduct({ rows: r, variants: VARS, decisions: { s75: { shein_sku: 's75', decision: 'delist', link_sku: null } }, owners: ownersFrom(r, VARS), holders: indexRows(r).holders, target: 'W1' });
    expect(p.edits).toEqual([{ skc: 'spu1-c', skuCode: 's8', supplierSku: 'A8', from: 'A9', by: 'rule', why: 'swap' }]);
    expect(p.skipped).toEqual([]);
  });

  test('two sizes that trade SKUs, or a chain: all parked or waiting now, every move in ONE second edit', () => {
    const chainVars = ['7', '8', '9', '10'].map((n) => V(`C${n}`, n, 2));
    const plan = (list, decisions = {}) => { const r = rows(list); return planProduct({ rows: r, variants: chainVars, decisions, owners: ownersFrom(r, chainVars), holders: indexRows(r).holders, target: 'W1' }); };
    // Each size shows the SKU of the next size up: 7 → C8, 8 → C9, 9 → C10, and 10 shows a dead SKU.
    const first = plan([['s7', 'C8', 'US7', 0, 0], ['s8', 'C9', 'US8', 0, 0], ['s9', 'C10', 'US9', 0, 0], ['s10', 'GONE', 'US10', 0, 0]]);
    const sent = Object.fromEntries(first.edits.map((e) => [e.skuCode, e]));
    // No SKU goes onto a size while another size still shows it.
    const shown = new Set(['C8', 'C9', 'C10', 'GONE']);
    for (const e of first.edits) expect(shown.has(e.supplierSku)).toBe(false);
    expect(new Set(first.edits.map((e) => e.supplierSku)).size).toBe(first.edits.length);
    expect(sent.s8).toMatchObject({ supplierSku: 'C9-off', frees: 'C9', finalSku: 'C8' });
    expect(sent.s9).toMatchObject({ supplierSku: 'C10-off', frees: 'C10', finalSku: 'C9' });
    // Step 2 = what SHEIN shows after approval + the saved links: every remaining move, nothing clashing.
    const second = plan([['s7', first.edits.find((e) => e.skuCode === 's7')?.supplierSku || 'C8', 'US7', 0, 0], ['s8', 'C9-off', 'US8', 0, 0], ['s9', 'C10-off', 'US9', 0, 0], ['s10', first.edits.find((e) => e.skuCode === 's10')?.supplierSku || 'GONE', 'US10', 0, 0]],
      { s8: { shein_sku: 's8', decision: 'link', link_sku: 'C8' }, s9: { shein_sku: 's9', decision: 'link', link_sku: 'C9' } });
    expect(second.skipped).toEqual([]);
    expect(Object.fromEntries(second.edits.map((e) => [e.skuCode, e.supplierSku]))).toMatchObject({ s8: 'C8', s9: 'C9' });
    expect(second.edits.every((e) => !e.finalSku)).toBe(true);
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

  test('the same SKU on two SHEIN products: only the right-size owner sells it', () => {
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

function fakeIO({ spu, stock, shopify, inReview = false, taken = [], ordersOn = false, open = new Map(), records = new Map(), deletable = true, deleteLog = null }) {
  const calls = { stock: [], edits: [], links: [], items: [], shelf: [], deletes: [], saved: [] };
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
      sheinShelfRecords: async () => records,
      saveSheinShelf: async (x) => { calls.saved.push(x); },
      sheinSetShelf: async (list, state) => { calls.shelf.push(...list.map((x) => ({ ...x, state }))); return { failed: new Map() }; },
      sheinCheckDeletable: async (skcs) => ({ ok: new Set(deletable ? skcs : []), no: new Map(deletable ? [] : skcs.map((k) => [k, 'quota used up'])) }),
      sheinDeleteSkc: async (skc) => { calls.deletes.push(skc); return { submitted: true, applyNo: 'APP1' }; },
      sheinDeleteLogs: async (skcs) => new Map(deleteLog ? skcs.map((k) => [k, deleteLog]) : []),
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

  test('preview: decides and logs every size, writes nothing', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify });
    const r = await stepProduct('spu1', ctxFor(f.io, 'dry', scan()));
    expect(f.calls.stock).toEqual([]); expect(f.calls.edits).toEqual([]);
    expect(f.calls.items).toHaveLength(3);
    const s7 = f.calls.items.find((i) => i.shein_sku === 's7');
    expect(s7).toMatchObject({ before_qty: 9, target_qty: 4, shopify_qty: 5, held: 1, wrote: 'dry', reason: 'ok' });
    expect(s7.action).toContain('would set 9 → 4');
    // …and it shows the SKU fix full mode would send (checked, not sent).
    expect(f.calls.items.find((i) => i.shein_sku === 's75').action).toContain('would change A8 → A8-off');
    expect(f.calls.items.find((i) => i.shein_sku === 's8').action).toContain('step 2 of 2');
    expect(r.counts).toMatchObject({ sizes: 3, links_changed: 0, links_skipped: 1 });   // step 1 only parks; s8's move is step 2
  });

  test('stock mode: SHEIN gets Shopify’s live number (total incl. held), read back; SKUs untouched', async () => {
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

  test('SHEIN still shows the old number after a write: wait, write again, read back — and an unwritten size is never a mismatch', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    // s75 already right (Shopify 8 → A8 = 2): not written, so not read back.
    const f = fakeIO({ spu, stock, shopify });
    const set = f.io.sheinSetStock; let first = true;
    f.io.sheinSetStock = async (writes) => {   // the first write of s8 is accepted but doesn't show
      if (first) { first = false; f.calls.stock.push(...writes); return set(writes.filter((w) => w.skuCode !== 's8')).then(() => ({ failed: [] })); }
      return set(writes);
    };
    f.io.readBackWaits = [0, 0, 0];
    const r = await stepProduct('spu1', ctxFor(f.io, 'stock', scan()));
    expect(f.calls.stock.filter((w) => w.skuCode === 's8')).toHaveLength(2);
    expect(f.calls.stock.find((w) => w.key.endsWith('-again'))).toBeTruthy();
    expect(f.calls.items.find((i) => i.shein_sku === 's8')).toMatchObject({ after_qty: 0, result: 'changed' });
    expect(r.counts.mismatch).toBe(0);
  });

  test('a write SHEIN never takes is reported as a mismatch (after the retries)', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify });
    f.io.sheinSetStock = async (writes) => { f.calls.stock.push(...writes); return { failed: [] }; };   // accepts, changes nothing
    f.io.readBackWaits = [0, 0, 0];
    const r = await stepProduct('spu1', ctxFor(f.io, 'stock', scan()));
    expect(f.calls.items.find((i) => i.shein_sku === 's8')).toMatchObject({ before_qty: 3, target_qty: 0, after_qty: 3, result: 'mismatch' });
    expect(r.counts.mismatch).toBe(3);
  });

  test('full mode: the swap is sent to SHEIN and remembered (the size sells once SHEIN shows it)', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify });
    await stepProduct('spu1', ctxFor(f.io, 'full', scan()));
    // Step 1 only: SHEIN refuses A8 on s8 while s75 shows it, so s75 moves off first.
    expect(f.calls.edits.map((e) => [e.skuCode, e.supplierSku])).toEqual([['s75', 'A8-off']]);
    expect(f.calls.links).toEqual([expect.objectContaining({ shein_sku: 's75', link_sku: null, decision: 'delist' })]);
    const s8 = f.calls.items.find((i) => i.shein_sku === 's8');
    expect(s8).toMatchObject({ wrote: 'stock', target_qty: 0, link_to: 'A8', result: 'changed' });
    expect(s8.action).toContain('step 2 of 2');
  });

  test('full mode, SHEIN’s real refusal: a SKU another size still shows is refused; the two edits both pass and the parked size’s real SKU is saved', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    // Two sizes that hold each other's SKU, and a SHEIN that refuses what the live store refused on 2026-11-06.
    const state = { x8: 'A9', x9: 'A8' };
    const live = () => SPU('spu1', [SKU('x8', state.x8, 'US8'), SKU('x9', state.x9, 'US9')]);
    const f = fakeIO({ spu: live(), stock: [['x8', 0], ['x9', 0]], shopify: [V('A8', '8', 2), V('A9', '9', 2)] });
    f.io.sheinSpuInfo = async () => live();
    f.io.sheinSetSellerSkus = async (n, edits) => {
      for (const e of edits) if (Object.entries(state).some(([code, sku]) => code !== e.skuCode && sku === e.supplierSku)) return { ok: false, version: null, messages: [`Duplicate SKU. SKU: ${e.supplierSku}`] };
      for (const e of edits) state[e.skuCode] = e.supplierSku;
      f.calls.edits.push(...edits);
      return { ok: true, version: 'v1', messages: [] };
    };
    const decisions = {};
    const run = async () => {
      const rows = rowsFromSpu(live(), STOCK([['x8', 0], ['x9', 0]]), {});
      const before = f.calls.links.length;
      const out = await stepProduct('spu1', { ...ctxFor(f.io, 'full', rows), decisions });
      for (const l of f.calls.links.slice(before)) decisions[l.shein_sku] = l;
      return out;
    };
    expect((await run()).counts.errors).toBe(0);
    expect(state).toEqual({ x8: 'A9-off', x9: 'A8-off' });
    expect(decisions.x8).toMatchObject({ link_sku: 'A8', decision: 'link', source: 'swap' });
    expect(decisions.x9).toMatchObject({ link_sku: 'A9', decision: 'link', source: 'swap' });
    expect((await run()).counts.errors).toBe(0);
    expect(state).toEqual({ x8: 'A8', x9: 'A9' });
  });

  test('full mode: the SKU edit carries the details SHEIN now requires; with no default set it waits (SHEIN would refuse it)', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const list = [{ attribute_id: 1002260, attribute_value_id: 459 }];
    const f = fakeIO({ spu, stock, shopify });
    let sent = null;
    f.io.sheinSetSellerSkus = async (spuName, edits, opts) => { sent = opts; f.calls.edits.push(...edits); return { ok: true, version: 'v1', messages: [] }; };
    f.io.sheinEditAttrs = async () => ({ list, added: [{ attributeId: 1002260, attribute: 'Reflection' }], dropped: [], problems: [] });
    await stepProduct('spu1', ctxFor(f.io, 'full', scan()));
    expect(sent).toEqual({ attributes: list });
    expect(f.calls.items.find((i) => i.shein_sku === 's75').action).toContain('SHEIN details it now requires (Reflection)');
    const g = fakeIO({ spu, stock, shopify });
    g.io.sheinEditAttrs = async () => ({ list: null, added: [], dropped: [], problems: [{ code: 'missing_attr', params: { attributeId: 1002260, attribute: 'Reflection' } }] });
    await stepProduct('spu1', ctxFor(g.io, 'full', scan()));
    expect(g.calls.edits).toEqual([]);
    expect(g.calls.items.find((i) => i.shein_sku === 's75').action).toContain('SHEIN now requires Reflection on this shoe');
    expect(g.calls.stock.length).toBeGreaterThan(0);   // stock is still fixed
    // nothing missing → no list (an attribute list sends every colour to review)
    const h = fakeIO({ spu, stock, shopify }); let opts = 'unset';
    h.io.sheinSetSellerSkus = async (n, e, o) => { opts = o; return { ok: true, version: 'v1', messages: [] }; };
    h.io.sheinEditAttrs = async () => ({ list: null, added: [], dropped: [], problems: [] });
    await stepProduct('spu1', ctxFor(h.io, 'full', scan()));
    expect(opts).toEqual({ attributes: null });
  });

  test('full mode: a product SHEIN is still reviewing gets stock fixed but no edit', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify, inReview: true });
    await stepProduct('spu1', ctxFor(f.io, 'full', scan()));
    expect(f.calls.edits).toEqual([]);
    expect(f.calls.stock.length).toBe(3);
    expect(f.calls.items.find((i) => i.shein_sku === 's75').action).toContain('still reviewing');
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

  test('the buyer’s own order time is kept apart from when SHEIN released the order', () => {
    const [u] = unitsFromOrders([order([g('1', '10091348', 1)], { orderTime: '2026-10-16 21:58:00', orderAllocateTime: '2026-10-16 22:00:00' })]);
    expect(u.buyer_order_time).toBe('2026-10-16T13:58:00.000Z');
    expect(u.order_time).toBe('2026-10-16T14:00:00.000Z');
    expect(unitsFromOrders([order([g('1', '10091348', 1)], { orderTime: undefined })])[0].buyer_order_time).toBe(null);
  });

  test('the 10-second check sends only orders it has never seen, and nothing else when there are none', async () => {
    const now = Date.parse('2026-11-07T20:00:00Z');
    const processed = [];
    const windows = [];
    const io = (changed, known = []) => ({
      changed: async (from, to) => { windows.push([from.getTime(), to.getTime()]); return changed; },
      known: async () => new Set(known),
      process: async (nos) => { processed.push(nos); return { units: nos.length, deducted: nos.length, restocked: 0, failed: 0 }; },
    });
    // Nothing changed, or only orders we hold: nothing runs, so failing pairs don't lose tries.
    expect(await checkNewOrders(io([]), now)).toBe(null);
    expect(await checkNewOrders(io(['GSU1'], ['GSU1']), now)).toBe(null);
    expect(processed).toEqual([]);
    // One new among known: only the new one.
    expect(await checkNewOrders(io(['GSU1', 'GSU2'], ['GSU1']), now)).toMatchObject({ orders: 1, deducted: 1 });
    expect(processed).toEqual([['GSU2']]);
    expect(windows[0]).toEqual([now - NEW_ORDER_LOOKBACK_MS, now]);
  });

  test('a new order the check and the webhook both see still comes off once', async () => {
    const unit = { goods_id: '1', order_no: 'GSU1', due: true, stock_mode: 3, exchange_tag: 1, unit_status: 1, deducted_at: null, restocked_at: null, shipped_seen: false, seller_sku: 'A', attempts: 0 };
    const writes = [];
    const io = {
      shopifyConfigured: () => true,
      sheinUnitsToAct: async () => (unit.deducted_at ? [] : [unit]),
      shopifyStockForSku: async () => ({ inventoryItemId: 'I', variantId: 'V', levels: [{ locationId: 'L', location: 'L', available: 3 }] }),
      shopifyAdjustAvailable: async (w) => { writes.push(w); return { ok: true, after: w.from + w.delta }; },
      markSheinUnit: async (_id, m) => { if (m.deducted) unit.deducted_at = 'now'; },
    };
    await Promise.all([actOnUnits(io), actOnUnits(io)]);
    expect(writes).toHaveLength(1);
    expect(writes[0].delta).toBe(-1);
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

  test('taking a unit off Shopify: compare-and-set, refresh when a sale elsewhere got there first, key = goodsId + definite refusals', async () => {
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

  test('the order carries the size’s OLD SKU Shopify no longer has: taken off the SKU it was relinked to — but not on a unit that already gave up', async () => {
    const { applyToShopify } = await import('../api/_lib/shein-orders.js');
    const asked = []; const adjusts = []; const marks = [];
    const io = {
      shopifyStockForSku: async (sku) => { asked.push(sku); return sku === 'NEW8' ? { variantId: 'V2', inventoryItemId: 'I2', levels: [{ locationId: 'L1', location: 'Warehouse', available: 2 }] } : { error: `No Shopify variant has SKU ${sku}.`, code: 'missing' }; },
      shopifyAdjustAvailable: async (a) => { adjusts.push(a); return { ok: true, after: a.from + a.delta }; },
      markSheinUnit: async (id, m) => { marks.push([id, m]); },
      sheinLinkedSku: async (sheinSku) => (sheinSku === 'S8' ? 'NEW8' : null),
    };
    expect((await applyToShopify({ goods_id: 'G1', order_no: 'O1', seller_sku: 'OLD8', shein_sku: 'S8', attempts: 2 }, 'deduct', io)).ok).toBe(true);
    expect(asked).toEqual(['OLD8', 'NEW8']);
    expect(adjusts[0]).toMatchObject({ inventoryItemId: 'I2', delta: -1, from: 2 });
    expect(marks.at(-1)[1].note).toContain('via relinked SKU NEW8');
    asked.length = 0;
    const r = await applyToShopify({ goods_id: 'G2', order_no: 'O1', seller_sku: 'OLD8', shein_sku: 'S8', attempts: 8 }, 'deduct', io);
    expect(r.code).toBe('missing'); expect(asked).toEqual(['OLD8']);
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

test.describe('SHEIN live — the worker', () => {
  test('the 10-second check is on unless switched off', async () => {
    const { fastCheckEnabled } = await import('../api/_lib/shein-worker.js');
    expect(fastCheckEnabled({})).toBe(true);
    expect(fastCheckEnabled({ SHEIN_FAST_ORDER_CHECK: 'OFF ' })).toBe(false);
  });

  test('the stock walk: every 3 h, and at once after a restart cut one off (only once in a row)', async () => {
    const { walkDue, AFTER_RESTART } = await import('../api/_lib/shein-worker.js');
    const now = Date.parse('2026-10-25T15:00:00Z');
    const ago = (h) => new Date(now - h * 3600_000).toISOString();
    expect(walkDue(null, now)).toBe(true);
    expect(walkDue({ status: 'running', started_at: ago(5) }, now)).toBe(false);
    expect(walkDue({ status: 'done', started_at: ago(1) }, now)).toBe(false);
    expect(walkDue({ status: 'done', started_at: ago(4) }, now)).toBe(true);
    expect(walkDue({ status: 'interrupted', started_at: ago(0.2), started_by: 'kervz' }, now)).toBe(true);
    expect(walkDue({ status: 'interrupted', started_at: ago(0.2), started_by: AFTER_RESTART }, now)).toBe(false);
    expect(walkDue({ status: 'stopped', started_at: ago(0.2) }, now)).toBe(false);   // a person stopped it
  });
});

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

    // After a rotation Shopify signs with the OLD secret while SHOPIFY_SECRET_KEY holds the new one.
    const old = process.env.SHOPIFY_WEBHOOK_SECRET;
    const signedByOld = crypto.createHmac('sha256', 'shpss_old_secret').update(raw).digest('base64');
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    expect(shopifyWebhookValid(raw, signedByOld)).toBe(false);
    process.env.SHOPIFY_WEBHOOK_SECRET = 'shpss_old_secret';
    expect(shopifyWebhookValid(raw, signedByOld)).toBe(true);
    expect(shopifyWebhookValid(raw, good)).toBe(true);
    expect(shopifyWebhookValid(raw, crypto.createHmac('sha256', 'someone_else').update(raw).digest('base64'))).toBe(false);
    if (old === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET; else process.env.SHOPIFY_WEBHOOK_SECRET = old;
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
  test('connected: sync switches, a automatic sync needs “4seller paused”, the run’s sizes filter', async ({ page }) => {
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
    await page.goto('/shein?section=live&liveadv=1');
    await expect(page.locator('[data-section="live"]').getByText('SHEIN sales → Shopify').first()).toBeVisible();
    await expect(page.getByText('SHEIN sales → Shopify', { exact: false }).first()).toBeVisible();
    // Turning the sales sync on asks about the orders already sold but not shipped.
    await page.getByRole('button', { name: 'Turn on SHEIN sales → Shopify…' }).click();
    await expect(page.getByText('already sold but not shipped yet')).toBeVisible();
    await page.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect.poll(() => posted.at(-1)).toEqual({ action: 'orders_on', openAtStart: true });
    // A automatic sync can't start until 4seller is said to be paused.
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

  test('Shopify orders: a shipped sale has Add to Shopify, a written one links to its order, a cancelled one has no button', async ({ page }) => {
    const { loginAs } = await import('./helpers/auth.js');
    const posted = [];
    const unit = (id, order, status, extra = {}) => ({ goods_id: id, order_no: order, unit_status: status, shipped_seen: status === 4, due: true, deducted_at: '2026-11-08T23:00:00Z', order_time: '2026-11-08T23:00:00Z', seller_sku: 'A7', title: 'Air Max', ...extra });
    let live = {
      ok: true, connected: true, configured: true, worker: true, active: null, modes: ['dry', 'stock', 'full'], run: null, items: [], pushes: [],
      sync: { orders: 'on', since: '2026-10-16T14:00:00Z', shopifyOrders: 'off', shopifyOrdersSince: '2026-11-07T00:00:00Z' }, unitCounts: { last24: 0, failing: 0 }, shopifyOrdersReady: true, shopifyStore: 'teststore',
      units: [unit('1', 'GSUSHIP', 4), unit('2', 'GSUDONE', 4), unit('3', 'GSUGONE', 6), unit('4', 'GSUOPEN', 2), unit('5', 'GSUBAD', 4), unit('6', 'GSUPAST', 4, { order_time: '2026-11-03T23:00:00Z' })],
      shopifyOrders: [{ order_no: 'GSUDONE', state: 'created', shopify_order_id: 'gid://shopify/Order/55', shopify_name: '#40000' }, { order_no: 'GSUBAD', state: 'failed', error: 'Location not found' }],
    };
    await page.route('**/api/shein/status', (r) => r.fulfill({ json: { ok: true, configured: true, connected: true } }));
    await page.route('**/api/shein/live', (r) => {
      if (r.request().method() !== 'POST') return r.fulfill({ json: live });
      const b = r.request().postDataJSON(); posted.push(b);
      if (b.action === 'shopify_order') {
        live = { ...live, shopifyOrders: [...live.shopifyOrders, { order_no: b.orderNo, state: 'created', shopify_order_id: 'gid://shopify/Order/56', shopify_name: '#40001' }] };
        return r.fulfill({ json: { ok: true, result: { state: 'created', name: '#40001' } } });
      }
      live = { ...live, sync: { ...live.sync, shopifyOrders: 'on' } };
      return r.fulfill({ json: { ok: true } });
    });
    await loginAs(page, 'admin');
    await page.goto('/shein?section=live&liveadv=1');
    await page.getByText('Latest SHEIN sales', { exact: false }).click();
    const row = (no) => page.locator('tr', { hasText: no });
    await expect(row('GSUDONE').getByRole('link', { name: '#40000' })).toHaveAttribute('href', 'https://admin.shopify.com/store/teststore/orders/55');
    await expect(row('GSUGONE').getByRole('button')).toHaveCount(0);
    await expect(row('GSUOPEN').getByRole('button')).toHaveCount(0);
    // Future orders only: shipped, but sold before the switch-on, so no button.
    await expect(row('GSUPAST').getByRole('button')).toHaveCount(0);
    await expect(row('GSUBAD').getByText('Location not found')).toBeVisible();
    await expect(row('GSUBAD').getByRole('button', { name: 'Try again' })).toBeVisible();
    await row('GSUSHIP').getByRole('button', { name: 'Add to Shopify' }).click();
    await expect.poll(() => posted.at(-1)).toEqual({ action: 'shopify_order', orderNo: 'GSUSHIP' });
    await expect(page.getByText('GSUSHIP is in Shopify as #40001.')).toBeVisible();
    await expect(row('GSUSHIP').getByRole('link', { name: '#40001' })).toBeVisible();
    // The going-forward switch is separate from adding one order.
    await page.getByRole('button', { name: 'Turn on SHEIN orders in Shopify' }).click();
    await expect.poll(() => posted.at(-1)).toEqual({ action: 'shopify_orders_on' });
    await expect(page.getByRole('button', { name: 'Stop SHEIN orders in Shopify' })).toBeVisible();
    await page.getByRole('button', { name: 'Write orders at the sale' }).click();
    await expect.poll(() => posted.at(-1)).toEqual({ action: 'shopify_orders_at_sale' });
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
    await page.goto('/shein?section=live&liveadv=1');
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

/* ------------------------- delist / re-list / delete ------------------------- */
test.describe('SHEIN live — whole shoes off the shelf', () => {
  const shelfOn = (on) => ({ shelfStatusInfoList: [{ siteAbbr: 'shein-us', shelfStatus: on ? 1 : 0 }] });
  const SPUS = (on, skus) => ({ ...SPU('spuX', skus), skcInfoList: [{ skcName: 'skcX', ...shelfOn(on), skuInfoList: skus }] });
  const row = (size, newQty, reason = 'ok', extra = {}) => ({ skc: 'skcX', size, newQty, reason, ...extra });
  const shelf = (on) => new Map([['skcX', on ? { on: ['shein-us'], off: [] } : { on: [], off: ['shein-us'] }]]);

  test('the owner’s example: sizes 8/9/10 = SKUs 123/456/789; one size at 0 keeps the shoe up, all three at 0 delists it', () => {
    expect(shelfPlan({ rows: [row('8', 0), row('9', 1), row('10', 1)], shelf: shelf(true) })).toEqual([]);
    expect(shelfPlan({ rows: [row('8', 0), row('9', 0), row('10', 0)], shelf: shelf(true) }))
      .toEqual([{ skc: 'skcX', act: 'delist', sites: ['shein-us'], why: 'every size is at 0' }]);
  });

  test('delete only when every SKU is gone from Shopify AND it is already off the shelf; a 0-stock shoe still on Shopify is never deleted', () => {
    const gone = [row('8', 0, 'no_shopify'), row('9', 0, 'no_shopify')];
    expect(shelfPlan({ rows: gone, shelf: shelf(true) })[0]).toMatchObject({ act: 'delist', why: 'every size’s seller SKU is gone from Shopify' });
    expect(shelfPlan({ rows: gone, shelf: shelf(false) })[0]).toMatchObject({ act: 'delete' });
    expect(shelfPlan({ rows: [row('8', 0, 'no_shopify'), row('9', 0)], shelf: shelf(false) })).toEqual([]);     // one size still on Shopify
    expect(shelfPlan({ rows: [row('8', 0, 'no_shopify', { linkTo: { sku: 'N8' } })], shelf: shelf(false) })).toEqual([]);   // a relink is coming
    const rec = (state) => new Map([['skcX', { state }]]);
    expect(shelfPlan({ rows: gone, shelf: shelf(false), records: rec('delete_requested') })[0]).toMatchObject({ act: 'delete_check' });
    expect(shelfPlan({ rows: gone, shelf: shelf(false), records: rec('delete_refused') })).toEqual([]);
    expect(shelfPlan({ rows: gone, shelf: shelf(false), records: rec('deleted') })).toEqual([]);
  });

  test('SKUs gone but Shopify still sells the STYLE (re-made with new SKUs): delisted at 0, never deleted', () => {
    const gone = [row('8', 0, 'no_shopify'), row('9', 0, 'no_shopify')];
    const kept = new Set(['skcX']);
    expect(shelfPlan({ rows: gone, shelf: shelf(true), styleOnShopify: kept })[0]).toMatchObject({ act: 'delist' });
    expect(shelfPlan({ rows: gone, shelf: shelf(false), styleOnShopify: kept })).toEqual([expect.objectContaining({ act: 'relink' })]);
    expect(shelfPlan({ rows: gone, shelf: shelf(false), styleOnShopify: kept, records: new Map([['skcX', { state: 'delete_requested' }]]) })[0].act).toBe('relink');
  });

  test('re-list only what WE delisted, and not within SHEIN’s 20-minute gap', () => {
    const back = [row('8', 0), row('9', 2)];
    expect(shelfPlan({ rows: back, shelf: shelf(false) })).toEqual([]);                                      // a person delisted it: leave it
    const now = Date.parse('2026-10-23T15:00:00Z');
    const ours = (mins) => new Map([['skcX', { state: 'delisted', sites: ['shein-us'], shelf_at: new Date(now - mins * 60_000).toISOString() }]]);
    expect(shelfPlan({ rows: back, shelf: shelf(false), records: ours(30), now })[0]).toMatchObject({ act: 'relist', sites: ['shein-us'] });
    expect(shelfPlan({ rows: back, shelf: shelf(false), records: ours(5), now })[0]).toMatchObject({ act: 'wait' });
    expect(shelfPlan({ rows: back, shelf: shelf(true), records: ours(30), now })[0]).toMatchObject({ act: 'settle' });   // someone listed it by hand
    expect(shelfFrom(SPUS(true, []))).toEqual(new Map([['skcX', { on: ['shein-us'], off: [] }]]));
  });

  test('a walk: all sizes 0 on Shopify → SHEIN stock 0 AND the shoe delisted, remembered as ours', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const spu = SPUS(true, [SKU('s7', 'A7', 'US7'), SKU('s8', 'A8', 'US8')]);
    const f = fakeIO({ spu, stock: [['s7', 2], ['s8', 1]], shopify: [V('A7', '7', 0), V('A8', '8', 0)] });
    f.io.readBackWaits = [0, 0, 0];
    const r = await stepProduct('spuX', ctxFor(f.io, 'stock', rowsFromSpu(spu, STOCK([['s7', 2], ['s8', 1]]), {})));
    expect(f.calls.shelf).toEqual([{ skc: 'skcX', sites: ['shein-us'], state: 2 }]);
    expect(f.calls.saved[0]).toMatchObject({ skc: 'skcX', state: 'delisted', sites: ['shein-us'], shelfAt: true });
    expect(r.counts.skc_delisted).toBe(1);
    expect(f.calls.items[0].action).toContain('shoe DELISTED on SHEIN');
  });

  test('a walk: every SKU gone from Shopify and off the shelf → delete requested; its sizes no longer “need a person”', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const spu = SPUS(false, [SKU('s7', 'DEAD7', 'US7'), SKU('s8', 'DEAD8', 'US8')]);
    const scan = rowsFromSpu(spu, STOCK([['s7', 0], ['s8', 0]]), {});
    const f = fakeIO({ spu, stock: [['s7', 0], ['s8', 0]], shopify: [V('A9', '9', 3)] });
    const r = await stepProduct('spuX', ctxFor(f.io, 'stock', scan));
    expect(f.calls.deletes).toEqual(['skcX']);
    expect(f.calls.saved[0]).toMatchObject({ state: 'delete_requested', applyNo: 'APP1' });
    expect(f.calls.items.every((i) => i.reason === 'gone')).toBe(true);
    expect(r.counts).toMatchObject({ needs_person: 0, skc_delete_requested: 1 });
    // A single Shopify push never deletes; SHEIN's quota/permission "no" leaves it delisted.
    const p = fakeIO({ spu, stock: [['s7', 0], ['s8', 0]], shopify: [V('A9', '9', 3)] });
    await stepProduct('spuX', { ...ctxFor(p.io, 'stock', scan), source: 'push' });
    expect(p.calls.deletes).toEqual([]);
    const q = fakeIO({ spu, stock: [['s7', 0], ['s8', 0]], shopify: [V('A9', '9', 3)], deletable: false });
    await stepProduct('spuX', ctxFor(q.io, 'stock', scan));
    expect(q.calls.deletes).toEqual([]);
    expect(q.calls.items[0].action).toContain('SHEIN won’t delete it: quota used up');
  });

  test('a walk: SKUs gone but the style is on Shopify under new SKUs → no delete, its sizes still need a person (relink)', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const spu = SPUS(false, [SKU('s7', 'DEAD7', 'US7'), SKU('s8', 'DEAD8', 'US8')]);
    const scan = rowsFromSpu(spu, STOCK([['s7', 0], ['s8', 0]]), {});
    const remade = [V('N10', '10', 3, 'P2')];   // same style (IB7936-100), new product, no size the rules can place
    const f = fakeIO({ spu, stock: [['s7', 0], ['s8', 0]], shopify: remade });
    const r = await stepProduct('spuX', { ...ctxFor(f.io, 'stock', scan), catalogue: remade });
    expect(f.calls.deletes).toEqual([]);
    expect(f.calls.items.every((i) => i.reason === 'no_shopify')).toBe(true);
    expect(r.counts.needs_person).toBe(2);
    expect(f.calls.items[0].action).toContain('Shopify still has this style under new SKUs');
  });

  test('one shoe (no catalogue): a shoe re-made under new SKUs is found by its style and relinked — never "would DELETE"', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const spu = SPUS(false, [SKU('s7', 'DEAD7', 'US7'), SKU('s8', 'DEAD8', 'US8')]);
    const scan = rowsFromSpu(spu, STOCK([['s7', 0], ['s8', 0]]), {});
    const remade = [V('N7', '7', 2, 'P2'), V('N8', '8', 1, 'P2')];   // same style IB7936-100, new product + SKUs
    // Before 2026-10-28 the one-shoe run only saw the SKUs' own products: none here → "gone".
    const f = fakeIO({ spu, stock: [['s7', 0], ['s8', 0]], shopify: remade });
    const asked = [];
    f.io.listingProductIdsForStyle = async (style) => { asked.push(style); return ['P2']; };
    await stepProduct('spuX', { ...ctxFor(f.io, 'dry', scan), source: 'shoe' });
    expect(asked).toEqual(['IB7936-100']);
    expect(f.calls.items.map((i) => [i.shein_sku, i.link_to])).toEqual([['s7', 'N7'], ['s8', 'N8']]);
    expect(f.calls.items.some((i) => /DELETE/.test(i.action))).toBe(false);
    expect(f.calls.edits).toEqual([]); expect(f.calls.deletes).toEqual([]);
    // Truly gone (no product of that style): the preview says the walk decides — Fix this shoe never deletes.
    const g = fakeIO({ spu, stock: [['s7', 0], ['s8', 0]], shopify: [] });
    g.io.listingProductIdsForStyle = async () => [];
    const r = await stepProduct('spuX', { ...ctxFor(g.io, 'dry', scan), source: 'shoe' });
    expect(g.calls.items[0].action).toContain('Fix this shoe never does');
    expect(g.calls.items.some((i) => /would ask SHEIN to DELETE/.test(i.action))).toBe(false);
    expect(r.counts.skc_delete_requested).toBeUndefined();
    const full = fakeIO({ spu, stock: [['s7', 0], ['s8', 0]], shopify: [] });
    full.io.listingProductIdsForStyle = async () => [];
    await stepProduct('spuX', { ...ctxFor(full.io, 'full', scan), source: 'shoe' });
    expect(full.calls.deletes).toEqual([]);
  });

  test('SHEIN’s review answer is recorded: deleted, or refused (it stays delisted, never asked again)', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const spu = SPUS(false, [SKU('s7', 'DEAD7', 'US7')]);
    const scan = rowsFromSpu(spu, STOCK([['s7', 0]]), {});
    const records = new Map([['skcX', { state: 'delete_requested' }]]);
    const ok = fakeIO({ spu, stock: [['s7', 0]], shopify: [], records, deleteLog: { status: 2 } });
    expect((await stepProduct('spuX', ctxFor(ok.io, 'stock', scan))).counts.skc_deleted).toBe(1);
    expect(ok.calls.saved[0]).toMatchObject({ state: 'deleted' });
    const no = fakeIO({ spu, stock: [['s7', 0]], shopify: [], records, deleteLog: { status: 3, fail_reason: 'order in the last year' } });
    await stepProduct('spuX', ctxFor(no.io, 'stock', scan));
    expect(no.calls.saved[0]).toMatchObject({ state: 'delete_refused', note: 'order in the last year' });
  });

  test('preview: says what it would delist / delete, touches nothing', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const spu = SPUS(true, [SKU('s7', 'A7', 'US7')]);
    const f = fakeIO({ spu, stock: [['s7', 2]], shopify: [V('A7', '7', 0)] });
    const r = await stepProduct('spuX', ctxFor(f.io, 'dry', rowsFromSpu(spu, STOCK([['s7', 2]]), {})));
    expect(f.calls.shelf).toEqual([]); expect(f.calls.saved).toEqual([]);
    expect(r.counts.skc_delisted).toBe(1);
    expect(f.calls.items[0].action).toContain('would DELIST this shoe');
  });
});

/* ------------------- one shoe (SHEIN Listings → Details → Fix this shoe) ------------------- */
// docs/context/shein-live-fix.md → "One shoe". The walk's step for ONE product, without the store scan.
test.describe('SHEIN live — one shoe', () => {
  // The user's shoe (2026-10-28): SHEIN US7.5 carries our size 8's SKU (A8); our 7.5 (A75) is on SHEIN US7-8.
  const VARS = [V('A75', '7.5', 0), V('A8', '8', 0), V('A9', '9', 0)];
  const spu = SPU('spu1', [SKU('s78', 'A75', 'US7-8'), SKU('s75', 'A8', 'US7.5'), SKU('s9', 'A9', 'US9')]);
  const stock = [['s78', 0], ['s75', 0], ['s9', 0]];
  const scan = () => rowsFromSpu(spu, STOCK(stock), {});

  test('a size a person took off SHEIN keeps its live SKU — unless parkDelisted (one shoe only): then it is parked so the right size can carry it', () => {
    const r = scan();
    const decisions = { s75: { shein_sku: 's75', decision: 'delist', link_sku: null, decided_by: 'Kervy' } };
    const base = { rows: r, variants: VARS, decisions, owners: ownersFrom(r, VARS), holders: indexRows(r).holders, target: 'W1' };
    const walk = planProduct(base);
    expect(walk.rows.find((x) => x.sheinSku === 's75')).toMatchObject({ reason: 'delist', newQty: 0 });
    expect(walk.edits).toEqual([]);   // the full walk is unchanged
    const one = planProduct({ ...base, parkDelisted: true });
    expect(one.edits).toEqual([{ skc: 'spu1-c', skuCode: 's75', supplierSku: 'A8-off', from: 'A8', by: 'person', why: 'frees', frees: 'A8' }]);
    // a parked name already in use anywhere is skipped
    const holders = indexRows([...r, { spu: 'spu9', sheinSku: 'z', sellerSku: 'A8-off' }]).holders;
    expect(planProduct({ ...base, holders, parkDelisted: true }).edits[0].supplierSku).toBe('A8-off2');
    // a SKU Shopify no longer has is not parked (nothing needs it), nor in stock mode
    expect(planProduct({ ...base, variants: VARS.filter((v) => v.sku !== 'A8'), parkDelisted: true }).edits).toEqual([]);
    expect(planProduct({ ...base, links: false, parkDelisted: true }).edits).toEqual([]);
  });

  test('step without a catalogue: the Shopify product SHEIN Listings matched is read live (productIds), and a person’s link to a SKU of ANOTHER product is looked up', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const other = V('B9', '9', 3, 'P2', { productTitle: 'Other shoe', style: 'ZZ0000-001' });
    const f = fakeIO({ spu, stock, shopify: [...VARS, other] });
    const asked = [];
    const live = f.io.shopifyProductsLive; f.io.shopifyProductsLive = async (ids) => { asked.push(...ids); return live(ids); };
    const r = scan();
    const ctx = { ...ctxFor(f.io, 'dry', r), source: 'shoe', productIds: ['P1'], parkDelisted: true,
      decisions: { s75: { shein_sku: 's75', decision: 'delist', link_sku: null }, s9: { shein_sku: 's9', decision: 'link', link_sku: 'B9' } } };
    const out = await stepProduct('spu1', ctx);
    expect(asked).toEqual(expect.arrayContaining(['P1', 'P2']));
    expect(f.calls.stock).toEqual([]); expect(f.calls.edits).toEqual([]);   // a preview writes nothing
    const by = Object.fromEntries(f.calls.items.map((i) => [i.shein_sku, i]));
    expect(by.s75).toMatchObject({ source: 'shoe', reason: 'delist', wrote: 'dry' });
    expect(by.s75.action).toContain('A8 → A8-off');
    expect(by.s9).toMatchObject({ reason: 'pending_change', link_to: 'B9', link_by: 'person' });
    expect(out.counts.sizes).toBe(3);
  });

  test('full: the park is sent to SHEIN and remembered as taken off', async () => {
    const { stepProduct } = await import('../api/_lib/shein-live.js');
    const f = fakeIO({ spu, stock, shopify: VARS });
    const r = scan();
    await stepProduct('spu1', { ...ctxFor(f.io, 'full', r), source: 'shoe', productIds: ['P1'], parkDelisted: true,
      decisions: { s75: { shein_sku: 's75', decision: 'delist', link_sku: null } } });
    expect(f.calls.edits.map((e) => [e.skuCode, e.supplierSku])).toEqual([['s75', 'A8-off']]);
    expect(f.calls.links).toEqual([expect.objectContaining({ shein_sku: 's75', link_sku: null, decision: 'delist', seller_sku_was: 'A8' })]);
  });

  test('a one-shoe run is never “the” walk: the live panel and the 3-hour re-walk skip it; the drawer finds it by SPU', async () => {
    const db = await import('../api/_lib/db.js');
    const walk = await db.createSheinLiveRun({ mode: 'dry', by: 'e2e' });
    const one = await db.createSheinLiveRun({ mode: 'shoe:dry', by: 'e2e' });
    try {
      await db.updateSheinLiveRun(one.id, { current: 'e2e-spu-one', status: 'done', finished: true });
      await db.updateSheinLiveRun(walk.id, { status: 'done', finished: true });
      expect((await db.latestSheinLiveRun()).id).toBe(walk.id);
      expect((await db.latestShoeRun('e2e-spu-one')).id).toBe(one.id);
      expect(await db.latestShoeRun('e2e-spu-none')).toBeNull();
    } finally {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query('DELETE FROM shein_live_runs WHERE id = ANY($1::bigint[])', [[walk.id, one.id]]).finally(() => pool.end());
    }
  });

  test('the endpoint: preview open to PH, Fix needs admin / Connect integrations; a bad SPU is refused before SHEIN is called', async ({ request }) => {
    const { signToken } = await import('../api/_lib/util.js');
    const ph = { Authorization: `Bearer ${signToken({ uid: 'e2e-ph', username: 'e2e_ph', name: 'E2E PH', role: 'ph_team' })}` };
    const admin = { Authorization: `Bearer ${signToken({ uid: 'admin', username: 'admin', name: 'Alex', role: 'admin' })}` };
    const wh = { Authorization: `Bearer ${signToken({ uid: 'e2e-wh', username: 'e2e_wh', name: 'E2E WH', role: 'warehouse' })}` };
    expect((await request.get('/api/shein/live?shoe=spu1', { headers: wh })).status()).toBe(403);
    expect((await request.get('/api/shein/live?shoe=bad%20spu!', { headers: ph })).status()).toBe(400);
    const g = await request.get('/api/shein/live?shoe=e2e-spu-none', { headers: ph });
    expect(g.status()).toBe(200);
    expect(await g.json()).toMatchObject({ ok: true, run: null, items: [], links: [] });
    let r = await request.post('/api/shein/live', { headers: ph, data: { action: 'shoe', spu: 'spu1', mode: 'full' } });
    expect(r.status()).toBe(403);
    expect((await r.json()).error).toContain('Connect integrations');
    r = await request.post('/api/shein/live', { headers: ph, data: { action: 'shoe', spu: 'x y', mode: 'dry' } });
    expect(r.status()).toBe(400);
    r = await request.post('/api/shein/live', { headers: admin, data: { action: 'shoe', spu: 'spu1', mode: 'stock' } });
    expect(r.status()).toBe(400);   // one shoe: dry or full only
  });
});

/* ---------------- SHEIN orders written to Shopify (our own app) ---------------- */
test.describe('SHEIN orders in Shopify', () => {
  const GOOD = (extra = {}) => ({ goodsId: 1001, sellerSku: 'A7', skuCode: 's7', goodsTitle: 'Nike Air Max 95', newGoodsStatus: 4, goodsExchangeTag: 1, sellerCurrencyPrice: 55, saleTax: 3.99, ...extra });
  const ORDER = (extra = {}) => ({ orderNo: 'GSU1', stockMode: 3, orderStatus: 4, orderCurrency: 'USD', orderAllocateTime: '2026-11-04 07:13:00.000+0800', packageWaybillList: [{ waybillNo: '1Z999', carrier: 'UPS' }], orderGoodsInfoList: [GOOD()], ...extra });
  const LOC = 'gid://shopify/Location/1';

  test('ready only once every live pair has shipped; a cancel before shipping never reaches Shopify', () => {
    expect(sheinOrderState(ORDER()).state).toBe('ready');
    expect(sheinOrderState(ORDER({ orderGoodsInfoList: [GOOD({ newGoodsStatus: 2 })] })).state).toBe('wait');
    expect(sheinOrderState(ORDER({ orderGoodsInfoList: [GOOD(), GOOD({ goodsId: 1002, newGoodsStatus: 1 })] })).state).toBe('wait');
    expect(sheinOrderState(ORDER({ orderGoodsInfoList: [GOOD({ newGoodsStatus: 6 })] })).state).toBe('skip');
    expect(sheinOrderState(ORDER({ orderGoodsInfoList: [GOOD({ goodsExchangeTag: 2 })] })).state).toBe('skip');
    expect(sheinOrderState(ORDER({ stockMode: 2 })).state).toBe('skip');
    // A refunded pair beside a shipped one: the order is ready, with the shipped pair only.
    const mixed = ORDER({ orderGoodsInfoList: [GOOD(), GOOD({ goodsId: 1002, newGoodsStatus: 6 })] });
    expect(sheinOrderState(mixed).state).toBe('ready');
    expect(shopifyOrderInput(mixed, { locationId: LOC }).order.lineItems).toHaveLength(1);
  });

  test('the input: real sale date, paid, fulfilled with tracking, same marks as CedCommerce, tax is SHEIN’s to pay', () => {
    const { order, total } = shopifyOrderInput(ORDER(), { variants: new Map([['A7', 'gid://shopify/ProductVariant/7']]), locationId: LOC, now: new Date('2026-11-07T00:00:00Z') });
    expect(total).toBe(58.99);
    expect(order.processedAt).toBe(fromSheinTime('2026-11-04 07:13:00.000+0800'));
    expect(order).toMatchObject({ financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', sourceIdentifier: 'GSU1', tags: ['SHEIN', 'GSU1'], note: 'Source order id: GSU1' });
    expect(order.fulfillment).toEqual({ locationId: LOC, notifyCustomer: false, trackingNumber: '1Z999', trackingCompany: 'UPS' });
    expect(order.transactions[0]).toMatchObject({ gateway: 'SHEIN', amountSet: { shopMoney: { amount: '58.99', currencyCode: 'USD' } } });
    const line = order.lineItems[0];
    expect(line).toMatchObject({ variantId: 'gid://shopify/ProductVariant/7', quantity: 1, priceSet: { shopMoney: { amount: '55.00' } } });
    expect(line.taxLines[0]).toMatchObject({ title: 'Sale tax', rate: 0.0725, channelLiable: true, priceSet: { shopMoney: { amount: '3.99' } } });
    expect(order).not.toHaveProperty('sourceName');   // the Channel label comes from the app; a name here is ignored
  });

  test('prices: sale price minus coupon and promotion, never SHEIN’s “discount” field (that total already has the tax in it); never a blank or $0 order', () => {
    // Real orders, read from SHEIN 2026-11-06. The field = net price + tax, every time.
    for (const [price, promo, tax, paid, net] of [[76, 0, 5.32, 81.32, 76], [55, 0, 3.99, 58.99, 55], [68, 0, 3.89, 71.89, 68], [59.36, 2.97, 3.38, 59.77, 56.39]]) {
      const g = GOOD({ sellerCurrencyPrice: price, orderCurrencyPromotionPrice: promo, saleTax: tax, sellerCurrencyDiscountPrice: paid });
      expect(sheinLinePrice(g)).toBe(net);
      expect(shopifyOrderInput(ORDER({ orderGoodsInfoList: [g] }), { locationId: LOC }).total).toBe(paid);
    }
    expect(sheinLinePrice(GOOD({ orderCurrencyStoreCouponPrice: 5, orderCurrencyPromotionPrice: 2 }))).toBe(48);
    expect(() => shopifyOrderInput(ORDER({ orderGoodsInfoList: [GOOD({ sellerCurrencyPrice: null })] }), { locationId: LOC })).toThrow(/no usable price/);
    expect(() => shopifyOrderInput(ORDER({ orderGoodsInfoList: [GOOD({ sellerCurrencyPrice: 0 })] }), { locationId: LOC })).toThrow(/no usable price/);
    expect(() => shopifyOrderInput(ORDER({ orderCurrency: 'EUR' }), { locationId: LOC })).toThrow(/EUR/);
    expect(() => shopifyOrderInput(ORDER(), {})).toThrow(/location/);
  });

  test('a SKU Shopify no longer has goes in by SKU and title; no tracking yet still fulfils', () => {
    const { order } = shopifyOrderInput(ORDER({ packageWaybillList: [] }), { locationId: LOC });
    expect(order.lineItems[0]).toMatchObject({ sku: 'A7', title: 'Nike Air Max 95' });
    expect(order.lineItems[0]).not.toHaveProperty('variantId');
    expect(order.fulfillment).toEqual({ locationId: LOC, notifyCustomer: false });
  });

  // A fake store: the DB row, SHEIN and both Shopify apps. The row behaves as the real claim does.
  function fakeIo({ detail = ORDER(), create = () => ({ ok: true, id: 'gid://shopify/Order/9', name: '#40000', source: '123' }), find = () => ({ order: null }), row = null } = {}) {
    const st = { row, creates: [], finds: 0, stockReads: 0 };
    const io = {
      sheinOrdersConfigured: () => true,
      orderDetails: async () => (detail ? [detail] : []),
      shopifyStockForSku: async (sku) => { st.stockReads += 1; return { variantId: `gid://shopify/ProductVariant/${sku}`, levels: [{ locationId: LOC, location: '1', available: 2 }] }; },
      sheinLinkedSku: async () => null,
      shopifyFindSheinOrder: async () => { st.finds += 1; return find(); },
      shopifyCreateSheinOrder: async (o) => { st.creates.push(o); return create(); },
      claim: async (no, by) => {
        if (st.row && !['waiting', 'failed'].includes(st.row.state) && !st.row.stale) return null;
        st.row = { ...st.row, order_no: no, state: 'creating', attempts: (st.row?.attempts || 0) + 1, requested_by: by, stale: false };
        return st.row;
      },
      mark: async (no, patch) => { st.row = { ...st.row, ...patch, shopify_name: patch.name ?? st.row.shopify_name, stale: false }; },
      get: async () => st.row,
    };
    return { io, st };
  }

  test('writes once; a second call finds the row and writes nothing', async () => {
    const { io, st } = fakeIo();
    const r = await addOrderToShopify('GSU1', { by: 'Kev', io });
    expect(r).toMatchObject({ state: 'created', name: '#40000', total: 58.99 });
    expect(st.creates).toHaveLength(1);
    expect(st.creates[0].fulfillment.locationId).toBe(LOC);
    const again = await addOrderToShopify('GSU1', { by: 'Kev', io });
    expect(again).toMatchObject({ state: 'created', name: '#40000' });
    expect(st.creates).toHaveLength(1);
  });

  test('a lost answer stays "creating"; the next try finds the order in Shopify and does not write a second one', async () => {
    let live = null;
    const { io, st } = fakeIo({ create: () => { live = { id: 'gid://shopify/Order/9', name: '#40000', sourceName: '123' }; return { error: 'Shopify answered HTTP 502 with no result.', definite: false }; }, find: () => ({ order: live }) });
    const first = await addOrderToShopify('GSU1', { io });
    expect(first.state).toBe('creating');
    expect(st.row.state).toBe('creating');
    // Within the 5 minutes the row can't be claimed at all.
    expect((await addOrderToShopify('GSU1', { io })).busy).toBe(true);
    expect(st.creates).toHaveLength(1);
    st.row.stale = true;   // 5 minutes later
    const later = await addOrderToShopify('GSU1', { io });
    expect(later).toMatchObject({ state: 'created', name: '#40000', already: true });
    expect(st.creates).toHaveLength(1);
  });

  test('a definite refusal can be tried again; not shipped waits; refunded is skipped; no credentials writes nothing', async () => {
    let calls = 0;
    const a = fakeIo({ create: () => { calls += 1; return calls === 1 ? { error: 'Location not found', definite: true } : { ok: true, id: 'x', name: '#40001' }; } });
    expect((await addOrderToShopify('GSU1', { io: a.io })).state).toBe('failed');
    expect(a.st.row.error).toBe('Location not found');
    expect((await addOrderToShopify('GSU1', { io: a.io })).name).toBe('#40001');

    const b = fakeIo({ detail: ORDER({ orderGoodsInfoList: [GOOD({ newGoodsStatus: 2 })] }) });
    expect((await addOrderToShopify('GSU1', { io: b.io })).state).toBe('waiting');
    expect(b.st.creates).toHaveLength(0);

    const c = fakeIo({ detail: ORDER({ orderGoodsInfoList: [GOOD({ newGoodsStatus: 6 })] }) });
    expect((await addOrderToShopify('GSU1', { io: c.io })).state).toBe('skipped');
    expect(c.st.creates).toHaveLength(0);

    const d = fakeIo();
    d.io.sheinOrdersConfigured = () => false;
    expect((await addOrderToShopify('GSU1', { io: d.io })).state).toBe('failed');
    expect(d.st.row).toBeNull();
  });

  // At the sale, the DPL way: the order takes the pair off, and the sync's −1 is only the backstop.
  const OPENED = (extra = {}) => ORDER({ packageWaybillList: [], orderGoodsInfoList: [GOOD({ newGoodsStatus: 2 })], ...extra });
  const UNIT = (extra = {}) => ({ goods_id: '1001', order_no: 'GSU1', seller_sku: 'A7', exchange_tag: 1, unit_status: 2, deducted_at: null, restocked_at: null, ...extra });
  const saleIo = (units, opts = {}) => {
    const f = fakeIo({ detail: OPENED(), ...opts });
    f.st.claims = []; f.st.marked = [];
    const create = f.io.shopifyCreateSheinOrder;
    f.io.shopifyCreateSheinOrder = async (o, { claim } = {}) => { f.st.claims.push(claim); return create(o); };
    f.io.units = async () => units;
    f.io.markUnit = async (id, p) => { f.st.marked.push({ id, ...p }); };
    const mark = f.io.mark;
    f.io.mark = async (no, p) => { await mark(no, p); if (p.claimed) f.st.row.stock_claimed = true; };
    return f;
  };

  test('at the sale: written open and claiming the pair; its units are marked off so the sync takes nothing', async () => {
    const { io, st } = saleIo([UNIT()]);
    const r = await addOrderToShopify('GSU1', { io, atSale: true });
    expect(r).toMatchObject({ state: 'created', claimed: true });
    expect(st.claims).toEqual([true]);
    expect(st.creates[0]).not.toHaveProperty('fulfillmentStatus');
    expect(st.creates[0]).not.toHaveProperty('closedAt');
    expect(st.marked).toHaveLength(1);
    expect(st.marked[0]).toMatchObject({ id: '1001', deducted: true, before: 2 });
    expect(st.marked[0].note).toContain('Shopify 2 → 1');
    expect(st.marked[0].note).toContain('#40000');
  });

  test('at the sale: never claims a pair already off, or a SKU with no variant; those stay with the sync', async () => {
    const off = saleIo([UNIT({ deducted_at: '2026-11-06T00:00:00Z' })]);
    expect((await addOrderToShopify('GSU1', { io: off.io, atSale: true })).claimed).toBe(false);
    expect(off.st.claims).toEqual([false]);
    expect(off.st.marked).toHaveLength(0);

    const gone = saleIo([UNIT()]);
    gone.io.shopifyStockForSku = async () => ({ error: 'No Shopify variant', code: 'missing' });
    gone.io.sheinLinkedSku = async () => null;
    await addOrderToShopify('GSU1', { io: gone.io, atSale: true });
    expect(gone.st.claims).toEqual([false]);
    expect(gone.st.marked).toHaveLength(0);
  });

  test('at the sale, a refused order: nothing marked off, so the sync still takes the pair', async () => {
    const { io, st } = saleIo([UNIT()], { create: () => ({ error: 'Nope', definite: true }) });
    expect((await addOrderToShopify('GSU1', { io, atSale: true })).state).toBe('failed');
    expect(st.marked).toHaveLength(0);
  });

  test('at the sale, a lost answer: the retry finds the order and marks its pairs off; never a second order or a second −1', async () => {
    let live = null;
    const { io, st } = saleIo([UNIT()], { create: () => { live = { id: 'gid://shopify/Order/9', name: '#40000', sourceName: '1' }; return { error: 'HTTP 502', definite: false }; }, find: () => ({ order: live }) });
    expect((await addOrderToShopify('GSU1', { io, atSale: true })).state).toBe('creating');
    expect(st.marked).toHaveLength(0);
    st.row.stale = true;
    const later = await addOrderToShopify('GSU1', { io, atSale: true });
    expect(later).toMatchObject({ state: 'created', already: true });
    expect(st.creates).toHaveLength(1);
    expect(st.marked).toHaveLength(1);
    expect(st.marked[0]).toMatchObject({ id: '1001', deducted: true });
  });

  test('the sync: waits while an order is being written; a pair the order took goes back through the order, not a +1', async () => {
    const adjusted = []; const released = [];
    const base = { shopifyConfigured: () => true, shopifyStockForSku: async () => ({ variantId: 'v', inventoryItemId: 'i', levels: [{ locationId: LOC, location: '1', available: 3 }] }),
      shopifyAdjustAvailable: async (a) => { adjusted.push(a); return { ok: true, after: a.from + a.delta }; }, markSheinUnit: async () => {}, sheinLinkedSku: async () => null, ordersAtSale: async () => {},
      releaseClaimed: async (u) => { released.push(u.goods_id); return { ok: true }; } };
    const due = UNIT({ due: true, stock_mode: 3 });
    await actOnUnits({ ...base, sheinUnitsToAct: async () => [due], orderRowsFor: async () => [{ order_no: 'GSU1', state: 'creating' }] });
    expect(adjusted).toHaveLength(0);
    await actOnUnits({ ...base, sheinUnitsToAct: async () => [due], orderRowsFor: async () => [{ order_no: 'GSU1', state: 'failed' }] });
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0].delta).toBe(-1);
    const cancelled = UNIT({ deducted_at: 'x', unit_status: 6, stock_mode: 3 });
    await actOnUnits({ ...base, sheinUnitsToAct: async () => [cancelled], orderRowsFor: async () => [{ order_no: 'GSU1', state: 'created', stock_claimed: true }] });
    expect(released).toEqual(['1001']);
    expect(adjusted).toHaveLength(1);
  });

  test('cancel before shipping: every pair gone cancels the order; one of two goes red for a person', async () => {
    const row = { shopify_order_id: 'gid://o/9', shopify_name: '#40000' };
    const run = async (units) => {
      const log = { cancels: [], marks: [] };
      const r = await releaseClaimedOrder(units[0], row, { units: async () => units, cancel: async (id) => { log.cancels.push(id); return { ok: true }; }, markUnit: async (id, p) => { log.marks.push({ id, ...p }); } });
      return { r, ...log };
    };
    const all = await run([UNIT({ unit_status: 6, deducted_at: 'x' })]);
    expect(all.r.ok).toBe(true);
    expect(all.cancels).toEqual(['gid://o/9']);
    expect(all.marks[0]).toMatchObject({ id: '1001', restocked: true });
    const one = await run([UNIT({ unit_status: 6, deducted_at: 'x' }), UNIT({ goods_id: '1002', unit_status: 2, deducted_at: 'x' })]);
    expect(one.cancels).toHaveLength(0);
    expect(one.r.error).toContain('by hand');
    expect(one.marks[0]).toMatchObject({ id: '1001', failed: true });
  });

  test('shipped: fulfilled with SHEIN’s tracking; a refusal is recorded on the order', async () => {
    const calls = []; const marks = [];
    const io = { sheinOrdersConfigured: () => true, toFulfil: async () => [{ order_no: 'GSU1', shopify_order_id: 'gid://o/9', shopify_name: '#40000' }], orderDetails: async () => [ORDER()],
      fulfil: async (id, t) => { calls.push([id, t]); return { ok: true }; }, markFulfilled: async (no, p) => { marks.push([no, p]); } };
    expect(await fulfilShippedOrders(io)).toEqual({ fulfilled: 1, failed: 0 });
    expect(calls[0]).toEqual(['gid://o/9', { number: '1Z999', company: 'UPS' }]);
    expect(marks[0]).toEqual(['GSU1', { error: null }]);
    io.fulfil = async () => ({ error: 'Access denied' });
    expect(await fulfilShippedOrders(io)).toEqual({ fulfilled: 0, failed: 1 });
    expect(marks[1][1].error).toContain('Access denied');
  });

  test('a SKU two variants share stops the order; no guessing', async () => {
    const { io, st } = fakeIo();
    io.shopifyStockForSku = async () => ({ error: '2 Shopify variants share SKU A7', code: 'ambiguous' });
    expect((await addOrderToShopify('GSU1', { io })).state).toBe('failed');
    expect(st.creates).toHaveLength(0);
  });
});
