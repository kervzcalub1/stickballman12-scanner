// Upload a supplier's spreadsheet as a PO manifest (docs/context/purchase-orders.md → "Paste a
// list" → "Upload a file"). Read in the browser into the SAME result the paste gives
// (src/lib/poPaste.js: { shoes, skipped, totals, pairs }), so the preview, "Add N pairs" and
// po/scan-bulk are the paste's own.
//
// Columns are found by their HEADER, not their position (case, spaces and punctuation
// ignored), in any of three layouts:
//   rows      SKU | Size | Qty [| Price ea | Total]      one row per SKU + size
//   per pair  SKU | Size [| Price]                        no qty column → each row is 1 pair
//   matrix    SKU | 8 | 8.5 | 9 | … [| Price]             sizes as column headers, pairs in the cells
// A title line or two above the header is fine; blank rows and a "Total" row are fine.
// Same strictness as the paste: a row it can't read is listed in `skipped` with its row
// number and why — never dropped, never guessed.
//
// A PO price is the SHELF price only ([[cost-is-shelf-plus-preset]]). If the sheet only has
// a line total, price ea = total ÷ qty and the size says so (`priceFrom: 'total'`).
import { mergeEntries, pairsOf, skuOf, clean, parsePoPaste } from './poPaste.js';

/* ------------------------------ delimited text ------------------------------ */

// One delimiter for the whole file: the one that splits the first lines most consistently.
function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  let best = ','; let bestScore = 0;
  for (const d of [',', '\t', ';', '|']) {
    const freq = new Map();
    for (const l of sample) { const n = countOutsideQuotes(l, d); if (n > 0) freq.set(n, (freq.get(n) || 0) + 1); }
    // Most rows split, and split the same way (a title line above the header doesn't).
    for (const [n, rowsLikeThis] of freq) {
      const score = rowsLikeThis * 100 + n;
      if (score > bestScore) { best = d; bestScore = score; }
    }
  }
  return best;
}
function countOutsideQuotes(line, d) {
  let n = 0; let q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
  return n;
}

// RFC 4180: "quoted, fields", "" for a quote inside, newlines inside quotes. BOM stripped.
export function parseDelimited(input, delimiter) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const d = delimiter || sniffDelimiter(text);
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') { field = ''; q = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return { rows, delimiter: d };
}

/* ---------------------------------- headers --------------------------------- */

// A header with case, spaces and punctuation gone: "Style #" → "style#", "Unit Price ($)" →
// "unitprice", "Qty." → "qty". A trailing currency word is dropped ("Price USD" → "price").
const normHeader = (h) => clean(h).toLowerCase().replace(/[^a-z0-9#]/g, '').replace(/(?:usd|\$)$/, '').replace(/^#$/, '#');

// In priority order within each role: an exact "sku" beats a looser "item".
const HEADERS = {
  sku: ['sku', 'stylecode', 'style#', 'styleno', 'stylenumber', 'stylenum', 'styleid', 'style', 'stylecolor', 'stylecolour',
    'sku#', 'skuno', 'skunumber', 'skucode', 'productcode', 'prodcode', 'productsku', 'itemcode', 'itemsku', 'itemno', 'item#',
    'itemnumber', 'articleno', 'articlenumber', 'artno', 'article', 'mpn', 'item', 'code'],
  size: ['size', 'sz', 'ussize', 'sizeus', 'usmenssize', 'usmensize', 'menssize', 'mensize', 'shoesize', 'sizeusm', 'usm', 'us'],
  qty: ['qty', 'quantity', 'pairs', 'pair', 'units', 'count', 'pcs', 'pieces', 'qtyordered', 'orderqty', 'orderedqty', 'qtyshipped',
    'shippedqty', 'totalpairs', 'totalqty', 'noofpairs', '#ofpairs', 'numberofpairs', 'qtypairs', 'pairsqty'],
  price: ['price', 'priceea', 'priceeach', 'priceperpair', 'pricepair', 'pricepp', 'unitprice', 'unitcost', 'cost', 'costea', 'costeach',
    'costperpair', 'each', 'ea', 'shelf', 'shelfprice', 'shelfpriceea', 'shelfpriceeach', 'rate', 'pp', 'buyprice', 'purchaseprice',
    'wholesale', 'wholesaleprice', 'ourprice'],
  total: ['total', 'amount', 'linetotal', 'totalprice', 'totalcost', 'totalamount', 'lineamount', 'extprice', 'extendedprice',
    'extended', 'extcost', 'extendedcost', 'subtotal', 'value', 'totalvalue'],
};
// The looser second pass (normalized header CONTAINS the word). Retail / MSRP / market are
// never the price we paid; a qty-ish "total pairs" is never the money total.
const FUZZY = {
  sku: { yes: /sku|style/ },
  size: { yes: /size/, no: /run|range|chart/ },
  qty: { yes: /qty|quantity|pairs|units|pcs/ },
  price: { yes: /price|cost/, no: /total|retail|msrp|market|resale|sell|ext/ },
  total: { yes: /total|amount|subtotal/, no: /pairs|qty|quantity|units|pcs/ },
};
const LABEL = { sku: 'SKU', size: 'Size', qty: 'Qty', price: 'Price ea', total: 'Line total' };

// "8", "8.5", "US 9", "9.5Y", "Size 10", "M 9" → the size; else null. (Header OR cell.)
export function sizeValue(v) {
  const s = clean(v).replace(/^(?:size|sz)\s*[:#]?\s*/i, '').replace(/^(?:us|men'?s|mens|m)\s*/i, '').replace(/(\d),(\d)$/, '$1.$2');
  const m = /^(\d{1,2}(?:\.\d+)?)\s*([a-z]{0,2})$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  // Shoe sizes are whole or half (xlsx can hand back "9.5000000001"); 0 and 20+ aren't sizes.
  if (!(n > 0 && n < 20) || Math.abs(n * 2 - Math.round(n * 2)) > 1e-6) return null;
  return String(Math.round(n * 2) / 2) + (m[2] ? m[2].toUpperCase() : '');
}

// "$1,234.50", "120", "120.00 USD", "USD 120" → 1234.5; blank → null; junk → NaN.
export function moneyValue(v, { decimalComma = false } = {}) {
  let s = clean(v);
  if (!s) return null;
  s = s.replace(/^(?:us\$|usd|\$)\s*/i, '').replace(/\s*(?:usd|\$)$/i, '').replace(/\s+/g, '');
  if (decimalComma && /^\d{1,3}(?:\.\d{3})*,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s)) return NaN;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 1e6 ? Math.round(n * 100) / 100 : NaN;
}

// A whole quantity ("2", "2.0" from a spreadsheet); blank → null; anything else → NaN.
function qtyValue(v) {
  const s = clean(v);
  if (!s) return null;
  if (!/^\d+(?:\.0+)?$/.test(s)) return NaN;
  return Number(s);
}

// The header row (searched in the first 15 rows) and which column is what.
function findHeader(grid) {
  let fallback = null;
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const cells = (grid[r] || []).map(normHeader);
    const col = {};
    for (const role of Object.keys(HEADERS)) {
      let best = -1; let rank = Infinity;
      cells.forEach((h, c) => {
        const k = HEADERS[role].indexOf(h);
        if (k >= 0 && k < rank && !Object.values(col).includes(c)) { best = c; rank = k; }
      });
      if (best >= 0) col[role] = best;
    }
    // Then the headers nobody spells the same way twice ("Style Code / SKU", "Size (US Men)",
    // "Qty Ordered ✅", "Price Paid"): a role still missing takes the first unclaimed header
    // that CONTAINS its word. Only one row is a header, so a title line can't claim it alone.
    for (const role of Object.keys(FUZZY)) {
      if (col[role] != null) continue;
      const c = cells.findIndex((h, i) => h && FUZZY[role].yes.test(h) && !(FUZZY[role].no?.test(h)) && !Object.values(col).includes(i));
      if (c >= 0) col[role] = c;
    }
    if (col.sku == null) continue;
    // Sizes as column headers (the matrix): only when there's no Size column.
    const sizeCols = [];
    if (col.size == null) {
      (grid[r] || []).forEach((h, c) => {
        if (Object.values(col).includes(c)) return;
        const z = sizeValue(h);
        if (z) sizeCols.push({ c, size: z });
      });
    }
    const found = { row: r, col, sizeCols: sizeCols.length >= 2 ? sizeCols : [] };
    if (col.size != null || found.sizeCols.length) return found;
    // A title line ("Style list for Kevin") or a header with no size column: keep looking for
    // a fuller header below; if there's none, this one stands (and says what's missing).
    fallback ??= found;
  }
  return fallback;
}

const rowText = (cells) => cells.map((c) => clean(c)).filter(Boolean).join(', ').slice(0, 160);
const isTotalRow = (cells) => cells.some((c) => /^(?:grand\s*)?(?:sub\s*)?total\b/i.test(clean(c)));

/* --------------------------------- the table --------------------------------- */

// grid: rows of cell strings (from a CSV, TSV or the first sheet of an .xlsx).
export function parsePoTable(grid, { decimalComma = false } = {}) {
  const rows = Array.from(grid || [], (r) => (Array.isArray(r) ? Array.from(r, (c) => (c == null ? '' : String(c))) : []));
  const empty = { shoes: [], skipped: [], totals: [], pairs: 0 };
  if (!rows.some((r) => r.some((c) => clean(c)))) return { ...empty, error: 'The file is empty.' };
  const head = findHeader(rows);
  if (!head) {
    const first = rows.find((r) => r.some((c) => clean(c))) || [];
    return { ...empty, error: `No SKU column — the header row needs a column called SKU or Style (first row read: ${rowText(first) || 'blank'}).` };
  }
  const { col, sizeCols } = head;
  const layout = col.size != null ? (col.qty != null ? 'rows' : 'per-pair') : sizeCols.length ? 'matrix' : null;
  if (!layout) return { ...empty, error: 'No Size column — name one "Size", or put the sizes across the header (8, 8.5, 9 …).' };
  const headerCells = rows[head.row];
  const headerKey = headerCells.map(normHeader).join('|');
  const columns = Object.keys(LABEL).filter((role) => col[role] != null).map((role) => ({ role: LABEL[role], header: clean(headerCells[col[role]]) }));
  if (layout === 'matrix') columns.push({ role: 'Sizes', header: sizeCols.map((s) => clean(headerCells[s.c])).join(' · ') });

  const skipped = [];
  const totals = [];
  const entries = [];
  const money = (v) => moneyValue(v, { decimalComma });
  for (let r = head.row + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.some((c) => clean(c))) continue;
    const rowNo = r + 1;
    const line = `Row ${rowNo}: ${rowText(cells)}`;
    const skip = (why) => skipped.push({ line, row: rowNo, why });
    // The header again (a multi-page export repeats it): not data, nothing lost.
    if (headerKey && cells.map(normHeader).join('|') === headerKey) continue;
    const rawSku = clean(cells[col.sku]);
    if ((!rawSku || /^(?:grand\s*)?(?:sub\s*)?total\b/i.test(rawSku)) && isTotalRow(cells)) {
      const amt = col.total != null ? money(cells[col.total]) : null;
      totals.push({ line, row: rowNo, amount: Number.isFinite(amt) ? amt : null });
      continue;
    }
    if (!rawSku) { skip('no SKU on this row'); continue; }
    const sku = skuOf(rawSku);
    if (!sku) { skip(`“${rawSku}” isn’t a style code`); continue; }
    const price = col.price != null ? money(cells[col.price]) : null;
    if (Number.isNaN(price)) { skip(`price “${clean(cells[col.price])}” isn’t an amount`); continue; }
    const total = col.total != null ? money(cells[col.total]) : null;
    if (price == null && Number.isNaN(total)) { skip(`total “${clean(cells[col.total])}” isn’t an amount`); continue; }

    if (layout === 'matrix') {
      let n = 0; let bad = false;
      const got = [];
      for (const { c, size } of sizeCols) {
        const q = qtyValue(cells[c]);
        if (q == null || q === 0) continue;
        if (Number.isNaN(q) || q > 999) { skip(`size ${size}: “${clean(cells[c])}” isn’t a number of pairs`); bad = true; break; }
        got.push({ size, qty: q }); n += q;
      }
      if (bad) continue;
      if (!got.length) { skip('no pairs in any size column'); continue; }
      // A Qty column beside the size columns is the row's pairs — they must agree.
      const said = col.qty != null ? qtyValue(cells[col.qty]) : null;
      if (said != null && said !== n) { skip(`the sizes add up to ${n} pairs but the ${clean(headerCells[col.qty])} column says ${clean(cells[col.qty])}`); continue; }
      // A row total in a matrix is the whole row's money: ÷ all its pairs.
      const ea = price ?? (total != null ? Math.round((total / n) * 100) / 100 : null);
      const from = price == null && total != null ? 'total' : null;
      for (const z of got) entries.push({ sku, name: '', size: z.size, qty: z.qty, price: ea, from, line, row: rowNo });
      continue;
    }

    const rawSize = clean(cells[col.size]);
    const size = sizeValue(rawSize);
    if (!rawSize) { skip('no size on this row'); continue; }
    if (!size) { skip(`size “${rawSize}” isn’t a shoe size`); continue; }
    let qty = 1;
    if (layout === 'rows') {
      const q = qtyValue(cells[col.qty]);
      if (q == null) { skip('no quantity on this row'); continue; }
      if (Number.isNaN(q) || q > 999) { skip(`quantity “${clean(cells[col.qty])}” isn’t a whole number of pairs`); continue; }
      if (q === 0) { skip('quantity 0'); continue; }
      qty = q;
    }
    const ea = price ?? (total != null ? Math.round((total / qty) * 100) / 100 : null);
    const from = price == null && total != null ? 'total' : null;
    entries.push({ sku, name: '', size, qty, price: ea, from, line, row: rowNo });
  }
  const shoes = mergeEntries(entries, skipped);
  return { shoes, skipped, totals, pairs: pairsOf(shoes), layout, columns };
}

// A file the person picked → the same result. `.txt` that isn't a table is the message
// itself (returned as `text` for the paste box). `.xlsx` = the first sheet.
// A sheet with no header row — typically the supplier's message pasted into one column
// ("$42.71 ✅" / "900001-007" / "8 x 1", blank rows between shoes) — IS the message: each
// row's cells joined with a space, blank rows kept as the blank lines that split the shoes,
// read by the paste parser. Only when there's no header to go on (or just one column); a
// table whose header was found but lacks a Size column still says so.
export function gridAsText(grid) {
  return Array.from(grid || [], (r) => Array.from(r || [], (c) => clean(c)).filter(Boolean).join(' ')).join('\n');
}
const usedColumns = (grid) => {
  const used = new Set();
  for (const r of Array.from(grid || [])) Array.from(r || [], (c, i) => { if (clean(c)) used.add(i); return null; });
  return used.size;
};
export function parsePoGrid(grid, opts = {}) {
  const res = parsePoTable(grid, opts);
  const noHeader = !!res.error && /^No SKU column/.test(res.error);
  const oneColumn = usedColumns(grid) <= 1;
  if (!noHeader && !(oneColumn && !res.pairs)) return res;
  const pasted = { ...parsePoPaste(gridAsText(grid)), layout: 'text', columns: [] };
  // A real table with an unrecognised header reads as nothing as a message — say what's
  // missing instead of listing every row as "not understood".
  return pasted.pairs || oneColumn ? pasted : res;
}

export async function readPoFile(file) {
  const name = String(file?.name || '');
  if (/\.xlsx$/i.test(name)) {
    const { openWorkbook, readSheet } = await import('./sheinReprice.js');
    const book = openWorkbook(new Uint8Array(await file.arrayBuffer()));
    if (!book || !book.sheets.length) return { name, shoes: [], skipped: [], totals: [], pairs: 0, error: 'Could not open that .xlsx file.' };
    return { name, ...parsePoGrid(readSheet(book, book.sheets[0].name) || []) };
  }
  if (/\.(xls|numbers|pdf|docx?)$/i.test(name)) {
    return { name, shoes: [], skipped: [], totals: [], pairs: 0, error: 'Save it as CSV (or .xlsx) and upload that.' };
  }
  const text = await file.text();
  const { rows, delimiter } = parseDelimited(text);
  const opts = { decimalComma: delimiter === ';' };
  // A .txt that's just the message (no header row) goes into the paste box instead.
  if (/\.txt$/i.test(name)) {
    const res = parsePoTable(rows, opts);
    if (res.error && !/^No Size column/.test(res.error)) return { name, text: text.replace(/\r\n?/g, '\n') };
  }
  return { name, ...parsePoGrid(rows, opts) };
}

export const PO_FILE_ACCEPT = '.csv,.tsv,.txt,.xlsx,text/csv,text/tab-separated-values,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
