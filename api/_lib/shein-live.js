// SHEIN live fix — the walker (docs/context/shein-live-fix.md). Goes through every SHEIN
// product ONE AT A TIME:
//   1. read the product from SHEIN (sizes, seller SKUs, stock and what SHEIN holds for
//      open orders);
//   2. read the Shopify products it points at LIVE, at that moment;
//   3. decide with the hard-coded rules (src/lib/sheinLive.js → sheinFix.js); the AI is
//      asked only about seller SKUs Shopify no longer has, and only a rule-verified answer
//      counts;
//   4. write SHEIN's stock (and, in "full" mode, the seller-SKU fixes), read it back, log
//      every size, and move on.
// Before the walk, one read-only pass over the whole store builds the facts no single
// product can know: which SHEIN size owns a seller SKU that several carry.
//
// The same per-product step pushes ONE Shopify change to SHEIN (pushSkus), so the fix and
// the live sync are the same code.
import {
  sheinAllSpus, sheinSpuInfo, sheinStock, sheinWarehouses, sheinSetStock, sheinInReview, sheinSellerSkusTaken, sheinSetSellerSkus, sheinStatus,
} from './shein.js';
import { shopifyAllVariants, shopifyProductsLive, shopifyProductIdsForSkus, shopifyConfigured } from './shopify.js';
import {
  listSheinLinks, saveSheinLinks, createSheinLiveRun, updateSheinLiveRun, getSheinLiveRun, latestSheinLiveRun, markStaleSheinRuns,
  addSheinLiveItems, sheinOpenNotDeducted, getSetting, sheinLastWalkFacts,
} from './db.js';
import { sheinAiMatch, sheinAiConfigured } from './shein-ai.js';
import { readSync } from './shein-orders.js';
import { rowsFromSpu, ownersFrom, indexRows, planProduct, outcome } from '../../src/lib/sheinLive.js';
import { candidatesFor, verifyAiLink } from '../../src/lib/sheinFix.js';
import { styleFromTitle } from '../../src/lib/ebayReprice.js';

export const MODES = ['dry', 'stock', 'full'];
// Everything the step touches outside itself — swappable in tests (e2e/shein-live.spec.js).
export const IO = {
  sheinSpuInfo, sheinStock, sheinInReview, sheinSellerSkusTaken, sheinSetSellerSkus, sheinSetStock,
  shopifyProductsLive, shopifyProductIdsForSkus, saveSheinLinks, addSheinLiveItems, sheinOpenNotDeducted, readSync, sheinAiMatch, sheinAiConfigured,
  readBackWaits: [3_000, 5_000, 10_000],   // ms between read-backs of a size still showing the old stock
};
let active = null;   // { runId, promise } — one walk per process

/* --------------------------------- context --------------------------------- */

// Our merchant warehouses and the one stock is set in: SHOPIFY's warehouse = SHEIN's
// default merchant warehouse for the US site, else the only merchant warehouse.
export function pickTargetWarehouse(list) {
  const mine = (list || []).filter((w) => String(w.warehouseType) === '1');
  const defaults = (w) => [].concat(w.countrySiteDefaultList || []);
  const def = mine.find((w) => defaults(w).some((d) => Number(d.defaultFlag) === 1 && /us/i.test(d.countrySiteCode || '')))
    || mine.find((w) => defaults(w).some((d) => Number(d.defaultFlag) === 1));
  return { target: (def || (mine.length === 1 ? mine[0] : null))?.warehouseCode || null, merchant: new Set(mine.map((w) => String(w.warehouseCode))), count: mine.length };
}

// What a SHEIN order still holds back from Shopify's number, per seller SKU. With the sales
// sync ON, a SHEIN sale is already off Shopify, so only the ones not yet taken off count;
// with it OFF, everything SHEIN holds for open orders.
// `rows` = this product, fresh: what SHEIN holds for them replaces what the scan saw.
async function heldMap(ctx, rows, io) {
  const sync = await io.readSync();
  if (sync.orders === 'on') return { map: await io.sheinOpenNotDeducted(), source: 'orders' };
  const map = new Map(ctx.sheinHeld || []);
  for (const r of rows) {
    if (!r.sellerSku) continue;
    const was = Number(ctx.scanRowHeld?.get(r.sheinSku) || 0);
    map.set(r.sellerSku, Math.max(0, Number(map.get(r.sellerSku) || 0) - was) + Number(r.held || 0));
  }
  return { map, source: 'shein' };
}

const decisionsMap = async () => Object.fromEntries((await listSheinLinks()).map((l) => [l.shein_sku, l]));

// Fresh Shopify variants for one SHEIN product: every product its seller SKUs point at (read
// live; a SKU the catalogue doesn't know is looked up by itself), plus same-style products
// for relinks, plus anything a person linked it to.
async function liveVariants(rows, catalogue, decisions, io) {
  const bySku = new Map((catalogue || []).map((v) => [String(v.sku), v]));
  const ids = new Set(); const unknown = [];
  for (const r of rows) {
    const v = r.sellerSku && bySku.get(r.sellerSku);
    if (v) ids.add(v.productId); else if (r.sellerSku) unknown.push(r.sellerSku);
    const d = decisions[r.sheinSku];
    const dv = d?.link_sku && bySku.get(String(d.link_sku));
    if (dv) ids.add(dv.productId);
  }
  if (unknown.length) {
    const f = await io.shopifyProductIdsForSkus(unknown);
    if (f.error) throw new Error(f.error);
    for (const id of f.found.values()) ids.add(id);
  }
  const style = styleFromTitle(rows[0]?.name || '');
  if (style && catalogue) for (const v of catalogue) if (String(v.style || '').toUpperCase() === style.toUpperCase()) ids.add(v.productId);
  const live = await io.shopifyProductsLive([...ids]);
  if (live.error) throw new Error(live.error);
  const fresh = new Set(ids);
  return { variants: [...(catalogue || []).filter((v) => !fresh.has(v.productId)), ...live.variants], liveProducts: ids.size };
}

/* ------------------------------ one product ------------------------------ */

// Read → decide → (write) → read back → log, for ONE SHEIN product.
export async function stepProduct(spuName, ctx) {
  const { mode, runId = null, source = 'walk' } = ctx;
  const io = ctx.io || IO;
  const spu = await io.sheinSpuInfo(spuName);
  const skus = (spu?.skcInfoList || []).flatMap((c) => (c.skuInfoList || []).map((s) => String(s.skuCode))).filter(Boolean);
  const rows = rowsFromSpu(spu, skus.length ? await io.sheinStock(skus) : [], { merchant: ctx.merchant });
  if (!rows.length) return { items: [], counts: {} };
  const { variants } = await liveVariants(rows, ctx.catalogue, ctx.decisions, io);
  const held = await heldMap(ctx, rows, io);
  // A dry run shows everything "full" would do (incl. seller SKUs); "stock" never edits them.
  const base = { rows, variants, decisions: ctx.decisions, owners: ctx.owners, holders: ctx.holders, heldBySku: held.map, target: ctx.target, links: mode !== 'stock' };
  let plan = planProduct({ ...base, aiLinks: {} });

  // The AI, only for sizes whose seller SKU Shopify no longer has and no rule could place.
  if (ctx.ai && mode !== 'stock' && io.sheinAiConfigured()) {
    const need = plan.rows.filter((r) => r.reason === 'no_shopify' && !r.linkTo && r.size);
    const candidates = need.length ? candidatesFor(rows[0].name, variants) : [];
    if (need.length && candidates.length) {
      try {
        const [m] = await io.sheinAiMatch([{ key: spuName, name: rows[0].name, sizes: need.map((r) => ({ line: r.line, sellerSku: r.sellerSku, size: r.size })),
          candidates: candidates.map((c) => ({ productId: c.productId, title: c.title, variants: c.variants })) }]);
        const aiLinks = {};
        for (const x of m?.sizes || []) {
          const row = need.find((r) => r.line === x.line);
          const ok = row && m.productId && m.confidence >= 0.6 && verifyAiLink(row, { productId: m.productId, shopifySku: x.shopifySku, reason: m.reason }, variants);
          if (ok) aiLinks[x.line] = { ...ok, confidence: m.confidence };
        }
        if (Object.keys(aiLinks).length) plan = planProduct({ ...base, aiLinks });
      } catch (e) { console.error('[shein-live] AI', spuName, e.message); }
    }
  }

  // Seller SKUs (full mode): not while SHEIN is reviewing this product, never onto a SKU
  // that exists elsewhere in the store (incl. products in review).
  const editResult = new Map(); const skipResult = new Map(plan.skipped.map((s) => [s.sheinSku, s]));
  let edits = plan.edits;
  if ((mode === 'full' || mode === 'dry') && edits.length) {   // the checks are reads: a dry run makes them too
    if (await io.sheinInReview(spuName)) {
      for (const e of edits) skipResult.set(e.skuCode, { sheinSku: e.skuCode, why: 'SHEIN is still reviewing an earlier edit of this product — next walk' });
      edits = [];
    } else {
      const inThis = new Set(rows.map((r) => r.sellerSku));
      const taken = await io.sheinSellerSkusTaken(edits.map((e) => e.supplierSku));
      const blocked = new Set(edits.filter((e) => taken.has(e.supplierSku) && !inThis.has(e.supplierSku)).map((e) => e.supplierSku));
      edits = edits.filter((e) => {
        const dead = blocked.has(e.supplierSku) || (e.frees && blocked.has(e.frees));
        if (dead) skipResult.set(e.skuCode, { sheinSku: e.skuCode, why: `${e.frees || e.supplierSku} is already used by a SHEIN listing in review or outside this product` });
        return !dead;
      });
      if (edits.length && mode === 'full') {
        const r = await io.sheinSetSellerSkus(spuName, edits);
        for (const e of edits) editResult.set(e.skuCode, { ...e, ok: r.ok, error: r.ok ? null : r.messages.join(' | ') || 'SHEIN refused the edit' });
        if (r.ok) {
          const byRow = new Map(plan.rows.map((x) => [x.sheinSku, x]));
          await io.saveSheinLinks(edits.map((e) => {
            const row = byRow.get(e.skuCode);
            return { shein_sku: e.skuCode, spu: spuName, skc: e.skc, shein_size: row?.size || null, seller_sku_was: e.from || null,
              link_sku: e.frees ? null : e.supplierSku, decision: e.frees ? 'delist' : 'link', source: e.by === 'ai' ? 'ai' : e.why === 'swap' ? 'swap' : e.by === 'person' ? 'person' : 'rule' };
          }), 'SHEIN live fix');
        }
      }
    }
  }

  // Stock. Read back what SHEIN shows after the write.
  const wrote = new Map(); const failedStock = new Map(); const after = new Map();
  if ((mode === 'stock' || mode === 'full') && plan.writes.length) {
    const writes = plan.writes.map((w) => ({ ...w, skuCode: w.sheinSku, key: `sb12-${w.sheinSku}-${w.warehouseCode}-${w.total}-${Date.now()}` }));
    const r = await io.sheinSetStock(writes);
    for (const f of r.failed) failedStock.set(String(f.skuCode), f.reason);
    for (const w of writes) if (!failedStock.has(w.sheinSku)) wrote.set(w.sheinSku, (wrote.get(w.sheinSku) || 0) + 1);
    // Read back only what we wrote (an unwritten size isn't in the answer and would read as 0).
    // SHEIN accepts a write without refusing it yet can still show the old number for a
    // while (run 6, 2026-10-22: 268 sizes) — so wait and read again, and write the ones
    // still wrong once more, before calling it a mismatch.
    const want = new Map(plan.rows.filter((x) => wrote.has(x.sheinSku)).map((x) => [x.sheinSku, Number(x.newQty || 0)]));
    const readBack = async () => {
      const back = rowsFromSpu(spu, await io.sheinStock([...want.keys()]), { merchant: ctx.merchant });
      for (const b of back) if (want.has(b.sheinSku)) after.set(b.sheinSku, b.qty);
      return [...want].filter(([k, v]) => after.get(k) !== v).map(([k]) => k);
    };
    let wrong = want.size ? await readBack() : [];
    const waits = io.readBackWaits || IO.readBackWaits;
    for (let i = 0; wrong.length && i < waits.length; i++) {
      await new Promise((ok) => setTimeout(ok, waits[i]));
      if (i === 1) {   // still wrong after the first wait: write those again (new key = a new write)
        const again = writes.filter((w) => wrong.includes(w.sheinSku)).map((w) => ({ ...w, key: `${w.key}-again` }));
        const r2 = await io.sheinSetStock(again);
        for (const f of r2.failed) failedStock.set(String(f.skuCode), f.reason);
      }
      wrong = await readBack();
    }
  }

  const counts = { sizes: 0, stock_changed: 0, zeroed: 0, links_changed: 0, links_skipped: 0, needs_person: 0, errors: 0, mismatch: 0 };
  const items = plan.rows.map((r) => {
    counts.sizes += 1;
    const want = plan.writes.some((w) => w.sheinSku === r.sheinSku);
    const e = editResult.get(r.sheinSku) || (mode === 'dry' ? edits.find((x) => x.skuCode === r.sheinSku) : null);
    const skip = skipResult.get(r.sheinSku) || null;
    const err = failedStock.get(r.sheinSku) || (e && e.ok === false ? e.error : null);
    const a = after.has(r.sheinSku) ? after.get(r.sheinSku) : null;
    let result = 'ok';
    if (err) { result = 'failed'; counts.errors += 1; }
    else if (a != null && a !== r.newQty) { result = 'mismatch'; counts.mismatch += 1; }
    else if (want || (e && e.ok !== false)) result = 'changed';
    else if (skip) result = 'skipped';
    if (want && !err) { counts.stock_changed += 1; if (r.newQty === 0 && r.qty > 0) counts.zeroed += 1; }
    if (e && e.ok !== false && !e.frees) counts.links_changed += 1;
    if (skip) counts.links_skipped += 1;
    if (r.reason !== 'ok' && !r.linkTo && !e) counts.needs_person += 1;
    return {
      run_id: runId, source, spu: r.spu, skc: r.skc, shein_sku: r.sheinSku, seller_sku: r.sellerSku || null, shein_size: r.size || null, product_name: r.name || null,
      shopify_sku: r.variant?.sku || null, shopify_size: r.variant?.size || null, shopify_product: r.variant?.productTitle || null,
      shopify_qty: r.shopifyQty == null ? null : Number(r.shopifyQty), held: Number(held.map.get(r.sellerSku) || 0),
      before_qty: Number(r.qty || 0), target_qty: Number(r.newQty || 0), after_qty: a,
      reason: r.reason, action: [r.action, outcome(r, { wrote: want ? [1] : [], edit: e, skip, after: a, dry: mode === 'dry' })].filter(Boolean).join(' — ').slice(0, 1000),
      link_to: r.linkTo?.sku || null, link_by: r.linkTo?.by || null,
      wrote: mode === 'dry' ? (want || e ? 'dry' : 'none') : [wrote.has(r.sheinSku) && 'stock', e && e.ok !== false && 'link'].filter(Boolean).join('+') || 'none',
      result, error: err || null,
    };
  });
  await io.addSheinLiveItems(items);
  return { items, counts, heldSource: held.source };
}

/* --------------------------------- the walk --------------------------------- */

const add = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + (Number(v) || 0); return a; };

async function runWalk(run, { ai }) {
  const id = run.id;
  const mode = run.mode;
  const stopped = async () => (await getSheinLiveRun(id))?.stop_requested;
  try {
    await updateSheinLiveRun(id, { phase: 'Reading SHEIN warehouses' });
    const wh = pickTargetWarehouse(await sheinWarehouses());
    if (!wh.target) throw new Error(wh.count ? `SHEIN has ${wh.count} merchant warehouses and none is the US default — can’t tell where stock goes.` : 'SHEIN shows no merchant warehouse for this store.');
    await updateSheinLiveRun(id, { phase: 'Reading every Shopify variant' });
    const cat = await shopifyAllVariants();
    if (cat.error) throw new Error(cat.error);
    await updateSheinLiveRun(id, { phase: 'Listing SHEIN products' });
    const spus = await sheinAllSpus();
    await updateSheinLiveRun(id, { phase: 'Scanning SHEIN (read-only)', total: spus.length, done: 0 });

    // Pass 1 — read-only, the whole store: who owns a seller SKU several sizes carry.
    const all = [];
    for (let i = 0; i < spus.length; i++) {
      if (i % 10 === 0 && await stopped()) return finish(id, 'stopped', {});
      try {
        const spu = await sheinSpuInfo(spus[i]);
        const codes = (spu?.skcInfoList || []).flatMap((c) => (c.skuInfoList || []).map((s) => String(s.skuCode))).filter(Boolean);
        all.push(...rowsFromSpu(spu, codes.length ? await sheinStock(codes) : [], { merchant: wh.merchant }));
      } catch (e) { console.error('[shein-live] scan', spus[i], e.message); }
      if (i % 10 === 9) await updateSheinLiveRun(id, { done: i + 1, current: spus[i] });
    }
    const { holders, held } = indexRows(all);
    const ctx = { mode, runId: id, merchant: wh.merchant, target: wh.target, catalogue: cat.variants, owners: ownersFrom(all, cat.variants), holders, sheinHeld: held,
      scanRowHeld: new Map(all.map((r) => [r.sheinSku, Number(r.held || 0)])), ai };

    // Pass 2 — one product at a time: live Shopify read, decide, write, read back.
    await updateSheinLiveRun(id, { phase: mode === 'dry' ? 'Checking each product (dry run — nothing written)' : 'Fixing each product', done: 0 });
    const counts = { products: 0, products_failed: 0 };
    for (let i = 0; i < spus.length; i++) {
      if (await stopped()) return finish(id, 'stopped', counts);
      ctx.decisions = await decisionsMap();
      try {
        const r = await stepProduct(spus[i], ctx);
        add(counts, r.counts); counts.products += 1;
      } catch (e) {
        counts.products_failed += 1;
        await addSheinLiveItems([{ run_id: id, spu: spus[i], reason: 'error', action: 'This product could not be read or written', result: 'failed', error: String(e.message).slice(0, 500), wrote: 'none' }]);
        if (/not connected|401|signature/i.test(e.message)) throw e;
      }
      await updateSheinLiveRun(id, { done: i + 1, current: spus[i], counts });
    }
    return finish(id, 'done', counts);
  } catch (e) {
    console.error('[shein-live] walk failed', e.message);
    await updateSheinLiveRun(id, { status: 'failed', error: String(e.message).slice(0, 500), finished: true });
  }
}
async function finish(id, status, counts) {
  await updateSheinLiveRun(id, { status, phase: status === 'done' ? 'Finished' : 'Stopped', counts, finished: true, current: '' });
}

export async function startWalk({ mode, by, ai = true }) {
  if (!MODES.includes(mode)) throw Object.assign(new Error('Unknown mode.'), { status: 400 });
  if (active) throw Object.assign(new Error('A walk is already running.'), { status: 409 });
  await markStaleSheinRuns();
  const cur = await latestSheinLiveRun();
  if (cur?.status === 'running') throw Object.assign(new Error('A walk is already running.'), { status: 409 });
  if (!shopifyConfigured()) throw Object.assign(new Error('Shopify is not configured on the server.'), { status: 503 });
  const st = await sheinStatus().catch(() => null);
  if (!st?.connected) throw Object.assign(new Error('SHEIN is not connected.'), { status: 503 });
  const run = await createSheinLiveRun({ mode, by });
  const promise = runWalk(run, { ai }).finally(() => { active = null; });
  active = { runId: run.id, promise };
  return run;
}

// A walk that's alive keeps its row fresh; one that isn't gets called interrupted.
export async function heartbeat() {
  if (active) await updateSheinLiveRun(active.runId, {});
  else await markStaleSheinRuns();
}

/* ------------------------- one Shopify change → SHEIN ------------------------- */
// docs/context/shein-live-fix.md → "Shopify → SHEIN". A Shopify stock change (webhook)
// names a SKU; every SHEIN product carrying it gets the same per-product step, STOCK ONLY
// (seller SKUs are the walk's job). Which SHEIN products carry a SKU comes from the last
// walk's log, so one walk (a dry run is enough) must have run first.
const queue = new Set(); let timer = null; let pushing = false;
export function queuePush(skus) {
  for (const s of skus || []) if (s) queue.add(String(s));
  if (!timer) timer = setTimeout(drain, 1500);   // coalesce a burst (a bulk edit in Shopify)
}
async function drain() {
  timer = null;
  if (pushing) { timer = setTimeout(drain, 1500); return; }
  const skus = [...queue]; queue.clear();
  if (!skus.length) return;
  pushing = true;
  try { await pushSkus(skus); } catch (e) { console.error('[shein-live] push', e.message); } finally { pushing = false; }
}
export async function pushSkus(skus) {
  const sync = await readSync();
  if (sync.push !== 'on') return { pushed: 0, why: 'push is off' };
  if (active) return { pushed: 0, why: 'a walk is running' };   // the walk will reach it
  const facts = await sheinLastWalkFacts();
  const mine = new Set(skus);
  const spus = [...new Set(facts.filter((f) => mine.has(f.seller_sku)).map((f) => f.spu).filter(Boolean))];
  if (!spus.length) return { pushed: 0, why: 'not on SHEIN (or no walk yet)' };
  const wh = pickTargetWarehouse(await sheinWarehouses());
  if (!wh.target) return { pushed: 0, why: 'no target warehouse' };
  // Who owns a duplicated seller SKU: whatever the last walk decided (not 'duplicate').
  const owners = new Map();
  for (const f of facts) {
    if (!f.seller_sku || f.reason === 'duplicate') continue;
    const cur = owners.get(f.seller_sku);
    if (!cur || (f.reason === 'ok' && !cur.fits)) owners.set(f.seller_sku, { sheinSku: f.shein_sku, spu: f.spu, fits: f.reason === 'ok' });
  }
  const { holders } = indexRows(facts.map((f) => ({ spu: f.spu, sheinSku: f.shein_sku, sellerSku: f.seller_sku, held: 0 })));
  const ctx = { mode: 'stock', source: 'push', merchant: wh.merchant, target: wh.target, catalogue: null, owners, holders, sheinHeld: new Map(), scanRowHeld: new Map(), decisions: await decisionsMap(), ai: false };
  let n = 0;
  for (const spu of spus) { try { const r = await stepProduct(spu, ctx); n += r.counts.stock_changed || 0; } catch (e) { console.error('[shein-live] push', spu, e.message); } }
  return { pushed: n, products: spus.length };
}

export const walkActive = () => (active ? active.runId : null);
export { getSetting };
