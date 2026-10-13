// SHEIN ↔ Shopify check — the pure half (docs/context/shein-check.md). SHEIN's Export
// Products file against the live Shopify store, matched by the seller SKU (the Shopify
// variant SKU the listing tool copied to SHEIN). It answers the two things that cost us
// cancellations and oversells: is each SHEIN size the SAME size as the Shopify variant
// behind it, and does SHEIN offer more pairs than Shopify has?
//
// The same comparison is what the API sync will run before it writes anything (step 1 of
// the SHEIN integration), so the rules live here and are tested here.
import { readSheetRows } from './sheinReprice.js';

/* ------------------------------ reading the export ------------------------------ */

// Columns found BY HEADER NAME (SHEIN reorders its exports).
const COLS = {
  sellerSku: (h) => h === 'sellerSKU',
  size: (h) => h === 'Secondary Specification Value1',
  qty: (h) => h === 'Current inventory',
  name: (h) => h === 'Default Product Name(en)',
  spu: (h) => h === 'SPU',
  skc: (h) => h === 'SKC',
  sheinSku: (h) => h === 'SKU',
  status: (h) => /^Listing status/i.test(h),
  link: (h) => /^Mall link/i.test(h),
  image: (h) => h === 'Main Image',
  brand: (h) => h === 'brand name' || h === 'Brand Name (English)',
  warehouse: (h) => h === 'Warehouse ID',
};
const NEEDED = { sellerSku: 'sellerSKU', size: 'Secondary Specification Value1', qty: 'Current inventory' };

export function readSheinExport(bytes) {
  const grid = readSheetRows(bytes, 'Product Information');
  if (!grid) return { ok: false, error: 'Not SHEIN’s Export Products file — it needs the “Product Information” sheet (.xlsx).' };
  const head = (grid[0] || []).map((h) => String(h ?? '').replace(/ /g, ' ').trim());
  const at = {};
  for (const [k, test] of Object.entries(COLS)) { const i = head.findIndex(test); if (i >= 0 && at[k] == null) at[k] = i; }
  const missing = Object.keys(NEEDED).filter((k) => at[k] == null);
  if (missing.length) return { ok: false, error: `Missing column${missing.length === 1 ? '' : 's'}: ${missing.map((k) => NEEDED[k]).join(', ')}.` };
  const cell = (g, k) => (at[k] == null ? '' : String(g[at[k]] ?? '').trim());
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const g = grid[r];
    if (!g || !g.some((c) => String(c ?? '').trim())) continue;
    const q = Number(cell(g, 'qty'));
    rows.push({
      line: r + 1, sellerSku: cell(g, 'sellerSku'), size: cell(g, 'size'), qty: Number.isFinite(q) ? q : 0,
      name: cell(g, 'name'), spu: cell(g, 'spu'), skc: cell(g, 'skc'), sheinSku: cell(g, 'sheinSku'),
      status: cell(g, 'status'), link: cell(g, 'link'), image: cell(g, 'image'), brand: cell(g, 'brand'), warehouse: cell(g, 'warehouse'),
    });
  }
  if (!rows.length) return { ok: false, error: 'No product rows in the Product Information sheet.' };
  return { ok: true, rows };
}

/* --------------------------------- sizes --------------------------------- */

// A size as a number + who it fits. Both sides write sizes their own way:
//   SHEIN   "US10.5" · "US9.5W" · "7 Toddler" · "US7-8" · "CN35" · "EUR15"
//   Shopify "10.5" · "6W" · "3Y" · "4C" · "7.5 W"
// group: adult (no marker) · women (W) · youth (Y / GS) · child (C / Toddler / TD / PS / K)
// system: US · EUR · CN · other — only US sizes can be compared with Shopify's.
export function parseSize(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { blank: true };
  const u = s.toUpperCase().replace(/\s+/g, ' ');
  if (/^(EUR?|EU)\s*\d/.test(u)) return { system: 'EUR', text: s };
  if (/^CN\s*\d/.test(u)) return { system: 'CN', text: s };
  if (/^(UK)\s*\d/.test(u)) return { system: 'UK', text: s };
  if (/\d\s*-\s*\d/.test(u)) return { system: 'range', text: s };
  const m = u.replace(/^US\s*/, '').match(/^(\d{1,2}(?:\.\d)?)\s*(.*)$/);
  if (!m) return { system: 'other', text: s };
  const rest = m[2].trim();
  const group = !rest ? 'adult'
    : /^(W|WMNS|WOMEN'?S?)$/.test(rest) ? 'women'
      : /^(Y|GS|YOUTH|BIG KIDS?)$/.test(rest) ? 'youth'
        : /^(C|K|TD|PS|TODDLER|INFANT|LITTLE KIDS?|PRESCHOOL)$/.test(rest) ? 'child'
          : /^(M|MEN'?S?)$/.test(rest) ? 'adult' : 'unknown';
  return { system: 'US', n: Number(m[1]), group, text: s };
}

// One SHEIN size against the Shopify variant with the same SKU.
//   ok · ok_suffix (same size, only the W marker differs) · wrong_size · wrong_group ·
//   check_group (youth vs adult — GS sizes listed as adult) · other_system · blank
export function compareSize(sheinRaw, shopifyRaw) {
  const a = parseSize(sheinRaw);
  const b = parseSize(shopifyRaw);
  if (a.blank) return 'blank';
  if (a.system !== 'US') return 'other_system';
  if (b.blank || b.system !== 'US') return 'other_system';
  if (a.n !== b.n) return 'wrong_size';
  if (a.group === b.group) return 'ok';
  const g = new Set([a.group, b.group]);
  if (g.has('child')) return 'wrong_group';                      // toddler / little kids vs anything else
  if (g.has('youth') && g.has('women')) return 'wrong_group';
  if (g.has('youth')) return 'check_group';                      // 6.5Y vs 6.5
  return 'ok_suffix';                                            // 6 vs 6W, 9 vs 9M
}

/* ------------------------------- the check ------------------------------- */

// What each finding means and how bad it is. `bad` = a cancellation or an oversell waiting
// to happen; `warn` = look at it; `ok` = fine.
export const ISSUES = {
  wrong_size: { label: 'Wrong size', tone: 'bad', help: 'SHEIN sells this SKU as a different size than Shopify has — the buyer gets the wrong shoe, or we cancel.' },
  wrong_group: { label: 'Wrong age group', tone: 'bad', help: 'Same number, different fit — e.g. a GS (Y) size listed as Toddler, or Toddler as adult.' },
  blank: { label: 'No size on SHEIN', tone: 'bad', help: 'The SHEIN listing has no size for this SKU.' },
  not_in_shopify: { label: 'Not in Shopify', tone: 'bad', help: 'No Shopify variant has this SKU, and SHEIN still offers pairs — a sale there deducts nothing anywhere.' },
  not_in_shopify_zero: { label: 'Not in Shopify (0 on SHEIN)', tone: 'warn', help: 'No Shopify variant has this SKU; SHEIN shows 0, so nothing sells today — clean it up before stock comes back.' },
  over_stock: { label: 'More on SHEIN than Shopify', tone: 'bad', help: 'SHEIN offers more pairs than Shopify has — an oversell waiting to happen.' },
  no_seller_sku: { label: 'No seller SKU', tone: 'bad', help: 'The SHEIN size carries no seller SKU, so nothing links it to Shopify.' },
  duplicate: { label: 'SKU used twice on SHEIN', tone: 'warn', help: 'Two SHEIN sizes point at the same Shopify variant — both sell the same pairs.' },
  check_group: { label: 'Youth vs adult', tone: 'warn', help: 'Shopify says Y (GS), SHEIN says the adult size (or the other way) — usually wrong for kids’ shoes.' },
  other_system: { label: 'EUR / CN / range size', tone: 'warn', help: 'SHEIN lists this in another size system (or a range), so it can’t be checked — make it the US size.' },
  shopify_inactive: { label: 'Shopify product not active', tone: 'warn', help: 'The Shopify product is draft or archived, but SHEIN still offers it.' },
  under_stock: { label: 'Less on SHEIN than Shopify', tone: 'info', help: 'SHEIN offers fewer pairs than Shopify has — sales left on the table, not a risk.' },
  ok_suffix: { label: 'Same size (marker differs)', tone: 'ok', help: 'Same size; only the W/M marker is written differently.' },
};
export const ISSUE_ORDER = ['wrong_size', 'wrong_group', 'over_stock', 'not_in_shopify', 'blank', 'no_seller_sku', 'duplicate', 'check_group', 'other_system', 'not_in_shopify_zero', 'shopify_inactive', 'under_stock'];

// Every SHEIN size → { …row, variant, issues:[…], sizeVerdict, shopifyQty }. `variants` is
// Shopify's full list (api/shopify-listings/variants).
export function checkRows(sheinRows, variants) {
  const bySku = new Map();
  for (const v of variants || []) {
    const k = String(v.sku || '').trim();
    if (k && !bySku.has(k)) bySku.set(k, v);
  }
  const seen = new Map();
  for (const r of sheinRows) if (r.sellerSku) seen.set(r.sellerSku, (seen.get(r.sellerSku) || 0) + 1);
  return sheinRows.map((r) => {
    const issues = [];
    if (!r.sellerSku) {
      issues.push('no_seller_sku');
      if (!r.size) issues.push('blank');
      return { ...r, variant: null, issues, sizeVerdict: r.size ? null : 'blank', shopifyQty: null };
    }
    if (seen.get(r.sellerSku) > 1) issues.push('duplicate');
    const v = bySku.get(r.sellerSku);
    if (!v) {
      issues.push(r.qty > 0 ? 'not_in_shopify' : 'not_in_shopify_zero');
      if (!r.size) issues.push('blank');
      return { ...r, variant: null, issues, sizeVerdict: r.size ? null : 'blank', shopifyQty: null };
    }
    const sizeVerdict = compareSize(r.size, v.size);
    if (sizeVerdict !== 'ok' && sizeVerdict !== 'ok_suffix') issues.push(sizeVerdict);
    const shopifyQty = v.qty == null ? null : Math.max(0, Number(v.qty));
    if (shopifyQty != null && r.qty > shopifyQty) issues.push('over_stock');
    else if (shopifyQty != null && r.qty < shopifyQty) issues.push('under_stock');
    if (v.status && v.status !== 'ACTIVE' && r.qty > 0) issues.push('shopify_inactive');
    return { ...r, variant: v, issues, sizeVerdict, shopifyQty };
  });
}

export function tally(checked) {
  const t = Object.fromEntries(ISSUE_ORDER.map((k) => [k, 0]));
  let clean = 0;
  for (const r of checked) {
    const real = r.issues.filter((i) => ISSUES[i].tone !== 'info');
    if (!real.length) clean++;
    for (const i of r.issues) t[i] = (t[i] || 0) + 1;
  }
  return { ...t, clean, total: checked.length };
}

// SHEIN sizes grouped per SHEIN product (SPU), worst first: a wrong size (a cancellation)
// outranks an oversell, which outranks a dead SKU still offering pairs.
const WEIGHT = { wrong_size: 100, wrong_group: 100, over_stock: 50, not_in_shopify: 30, blank: 20, no_seller_sku: 20 };
export function groupByProduct(checked) {
  const by = new Map();
  for (const r of checked) {
    const k = r.spu || r.name || r.sellerSku;
    let g = by.get(k);
    if (!g) { g = { key: k, name: r.name, image: r.image, link: r.link, brand: r.brand, spu: r.spu, rows: [] }; by.set(k, g); }
    g.rows.push(r);
  }
  const score = (g) => g.rows.reduce((n, r) => n + r.issues.reduce((m, i) => m + (WEIGHT[i] ?? (ISSUES[i].tone === 'warn' ? 1 : 0)), 0), 0);
  return [...by.values()].map((g) => ({ ...g, score: score(g) })).sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
}

const BOM = '﻿';
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// The fix list: every SHEIN size with at least one finding (info-only rows left out).
export function issuesCsv(checked) {
  const head = ['Issue', 'Seller SKU', 'Product (SHEIN)', 'SHEIN size', 'Shopify size', 'SHEIN stock', 'Shopify stock', 'Shopify product',
    'Shopify status', 'SPU', 'SKC', 'SHEIN SKU', 'SHEIN link', 'Export row'];
  const rows = checked.filter((r) => r.issues.some((i) => ISSUES[i].tone !== 'info'))
    .map((r) => [r.issues.filter((i) => ISSUES[i].tone !== 'info').map((i) => ISSUES[i].label).join('; '), r.sellerSku, r.name, r.size,
      r.variant?.size ?? '', r.qty, r.shopifyQty ?? '', r.variant?.productTitle ?? '', r.variant?.status ?? '', r.spu, r.skc, r.sheinSku, r.link, r.line]);
  return BOM + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// "Export Products_2026-10-09 13_36_02.xlsx" → "2026-10-09" (how old the export is matters
// for the stock columns; sizes don't age).
export function exportDate(name) {
  const m = String(name || '').match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
