// SHEIN listing fix — the pure half (docs/context/shein-fix.md). Built on the check
// (sheinCheck.js): for every SHEIN size, decide the stock SHEIN should show and what (if
// anything) a person must change on SHEIN. The RULES are hard-coded here, from the 10/13
// investigation of 4seller's mistakes; the AI only suggests links for SKUs Shopify no longer
// has, and every suggestion is re-checked by these rules before it counts.
//
// What 4seller did (10/9 export vs Shopify, 10/13):
//   · a Shopify size SHEIN's size list didn't have was pushed onto the nearest SHEIN size
//     (Shopify 4 / 4.5 / 5 → SHEIN US7 / 7.5 / 8; 5W → US7W; 15.5W → US15W) — 49 of 58;
//   · sizes swapped inside one product (SHEIN US8 → the SKU of Shopify 9, while the SKU of
//     Shopify 8 sits on SHEIN US7) — 9 of 58;
//   · SHEIN stock left above Shopify's, and SHEIN sales never taken off Shopify.
//
// THE rule that matters: a SHEIN order arrives with the SELLER SKU, and the warehouse picks
// that SKU. So a SHEIN size whose seller SKU is a different Shopify size must sell NOTHING
// until its seller SKU is corrected — fixing the number alone would ship the wrong shoe.
import { zipSync } from 'fflate';
import { readSheetRows, openWorkbook, readSheet } from './sheinReprice.js';
import { buildXlsx } from './xlsx.js';
import { compareSize, parseSize } from './sheinCheck.js';
import { styleFromTitle } from './ebayReprice.js';

const sizeMatches = (sheinSize, shopifySize) => ['ok', 'ok_suffix', 'check_group'].includes(compareSize(sheinSize, shopifySize));

/* ------------------------------ SHEIN orders ------------------------------ */

// Order statuses where the pair is SOLD on SHEIN but hasn't left yet — those pairs are
// spoken for, so SHEIN must not offer them again (Shopify doesn't know about them).
const DONE = /delivered|shipped|refund|cancel|return|closed|complete|rejected/i;
export function readSheinOrders(bytes) {
  const book = readSheetRows(bytes, '0') || readSheetRows(bytes, 'Sheet1') || readSheetRows(bytes, 'sheet1');
  if (!book) return { ok: false, error: 'Not SHEIN’s order export (.xlsx).' };
  // The header is the row that has "Seller SKU" (row 2 in SHEIN's export — row 1 groups).
  const hr = book.findIndex((r) => (r || []).some((c) => String(c ?? '').trim() === 'Seller SKU'));
  if (hr < 0) return { ok: false, error: 'No “Seller SKU” column — use SHEIN’s Export Order file.' };
  const h = book[hr].map((c) => String(c ?? '').trim());
  const at = (n) => h.indexOf(n);
  const iSku = at('Seller SKU'); const iStatus = at('Order Status') >= 0 ? at('Order Status') : at('Product Status');
  const iNo = at('Order Number'); const iQty = at('Number of items sold'); const iSpec = at('Specification');
  const rows = [];
  for (const r of book.slice(hr + 1)) {
    if (!r || !String(r[iSku] ?? '').trim()) continue;
    const qty = Number(r[iQty]);
    rows.push({ order: String(r[iNo] ?? ''), sellerSku: String(r[iSku]).trim(), status: String(r[iStatus] ?? '').trim(),
      spec: String(r[iSpec] ?? ''), qty: Number.isFinite(qty) && qty > 0 ? qty : 1 });
  }
  const open = rows.filter((r) => r.status && !DONE.test(r.status));
  const bySku = {};
  for (const r of open) bySku[r.sellerSku] = (bySku[r.sellerSku] || 0) + r.qty;
  return { ok: true, rows, open, bySku };
}

/* ------------------------------- relinking ------------------------------- */

// A SHEIN size whose seller SKU Shopify no longer has: find the Shopify variant it SHOULD
// point at — same style code (read from the SHEIN product name) and the same size. Only a
// single, exact answer counts; anything else goes to the AI helper (or stays unresolved).
export function ruleRelink(row, variants) {
  const style = styleFromTitle(row.name);
  if (!style || !row.size) return null;
  const want = style.toUpperCase();
  const hits = variants.filter((v) => String(v.style || '').toUpperCase() === want && sizeMatches(row.size, v.size));
  const active = hits.filter((v) => !v.status || v.status === 'ACTIVE');
  const pick = active.length === 1 ? active[0] : hits.length === 1 ? hits[0] : null;
  return pick ? { sku: pick.sku, size: pick.size, productTitle: pick.productTitle, by: 'rule', why: `same style ${want}, same size` } : null;
}

// Shopify products worth showing the AI for one SHEIN product: share the most words with
// the SHEIN name (style codes count triple). Top `n`.
export function candidatesFor(name, variants, n = 6) {
  const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9.\- ]/g, ' ').split(/\s+/).filter((w) => w.length > 1));
  const target = words(name);
  const style = (styleFromTitle(name) || '').toLowerCase();
  const byProduct = new Map();
  for (const v of variants) {
    let p = byProduct.get(v.productId);
    if (!p) { p = { productId: v.productId, title: v.productTitle, status: v.status, style: v.style, variants: [] }; byProduct.set(v.productId, p); }
    p.variants.push({ sku: v.sku, size: v.size, qty: v.qty });
  }
  const scored = [...byProduct.values()].map((p) => {
    const w = words(p.title);
    let s = 0;
    for (const t of target) if (w.has(t)) s += 1;
    if (style && String(p.style || '').toLowerCase() === style) s += 3;
    return { ...p, score: s };
  }).filter((p) => p.score >= 2).sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

// An AI suggestion becomes a link only if the rules agree: the variant exists, belongs to
// the suggested product, and is the same size as the SHEIN size.
export function verifyAiLink(row, suggestion, variants) {
  if (!suggestion?.shopifySku) return null;
  const v = variants.find((x) => String(x.sku) === String(suggestion.shopifySku));
  if (!v || (suggestion.productId && v.productId !== suggestion.productId)) return null;
  if (!sizeMatches(row.size, v.size)) return null;
  return { sku: v.sku, size: v.size, productTitle: v.productTitle, by: 'ai', why: suggestion.reason || 'AI match, size verified' };
}

/* -------------------------------- the fix -------------------------------- */

// The decision for every SHEIN size (`checked` = checkRows output):
//   { newQty, change, reason, action, linkTo }
//   reason: ok | wrong_size | swap | no_shopify | duplicate | inactive | no_size | other_system | no_seller_sku
// `openBySku` = SHEIN orders not yet shipped, per seller SKU (held back from the stock).
// `aiLinks` = { [line]: verified link } from the AI helper.
export const REASONS = {
  ok: 'Shopify stock (minus SHEIN orders not shipped yet)',
  swap: 'Linked to another size — the right Shopify SKU exists: change the seller SKU',
  wrong_size: 'Linked to another size — Shopify has no such size: stop selling it',
  no_shopify: 'Seller SKU not in Shopify — stop selling it',
  duplicate: 'Same seller SKU on another SHEIN size — only one may sell',
  inactive: 'Shopify product is draft / archived',
  no_size: 'No size on SHEIN',
  other_system: 'EUR / CN / range size — can’t be matched to Shopify',
  no_seller_sku: 'No seller SKU on SHEIN',
  pending_change: 'Matched by a person — sells once SHEIN shows the new seller SKU',
  delist: 'A person decided: stop selling this size',
};
// `decisions` = { [SHEIN SKU]: shein_links row } — what a person confirmed on the match screen.
export function buildFix(checked, variants, { openBySku = {}, aiLinks = {}, decisions = {} } = {}) {
  const bySku = new Map(variants.map((v) => [String(v.sku), v]));
  const byProduct = new Map();
  for (const v of variants) { const a = byProduct.get(v.productId) || []; a.push(v); byProduct.set(v.productId, a); }
  const firstOf = new Map();
  // Swaps first: which seller SKU belongs on which SHEIN size, so the row losing it can say where it goes.
  const movedTo = new Map();
  for (const r of checked) {
    if (!r.variant || !r.size || !r.issues.some((i) => ['wrong_size', 'wrong_group'].includes(i))) continue;
    const sib = (byProduct.get(r.variant.productId) || []).find((v) => v.sku !== r.sellerSku && sizeMatches(r.size, v.size));
    if (sib) movedTo.set(sib.sku, r.size);
  }
  const rows = checked.map((r) => {
    const cur = Number(r.qty || 0);
    const done = (newQty, reason, action = '', linkTo = null) => ({ ...r, newQty, change: newQty !== cur, reason, action, linkTo });
    // A person's decision comes first.
    const d = r.sheinSku ? decisions[r.sheinSku] : null;
    let applied = false;
    if (d?.decision === 'delist') return done(0, 'delist', `Delist this size on SHEIN${d.decided_by ? ` (decided by ${d.decided_by})` : ''}`);
    if (d?.link_sku && d.link_sku !== r.sellerSku) {
      const v = bySku.get(String(d.link_sku));
      return done(0, 'pending_change', `Change the seller SKU to ${d.link_sku}${v ? ` (Shopify size ${v.size})` : ''} — confirmed${d.decided_by ? ` by ${d.decided_by}` : ''}; sells once SHEIN shows it`,
        { sku: d.link_sku, size: v?.size ?? '', productTitle: v?.productTitle, by: 'person', confirmed: true });
    }
    if (d?.link_sku && d.link_sku === r.sellerSku) applied = true;   // SHEIN now carries the confirmed SKU
    if (!r.sellerSku) return done(0, 'no_seller_sku', 'Add the seller SKU on SHEIN (or delist this size)');
    if (r.issues.includes('duplicate')) {
      if (firstOf.has(r.sellerSku)) return done(0, 'duplicate', `Seller SKU ${r.sellerSku} is also on SHEIN row ${firstOf.get(r.sellerSku)} — remove it from this size`);
      firstOf.set(r.sellerSku, r.line);
    }
    if (!r.variant) {
      const link = ruleRelink(r, variants) || aiLinks[r.line] || null;
      return done(0, 'no_shopify', link
        ? `Change the seller SKU to ${link.sku} (Shopify size ${link.size}${link.by === 'ai' ? ', AI match — size verified' : ''}) — it sells again on the next fix`
        : 'Delist this size on SHEIN, or link it to the right Shopify SKU', link);
    }
    // A size SHEIN writes in EUR/CN (or not at all) can't be checked by the rules; a person who
    // matched it to this exact SKU — and SHEIN now carries that SKU — has checked it.
    const sizeIssue = r.issues.find((i) => ['wrong_size', 'wrong_group'].includes(i) || (!applied && ['blank', 'other_system'].includes(i)));
    if (sizeIssue) {
      const sib = (byProduct.get(r.variant.productId) || []).find((v) => v.sku !== r.sellerSku && r.size && sizeMatches(r.size, v.size));
      if (sib) return done(0, 'swap', `Change the seller SKU to ${sib.sku} (that is Shopify size ${sib.size}) — it sells again on the next fix`, { sku: sib.sku, size: sib.size, by: 'rule', productTitle: sib.productTitle });
      if (sizeIssue === 'blank') return done(0, 'no_size', `Give this SHEIN size ${addLabel(r.variant.size)} (Shopify’s size for ${r.sellerSku})`);
      if (sizeIssue === 'other_system') return done(0, 'other_system', `Make this size ${addLabel(r.variant.size)} on SHEIN (Shopify’s size for ${r.sellerSku})`);
      return done(0, 'wrong_size', `SHEIN ${r.size} ≠ Shopify ${r.variant.size}. Remove seller SKU ${r.sellerSku} from this size; ${movedTo.has(r.sellerSku)
        ? `it moves to SHEIN ${movedTo.get(r.sellerSku)} (see that row)`
        : `add size ${addLabel(r.variant.size)} to the listing for it`}`);
    }
    if (r.variant.status && r.variant.status !== 'ACTIVE') return done(0, 'inactive', 'Shopify product is not active — relist it there or delist on SHEIN');
    const want = Math.max(0, Number(r.shopifyQty || 0) - Number(openBySku[r.sellerSku] || 0));
    return done(want, 'ok');
  });
  return { rows, sizesToAdd: sizesToAdd(rows, byProduct), summary: summarizeFix(rows) };
}

// Shopify sizes with stock that no SHEIN size sells correctly — the sizes to ADD on SHEIN
// (custom size values when SHEIN's list hasn't got them: 4, 4.5, 15.5W…).
function sizesToAdd(rows, byProduct) {
  const productsOnShein = new Map();
  for (const r of rows) if (r.variant) productsOnShein.set(r.variant.productId, r);
  const sold = new Set(rows.filter((r) => r.reason === 'ok').map((r) => r.sellerSku));
  const out = [];
  for (const [pid, sample] of productsOnShein) {
    for (const v of byProduct.get(pid) || []) {
      if (sold.has(v.sku) || !(Number(v.qty) > 0)) continue;
      const pendingSwap = rows.some((r) => r.linkTo?.sku === v.sku);
      out.push({ spu: sample.spu, sheinName: sample.name, productTitle: v.productTitle, sku: v.sku, size: v.size, qty: Number(v.qty),
        note: pendingSwap ? 'fixed by the seller-SKU change above' : `add size ${addLabel(v.size)} on SHEIN`, pendingSwap });
    }
  }
  return out.sort((a, b) => String(a.sheinName).localeCompare(String(b.sheinName)) || String(a.size).localeCompare(String(b.size), 'en', { numeric: true }));
}
// How a Shopify size should be written on SHEIN: "US" + number + the marker it needs.
export function addLabel(shopifySize) {
  const p = parseSize(shopifySize);
  if (p.system !== 'US') return String(shopifySize);
  const mark = p.group === 'women' ? 'W' : p.group === 'youth' ? 'Y' : p.group === 'child' ? 'C' : '';
  return `US${p.n}${mark}`;
}

export function summarizeFix(rows) {
  const s = { sizes: rows.length, changed: 0, toZero: 0, pairsBefore: 0, pairsAfter: 0, byReason: {}, links: 0, linksAi: 0, unresolved: 0 };
  for (const r of rows) {
    s.pairsBefore += Number(r.qty || 0); s.pairsAfter += r.newQty;
    if (r.change) s.changed++;
    if (r.change && r.newQty === 0) s.toZero++;
    s.byReason[r.reason] = (s.byReason[r.reason] || 0) + 1;
    if (r.linkTo) { s.links++; if (r.linkTo.by === 'ai') s.linksAi++; }
    if (r.reason === 'no_shopify' && !r.linkTo && Number(r.qty) > 0) s.unresolved++;
  }
  return s;
}

/* ------------------------------- outputs ------------------------------- */

const BOM = '﻿';
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (head, rows) => BOM + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

// Every SHEIN size a person must touch on SHEIN, plus the sizes to add.
export function fixListCsv(fix) {
  const head = ['What to do', 'Why', 'SHEIN product', 'SPU', 'SKC', 'SHEIN SKU', 'SHEIN size', 'Seller SKU now', 'Shopify size of that SKU',
    'Change seller SKU to', 'Stock now', 'Stock after fix', 'Export row'];
  const rows = fix.rows.filter((r) => r.action).map((r) => [r.action, REASONS[r.reason], r.name, r.spu, r.skc, r.sheinSku, r.size, r.sellerSku,
    r.variant?.size ?? '', r.linkTo?.sku ?? '', r.qty, r.newQty, r.line]);
  for (const a of fix.sizesToAdd.filter((x) => !x.pendingSwap)) {
    rows.push([`Add size ${addLabel(a.size)} on SHEIN for seller SKU ${a.sku}`, `Shopify has ${a.qty} in size ${a.size}; no SHEIN size sells it`, a.sheinName, a.spu, '', '', '', a.sku, a.size, '', '', a.qty, '']);
  }
  return csv(head, rows);
}

// The stock changes as a plain sheet (when SHEIN's own template isn't loaded).
export function stockRows(fix) {
  return fix.rows.filter((r) => r.change && r.sheinSku).map((r) => ({
    sheinSku: r.sheinSku, sellerSku: r.sellerSku, size: r.size, warehouse: r.warehouse || '', before: r.qty, after: r.newQty, why: REASONS[r.reason],
  }));
}

/* ------------------------- SHEIN's inventory template ------------------------- */
// SHEIN Seller Center → Products → batch edit inventory → download template. We don't ship
// one (none on hand yet), so the person loads theirs and it is filled the way SHEIN Reprice
// fills Edit+Price: the sheet whose header row has "SKU" and an inventory column, rows
// below SHEIN's guide/example rows replaced with ours, every other part of the file untouched.
const td = new TextDecoder();
const te = new TextEncoder();
const escXml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => { let n = i + 1; let out = ''; while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); } return out; };

export function readInventoryTemplate(bytes) {
  const book = openWorkbook(bytes);
  if (!book) return { ok: false, error: 'Not an Excel file (.xlsx) — use SHEIN’s inventory template.' };
  for (const sh of book.sheets) {
    const grid = readSheet(book, sh.name);
    if (!grid) continue;
    const head = (grid[0] || []).map((h) => String(h ?? '').trim());
    const sku = head.findIndex((h) => /^(SHEIN\s*)?SKU(\s*code)?$/i.test(h));
    const qty = head.findIndex((h) => /inventory|stock|quantity/i.test(h));
    if (sku < 0 || qty < 0) continue;
    const wh = head.findIndex((h) => /warehouse/i.test(h));
    let start = 1;
    for (let r = 1; r < Math.min(grid.length, 6); r++) {
      const first = String((grid[r] || [])[0] ?? '').trim();
      if (/guide|example|fill in|instruction|填写|示例|说明/i.test(first)) start = r + 1;
    }
    return { ok: true, bytes: new Uint8Array(bytes), sheet: sh.name, cols: { sku, qty, wh }, headers: head, start };
  }
  return { ok: false, error: 'No sheet with a “SKU” column and an inventory/stock column — is this SHEIN’s inventory template?' };
}

export function fillInventoryTemplate(tpl, changes) {
  const book = openWorkbook(tpl.bytes);
  const sheet = book.sheets.find((s) => s.name === tpl.sheet);
  let xml = td.decode(book.files[sheet.path]);
  const first = tpl.start + 1;   // 1-based row of the first data row
  xml = xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>\s*/g, (m, r) => (Number(r) >= first ? '' : m));
  const cell = (c, r, v) => (v === '' || v == null ? '' : `<c r="${colName(c)}${r}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`);
  const cells = (r, ch) => [[tpl.cols.sku, ch.sheinSku], [tpl.cols.qty, String(ch.after)], ...(tpl.cols.wh >= 0 ? [[tpl.cols.wh, ch.warehouse]] : [])]
    .sort((a, b) => a[0] - b[0]).map(([c, v]) => cell(c, r, v)).join('');
  const rowsXml = changes.map((ch, i) => `<row r="${first + i}">${cells(first + i, ch)}</row>\n`).join('');
  xml = xml.includes('<sheetData/>') ? xml.replace('<sheetData/>', `<sheetData>${rowsXml}</sheetData>`) : xml.replace(/<\/sheetData>/, `${rowsXml}</sheetData>`);
  const lastCol = colName(Math.max(tpl.cols.sku, tpl.cols.qty, tpl.cols.wh, tpl.headers.length - 1));
  xml = xml.replace(/<dimension ref="[^"]*"\s*\/>/, `<dimension ref="A1:${lastCol}${Math.max(first - 1, first - 1 + changes.length)}"/>`);
  return zipSync({ ...book.files, [sheet.path]: te.encode(xml) }, { level: 6 });
}

// Read the filled file back: same rows, same numbers, nothing else touched.
export function verifyInventoryFile(tpl, outBytes, changes) {
  const a = openWorkbook(tpl.bytes); const b = openWorkbook(outBytes);
  if (!b) return { ok: false, detail: 'the file does not open' };
  const path = a.sheets.find((s) => s.name === tpl.sheet).path;
  const same = (x, y) => x && y && x.length === y.length && x.every((v, i) => v === y[i]);
  const changed = Object.keys(a.files).filter((k) => k !== path && !same(a.files[k], b.files[k]));
  if (changed.length) return { ok: false, detail: `other parts changed: ${changed.join(', ')}` };
  const grid = readSheet(b, tpl.sheet);
  const top = readSheet(a, tpl.sheet).slice(0, tpl.start);
  if (JSON.stringify(top) !== JSON.stringify(grid.slice(0, tpl.start))) return { ok: false, detail: 'SHEIN’s header / guide rows changed' };
  const data = grid.slice(tpl.start).filter((r) => r && r.some((v) => String(v ?? '').trim()));
  if (data.length !== changes.length) return { ok: false, detail: `${data.length} rows written, ${changes.length} expected` };
  const bad = data.filter((r, i) => String(r[tpl.cols.sku]) !== String(changes[i].sheinSku) || String(r[tpl.cols.qty]) !== String(changes[i].after));
  return bad.length ? { ok: false, detail: `${bad.length} rows don’t match` } : { ok: true, detail: `${data.length} SKUs, every number checked` };
}

// No template loaded: the same changes as a plain sheet, one row per SHEIN SKU.
export function plainInventoryXlsx(changes) {
  return buildXlsx({ sheetName: 'Inventory fix', columns: [
    { label: 'SHEIN SKU' }, { label: 'Seller SKU' }, { label: 'SHEIN size' }, { label: 'Warehouse ID' },
    { label: 'Inventory now', type: 'int' }, { label: 'New inventory', type: 'int' }, { label: 'Why', maxWidth: 70 },
  ], rows: changes.map((c) => [c.sheinSku, c.sellerSku, c.size, c.warehouse, c.before, c.after, c.why]) });
}
