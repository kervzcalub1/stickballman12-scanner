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
  sheinSetShelf, sheinCheckDeletable, sheinDeleteSkc, sheinDeleteLogs,
} from './shein.js';
import { shopifyAllVariants, shopifyProductsLive, shopifyProductIdsForSkus, shopifyConfigured } from './shopify.js';
import {
  listSheinLinks, saveSheinLinks, createSheinLiveRun, updateSheinLiveRun, getSheinLiveRun, latestSheinLiveRun, markStaleSheinRuns,
  addSheinLiveItems, sheinOpenNotDeducted, getSetting, sheinLastWalkFacts, sheinPushQueueAdd, sheinPushQueueDone, sheinPushQueueList, sheinShelfRecords, saveSheinShelf,
  listingInflightSpus, latestShoeRun, listingProductIdsForStyle,
} from './db.js';
import { sheinAiMatch, sheinAiConfigured } from './shein-ai.js';
import { readSync } from './shein-orders.js';
import { rowsFromSpu, ownersFrom, indexRows, planProduct, outcome, shelfFrom, shelfPlan } from '../../src/lib/sheinLive.js';
import { candidatesFor, verifyAiLink } from '../../src/lib/sheinFix.js';
import { styleFromTitle } from '../../src/lib/ebayReprice.js';

export const MODES = ['dry', 'stock', 'full'];
// The walk's mode for one SHEIN product: a SHEIN Listings edit in flight (any state) only takes the
// seller-SKU edits away (full → stock). Stock is NEVER skipped — skipping it is an oversell.
export const walkModeFor = (flight, mode) => (flight && mode === 'full' ? 'stock' : mode);
// Everything the step touches outside itself — swappable in tests (e2e/shein-live.spec.js).
export const IO = {
  sheinSpuInfo, sheinStock, sheinInReview, sheinSellerSkusTaken, sheinSetSellerSkus, sheinSetStock,
  shopifyProductsLive, shopifyProductIdsForSkus, listingProductIdsForStyle, saveSheinLinks, addSheinLiveItems, sheinOpenNotDeducted, readSync, sheinAiMatch, sheinAiConfigured,
  sheinSetShelf, sheinCheckDeletable, sheinDeleteSkc, sheinDeleteLogs, sheinShelfRecords, saveSheinShelf,
  sheinEditAttrs: async (spu) => (await import('./shein-listing.js')).editAttrs(spu),   // lazy: shein-listing imports this file
  readBackWaits: [3_000, 5_000, 10_000],   // ms between read-backs of a size still showing the old stock
};
let active = null;   // { runId, promise } — one walk per process
let shoe = null;     // { runId, spu } — one "fix this shoe" run per process (seconds), never alongside a walk

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
// for relinks, plus anything a person linked it to, plus `extraIds` (the one-shoe run: the
// Shopify product SHEIN Listings matched it to). With no catalogue (the one-shoe run) the
// same-style products come from SHEIN Listings' copy of Shopify — without them a shoe re-made
// under new SKUs read as "gone" and its dead sizes were never relinked (2026-10-28).
async function liveVariants(rows, catalogue, decisions, io, extraIds = []) {
  const bySku = new Map((catalogue || []).map((v) => [String(v.sku), v]));
  const ids = new Set(extraIds.filter(Boolean)); const unknown = [];
  for (const r of rows) {
    const v = r.sellerSku && bySku.get(r.sellerSku);
    if (v) ids.add(v.productId); else if (r.sellerSku) unknown.push(r.sellerSku);
    const d = decisions[r.sheinSku];
    const dv = d?.link_sku && bySku.get(String(d.link_sku));
    if (dv) ids.add(dv.productId); else if (d?.link_sku) unknown.push(String(d.link_sku));
  }
  if (unknown.length) {
    const f = await io.shopifyProductIdsForSkus(unknown);
    if (f.error) throw new Error(f.error);
    for (const id of f.found.values()) ids.add(id);
  }
  const style = styleFromTitle(rows[0]?.name || '');
  if (style && catalogue) for (const v of catalogue) if (String(v.style || '').toUpperCase() === style.toUpperCase()) ids.add(v.productId);
  if (style && !catalogue && io.listingProductIdsForStyle) for (const id of await io.listingProductIdsForStyle(style)) ids.add(id);
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
  const { variants } = await liveVariants(rows, ctx.catalogue, ctx.decisions, io, ctx.productIds || []);
  const held = await heldMap(ctx, rows, io);
  // A dry run shows everything "full" would do (incl. seller SKUs); "stock" never edits them.
  const base = { rows, variants, decisions: ctx.decisions, owners: ctx.owners, holders: ctx.holders, heldBySku: held.map, target: ctx.target, links: mode !== 'stock', parkDelisted: !!ctx.parkDelisted };
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
      // SHEIN re-checks the WHOLE product on this edit: a detail it now requires (e.g. "Reflection") goes
      // with it from Setup → SHEIN details, or — none set — the edit waits (SHEIN would refuse it).
      const attrs = edits.length && io.sheinEditAttrs ? await io.sheinEditAttrs(spu).catch((e) => { console.error('[shein-live] details', spuName, e.message); return null; }) : null;
      if (attrs?.problems?.length) {
        const names = [...new Set(attrs.problems.map((p) => p.params?.attribute || `detail ${p.params?.attributeId ?? '?'}`))].join(', ');
        for (const e of edits) skipResult.set(e.skuCode, { sheinSku: e.skuCode, why: `SHEIN now requires ${names} on this shoe — set it in SHEIN Listings → Setup → SHEIN details` });
        edits = [];
      } else if (attrs?.list?.length) edits = edits.map((e) => ({ ...e, withAttrs: attrs.added.map((a) => a.attribute) }));
      if (edits.length && mode === 'full') {
        const r = await io.sheinSetSellerSkus(spuName, edits, { attributes: attrs?.list || null });
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
  const { notes: shelfNote, gone } = await stepShelf({ spu, spuName, plan, variants, mode, runId, source, io, counts });
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
    const reason = gone.has(r.skc) ? 'gone' : r.reason;   // the whole shoe is gone from Shopify and off SHEIN's shelf: nothing for a person to do
    if (reason !== 'ok' && reason !== 'gone' && !r.linkTo && !e) counts.needs_person += 1;
    return {
      run_id: runId, source, spu: r.spu, skc: r.skc, shein_sku: r.sheinSku, seller_sku: r.sellerSku || null, shein_size: r.size || null, product_name: r.name || null,
      shopify_sku: r.variant?.sku || null, shopify_size: r.variant?.size || null, shopify_product: r.variant?.productTitle || null,
      shopify_qty: r.shopifyQty == null ? null : Number(r.shopifyQty), held: Number(held.map.get(r.sellerSku) || 0),
      before_qty: Number(r.qty || 0), target_qty: Number(r.newQty || 0), after_qty: a,
      reason, action: [r.action, outcome(r, { wrote: want ? [1] : [], edit: e, skip, after: a, dry: mode === 'dry' }), shelfNote.get(r.skc)].filter(Boolean).join(' — ').slice(0, 1000),
      link_to: r.linkTo?.sku || null, link_by: r.linkTo?.by || null,
      wrote: mode === 'dry' ? (want || e ? 'dry' : 'none') : [wrote.has(r.sheinSku) && 'stock', e && e.ok !== false && 'link'].filter(Boolean).join('+') || 'none',
      result, error: err || null,
    };
  });
  await io.addSheinLiveItems(items);
  return { items, counts, heldSource: held.source };
}

/* -------------------------- delist / re-list / delete -------------------------- */

// Whole shoes (SKCs): delist at 0, re-list what WE delisted when stock is back, ask SHEIN to
// delete one whose seller SKUs are all gone from Shopify (rules: shelfPlan). Delete only on a
// walk, never on a single Shopify push. Returns { notes: SKC → one line for each of its sizes,
// gone: SKCs whose every seller SKU is gone from Shopify and that are (now) off the shelf }.
async function stepShelf({ spu, spuName, plan, variants = [], mode, runId, source, io, counts }) {
  const notes = new Map(); const gone = new Set();
  const shelf = shelfFrom(spu);
  if (!shelf.size) return { notes, gone };
  const bySkc = new Map();
  for (const r of plan.rows) { const a = bySkc.get(r.skc) || []; a.push(r); bySkc.set(r.skc, a); }
  // A shoe whose seller SKUs are all gone but whose STYLE Shopify still sells (re-made with new
  // SKUs, like the Adistar XLG KJ7895) isn't gone — it needs relinking, never deleting.
  const styles = new Set(variants.map((v) => String(v.style || '').toUpperCase()).filter(Boolean));
  const styleOnShopify = new Set([...bySkc].filter(([, rs]) => { const st = styleFromTitle(rs[0]?.name || '').toUpperCase(); return st && styles.has(st); }).map(([skc]) => skc));
  const acts = shelfPlan({ rows: plan.rows, shelf, records: await io.sheinShelfRecords([...shelf.keys()]), styleOnShopify });
  for (const [skc, rs] of bySkc) {
    const all = rs.every((r) => r.reason === 'no_shopify' && !r.linkTo) && !styleOnShopify.has(skc);
    const act = acts.find((x) => x.skc === skc);
    if (all && (!(shelf.get(skc)?.on || []).length || (act?.act === 'delist' && mode === 'dry'))) gone.add(skc);
  }
  const nameOf = (skc) => plan.rows.find((r) => r.skc === skc)?.name || null;
  const save = (x, patch) => io.saveSheinShelf({ skc: x.skc, spu: spuName, name: nameOf(x.skc), runId, ...patch });
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  for (const x of acts) {
    // Only the walk deletes (below): a one-shoe dry run must not say it would (2026-10-28).
    if ((x.act === 'delete' || x.act === 'delete_check') && source !== 'walk') { notes.set(x.skc, `${x.why} — only the store-wide walk asks SHEIN to delete a shoe; Fix this shoe never does`); continue; }
    if (mode === 'dry') {
      const t = { delist: `would DELIST this shoe on SHEIN (${x.why})`, relist: `would LIST this shoe again (${x.why})`, delete: `would ask SHEIN to DELETE this shoe (${x.why})` }[x.act];
      if (t || x.act === 'wait' || x.act === 'delete_check' || x.act === 'relink') notes.set(x.skc, t || x.why);
      if (x.act === 'delist') bump('skc_delisted'); else if (x.act === 'delete') bump('skc_delete_requested');
      continue;
    }
    try {
      if (x.act === 'delist' || x.act === 'relist') {
        const r = await io.sheinSetShelf([{ skc: x.skc, sites: x.sites }], x.act === 'delist' ? 2 : 1);
        if (r.failed.has(x.skc)) { bump('shelf_failed'); notes.set(x.skc, `SHEIN refused to ${x.act} this shoe: ${r.failed.get(x.skc)}`); continue; }
        await save(x, { state: x.act === 'delist' ? 'delisted' : 'listed', sites: x.sites, why: x.why, shelfAt: true });
        bump(x.act === 'delist' ? 'skc_delisted' : 'skc_relisted');
        if (x.act === 'delist' && !styleOnShopify.has(x.skc) && bySkc.get(x.skc)?.every((r) => r.reason === 'no_shopify' && !r.linkTo)) gone.add(x.skc);
        notes.set(x.skc, x.act === 'delist' ? `shoe DELISTED on SHEIN — ${x.why}` : `shoe LISTED again on SHEIN — ${x.why}`);
      } else if (x.act === 'settle') {
        await save(x, { state: 'listed', note: x.why });
      } else if (x.act === 'wait' || x.act === 'relink') {
        notes.set(x.skc, x.why);
      } else if (x.act === 'delete' && source === 'walk') {
        const chk = await io.sheinCheckDeletable([x.skc]);
        if (!chk.ok.has(x.skc)) { notes.set(x.skc, `stays delisted — SHEIN won’t delete it: ${chk.no.get(x.skc) || 'not deletable'}`); continue; }
        const d = await io.sheinDeleteSkc(x.skc);
        if (!d.submitted) { bump('shelf_failed'); notes.set(x.skc, 'SHEIN didn’t take the delete request'); continue; }
        await save(x, { state: 'delete_requested', why: x.why, applyNo: d.applyNo });
        bump('skc_delete_requested');
        notes.set(x.skc, `asked SHEIN to DELETE this shoe (${x.why}) — SHEIN reviews it`);
      } else if (x.act === 'delete_check' && source === 'walk') {
        const l = (await io.sheinDeleteLogs([x.skc])).get(x.skc);
        const status = Number(l?.status);
        if (status === 2) { await save(x, { state: 'deleted', note: 'SHEIN deleted it' }); bump('skc_deleted'); notes.set(x.skc, 'SHEIN DELETED this shoe'); }
        else if (status === 3) { await save(x, { state: 'delete_refused', note: l.fail_reason || 'refused' }); bump('skc_delete_refused'); notes.set(x.skc, `SHEIN refused to delete it (${l.fail_reason || 'no reason given'}) — it stays delisted`); }
        else notes.set(x.skc, x.why);
      }
    } catch (e) {
      bump('shelf_failed');
      notes.set(x.skc, `couldn’t ${x.act} this shoe: ${String(e.message).slice(0, 200)}`);
    }
  }
  return { notes, gone };
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
      // SHEIN Listings has an edit of this product in flight (sending, possibly sent, or in SHEIN's
      // review): one partialEdit at a time per product, so the walk changes NO seller SKU on it — but it
      // ALWAYS sets stock (a sale must reach SHEIN; skipping stock is an oversell). No listing items → no change.
      const flight = (await listingInflightSpus().catch(() => new Map())).get(spus[i]);
      if (flight) counts.products_in_flight = (counts.products_in_flight || 0) + 1;
      try {
        const r = await stepProduct(spus[i], { ...ctx, mode: walkModeFor(flight, mode) });
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
  if (shoe) throw Object.assign(new Error(`One shoe (${shoe.spu}) is being checked — start the walk in a moment.`), { status: 409 });
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
// The queue is also kept in table shein_push_queue (until pushed), so a deploy or restart —
// which used to drop every change held during a walk — picks them up again (resumePushes, on
// the worker's start). Pushing a SKU twice is harmless: it writes Shopify's number as it is then.
const queue = new Set(); let timer = null; let pushing = false;
const logQueue = (e) => console.error('[shein-live] push queue', e.message);
export function queuePush(skus, { save = true } = {}) {
  const add = (skus || []).filter(Boolean).map(String);
  for (const s of add) queue.add(s);
  if (save && add.length) sheinPushQueueAdd(add).catch(logQueue);
  if (!timer) timer = setTimeout(drain, 1500);   // coalesce a burst (a bulk edit in Shopify)
}
export async function resumePushes() {
  try {
    const list = await sheinPushQueueList();
    if (list.length) { console.log(`[shein-live] ${list.length} Shopify change(s) from before the restart → SHEIN`); queuePush(list, { save: false }); }
  } catch (e) { logQueue(e); }
}
async function drain() {
  timer = null;
  if (pushing) { timer = setTimeout(drain, 1500); return; }
  // A walk is running: hold the changes and push them once it ends. Dropping them (the walk
  // "will reach it") lost every sale on a product the walk had already passed — until the
  // next walk, up to 3 h later.
  if (active) { if (queue.size) timer = setTimeout(drain, 30_000); return; }
  const skus = [...queue]; queue.clear();
  if (!skus.length) return;
  pushing = true;
  try { await pushSkus(skus); } catch (e) { console.error('[shein-live] push', e.message); } finally {
    pushing = false;
    // Done — unless the same SKU changed again meanwhile (it's queued once more).
    await sheinPushQueueDone(skus.filter((s) => !queue.has(s))).catch(logQueue);
  }
}
export async function pushSkus(skus) {
  const sync = await readSync();
  if (sync.push !== 'on') return { pushed: 0, why: 'push is off' };
  if (active) return { pushed: 0, why: 'a walk is running' };   // the walk will reach it
  const facts = await sheinLastWalkFacts();
  const mine = new Set(skus);
  const spus = [...new Set(facts.filter((f) => mine.has(f.seller_sku)).map((f) => f.spu).filter(Boolean))];
  if (!spus.length) return { pushed: 0, why: 'not on SHEIN (or no walk yet)' };
  return stockStepSpus(spus, facts);
}
// One stock-only step for these SHEIN products — SHEIN Listings calls it once SHEIN approves the
// sizes it added (docs/context/shein-listings.md → Phase 2). Same switches as a Shopify push.
export async function pushSpus(spus) {
  const sync = await readSync();
  if (sync.push !== 'on') return { pushed: 0, why: 'push is off' };
  if (active) return { pushed: 0, why: 'a walk is running' };   // the walk will reach it
  return stockStepSpus(spus, await sheinLastWalkFacts());
}
// The store-wide facts one product can't know (who owns a seller SKU several sizes carry, every
// SHEIN size holding a SKU) — from the last walk's log, for a step outside a walk.
function factsCtx(facts) {
  // Who owns a duplicated seller SKU: whatever the last walk decided (not 'duplicate').
  const owners = new Map();
  for (const f of facts) {
    if (!f.seller_sku || f.reason === 'duplicate') continue;
    const cur = owners.get(f.seller_sku);
    if (!cur || (f.reason === 'ok' && !cur.fits)) owners.set(f.seller_sku, { sheinSku: f.shein_sku, spu: f.spu, fits: f.reason === 'ok' });
  }
  const { holders } = indexRows(facts.map((f) => ({ spu: f.spu, sheinSku: f.shein_sku, sellerSku: f.seller_sku, held: 0 })));
  return { owners, holders };
}
async function stockStepSpus(spus, facts) {
  const wh = pickTargetWarehouse(await sheinWarehouses());
  if (!wh.target) return { pushed: 0, why: 'no target warehouse' };
  const ctx = { mode: 'stock', source: 'push', merchant: wh.merchant, target: wh.target, catalogue: null, ...factsCtx(facts), sheinHeld: new Map(), scanRowHeld: new Map(), decisions: await decisionsMap(), ai: false };
  let n = 0;
  for (const spu of spus) { try { const r = await stepProduct(spu, ctx); n += r.counts.stock_changed || 0; } catch (e) { console.error('[shein-live] push', spu, e.message); } }
  return { pushed: n, products: spus.length };
}

/* ------------------------------- one shoe ------------------------------- */
// SHEIN Listings → Details → "Dry run this shoe" / "Fix this shoe" (docs/context/shein-live-fix.md →
// "One shoe"). The walk's own step for ONE SHEIN product — no store-wide scan: the facts no single
// product can know (who else carries a seller SKU) come from the last walk's log, like a Shopify
// push; the seller-SKU checks against SHEIN are still made live before any edit. A size a person
// took off SHEIN (Match sizes → "take it off") has its seller SKU parked, so the right size can
// carry it. A server job: a shein_live_runs row (mode shoe:dry | shoe:full, the SPU in `current`)
// that a closed tab never stops; the drawer reads it back. Then SHEIN Listings re-reads the product.
export const SHOE_MODES = ['dry', 'full'];
export async function startShoe({ spu, mode, by, productIds = [], io = IO }) {
  spu = String(spu || '').trim();
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(spu)) throw Object.assign(new Error('That isn’t a SHEIN SPU.'), { status: 400 });
  if (!SHOE_MODES.includes(mode)) throw Object.assign(new Error('Unknown mode.'), { status: 400 });
  if (active) throw Object.assign(new Error('The full SHEIN walk is running — it reaches this shoe too. Try again when it ends.'), { status: 409 });
  if (shoe) throw Object.assign(new Error(`Another shoe (${shoe.spu}) is being checked — try again in a moment.`), { status: 409 });
  await markStaleSheinRuns();
  if ((await latestSheinLiveRun())?.status === 'running') throw Object.assign(new Error('The full SHEIN walk is running — try again when it ends.'), { status: 409 });
  if (!shopifyConfigured()) throw Object.assign(new Error('Shopify is not configured on the server.'), { status: 503 });
  const st = await sheinStatus().catch(() => null);
  if (!st?.connected) throw Object.assign(new Error('SHEIN is not connected.'), { status: 503 });
  const run = await createSheinLiveRun({ mode: `shoe:${mode}`, by });
  await updateSheinLiveRun(run.id, { current: spu, total: 1, phase: 'Reading SHEIN warehouses' });
  shoe = { runId: run.id, spu };
  runShoe(run.id, { spu, mode, productIds, io }).finally(() => { shoe = null; });
  return { ...run, current: spu };
}
async function runShoe(id, { spu, mode, productIds, io }) {
  try {
    const wh = pickTargetWarehouse(await sheinWarehouses());
    if (!wh.target) throw new Error(wh.count ? `SHEIN has ${wh.count} merchant warehouses and none is the US default — can’t tell where stock goes.` : 'SHEIN shows no merchant warehouse for this store.');
    // A SHEIN Listings send of this product in flight: stock only, no seller-SKU edit (as the walk).
    const flight = (await listingInflightSpus().catch(() => new Map())).get(spu);
    const ctx = { mode: walkModeFor(flight, mode), runId: id, source: 'shoe', merchant: wh.merchant, target: wh.target, catalogue: null, productIds,
      ...factsCtx(await sheinLastWalkFacts()), sheinHeld: new Map(), scanRowHeld: new Map(), decisions: await decisionsMap(), ai: true, parkDelisted: true, io };
    await updateSheinLiveRun(id, { phase: mode === 'dry' ? 'Checking this shoe (dry run — nothing written)' : 'Fixing this shoe' });
    const r = await stepProduct(spu, ctx);
    const counts = { ...r.counts, products: 1, ...(flight ? { products_in_flight: 1 } : {}) };
    await updateSheinLiveRun(id, { phase: 'Refreshing SHEIN Listings', done: 1, counts });
    try { const { refreshListingSpu } = await import('./shein-listing.js'); await refreshListingSpu(spu, { by: `fix this shoe #${id}` }); }
    catch (e) { console.error('[shein-live] shoe refresh', spu, e.message); counts.refresh_failed = 1; }
    await updateSheinLiveRun(id, { status: 'done', phase: 'Finished', counts, finished: true });
  } catch (e) {
    console.error('[shein-live] shoe failed', spu, e.message);
    await updateSheinLiveRun(id, { status: 'failed', error: String(e.message).slice(0, 500), finished: true });
  }
}
export const shoeActive = () => shoe;
export { latestShoeRun };

export const walkActive = () => (active ? active.runId : null);
export { getSetting };
