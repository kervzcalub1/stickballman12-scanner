// eBay Sync, the oversell guard (docs/context/ebay-sync.md "Oversell guard", docs/ebay-oversell-findings.md):
// eBay may never offer more pairs than Shopify holds. Neither eBay nor Shopify is reached: the engine runs
// against the mocked IO (e2e/helpers/ebaySyncIO.js). What this pins:
//   · a SKU on several listings SHARES Shopify's number (one keeps it, the others are held), never the full
//     number on each; a held listing with nothing else to sell keeps one pair while Shopify has 2 or more;
//   · holding a duplicate at 0 that would END its listing needs the End switch live; otherwise nothing is
//     sent for it, the intent is logged and a person is told;
//   · a negative Shopify quantity is 0 on every path;
//   · LOWERING goes out at once, raising still waits for the settle time;
//   · a refused stock change, and eBay staying above Shopify past the settle time, alert;
//   · in Test mode none of this writes.
import { test, expect } from '@playwright/test';
import { buildLinks, decideLink, stockDecision, planDuplicates, dupTargets, applyDupPlan, oversellOf, oversellWords, buildListing } from '../src/lib/ebaySync.js';
import { reconcilePass, queuePass } from '../api/_lib/ebay-sync.js';
import { mkIO, ctxOf, OLD, TITLE, PROFILE, ALL_LIVE } from './helpers/ebaySyncIO.js';

process.env.EBAY_SYNC_WRITES = 'on';

const STOCK_ONLY = { switches: { stock: 'live', price: 'shadow', content: 'shadow', create: 'shadow', end: 'shadow' }, blastPct: 100 };
const row = (item, sku, size, qty, extra = {}) => ({ item_id: item, variation_key: sku, sku, size, price: 100, qty_available: qty, title: TITLE, view_url: `https://www.ebay.com/itm/${item}`, ...extra });
const variant = (sku, size, qty, pid = 'P1') => ({ variantId: `v-${sku}`, productId: pid, sku, size, price: '100.00', qty, status: 'ACTIVE', productTitle: TITLE });
const decided = (ebayRows, variants) => buildLinks({ ebayRows, variants }).links.map((l) => decideLink(l, {}));
const sent = (t) => t.calls.filter((c) => c[0] === 'reviseEbayQuantities').flatMap((c) => c[1][0]);

test.describe('oversell guard: the rules', () => {
  test('a SKU on two listings shares Shopify\'s number: the listing with more sizes keeps it, the other is held', () => {
    const links = decided([row('111', 'A', '8', 3), row('111', 'B', '9', 2), row('333', 'A', '8', 3), row('333', 'B', '9', 2), row('333', 'C', '10', 1), row('111', 'D', '11', 1), row('111', 'E', '12', 1)],
      [variant('A', '8', 3), variant('B', '9', 2), variant('C', '10', 1), variant('D', '11', 1), variant('E', '12', 1)]);
    const plan = planDuplicates(links);
    expect(plan.A).toMatchObject({ keep: '111', alive: [] });       // 333 still sells size 10, so it needs no pair kept
    const out = applyDupPlan(links, plan);
    const t = (item, sku) => out.find((l) => l.item_id === item && l.sku === sku).stock;
    expect(t('111', 'A')).toMatchObject({ action: 'none', target: 3 });
    expect(t('333', 'A')).toMatchObject({ action: 'set', target: 0, dup: true });
    expect(t('333', 'B')).toMatchObject({ action: 'set', target: 0 });
    expect(out.find((l) => l.sku === 'A').state).toBe('duplicate');   // still shown as a duplicate
  });
  test('a held listing with nothing else to sell keeps ONE pair where Shopify has 2 or more; the total never passes Shopify', () => {
    const links = decided([row('111', 'A', '8', 3), row('111', 'B', '9', 5), row('111', 'D', '11', 1), row('333', 'A', '8', 3), row('333', 'B', '9', 5)],
      [variant('A', '8', 3), variant('B', '9', 5), variant('D', '11', 1)]);
    const plan = planDuplicates(links);
    expect(plan.B.alive).toEqual(['333']);                         // its best-stocked shared size
    expect(plan.A.alive).toEqual([]);
    for (const entry of Object.values(plan)) {
      for (let q = -3; q <= 8; q++) {
        const share = dupTargets(entry, q);
        expect([...share.values()].reduce((a, b) => a + b, 0)).toBe(Math.max(0, q));
        expect([...share.values()].every((n) => n >= 0)).toBe(true);
      }
    }
    expect([...dupTargets(plan.B, 5)]).toEqual([['111', 4], ['333', 1]]);
    expect([...dupTargets(plan.B, 1)]).toEqual([['111', 1], ['333', 0]]);   // one pair left: only the keeper shows it
  });
  test('three listings, the older one keeps it on a tie; a SKU twice on ONE listing or on two Shopify variants is left to a person', () => {
    const three = decided([row('30', 'A', '8', 4, { start_time: '2026-03-01T00:00:00Z' }), row('20', 'A', '8', 4, { start_time: '2026-01-01T00:00:00Z' }), row('10', 'A', '8', 4, { start_time: '2026-02-01T00:00:00Z' })], [variant('A', '8', 4)]);
    const p = planDuplicates(three);
    expect(p.A.keep).toBe('20');
    expect([...dupTargets(p.A, 4).values()].reduce((a, b) => a + b, 0)).toBe(4);
    expect(planDuplicates(decided([row('1', 'A', '8', 1), { ...row('1', 'A', '9', 1), variation_key: 'A2' }], [variant('A', '8', 2)]))).toEqual({});
    expect(planDuplicates(decided([row('1', 'A', '8', 1), row('2', 'A', '8', 1)], [variant('A', '8', 1), variant('A', '8', 1, 'P2')]))).toEqual({});
  });
  test('"eBay has more than Shopify": simply higher, duplicates (pairs counted once), SKU not in Shopify, no Custom label; negative Shopify = 0', () => {
    const links = decided(
      [row('1', 'A', '8', 3), row('1', 'N', '9', 2), row('2', 'D', '8', 2), row('3', 'D', '8', 2), row('4', 'X', '8', 1), row('5', null, '8', 2), row('6', 'OK', '8', 1), row('6', 'Z', '9', 0)],
      [variant('A', '8', 1), variant('N', '9', -4), variant('D', '8', 3), variant('OK', '8', 1), variant('Z', '9', -1)]);
    const o = oversellOf(links);
    expect(o.by).toEqual({ stock: 2, duplicate: 2, no_shopify: 1, no_sku: 1 });
    expect(o.pairs).toBe(2 + 2 + 1 + 1 + 2);     // A 3-1, N 2-0, D (2+2)-3 once, X 1, no label 2
    expect(o.sizes).toBe(6);
    expect(o.rows.some((r) => r.sku === 'OK' || r.sku === 'Z')).toBe(false);
    expect(oversellWords(o)).toContain('8 pairs more than Shopify holds');
    expect(oversellWords(oversellOf([]))).toBeNull();
  });
  test('a negative Shopify quantity is 0 on every rule', () => {
    expect(stockDecision({ hasVariant: true, shopifyQty: -4, ebayQty: 2, shopifyComplete: true })).toEqual({ action: 'set', target: 0 });
    expect(stockDecision({ hasVariant: true, shopifyQty: -4, ebayQty: 0, shopifyComplete: true }).action).toBe('none');
    expect([...dupTargets({ keep: '1', alive: ['2'], items: ['1', '2'] }, -2).values()]).toEqual([0, 0]);
    const l = buildListing({ title: TITLE, vendor: 'nike', variants: [{ sku: 'A', size: '8', price: '100', qty: -1 }, { sku: 'B', size: '9', price: '100', qty: 2 }] }, PROFILE);
    expect(l.variations.map((v) => v.sku)).toEqual(['B']);
  });
});

test.describe('oversell guard: the full check', () => {
  const twoListings = (qtyA) => ({
    ebayRows: [row('111', 'A', '8', qtyA), row('111', 'B', '9', 2), row('333', 'A', '8', qtyA)],
    variants: [variant('A', '8', qtyA), variant('B', '9', 2)],
    light: [{ id: 'P1', title: TITLE, handle: 'p1', vendor: 'nike', status: 'ACTIVE', updatedAt: '2026-11-01T00:00:00Z', image: null }],
  });
  test('live: the extra listing is lowered AT ONCE (first sight) and the two listings together equal Shopify', async () => {
    const t = mkIO({ live: true, prev: [], ...twoListings(3) });
    await reconcilePass(await ctxOf(t, STOCK_ONLY));
    expect(sent(t).map((c) => [c.itemId, c.sku, c.qty])).toEqual([['333', 'A', 1], ['111', 'A', 2]]);   // 333 keeps one pair to stay listed; lowering only
    expect(sent(t).reduce((n, c) => n + c.qty, 0)).toBe(3);
    expect(t.alerts).toEqual([]);
    expect(JSON.parse(t.state.get('ebay_sync_state_reconcile')).dupPlan.A).toMatchObject({ keep: '111', alive: ['333'] });
  });
  test('Test mode: the same duplicate writes nothing, records the intent, and alerts once it has lasted past the settle time', async () => {
    const first = mkIO({ prev: [], ...twoListings(3) });
    await reconcilePass(await ctxOf(first, {}));
    expect(first.calls).toEqual([]);
    expect(first.alerts).toEqual([]);                                  // first sight: recorded, nobody woken
    expect(first.saved.links.filter((l) => l.sku === 'A').every((l) => l.qty_drift_since)).toBe(true);
    expect(first.logs.find((l) => l.domain === 'stock' && l.mode === 'shadow').after.count).toBe(2);
    const later = mkIO({ prev: [{ link_key: '111|A', qty_drift_since: OLD }, { link_key: '333|A', qty_drift_since: OLD }], ...twoListings(3) });
    await reconcilePass(await ctxOf(later, {}));
    expect(later.calls).toEqual([]);
    expect(later.alerts).toHaveLength(1);
    expect(later.alerts[0].title).toBe('eBay has more than Shopify');
    expect(later.alerts[0].body).toContain('3 pairs more than Shopify holds');
    expect(later.alerts[0].body).toContain('on more than one listing');
  });
  test('one pair on two single-size listings: holding the extra at 0 would END it, so with End in Test nothing is sent, it is logged and a person is told', async () => {
    const one = { ebayRows: [row('111', 'A', '8', 1), row('111', 'B', '9', 2), row('333', 'A', '8', 1)], variants: [variant('A', '8', 1), variant('B', '9', 2)], light: twoListings(1).light };
    const t = mkIO({ live: true, prev: [{ link_key: '333|A', qty_drift_since: OLD }, { link_key: '111|A', qty_drift_since: OLD }], ...one });
    await reconcilePass(await ctxOf(t, STOCK_ONLY));
    expect(t.calls).toEqual([]);
    expect(t.logs.find((l) => l.domain === 'end' && l.action === 'end_duplicate_by_zero')).toMatchObject({ mode: 'shadow', itemId: '333' });
    expect(JSON.parse(t.state.get('ebay_sync_state_reconcile')).dupHeld).toEqual(['333']);
    expect(t.alerts.map((a) => a.title)).toEqual(['eBay has more than Shopify']);
    expect(t.alerts[0].body).toContain('#333');
  });
  test('the same with End listings LIVE: the extra goes to 0, eBay ends it, and it is written to the ends log so it is never relisted', async () => {
    const one = { ebayRows: [row('111', 'A', '8', 1), row('111', 'B', '9', 2), row('333', 'A', '8', 1)], variants: [variant('A', '8', 1), variant('B', '9', 2)], light: twoListings(1).light };
    const t = mkIO({ live: true, prev: [], ...one });
    await reconcilePass(await ctxOf(t, { ...STOCK_ONLY, switches: { ...STOCK_ONLY.switches, end: 'live' } }));
    expect(sent(t).map((c) => [c.itemId, c.qty])).toEqual([['333', 0]]);
    expect(t.calls.find((c) => c[0] === 'logEbayEnd')[1][0]).toMatchObject({ itemId: '333', ok: true });
    expect(t.logs.find((l) => l.domain === 'end' && l.action === 'end_listing' && l.mode === 'live').after.via).toContain('duplicate');
    expect(t.alerts).toEqual([]);
  });
  test('lowering goes at once; a refused stock change alerts, and so does eBay still being higher', async () => {
    const base = { ebayRows: [row('111', 'A', '8', 3), row('111', 'B', '9', 2)], variants: [variant('A', '8', 1), variant('B', '9', 2)], light: twoListings(1).light };
    const ok = mkIO({ live: true, prev: [], ...base });
    await reconcilePass(await ctxOf(ok, STOCK_ONLY));
    expect(sent(ok).map((c) => [c.sku, c.qty])).toEqual([['A', 1]]);
    expect(ok.alerts).toEqual([]);
    const bad = mkIO({ live: true, prev: [{ link_key: '111|A', qty_drift_since: OLD }], ...base, qtyResult: (c) => c.map((x) => ({ key: x.key, ok: false, error: 'eBay ReviseInventoryStatus: Variation not found' })) });
    await reconcilePass(await ctxOf(bad, STOCK_ONLY));
    expect(bad.alerts.map((a) => a.title)).toEqual(['eBay Sync: a stock change failed', 'eBay has more than Shopify']);
    expect(bad.alerts[0].body).toContain('lowering a quantity');
    expect(bad.alerts[0].body).toContain('Variation not found');
    expect(bad.logs.find((l) => l.domain === 'stock' && l.mode === 'live')).toMatchObject({ ok: false });
  });
  test('a SKU that is not in Shopify, or a size with no Custom label, is never zeroed by itself: counted, and alerted once it lasts', async () => {
    const base = { ebayRows: [row('111', 'B', '9', 2), row('444', 'GONE', '8', 2), row('555', null, '8', 1)], variants: [variant('B', '9', 2)], light: twoListings(1).light };
    const t = mkIO({ live: true, prev: [{ link_key: '444|GONE', qty_drift_since: OLD }, { link_key: '555|', qty_drift_since: OLD }], ...base });
    await reconcilePass(await ctxOf(t, ALL_LIVE));
    expect(t.calls).toEqual([]);
    expect(t.saved.links.find((l) => l.item_id === '555')).toMatchObject({ state: 'no_shopify', sku: null });
    expect(t.saved.links.find((l) => l.item_id === '444').qty_drift_since).toBeTruthy();
    expect(t.alerts.map((a) => a.title)).toEqual(['eBay has more than Shopify']);
    expect(t.alerts[0].body).toContain('SKU not in Shopify');
  });
});

test.describe('oversell guard: the queue (Shopify webhook)', () => {
  const plan = { A: { keep: '111', alive: ['333'], items: ['111', '333'] } };
  const dupLinks = [{ link_key: '111|A', item_id: '111', sku: 'A', variation_key: 'A', ebay_qty: 2, duplicate: true }, { link_key: '333|A', item_id: '333', sku: 'A', variation_key: 'A', ebay_qty: 1, duplicate: true }];
  const mk = (available, over = {}) => {
    const t = mkIO({ live: true, queue: [{ id: 1, kind: 'sku', key: 'A' }], linksBySkuAll: async () => dupLinks, links: dupLinks, stockForSku: async () => ({ levels: [{ available }], tracked: true }), ...over });
    t.state.set('ebay_sync_state_reconcile', JSON.stringify({ dupPlan: plan }));
    return t;
  };
  test('a duplicate SKU gets its SHARE on each listing, lowered first, never the full number on both', async () => {
    const t = mk(2);                                    // Shopify sold one: 3 -> 2
    await queuePass(await ctxOf(t, STOCK_ONLY));
    expect(sent(t).map((c) => [c.itemId, c.qty])).toEqual([['111', 1]]);       // 333 keeps its 1, the keeper drops to 1: total 2
    const up = mk(5);
    await queuePass(await ctxOf(up, STOCK_ONLY));
    expect(sent(up).map((c) => [c.itemId, c.qty])).toEqual([['111', 4]]);
    expect(sent(up).reduce((n, c) => n + c.qty, 0) + 1).toBe(5);
  });
  test('a stale plan shares nothing: once a person ended the keeper, the listing that is left is not zeroed from the old plan', async () => {
    const left = [dupLinks[1]];                           // 111 (the keeper) was ended by hand since the last full check
    const t = mk(1, { linksBySkuAll: async () => left, links: left });
    await queuePass(await ctxOf(t, ALL_LIVE));             // End live too: this must still not end 333
    expect(t.calls).toEqual([]);
  });
  test('a negative Shopify quantity goes to eBay as 0; and in Test mode the queue writes nothing', async () => {
    const single = { queue: [{ id: 1, kind: 'sku', key: 'S' }], linksBySku: async () => [{ link_key: '9|S', item_id: '9', sku: 'S', variation_key: 'S', ebay_qty: 2 }], links: [{ link_key: '9|S', item_id: '9', sku: 'S', ebay_qty: 2 }, { link_key: '9|T', item_id: '9', sku: 'T', ebay_qty: 1 }], stockForSku: async () => ({ levels: [{ available: -4 }], tracked: true }) };
    const t = mkIO({ live: true, ...single });
    await queuePass(await ctxOf(t, STOCK_ONLY));
    expect(sent(t)).toEqual([{ key: '9|S', itemId: '9', sku: 'S', qty: 0 }]);
    const shadow = mk(2);
    await queuePass(await ctxOf(shadow, {}));
    expect(shadow.calls).toEqual([]);
  });
  test('a size that was already differing at the last full check is sent again even when the stored eBay number equals Shopify\'s', async () => {
    const t = mkIO({ live: true, queue: [{ id: 1, kind: 'sku', key: 'S' }], linksBySku: async () => [{ link_key: '9|S', item_id: '9', sku: 'S', variation_key: 'S', ebay_qty: 2, qty_drift_since: OLD }], links: [{ link_key: '9|S', item_id: '9', sku: 'S', ebay_qty: 2 }], stockForSku: async () => ({ levels: [{ available: 2 }], tracked: true }) });
    await queuePass(await ctxOf(t, STOCK_ONLY));
    expect(sent(t)).toEqual([{ key: '9|S', itemId: '9', sku: 'S', qty: 2 }]);
  });
});
