// SHEIN live fix — the pure half (docs/context/shein-live-fix.md). The walker
// (api/_lib/shein-live.js) goes through SHEIN ONE PRODUCT AT A TIME: it reads that product
// from SHEIN's API and the Shopify products it points at LIVE, decides here what SHEIN
// should show, writes it, reads it back, and moves on. No export file, so no window in
// which a sale on another channel goes unseen.
//
// The decisions are the SAME hard-coded rules as the export-based fix (sheinCheck.js →
// sheinFix.js). This file only adds what the API changes:
//   · rows come from spu-info + stock-query instead of the Export Products sheet;
//   · "SHEIN orders not shipped yet" = the stock SHEIN itself holds for open orders
//     (locked + temp-locked), per SKU, read live — no order export needed;
//   · SHEIN's stock write is an OVERWRITE of the TOTAL (sellable + held), so the total we
//     send is the sellable number the rules want PLUS what SHEIN already holds;
//   · seller-SKU edits go through SHEIN's review, must stay unique in the store, and can't
//     be sent while the product is already in a review.
import { checkRows } from './sheinCheck.js';
import { buildFix } from './sheinFix.js';
import { compareSize } from './sheinCheck.js';

const sizeMatches = (a, b) => ['ok', 'ok_suffix', 'check_group'].includes(compareSize(a, b));
const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// An AI link is written to SHEIN only at this confidence (the page's bar for SHOWING one is 0.6).
export const AI_WRITE_MIN = 0.8;

/* ------------------------------ reading SHEIN ------------------------------ */

const en = (list, key) => {
  const a = Array.isArray(list) ? list : [];
  const hit = a.find((x) => /^en/i.test(x?.language || '')) || a[0];
  return hit ? String(hit[key] ?? '').trim() : '';
};
// The size of one SHEIN SKU: its sale attribute named like a size (else the only one).
function skuSize(sku) {
  const attrs = Array.isArray(sku?.saleAttributeList) ? sku.saleAttributeList : [];
  const isSize = (a) => /size|尺码|尺寸|码/i.test(en(a.attributeMultiList, 'attributeName'));
  const a = attrs.find(isSize) || (attrs.length === 1 ? attrs[0] : attrs[0]);
  if (!a) return '';
  return en(a.attributeValueMultiList, 'attributeValueName') || String(a.attributeValue ?? a.customAttributeValue ?? '').trim();
}

// spu-info (one product) + stock-query rows → the same row shape the export gave
// (readSheinExport), plus the live stock detail: `qty` = sellable now, `held` = held for
// SHEIN orders not shipped yet, `whs` = per merchant warehouse.
// `merchant` = Set of OUR warehouse codes (type 1); stock elsewhere isn't ours to set.
export function rowsFromSpu(spu, stockList, { merchant = null } = {}) {
  const stockBySku = new Map();
  for (const g of stockList || []) {
    for (const s of g?.skuList || []) {   // one SKU may come back in more than one group: combine its warehouses
      const k = String(s.skuCode); const cur = stockBySku.get(k);
      stockBySku.set(k, cur ? { ...cur, warehouseInventoryList: [...(cur.warehouseInventoryList || []), ...(s.warehouseInventoryList || [])] } : s);
    }
  }
  const name = en(spu?.productMultiNameList, 'productName') || en(spu?.productMultiNameList, 'name');
  const rows = [];
  for (const skc of spu?.skcInfoList || []) {
    const skcName = en(skc.productMultiNameList, 'productName');
    for (const sku of skc.skuInfoList || []) {
      const st = stockBySku.get(String(sku.skuCode));
      const whs = (st?.warehouseInventoryList || [])
        .filter((w) => !merchant || merchant.has(String(w.warehouseCode)))
        .map((w) => {
          const total = n0(w.inventoryQuantity); const usable = n0(w.usableInventory);
          const held = Math.max(n0(w.lockedQuantity) + n0(w.tempLockQuantity), total - usable, 0);
          return { code: String(w.warehouseCode), total, usable, held };
        });
      const price = (sku.priceInfoList || []).find((p) => /shein-us/i.test(p.subSite || '')) || (sku.priceInfoList || [])[0] || null;
      rows.push({
        line: rows.length + 1,
        spu: spu.spuName, skc: skc.skcName, sheinSku: String(sku.skuCode || ''),
        sellerSku: String(sku.supplierSku ?? '').trim(), size: skuSize(sku),
        name: skcName || name, qty: whs.reduce((s, w) => s + w.usable, 0), held: whs.reduce((s, w) => s + w.held, 0), whs,
        mallState: sku.mallState == null ? null : Number(sku.mallState),
        price: price ? { base: price.basePrice ?? null, special: price.specialPrice ?? null, currency: price.currency || null, site: price.subSite || null } : null,
        warehouse: whs[0]?.code || '',
      });
    }
  }
  return rows;
}

/* --------------------------- store-wide facts --------------------------- */

// Who may sell each seller SKU when several SHEIN sizes carry it (4seller left some): the
// one whose SHEIN size IS the Shopify size of that SKU; else the first seen. One owner per
// SKU across the WHOLE store — a duplicate in another product must not sell it too.
export function ownersFrom(allRows, variants) {
  const bySku = new Map((variants || []).map((v) => [String(v.sku), v]));
  const owners = new Map();
  for (const r of allRows) {
    if (!r.sellerSku) continue;
    const cur = owners.get(r.sellerSku);
    const v = bySku.get(r.sellerSku);
    const fits = !!(v && r.size && sizeMatches(r.size, v.size));
    if (!cur || (fits && !cur.fits)) owners.set(r.sellerSku, { sheinSku: r.sheinSku, spu: r.spu, fits });
  }
  return owners;
}
// Every SHEIN SKU carrying each seller SKU, and what SHEIN holds per seller SKU (orders).
export function indexRows(allRows) {
  const holders = new Map(); const held = new Map();
  for (const r of allRows) {
    if (!r.sellerSku) continue;
    const a = holders.get(r.sellerSku) || []; a.push({ sheinSku: r.sheinSku, spu: r.spu }); holders.set(r.sellerSku, a);
    held.set(r.sellerSku, (held.get(r.sellerSku) || 0) + n0(r.held));
  }
  return { holders, held };
}

/* -------------------------------- the plan -------------------------------- */

// One product → { rows (the fix's rows, with `held`), writes, edits, skipped }.
//   writes: [{ sheinSku, warehouseCode, total, sellable, before }] — OVERWRITE totals;
//   edits:  [{ skc, skuCode, supplierSku, from, by, why, frees }] — seller-SKU changes;
//   skipped: [{ sheinSku, why }] — a link the rules found but may not be written now.
// `heldBySku` = SHEIN's held stock per seller SKU, store-wide (indexRows().held);
// `owners` / `holders` from the whole store; `target` = the warehouse stock goes to.
// parkDelisted (the one-shoe run only): a size a person took off SHEIN ("delist") that still carries a
// live Shopify SKU gets that SKU parked, so the right SHEIN size can carry it (the full walk leaves it).
export function planProduct({ rows, variants, decisions = {}, aiLinks = {}, owners = new Map(), holders = new Map(), heldBySku = new Map(), target = '', links = true, parkDelisted = false }) {
  // The owner of a duplicated SKU goes first, so the fix's "first one sells" picks it.
  const ordered = [...rows].sort((a, b) => Number(owners.get(b.sellerSku)?.sheinSku === b.sheinSku) - Number(owners.get(a.sellerSku)?.sheinSku === a.sheinSku) || a.line - b.line);
  const open = Object.fromEntries([...heldBySku]);
  const fix = buildFix(checkRows(ordered, variants), variants, { openBySku: open, aiLinks, decisions });
  const out = fix.rows.map((r) => {
    const own = r.sellerSku ? owners.get(r.sellerSku) : null;
    if (own && own.sheinSku !== r.sheinSku && r.newQty > 0) {
      return { ...r, newQty: 0, change: r.qty !== 0, reason: 'duplicate', action: `Seller SKU ${r.sellerSku} is also on SHEIN SKU ${own.sheinSku}${own.spu !== r.spu ? ` (another SHEIN product, ${own.spu})` : ''}, which sells it — this size must not` };
    }
    return r;
  });

  // Stock: the total SHEIN should hold = what may be sold + what open orders already hold.
  const writes = [];
  for (const r of out) {
    if (!r.sheinSku || r.mallState === 2) continue;          // stopped on SHEIN: SHEIN keeps no stock for it
    const sellable = Math.max(0, Math.floor(n0(r.newQty)));
    if (sellable === n0(r.qty)) continue;
    const whs = r.whs?.length ? r.whs : [{ code: target, total: 0, usable: 0, held: 0 }];
    const main = whs.find((w) => w.code === target) || (target ? { code: target, total: 0, usable: 0, held: 0 } : whs[0]);
    writes.push({ sheinSku: r.sheinSku, warehouseCode: main.code, total: sellable + main.held, sellable, before: n0(r.qty) });
    for (const w of whs) if (w.code !== main.code && w.usable > 0) writes.push({ sheinSku: r.sheinSku, warehouseCode: w.code, total: w.held, sellable: 0, before: w.usable });
  }

  // Seller SKUs: only links the rules proved (or a person confirmed, or a verified AI match
  // at AI_WRITE_MIN). The new SKU must be free — or held by a size in THIS product that is
  // being moved off it in the same edit.
  const edits = []; const skipped = [];
  if (links) {
    const bySheinSku = new Map(out.map((r) => [r.sheinSku, r]));
    const wanted = out.filter((r) => r.linkTo?.sku && r.linkTo.sku !== r.sellerSku && ['swap', 'no_shopify', 'pending_change'].includes(r.reason));
    const moving = new Map();   // seller SKU → the row that will carry it after the edit
    for (const r of wanted) {
      const l = r.linkTo;
      const okBy = l.by === 'rule' || l.by === 'person' || (l.by === 'ai' && n0(l.confidence) >= AI_WRITE_MIN);
      if (!okBy) { skipped.push({ sheinSku: r.sheinSku, why: `AI match below ${AI_WRITE_MIN} confidence — confirm it on Match sizes` }); continue; }
      if (moving.has(l.sku)) { skipped.push({ sheinSku: r.sheinSku, why: `${l.sku} is already going to SHEIN SKU ${moving.get(l.sku)}` }); continue; }
      const others = (holders.get(l.sku) || []).filter((h) => h.sheinSku !== r.sheinSku);
      const elsewhere = others.find((h) => h.spu !== r.spu);
      if (elsewhere) { skipped.push({ sheinSku: r.sheinSku, why: `${l.sku} is on another SHEIN product (${elsewhere.spu}) — fix that one first` }); continue; }
      const sellsIt = others.map((h) => bySheinSku.get(h.sheinSku)).find((x) => x && x.reason === 'ok');
      if (sellsIt) { skipped.push({ sheinSku: r.sheinSku, why: `SHEIN size ${sellsIt.size} already sells ${l.sku} correctly — this size is a duplicate listing; delist it` }); continue; }
      moving.set(l.sku, r.sheinSku);
      edits.push({ skc: r.skc, skuCode: r.sheinSku, supplierSku: l.sku, from: r.sellerSku, by: l.by, why: r.reason });
    }
    // A size losing its SKU to a move gets a parked SKU (seller SKUs are required and unique);
    // it stays at 0 and is recorded as delisted.
    for (const e of [...edits]) {
      for (const h of holders.get(e.supplierSku) || []) {
        if (h.sheinSku === e.skuCode || edits.some((x) => x.skuCode === h.sheinSku)) continue;
        const r = bySheinSku.get(h.sheinSku);
        if (!r) continue;
        const taken = new Set([...holders.keys(), ...edits.map((x) => x.supplierSku)]);
        let park = `${e.supplierSku}-off`; let i = 2;
        while (taken.has(park)) park = `${e.supplierSku}-off${i++}`;
        edits.push({ skc: r.skc, skuCode: r.sheinSku, supplierSku: park, from: r.sellerSku, by: 'rule', why: 'frees', frees: e.supplierSku });
      }
    }
    if (parkDelisted) {
      const live = new Set((variants || []).map((v) => String(v.sku)));
      for (const r of out) {
        if (r.reason !== 'delist' || !r.sellerSku || !live.has(r.sellerSku) || edits.some((x) => x.skuCode === r.sheinSku)) continue;
        const taken = new Set([...holders.keys(), ...edits.map((x) => x.supplierSku)]);
        let park = `${r.sellerSku}-off`; let i = 2;
        while (taken.has(park)) park = `${r.sellerSku}-off${i++}`;
        edits.push({ skc: r.skc, skuCode: r.sheinSku, supplierSku: park, from: r.sellerSku, by: 'person', why: 'frees', frees: r.sellerSku });
      }
    }
  }
  const steps = links ? twoStepMoves(edits, out, holders) : { edits, waiting: [] };
  return { rows: out, writes, edits: steps.edits, skipped: [...skipped, ...steps.waiting], sizesToAdd: fix.sizesToAdd };
}

// SHEIN refuses a new seller SKU while another size of this product still SHOWS it, even when the same
// edit moves it away ("Duplicate seller SKU", 29 sizes on 9 shoes, live run 2026-11-06). So such a move
// takes two edits: now, every size showing a wanted SKU moves off it; once SHEIN has approved that, the
// next "Fix stock + seller SKUs" sends the moves (their SKUs are free by then). A size that both shows a
// wanted SKU and waits for one is parked now, with its real SKU saved (finalSku), so a swap or a chain
// of any length is two edits, not one per link. Edits that clash with nothing go out as before.
function twoStepMoves(edits, rows, holders) {
  const showing = new Map();
  for (const r of rows) if (r.sellerSku) showing.set(r.sellerSku, [...(showing.get(r.sellerSku) || []), r]);
  const others = (e) => (showing.get(e.supplierSku) || []).filter((r) => r.sheinSku !== e.skuCode);
  const clash = edits.filter((e) => !e.frees && others(e).length);
  if (!clash.length) return { edits, waiting: [] };
  const held = new Set(clash.map((e) => e.skuCode));
  const send = edits.filter((e) => !held.has(e.skuCode));
  const moving = new Set(send.map((e) => e.skuCode));
  const taken = new Set([...holders.keys(), ...edits.map((e) => e.supplierSku)]);
  const waiting = [];
  for (const e of clash) {
    const seller = others(e).find((r) => r.reason === 'ok');   // the last read says it sells this SKU right: leave both alone
    if (seller) { held.delete(e.skuCode); waiting.push({ sheinSku: e.skuCode, why: `SHEIN size ${seller.size} already sells ${e.supplierSku} correctly — this size is a duplicate listing; delist it` }); continue; }
    for (const r of others(e)) {
      if (moving.has(r.sheinSku)) continue;
      let park = `${e.supplierSku}-off`; let i = 2;
      while (taken.has(park)) park = `${e.supplierSku}-off${i++}`;
      taken.add(park); moving.add(r.sheinSku);
      const own = clash.find((x) => x.skuCode === r.sheinSku);
      send.push({ skc: r.skc, skuCode: r.sheinSku, supplierSku: park, from: r.sellerSku, by: 'rule', why: 'frees', frees: e.supplierSku, ...(own ? { finalSku: own.supplierSku } : {}) });
    }
  }
  for (const e of clash) {
    if (!held.has(e.skuCode) || moving.has(e.skuCode)) continue;
    const r = others(e)[0];
    waiting.push({ sheinSku: e.skuCode, why: `step 2 of 2: ${e.supplierSku} is still on SHEIN size ${r.size}. That size moves off it first; once SHEIN approves, the next Fix stock + seller SKUs changes this one` });
  }
  return { edits: send, waiting };
}

/* ------------------------- delist / re-list / delete ------------------------- */
// One SHEIN SKC = one shoe (one colour, all its sizes). The owner's rule (2026-10-23):
//   · every size at 0 (nothing Shopify can sell for it)  → DELIST it (reversible);
//   · stock back on a size of one WE delisted             → LIST it again;
//   · every size's seller SKU gone from Shopify, already off the shelf everywhere → ask
//     SHEIN to DELETE it (irreversible; SHEIN reviews, and refuses one with an order in the
//     last year — that one simply stays delisted).
// A shoe still at 0 but on Shopify is only delisted, never deleted: it may be restocked.
export const SHELF_GAP_MS = 20 * 60_000;   // SHEIN: one change per SKC + site per 20 minutes
export const SHELF_DEFAULT_SITES = ['shein-us'];

// spu-info → per SKC, the sites it is on / off the shelf.
export function shelfFrom(spu) {
  const out = new Map();
  for (const skc of spu?.skcInfoList || []) {
    const list = skc.shelfStatusInfoList || [];
    out.set(String(skc.skcName), {
      on: list.filter((x) => Number(x.shelfStatus) === 1).map((x) => String(x.siteAbbr)).filter(Boolean),
      off: list.filter((x) => Number(x.shelfStatus) !== 1).map((x) => String(x.siteAbbr)).filter(Boolean),
    });
  }
  return out;
}

// rows = planProduct().rows (newQty = what SHEIN may sell now); records = our shein_skc_shelf
// rows by SKC; styleOnShopify = SKCs whose style code Shopify still sells under OTHER SKUs
// (re-made product, new SKUs: the shoe isn't gone, its sizes need relinking — never delete).
// → [{ skc, act: delist | relist | delete | delete_check | settle | wait | relink, sites, why }]
export function shelfPlan({ rows, shelf, records = new Map(), styleOnShopify = new Set(), now = Date.now() }) {
  const bySkc = new Map();
  for (const r of rows) { if (!r.skc) continue; const a = bySkc.get(r.skc) || []; a.push(r); bySkc.set(r.skc, a); }
  const out = [];
  for (const [skc, rs] of bySkc) {
    const st = shelf.get(skc) || { on: [], off: [] };
    const rec = records.get(skc) || null;
    const recent = rec?.shelf_at && now - new Date(rec.shelf_at).getTime() < SHELF_GAP_MS;
    const zero = rs.every((r) => n0(r.newQty) === 0);
    const deadSkus = rs.every((r) => r.reason === 'no_shopify' && !r.linkTo);
    const gone = deadSkus && !styleOnShopify.has(skc);
    if (rec?.state === 'deleted') continue;
    if (!zero) {
      if (rec?.state === 'delisted' && st.on.length) out.push({ skc, act: 'settle', why: 'listed again on SHEIN' });   // someone listed it by hand
      else if (rec?.state === 'delisted') {
        const sites = rec.sites?.length ? rec.sites : SHELF_DEFAULT_SITES;
        out.push(recent ? { skc, act: 'wait', sites, why: 'stock is back — re-list after SHEIN’s 20-minute gap' }
          : { skc, act: 'relist', sites, why: `stock is back (${rs.filter((r) => n0(r.newQty) > 0).length} size${rs.filter((r) => n0(r.newQty) > 0).length === 1 ? '' : 's'})` });
      }
      continue;
    }
    if (st.on.length) {
      const why = gone ? 'every size’s seller SKU is gone from Shopify' : deadSkus ? 'every size is at 0 (its seller SKUs are gone; Shopify has the style under new SKUs)' : 'every size is at 0';
      out.push(recent ? { skc, act: 'wait', sites: st.on, why: `${why} — delist after SHEIN’s 20-minute gap` } : { skc, act: 'delist', sites: st.on, why });
      continue;
    }
    if (deadSkus && !gone) { out.push({ skc, act: 'relink', why: 'its seller SKUs are gone, but Shopify still has this style under new SKUs — not deleted; relink it on Match sizes' }); continue; }
    if (!gone) continue;                                   // off the shelf, still on Shopify: stays delisted
    if (rec?.state === 'delete_requested') out.push({ skc, act: 'delete_check', why: 'waiting for SHEIN’s review of the delete' });
    else if (rec?.state !== 'delete_refused') out.push({ skc, act: 'delete', why: 'every size’s seller SKU is gone from Shopify and it is off the shelf' });
  }
  return out;
}

// What a walk did to one SHEIN size, in one line (the log, the page, the CSV).
export function outcome(row, { wrote = [], edit = null, skip = null, after = null, dry = false } = {}) {
  const parts = [];
  if (wrote.length) parts.push(`${dry ? 'would set' : 'stock'} ${row.qty} → ${row.newQty}${after != null && after !== row.newQty ? ` (SHEIN shows ${after}!)` : ''}`);
  if (edit) parts.push(`${dry ? 'would change' : 'seller SKU'} ${edit.from || '—'} → ${edit.supplierSku}${edit.frees ? ` (frees ${edit.frees}${edit.finalSku ? `; becomes ${edit.finalSku} once SHEIN approves` : ''})` : ''}${edit.withAttrs?.length ? ` + SHEIN details it now requires (${edit.withAttrs.join(', ')})` : ''}`);
  if (skip) parts.push(`not changed: ${skip.why}`);
  return parts.join(' · ');
}

/* ------------------------- SHEIN sales → Shopify ------------------------- */
// Every SHEIN sale must leave Shopify at once — Shopify is the one count every other
// channel (eBay, StockX, Alias, the stores) sells from. SHEIN lists every UNIT of an order
// with its own goodsId: one unit = one pair = one −1 on Shopify, keyed by that goodsId.

// SHEIN's API speaks Beijing time (UTC+8) — both in its query filters and in times it
// returns without an offset. Never the host's clock.
export function toSheinTime(date) {
  const d = new Date(new Date(date).getTime() + 8 * 3600_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
export function fromSheinTime(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(t)) { const d = new Date(t.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
  const d = new Date(`${t.replace(' ', 'T')}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const OPEN = new Set([1, 2, 7]);          // pending · to ship · waiting for pick-up: the pair is still here
const SHIPPED = new Set([4, 5, 8, 9]);    // shipped · signed · lost · rejected: it has left

// order-detail rows → units. `since` = the switch-on moment: a unit sold before it was not
// ours to deduct (Shopify either already has it or a person decided). `known` = goodsIds
// already recorded (their `due` never changes after first sight). `openAtStart` = the person
// chose to take off the sales still open at switch-on too (only used by the first load).
export function unitsFromOrders(details, { since = null, known = new Set(), openAtStart = false } = {}) {
  const out = [];
  for (const o of details || []) {
    const orderTime = fromSheinTime(o.orderAllocateTime) || fromSheinTime(o.orderTime) || fromSheinTime(o.paymentTime);
    for (const g of o.orderGoodsInfoList || []) {
      const goodsId = String(g.goodsId ?? '').trim();
      if (!goodsId) continue;
      const status = Number(g.newGoodsStatus ?? g.goodsStatus ?? o.orderStatus);
      const after = !since || (orderTime && orderTime >= new Date(since).toISOString());
      out.push({
        goods_id: goodsId, order_no: String(o.orderNo || ''), order_status: Number(o.orderStatus) || null, unit_status: status || null,
        exchange_tag: Number(g.goodsExchangeTag ?? 1) || 1, stock_mode: Number(o.stockMode ?? 3) || null,
        seller_sku: String(g.sellerSku ?? '').trim() || null, shein_sku: String(g.skuCode ?? '').trim() || null,
        title: String(g.goodsTitle ?? '').slice(0, 300) || null, price: g.sellerCurrencyPrice == null ? null : Number(g.sellerCurrencyPrice),
        order_time: orderTime, shipped_seen: SHIPPED.has(status),
        due: known.has(goodsId) ? false : !!(after || (openAtStart && OPEN.has(status))),
      });
    }
  }
  return out;
}

// Is this SHEIN order ready to be written to Shopify as an order? Only once every live pair has
// left the warehouse: a cancel before shipping then never reaches Shopify, and the order goes in
// with its tracking number. 'ready' | 'wait' | 'skip'.
const liveGoods = (o) => (o?.orderGoodsInfoList || []).filter((g) => [1, 3].includes(Number(g.goodsExchangeTag ?? 1)) && Number(g.newGoodsStatus ?? g.goodsStatus ?? o.orderStatus) !== 6);
export function sheinOrderState(o) {
  if (Number(o?.stockMode ?? 3) !== 3) return { state: 'skip', reason: 'SHEIN ships this one from its own warehouse.' };
  const live = liveGoods(o);
  if (!live.length) return { state: 'skip', reason: 'SHEIN refunded or swapped every pair on this order.' };
  if (live.some((g) => OPEN.has(Number(g.newGoodsStatus ?? g.goodsStatus ?? o.orderStatus)))) return { state: 'wait', reason: 'Not shipped yet. It goes into Shopify when it ships.' };
  return { state: 'ready' };
}

const money = (n) => Number(n).toFixed(2);
// What the buyer paid for the pair, before tax: SHEIN's own income formula starts from
// sellerCurrencyPrice and takes off the coupon and promotion. NOT sellerCurrencyDiscountPrice:
// that's the buyer's total WITH tax (checked on 4 real orders, 2026-11-06), so using it counted
// the tax twice on #31114 ($59.77 + $3.38 instead of $56.39 + $3.38).
export function sheinLinePrice(g) {
  const base = Number(g.sellerCurrencyPrice);
  if (g.sellerCurrencyPrice == null || !Number.isFinite(base)) return null;
  const net = base - (Number(g.orderCurrencyStoreCouponPrice) || 0) - (Number(g.orderCurrencyPromotionPrice) || 0);
  return Math.round(net * 100) / 100;
}

// The orderCreate input for one SHEIN order. `variants`: Map(seller SKU → variant gid); a SKU
// Shopify no longer has goes in by SKU and title, so the sale is still on record. Throws rather
// than write a wrong amount. SHEIN collects and pays US sales tax, hence channelLiable.
export function shopifyOrderInput(o, { variants = new Map(), locationId, now = new Date(), shipped = true }) {
  const orderNo = String(o?.orderNo || '').trim();
  if (!orderNo) throw new Error('The SHEIN order has no number.');
  if (shipped && !locationId) throw new Error('No Shopify location to record the shipment against.');
  const currency = String(o.orderCurrency || liveGoods(o)[0]?.orderCurrency || 'USD').toUpperCase();
  if (currency !== 'USD') throw new Error(`SHEIN order ${orderNo} is in ${currency}; the store is in USD.`);
  const shopMoney = (n) => ({ shopMoney: { amount: money(n), currencyCode: currency } });
  let total = 0;
  const lineItems = liveGoods(o).map((g) => {
    const price = sheinLinePrice(g);
    if (price == null || price <= 0) throw new Error(`SHEIN gave no usable price for ${g.sellerSku || g.goodsId} on ${orderNo}.`);
    const tax = Math.round((Number(g.saleTax) || 0) * 100) / 100;
    total += price + tax;
    const sku = String(g.sellerSku ?? '').trim();
    const variantId = variants.get(sku);
    return {
      quantity: 1, priceSet: shopMoney(price), requiresShipping: true,
      ...(variantId ? { variantId } : { title: String(g.goodsTitle || sku || 'SHEIN item').slice(0, 250), ...(sku ? { sku } : {}) }),
      ...(tax > 0 ? { taxLines: [{ title: 'Sale tax', rate: Number((tax / price).toFixed(4)), priceSet: shopMoney(tax), channelLiable: true }] } : {}),
    };
  });
  if (!lineItems.length) throw new Error(`SHEIN order ${orderNo} has no live pairs.`);
  const soldAt = fromSheinTime(o.orderAllocateTime) || fromSheinTime(o.orderTime) || fromSheinTime(o.paymentTime);
  const packages = (o.packageWaybillList || []).filter((p) => String(p?.waybillNo || '').trim());
  const extra = packages.slice(1).map((p) => p.waybillNo);
  return {
    total: Math.round(total * 100) / 100,
    order: {
      lineItems, currency, financialStatus: 'PAID',
      // Not shipped yet (written at the sale): it goes in open and is fulfilled when it ships.
      ...(shipped ? { fulfillmentStatus: 'FULFILLED', fulfillment: { locationId, notifyCustomer: false,
        ...(packages[0] ? { trackingNumber: String(packages[0].waybillNo).trim(), ...(packages[0].carrier ? { trackingCompany: String(packages[0].carrier) } : {}) } : {}) } } : {}),
      transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'SHEIN', amountSet: shopMoney(total), ...(soldAt ? { processedAt: soldAt } : {}) }],
      ...(soldAt ? { processedAt: soldAt } : {}),
      // Same marks CedCommerce left, so searches and habits keep working. The order number is
      // also a tag: that's how we find this order again after a lost answer.
      tags: ['SHEIN', orderNo], sourceIdentifier: orderNo,
      note: `Source order id: ${orderNo}${extra.length ? ` · more tracking: ${extra.join(', ')}` : ''}`,
      customAttributes: [{ key: 'channel', value: 'SHEIN' }, { key: 'Source order id', value: orderNo }],
      // Shipped and paid: nothing left to do on it, so it goes straight to archived like
      // the CedCommerce orders did.
      ...(shipped ? { closedAt: new Date(now).toISOString() } : {}),
    },
  };
}

// The tracking to fulfil an order with: the first package's, and the rest for the note.
export function sheinOrderTracking(o) {
  const p = (o?.packageWaybillList || []).find((x) => String(x?.waybillNo || '').trim());
  return p ? { number: String(p.waybillNo).trim(), company: p.carrier ? String(p.carrier) : null } : {};
}

// What Shopify must do for a recorded unit: 'deduct' | 'restock' | null.
export function unitAction(u) {
  if (u.deducted_at == null) {
    return u.due && Number(u.stock_mode) === 3 && [1, 3].includes(Number(u.exchange_tag)) && Number(u.unit_status) !== 6 ? 'deduct' : null;
  }
  if (u.restocked_at == null && !u.shipped_seen && (Number(u.unit_status) === 6 || [2, 4].includes(Number(u.exchange_tag)))) return 'restock';
  return null;
}

// Which Shopify location a SHEIN sale comes out of: the one named in SHOPIFY_SHEIN_LOCATION
// (id or name); else the only one; else the one holding the most. Never a guess between equals.
export function pickLocation(levels, prefer = '') {
  const ls = (levels || []).filter((l) => l.locationId);
  if (!ls.length) return null;
  const p = String(prefer || '').trim().toLowerCase();
  if (p) { const hit = ls.find((l) => l.locationId.toLowerCase() === p || l.locationId.toLowerCase().endsWith(`/${p}`) || l.location.toLowerCase() === p); if (hit) return hit; }
  if (ls.length === 1) return ls[0];
  const sorted = [...ls].sort((a, b) => b.available - a.available);
  return sorted[0].available > (sorted[1]?.available ?? -Infinity) ? sorted[0] : null;
}
