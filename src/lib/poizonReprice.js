// POIZON Reprice — PURE helpers (docs/context/poizon-reprice.md). Same job as eBay, SHEIN
// and Temu Reprice: cut every POIZON listing priced above today's market + markup down to
// it, never up. POIZON works in .xlsx both ways:
//   in   Seller Dashboard → Listing → Smart Listing → Export All ("Export Smart Listing….xlsx")
//        + the store inventory report CSV (its SKU is the export's Barcode → Style ID)
//   out  POIZON's own "Price & Inventory Template": sheet "Template" filled from row 3 —
//        A SPU ID · B SKU ID · C Expected Price (Tax-Exclusive) · G Discount 0 · I left blank.
//        Uploaded by hand: Batch Import → Import Updated Price & Inventory.
// The spec is POIZON's own walkthrough (their account manager, 2026-11-20) + the owner's
// "same as we did for eBay, SHEIN and Temu".
import { zipSync } from 'fflate';
import { openWorkbook, readSheet, priceCents } from './sheinReprice.js';
import { styleFromTitle, cacheKey } from './ebayReprice.js';

const td = new TextDecoder();
const te = new TextEncoder();
const escXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export const SHEET = 'Template';
export const FIRST_ROW = 3;                 // row 1 = Required / Choose one, row 2 = the column names
// Price Update Method (column I) is left BLANK. POIZON's Data Definition tab: with no method
// set, the default is manual. Both spellings we tried were refused on every row ("Manual update",
// then "Update Manually", 2026-11-26); the owner's import with the column blank went through.
// Listings POIZON has not matched to its own catalogue yet: there is nothing to price.
export const NOT_ON_POIZON = new Set(['Unmatched', 'Matching in Progress']);
export const SOLD_OUT = 'Sold Out';

/* ------------------------------- the export -------------------------------- */

// Columns found BY HEADER NAME (the export has 48 and POIZON may reorder them).
const COLS = {
  spu: 'Seller SPU ID', sku: 'Seller SKU ID', status: 'Status', why: 'Reason for Unready to List',
  article: 'Article Number/Style ID', size: 'Size', currency: 'Currency',
  price: 'Expected Price (Tax-Exclusive)', name: 'Item Name', barcode: 'Barcode', method: 'Price Update Method',
};
const NEEDED = ['spu', 'sku', 'size', 'price', 'barcode'];

// "10" / "6.5W" / "5.5Y" / "10C" → "10" / "6.5" / "5.5" / "10". The letter is dropped: the
// style code already says which catalogue (women's, GS, TD) the size belongs to. Clothing
// sizes (S, XL, 2XL) and anything else are NOT guessed at — skipped and named.
export function poizonSize(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2}(?:\.5)?)\s*[WYC]?$/i);
  return m ? String(Number(m[1])) : '';
}

// The export's own style column is typed by hand upstream: mostly "HM6803-019", but also
// "AR3565-101 24", "IX1852-100-", "im6366-605" and now and then the store blurb. One clean
// code (tidied) or nothing.
export function articleCode(raw) {
  // "865031-009 24" — a two-digit year tacked on after the code — is still that code.
  const t = String(raw ?? '').trim().replace(/\s+\d{2}$/, '').replace(/-+$/, '');
  return /\d/.test(t) && t.length >= 4 && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t) && !/--/.test(t) ? t.toUpperCase() : '';
}

// "Listing price exceeds the limit. Set it to $171.00 or below." → 17100; else null.
export function limitCents(reason) {
  const m = String(reason ?? '').match(/Set it to \$([\d,]+(?:\.\d{1,2})?) or below/i);
  return m ? priceCents(m[1].replace(/,/g, '')) : null;
}

export function readExportFile(bytes) {
  const book = openWorkbook(bytes);
  if (!book) return { ok: false, error: 'Not an Excel file (.xlsx) — use POIZON’s Smart Listing “Export All” download.' };
  let grid = null; let at = null;
  for (const s of book.sheets) {
    const g = readSheet(book, s.name);
    const head = (g?.[0] || []).map((h) => String(h ?? '').replace(/\s+/g, ' ').trim());
    const found = Object.fromEntries(Object.entries(COLS).map(([k, name]) => [k, head.indexOf(name)]).filter(([, i]) => i >= 0));
    if (found.sku != null) { grid = g; at = found; break; }
  }
  if (!grid) return { ok: false, error: 'No “Seller SKU ID” column — is this the Smart Listing export (Listing → Smart Listing → Export All)?' };
  const missing = NEEDED.filter((k) => at[k] == null);
  if (missing.length) return { ok: false, error: `Missing column${missing.length === 1 ? '' : 's'}: ${missing.map((k) => COLS[k]).join(', ')}.` };
  const cell = (g, k) => (at[k] == null ? '' : String(g[at[k]] ?? '').trim());
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const g = grid[r];
    if (!g || !cell(g, 'sku')) continue;
    const sizeRaw = cell(g, 'size');
    rows.push({
      line: r + 1, spu: cell(g, 'spu'), sku: cell(g, 'sku'), status: cell(g, 'status'), why: cell(g, 'why').replace(/\s+/g, ' '),
      article: cell(g, 'article'), name: cell(g, 'name'), barcode: cell(g, 'barcode'), method: cell(g, 'method'),
      currency: cell(g, 'currency') || 'USD', sizeRaw, size: poizonSize(sizeRaw),
      priceText: cell(g, 'price'), priceCents: priceCents(cell(g, 'price')), limitCents: limitCents(cell(g, 'why')),
    });
  }
  if (!rows.length) return { ok: false, error: 'No listings in the export.' };
  const count = (f) => rows.filter(f).length;
  return {
    ok: true, rows, dupes: rows.length - new Set(rows.map((x) => x.sku)).size,
    stats: {
      rows: rows.length, listed: count((x) => x.status === 'Listed'), unable: count((x) => x.status === 'Unable to List'),
      soldOut: count((x) => x.status === SOLD_OUT), notOn: count((x) => NOT_ON_POIZON.has(x.status)),
    },
  };
}

// Style ID per listing: the inventory report by Barcode (the report's SKU) → else the
// export's own style column when it is one clean code → else a code in the item name → none.
// The report wins because it is our own record; it only lists stock on hand, so sold-out
// listings come the other two ways.
export function resolveStyles(rows, inv) {
  const n = { report: 0, article: 0, name: 0, none: 0 };
  const out = rows.map((x) => {
    const direct = x.barcode && !inv.conflicts.has(x.barcode) ? inv.sku2style.get(x.barcode) : '';
    if (direct) { n.report++; return { ...x, style: direct, styleFrom: 'inventory report' }; }
    const a = articleCode(x.article);
    if (a) { n.article++; return { ...x, style: a, styleFrom: 'POIZON export' }; }
    const t = styleFromTitle(x.name, inv.styles);
    if (t && articleCode(t)) { n.name++; return { ...x, style: t, styleFrom: 'item name' }; }
    n.none++;
    return { ...x, style: '', styleFrom: '' };
  });
  return { rows: out, n };
}

// Why a listing is not priced, or '' when it can be.
export function skipReason(x, { soldOut = true } = {}) {
  if (NOT_ON_POIZON.has(x.status)) return `Not on POIZON yet (${x.status})`;
  if (!soldOut && x.status === SOLD_OUT) return 'Sold out — left out by your choice';
  if (!x.spu) return 'No SPU ID';
  if (x.currency !== 'USD') return `Currency is ${x.currency}, not USD`;
  if (!x.sizeRaw) return 'No size';
  if (!x.size) return `Size "${x.sizeRaw}" is not a shoe size`;
  if (!x.style) return 'No style code (not in the inventory report, the export or the item name)';
  if (x.priceCents == null) return `No current price ("${x.priceText}")`;
  return '';
}

const codesOf = (style) => String(style || '').split('/').map((p) => p.trim()).filter(Boolean);

// Every (style, size) to price — the same jobs eBay / SHEIN / Temu Reprice send, so the
// four pages share one day's cache.
export function jobsFor(rows, opts) {
  const seen = new Map();
  for (const x of rows) {
    if (skipReason(x, opts)) continue;
    for (const code of codesOf(x.style)) seen.set(cacheKey(code, x.size), { sku: code, size: x.size });
  }
  return [...seen.values()];
}

/* ------------------------------- the markup -------------------------------- */

// ALWAYS rounded UP to a whole dollar, in integers (POIZON's own prices are whole dollars).
// 100 @ 15 % → 115; 104.35 @ 15 % → 121 (120.0025).
export function poizonRepriceDollars(marketCents, pctH) {
  const p = BigInt(marketCents) * BigInt(10000 + pctH);   // dollars × 1,000,000
  return Number((p + 999999n) / 1000000n);
}

// Cut every priced listing above market + markup down to it — never up. Returns the rows
// for the upload (only the cuts) and a report row for EVERY listing in the export.
export function applyReprice(rows, cache, pctH, opts) {
  const n = { lower: 0, higher: 0, equal: 0, nodata: 0, skipped: 0, overLimit: 0, toManual: 0, reductionCents: 0 };
  const upload = [];
  const report = [];
  for (const x of rows) {
    const base = { spu: x.spu, sku: x.sku, barcode: x.barcode, style: x.style, styleFrom: x.styleFrom, sizeRaw: x.sizeRaw, size: x.size,
      status: x.status, method: x.method, old: x.priceText, market: '', reprice: '' };
    const why = skipReason(x, opts);
    if (why) { n.skipped++; report.push({ ...base, action: 'skipped', note: why }); continue; }
    const answers = codesOf(x.style).map((c) => cache[cacheKey(c, x.size)]);
    const ok = answers.filter((a) => a?.status === 'ok' && a.valueCents > 0);
    if (!ok.length) {
      n.nodata++;
      const s = answers.find(Boolean)?.status;
      report.push({ ...base, action: 'unchanged', note: s === 'not_listed' ? 'Not on Alias' : s === 'bad_size' ? 'Size not in the Alias catalogue' : 'No market price today' });
      continue;
    }
    const market = Math.min(...ok.map((a) => a.valueCents));
    const dollars = poizonRepriceDollars(market, pctH);
    const cents = dollars * 100;
    const row = { ...base, market: (market / 100).toFixed(2), reprice: String(dollars) };
    if (cents >= x.priceCents) {
      if (cents === x.priceCents) n.equal++; else n.higher++;
      report.push({ ...row, action: 'kept', note: cents === x.priceCents ? 'Already at market + markup' : 'Market + markup is higher — never raised' });
      continue;
    }
    n.lower++;
    n.reductionCents += x.priceCents - cents;
    const notes = [];
    // POIZON names its own ceiling on some listings; a cut that still sits above it will not list.
    if (x.limitCents != null && cents > x.limitCents) { n.overLimit++; notes.push(`Still above POIZON’s limit of $${(x.limitCents / 100).toFixed(2)} — it may stay unlisted`); }
    if (!/manual/i.test(x.method)) { n.toManual++; notes.push('Price update method becomes manual (POIZON’s default when the column is blank)'); }
    upload.push({ spu: x.spu, sku: x.sku, price: String(dollars) });
    report.push({ ...row, action: 'lowered', note: notes.join(' · ') });
  }
  return { upload, report, n };
}

/* ------------------------------ the template ------------------------------- */

const WANT = ['SPU ID', 'SKU ID', 'Expected Price (Tax-Exclusive)', 'Expected Price (Tax-Inclusive)', 'Retail Price (Tax-Exclusive)',
  'Retail Price (Tax-Inclusive)', 'Discount', 'Inventory', 'Price Update Method'];

// The template's own check: a "Template" sheet whose row 2 is the nine columns, in order.
export function readTemplateFile(bytes) {
  const book = openWorkbook(bytes);
  if (!book) return { ok: false, error: 'Not an Excel file (.xlsx) — use POIZON’s Price & Inventory Template.' };
  const grid = readSheet(book, SHEET);
  if (!grid) return { ok: false, error: `No "${SHEET}" sheet — this file has: ${book.sheets.map((s) => s.name).join(', ')}. Is it the Price & Inventory Template?` };
  const head = WANT.map((_, i) => String(grid[1]?.[i] ?? '').trim());
  if (WANT.some((w, i) => head[i] !== w)) return { ok: false, error: `Row 2 of ${SHEET} should read ${WANT.join(' · ')} — it reads ${head.filter(Boolean).join(' · ') || '(blank)'}.` };
  const extra = grid.slice(FIRST_ROW - 1).filter((r) => r && r.some((v) => String(v ?? '').trim())).length;
  return { ok: true, bytes: new Uint8Array(bytes), extra };
}

// The filled template: every entry of the zip byte-for-byte as it came EXCEPT the Template
// sheet, where rows from 3 down are ours. IDs go in as text (as they are in the export — a
// 14-digit number must never turn into 4.97E+13), the price as a number (what typing it in
// Excel makes). D–F, H and I (the other three prices, Inventory, Price Update Method) stay
// blank: a blank Inventory leaves stock alone, a blank method is POIZON's manual default.
// G (Discount) is always 0: the template's Data Definition calls it Required ("0 when there
// is no discount"), and POIZON refused a whole import with it blank — "Invalid discount" on
// every row (2026-11-26).
export function fillTemplate(templateBytes, upload) {
  const book = openWorkbook(templateBytes);
  const sheet = book.sheets.find((s) => s.name.trim().toLowerCase() === SHEET.toLowerCase());
  let xml = td.decode(book.files[sheet.path]);
  xml = xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)\s*/g, (m, r) => (Number(r) >= FIRST_ROW ? '' : m));
  const text = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;
  const num = (ref, v) => `<c r="${ref}"><v>${escXml(v)}</v></c>`;
  const rowsXml = upload.map((u, i) => {
    const r = FIRST_ROW + i;
    return `<row r="${r}">${text(`A${r}`, u.spu)}${text(`B${r}`, u.sku)}${num(`C${r}`, u.price)}${num(`G${r}`, '0')}</row>`;
  }).join('');
  xml = xml.replace(/<\/sheetData>/, `${rowsXml}</sheetData>`);
  xml = xml.replace(/<dimension ref="[^"]*"\s*\/>/, `<dimension ref="A1:I${FIRST_ROW - 1 + upload.length}"/>`);
  return zipSync({ ...book.files, [sheet.path]: te.encode(xml) }, { level: 6 });
}

// Read the built file back and check it is what we meant to send — the download stays
// locked unless every check passes.
export function verifyOutput(templateBytes, outBytes, upload, exportRows) {
  const tpl = openWorkbook(templateBytes);
  const out = openWorkbook(outBytes);
  if (!out) return { ok: false, checks: [{ label: 'The file opens', ok: false, detail: 'not a valid .xlsx' }] };
  const checks = [];
  const sheetPath = tpl.sheets.find((s) => s.name.trim().toLowerCase() === SHEET.toLowerCase()).path;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const others = Object.keys(tpl.files).filter((k) => k !== sheetPath);
  const changed = others.filter((k) => !same(tpl.files[k], out.files[k]));
  checks.push({ label: 'Data Definition tab and the rest of POIZON’s template untouched', ok: !changed.length && Object.keys(out.files).length === Object.keys(tpl.files).length,
    detail: changed.length ? `changed: ${changed.join(', ')}` : `${others.length} parts identical` });
  const a = readSheet(tpl, SHEET);
  const b = readSheet(out, SHEET);
  const head = [0, 1].every((r) => JSON.stringify(a[r] || []) === JSON.stringify(b[r] || []));
  checks.push({ label: 'Rows 1–2 (the headers) as POIZON made them', ok: head, detail: head ? 'identical' : 'differ' });
  const data = b.slice(FIRST_ROW - 1).filter((r) => r && r.some((v) => String(v ?? '').trim()));
  checks.push({ label: 'One row per price cut', ok: data.length === upload.length, detail: `${data.length} rows, ${upload.length} cuts` });
  const bySku = new Map(exportRows.map((x) => [x.sku, x]));
  const seen = new Set();
  let bad = 0; const badIds = [];
  for (const r of data) {
    const v = (i) => String(r[i] ?? '').trim();
    const src = bySku.get(v(1));
    const price = priceCents(v(2));
    const fine = src && !seen.has(v(1)) && src.spu === v(0) && price != null && price > 0 && price % 100 === 0 && price < src.priceCents
      && !v(3) && !v(4) && !v(5) && v(6) === '0' && !v(7) && !v(8) && r.length <= 9;
    seen.add(v(1));
    if (!fine) { bad++; if (badIds.length < 5) badIds.push(v(1) || '(blank)'); }
  }
  checks.push({ label: `Every row: a SPU ID + SKU ID pair from the export, once · a whole-dollar price below today’s · Discount 0 · Inventory and Price Update Method blank`, ok: bad === 0,
    detail: bad ? `${bad} bad (${badIds.join(', ')})` : `${data.length} rows OK` });
  return { ok: checks.every((c) => c.ok), checks };
}

/* -------------------------------- outputs --------------------------------- */

// "Export Smart Listing20261118.xlsx" → "POIZON reprice (11.18.2026).xlsx"; else today's EST day.
export function outputName(sourceName, fallbackYmd) {
  const m = String(sourceName || '').match(/(20\d{2})-?(\d{2})-?(\d{2})/) || String(fallbackYmd || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `POIZON reprice (${Number(m[2])}.${Number(m[3])}.${m[1]}).xlsx` : 'POIZON reprice.xlsx';
}

const BOM = '﻿';
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportText(report, pctLabel) {
  const head = ['SPU ID', 'SKU ID', 'Barcode', 'Style ID', 'Style ID from', 'Size (POIZON)', 'Size', 'Status', 'Price update method', 'Current price',
    'Market price', `New price (+${pctLabel}%, rounded up)`, 'Action', 'Note'];
  // IDs as ="…" so Excel keeps all 14 digits instead of showing 4.97E+13.
  const id = (v) => (v ? `="${v}"` : '');
  const rows = report.map((r) => [id(r.spu), id(r.sku), r.barcode, r.style, r.styleFrom, r.sizeRaw, r.size, r.status, r.method, r.old, r.market, r.reprice, r.action, r.note]);
  return BOM + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
