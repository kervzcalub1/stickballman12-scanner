// PO "Paste a list" (src/lib/poPaste.js, api/po/scan-bulk.js): a supplier's
//   DZ5485-201
//   8.5 x 2
//   9 x 3
// message, many shoes at once, onto a label or a whole-order list (supplier or PH).
import { test, expect } from '@playwright/test';
import { signToken } from '../api/_lib/util.js';
import { loadEnv } from './helpers/auth.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePoPaste, takePrice, listValue } from '../src/lib/poPaste.js';
import { parsePoTable, parseDelimited, readPoFile } from '../src/lib/poCsv.js';
import { parseStorePaste } from '../src/lib/storePaste.js';
import { buildXlsx } from '../src/lib/xlsx.js';
import pg from 'pg';

loadEnv();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (t, v) => pool.query(t, v).then((r) => r.rows);
const SUPPLIER = 'E2E Paste Supplier';
let SUP; let OTHER;
const tokenFor = (uid, username, role) => signToken({ uid, username, name: username, role });
const hdr = (t) => ({ Authorization: `Bearer ${t}` });
let supTok; let otherTok;
const PH = tokenFor('e2e-paste-ph', 'e2e_paste_ph', 'ph_team');

test.beforeAll(async () => {
  const mk = async (u) => Number((await q(
    `INSERT INTO users (name, username, pass_hash, role, status) VALUES ($1,$1,'x','supplier','approved')
     ON CONFLICT (username) DO UPDATE SET role='supplier' RETURNING id`, [u]))[0].id);
  SUP = await mk('e2e_paste_sup'); OTHER = await mk('e2e_paste_other');
  supTok = tokenFor(SUP, 'e2e_paste_sup', 'supplier'); otherTok = tokenFor(OTHER, 'e2e_paste_other', 'supplier');
});
test.afterAll(async () => {
  await q('DELETE FROM purchase_orders WHERE supplier_name = $1', [SUPPLIER]);
  await q(`DELETE FROM users WHERE username IN ('e2e_paste_sup','e2e_paste_other')`);
  await pool.end();
});

async function order({ kind = 'shoes', scope = 'box' } = {}) {
  const po = (await q(
    `INSERT INTO purchase_orders (supplier_name, supplier_user_id, raised_by, expected_boxes, status, order_kind, manifest_scope)
     VALUES ($1,$2,'supplier',1,'draft',$3,$4) RETURNING *`, [SUPPLIER, SUP, kind, scope]))[0];
  const [box] = await q(`INSERT INTO po_boxes (po_id, box_number, status) VALUES ($1, 1, 'pending') RETURNING *`, [po.id]);
  return { po, box };
}
const lines = (poId) => q(`SELECT sku, size, qty_expected::int AS qty, unit_cost::float AS cost, po_box_id, entered_on_behalf
                             FROM po_lines WHERE po_id = $1 ORDER BY sku, size`, [poId]);
const bulk = (request, tok, data) => request.post('/api/po/scan-bulk', { headers: hdr(tok), data });

test('the parser: blocks, a price on the SKU line, a spaced SKU, the same SKU twice, and a stray line', () => {
  const r = parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3\n9.5 x 4\n\nIB4025 100 $120\n10 x 1\n\ndz5485-201\n9x1\nJordan 4 something\n8 x 5');
  expect(r.shoes).toEqual([
    { sku: 'DZ5485-201', name: '', unitCost: null, sizes: [{ size: '8.5', qty: 2 }, { size: '9', qty: 4 }, { size: '9.5', qty: 4 }] },
    { sku: 'IB4025-100', name: '', unitCost: 120, sizes: [{ size: '10', qty: 1 }] },
  ]);
  // The stray line is reported, and the sizes UNDER it are refused, not given to the shoe above.
  expect(r.skipped.map((x) => x.line)).toEqual(['Jordan 4 something', '8 x 5']);
  expect(r.pairs).toBe(11);
});

/* ------------------------- prices in a pasted message ------------------------- */

test('price shapes suppliers write are read; sizes, quantities and style codes never are', () => {
  const amt = (s) => takePrice(s)?.amount ?? null;
  for (const [s, v] of [['$120', 120], ['120$', 120], ['@120', 120], ['@ $120', 120], ['120 ea', 120], ['120 each', 120],
    ['120/pr', 120], ['120 / pair', 120], ['120 per pair', 120], ['price 120', 120], ['Price: $1,234.50', 1234.5],
    ['cost: 120', 120], ['unit price 99.5', 99.5], ['120.00', 120], ['USD 120', 120], ['120 USD', 120], ['$120.00 ea', 120]]) {
    expect(amt(s), s).toBe(v);
  }
  expect(takePrice('total $1,050')).toEqual({ rest: '', amount: 1050, total: true });
  expect(takePrice('$1,050 total')).toEqual({ rest: '', amount: 1050, total: true });
  expect(takePrice('9 x 2 $110')).toEqual({ rest: '9 x 2', amount: 110, total: false });
  // A bare number is never a price: a size, a quantity, a style code's digits.
  for (const s of ['120', '10.5', '9 x 2', '8.5x12', 'DZ5485-201', '305381-007', 'IB4025 100', '9.5 - 4', 'DZ5485-201 120']) {
    expect(takePrice(s), s).toBeNull();
  }
  // "10 x 1 each" — the 1 is the quantity: what's left ("10 x") isn't a size, so the line is refused.
  const each = parsePoPaste('DZ5485-201\n10 x 1 each');
  expect(each.shoes).toEqual([]);
  expect(each.skipped.map((s) => s.line)).toContain('10 x 1 each');
});

test('the paste: a price on the SKU line, on its own line, on a name line, per size, and from a total', () => {
  const r = parsePoPaste([
    'DZ5485-201', 'Air Jordan 1 Low - $120', '9 x 2 $110', '10 x 1', '10.5 - 3 - 125', '11 x 1 @ 130 ea',
    '', 'IB4025-100 total $1,050', '9 x 5', '10x5',
    '', 'HF1234-001 Nike Dunk Low @ 95', '8 x1',
    '', 'FD0001-100', '$140 each', '7 x 2',
    '', 'FD0002-100', '8 x 1', 'price: 150',
    '', 'Total: $2,420',
  ].join('\n'));
  expect(r.skipped).toEqual([]);
  expect(r.shoes).toEqual([
    { sku: 'DZ5485-201', name: 'Air Jordan 1 Low', unitCost: 120, sizes: [
      { size: '9', qty: 2, unitCost: 110 }, { size: '10', qty: 1 }, { size: '10.5', qty: 3, unitCost: 125 }, { size: '11', qty: 1, unitCost: 130 }] },
    { sku: 'IB4025-100', name: '', unitCost: 105, priceFrom: 'total', sizes: [{ size: '9', qty: 5 }, { size: '10', qty: 5 }] },
    { sku: 'HF1234-001', name: 'Nike Dunk Low', unitCost: 95, sizes: [{ size: '8', qty: 1 }] },
    { sku: 'FD0001-100', name: '', unitCost: 140, sizes: [{ size: '7', qty: 2 }] },
    { sku: 'FD0002-100', name: '', unitCost: 150, sizes: [{ size: '8', qty: 1 }] },
  ]);
  // The "Total" line is the check, never a price.
  expect(r.totals).toEqual([{ line: 'Total: $2,420', amount: 2420 }]);
  expect(r.pairs).toBe(21);
  // "Size 9 x 2", "sz: 10 - 1", "9.5 x 3 prs", and a unit price on a US size line.
  expect(parsePoPaste('DZ5485-201\nSize 9 x 2 $110\nsz: 10 - 1\n9.5 x 3 prs @ 120\nUS 11 x 1 120/pr').shoes[0].sizes).toEqual([
    { size: '9', qty: 2, unitCost: 110 }, { size: '10', qty: 1 }, { size: '9.5', qty: 3, unitCost: 120 }, { size: '11', qty: 1, unitCost: 120 }]);
});

test('the paste stays strict: unclear priced lines go to "Not added", the sizes under them are refused', () => {
  const r = parsePoPaste('DZ5485-201 $120\n9 x 2\n9 x 1 $130\n$99\nIB4025-100\n8 x 1\nprice TBD\n10 x 1\n$80\n');
  expect(r.shoes).toEqual([
    { sku: 'DZ5485-201', name: '', unitCost: 120, sizes: [{ size: '9', qty: 2 }] },
    { sku: 'IB4025-100', name: '', unitCost: null, sizes: [{ size: '8', qty: 1 }] },
  ]);
  expect(r.skipped.map((s) => [s.line, s.why])).toEqual([
    // Between two codes with no blank line: DZ5485-201's (under it) or IB4025-100's (above it)? Not guessed.
    ['$99', 'a price between DZ5485-201 and the next code — put it on the SKU’s line, or a blank line between the shoes'],
    ['price TBD', 'not a style code, a name, a price or “size x quantity”'],
    ['10 x 1', 'a size under a line that isn’t a style code'],
    ['$80', 'a price with no style code next to it'],
    ['9 x 1 $130', 'DZ5485-201 size 9 is already listed at $120.00 — one price per size'],
  ]);
  // A small number after a dash is a typo, not a price.
  expect(parsePoPaste('DZ5485-201\n9 x 1\n8 - 9 - 2').skipped.map((s) => s.line)).toContain('8 - 9 - 2');
});

/* ---- The owner's real message format (2026-11-12): the price on its own line ABOVE the code, ✅ after it.
   The fixtures keep the real files' exact layout (CRLF, blank first line, spacing) with FAKE SKUs and
   prices (each real price + $1.11) — supplier costs don't belong in the repo. ---- */

const REAL_PRICE_ABOVE = readFileSync(new URL('./fixtures/po-manifest-price-above.txt', import.meta.url), 'utf8');

test('the real "price above the SKU ✅" message: every shoe, size and price, matched to the right SKU', () => {
  const r = parsePoPaste(REAL_PRICE_ABOVE);
  // Worked out independently from the raw text: a block = price line, code line, size lines.
  const want = [];
  for (const block of REAL_PRICE_ABOVE.split(/\r?\n\s*\r?\n/)) {
    const ls = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!ls.length) continue;
    const price = Number(/^\$(\d+\.\d\d)\s*✅$/u.exec(ls[0])[1]);
    expect(ls[1]).toMatch(/^[0-9A-Z]{5,7}-[0-9A-Z]{3}$/);
    want.push({ sku: ls[1], price, sizes: ls.slice(2).map((l) => { const [s, q] = l.split(/\s*x\s*/); return { size: s, qty: Number(q) }; }) });
  }
  expect(want).toHaveLength(77);
  expect(r.skipped).toEqual([]);
  expect(r.shoes.map((s) => ({ sku: s.sku, price: s.unitCost, sizes: s.sizes }))).toEqual(want);
  const pairs = want.reduce((n, w) => n + w.sizes.reduce((k, z) => k + z.qty, 0), 0);
  const dollars = Math.round(want.reduce((t, w) => t + w.price * w.sizes.reduce((k, z) => k + z.qty, 0), 0) * 100) / 100;
  expect(r.pairs).toBe(pairs);
  expect(pairs).toBe(260);
  expect(listValue(r.shoes)).toEqual({ total: dollars, unpriced: 0 });
  expect(dollars).toBe(11261.21);
  // Spot checks: first, the numeric-only codes, a 2-pair size, the last (no space before ✅).
  const by = Object.fromEntries(r.shoes.map((s) => [s.sku, s]));
  expect(by['900001-007']).toEqual({ sku: '900001-007', name: '', unitCost: 42.71, sizes: [{ size: '8', qty: 1 }] });
  expect(by['900004-028']).toEqual({ sku: '900004-028', name: '', unitCost: 56.54, sizes: [
    { size: '7.5', qty: 1 }, { size: '9.5', qty: 1 }, { size: '10', qty: 1 }, { size: '11', qty: 1 }, { size: '12', qty: 2 }] });
  expect(by['900005-035'].unitCost).toBe(61.11);
  expect(by['900009-063'].unitCost).toBe(38.06);
  expect(by['ZQ0077-001']).toEqual({ sku: 'ZQ0077-001', name: '', unitCost: 61.16, sizes: [{ size: '10', qty: 1 }, { size: '12', qty: 1 }] });
});

test('price above or below: by blank lines and position, never given to the wrong shoe', () => {
  // Above, with ticks and emoji in any spacing; no blank lines needed once the paste starts that way.
  const a = parsePoPaste('$42.71✅\n900001-007\n8 x 1\n$50 ✔️\n900011-077\n9 x 2 ✅\n*$20.00*\nDZ5485-201\n10 x 1');
  expect(a.skipped).toEqual([]);
  expect(a.shoes.map((s) => [s.sku, s.unitCost, s.sizes])).toEqual([
    ['900001-007', 42.71, [{ size: '8', qty: 1 }]], ['900011-077', 50, [{ size: '9', qty: 2 }]], ['DZ5485-201', 20, [{ size: '10', qty: 1 }]]]);
  // Below (under the code, or after the sizes) — a blank line before the next shoe settles it.
  const b = parsePoPaste('DZ5485-201\n9 x 2\n$120 ✅\n\n$90\nIB4025-100\n8 x 1');
  expect(b.skipped).toEqual([]);
  expect(b.shoes.map((s) => [s.sku, s.unitCost])).toEqual([['DZ5485-201', 120], ['IB4025-100', 90]]);
  // A price above AND a different one below / on the SKU line: neither is picked.
  const c = parsePoPaste('$42.71 ✅\n900001-007\n8 x 1\n$45\n\n$50\n900011-077 $55\n9 x 1\n\n$30\nDZ5485-201\n$30 ea\n9 x 1');
  expect(c.shoes.map((s) => [s.sku, s.unitCost])).toEqual([['900001-007', null], ['900011-077', null], ['DZ5485-201', 30]]);
  expect(c.skipped.map((s) => s.line)).toEqual(['$45', '900011-077 $55']);
  expect(c.skipped[0].why).toMatch(/^two different prices for 900001-007 \(\$42\.71 .*\$45\.00 here\) — its price was left blank/);
  // A lone price followed by a blank line and nothing of a shoe: not added.
  expect(parsePoPaste('$42.71 ✅\n\n900001-007\n8 x 1').skipped.map((s) => [s.line, s.why])).toEqual([['$42.71', 'a price with no style code next to it']]);
});

// The owner's real CSV (a Google Sheets export, 2026-11-12): the SAME message in one column —
// CRLF, first line empty, no header, blank rows between the shoes.
const REAL_ONE_COLUMN = new URL('./fixtures/po-manifest-one-column.csv', import.meta.url);

test('the real one-column CSV reads exactly like the pasted message', async () => {
  const raw = readFileSync(REAL_ONE_COLUMN);
  const fromCsv = await readPoFile(new File([raw], 'manifest - Sheet1.csv'));
  const fromPaste = parsePoPaste(REAL_PRICE_ABOVE);
  expect(fromCsv.error).toBeUndefined();
  expect(fromCsv.layout).toBe('text');
  expect(fromCsv.skipped).toEqual([]);
  expect(fromCsv.shoes).toEqual(fromPaste.shoes);
  expect(fromCsv.shoes).toHaveLength(77);
  expect(fromCsv.pairs).toBe(260);
  expect(listValue(fromCsv.shoes)).toEqual({ total: 11261.21, unpriced: 0 });
  // A many-column table with no header it can name still says so (not 30 "not understood" rows).
  expect((await readPoFile(new File(['Name,Size,Qty\nDunk,9,1\n'], 'x.csv'))).error).toMatch(/^No SKU column/);
});

test('the store list keeps per-size prices — one entry per price', () => {
  const r = parseStorePaste('Store: AF #1\nDZ5485-612 $110\n8 x 2\n9 x 1 $120');
  expect(r.unpriced).toEqual([]);
  expect(r.stores[0].shoes).toEqual([
    { sku: 'DZ5485-612', name: '', unitCost: 110, sizes: [{ size: '8', qty: 2 }] },
    { sku: 'DZ5485-612', name: '', unitCost: 120, sizes: [{ size: '9', qty: 1 }] },
  ]);
  expect(r.total).toBe(340);
});

/* ------------------------------- CSV / xlsx upload ------------------------------- */

const csv = (text) => { const { rows, delimiter } = parseDelimited(text); return parsePoTable(rows, { decimalComma: delimiter === ';' }); };

test('CSV: header by name (synonyms), a title line, BOM, quotes, $1,234.50, blank rows, a TOTAL row', () => {
  const r = csv('﻿Order for Kevin 11/12\n'
    + 'Style #,Product Name,US Size,Quantity,Unit Price ($)\n'
    + 'DZ5485-201,"Jordan 1 Low ""Mocha"", men\'s",8.5,2,"$1,234.50"\n'
    + 'dz5485 201,x,9,3,$110\n'
    + 'IB4025-100,y,10,1,120.00\n'
    + ',,,,\n'
    + 'TOTAL,,,6,\n\n\n');
  expect(r.error).toBeUndefined();
  expect(r.layout).toBe('rows');
  expect(r.columns.map((c) => `${c.role}=${c.header}`)).toEqual(['SKU=Style #', 'Size=US Size', 'Qty=Quantity', 'Price ea=Unit Price ($)']);
  expect(r.shoes).toEqual([
    { sku: 'DZ5485-201', name: '', unitCost: null, sizes: [{ size: '8.5', qty: 2, unitCost: 1234.5 }, { size: '9', qty: 3, unitCost: 110 }] },
    { sku: 'IB4025-100', name: '', unitCost: 120, sizes: [{ size: '10', qty: 1 }] },
  ]);
  expect(r.skipped).toEqual([]);
  expect(r.pairs).toBe(6);
});

test('CSV: ; and tab delimiters, a line TOTAL ÷ qty (marked), one row per pair', () => {
  const semi = csv('sku;size;qty;total\nDZ5485-201;9;2;220,00\nDZ5485-201;9,5;1;115\n');
  expect(semi.shoes).toEqual([{ sku: 'DZ5485-201', name: '', unitCost: null, sizes: [
    { size: '9', qty: 2, unitCost: 110, priceFrom: 'total' }, { size: '9.5', qty: 1, unitCost: 115, priceFrom: 'total' }] }]);
  const same = csv('SKU,Size,Pairs,Amount\nDZ5485-201,9,2,$240\nDZ5485-201,10,1,$120\n');
  expect(same.shoes[0]).toEqual({ sku: 'DZ5485-201', name: '', unitCost: 120, priceFrom: 'total', sizes: [{ size: '9', qty: 2 }, { size: '10', qty: 1 }] });
  const perPair = csv('SKU\tSize\tPrice\nDZ5485-201\t9\t$100\nDZ5485-201\t9\t$100\nDZ5485-201\t10\t$100\n');
  expect(perPair.layout).toBe('per-pair');
  expect(perPair.shoes).toEqual([{ sku: 'DZ5485-201', name: '', unitCost: 100, sizes: [{ size: '9', qty: 2 }, { size: '10', qty: 1 }] }]);
});

test('CSV: the size matrix (sizes across the top, pairs in the cells)', () => {
  const r = csv('Style,Description,8,8.5,US 9,10,Total Pairs,Price ea\n'
    + 'DZ5485-201,Dunk,1,,2,0,3,$95\n'
    + 'IB4025-100,Other,,x,1,,1,\n'
    + 'HF1234-001,Third,2,2,,,5,$80\n'
    + 'FD0001-100,Fourth,,,,,,$80\n');
  expect(r.layout).toBe('matrix');
  expect(r.shoes).toEqual([{ sku: 'DZ5485-201', name: '', unitCost: 95, sizes: [{ size: '8', qty: 1 }, { size: '9', qty: 2 }] }]);
  expect(r.skipped.map((s) => [s.row, s.why])).toEqual([
    [3, 'size 8.5: “x” isn’t a number of pairs'],
    [4, 'the sizes add up to 4 pairs but the Total Pairs column says 5'],
    [5, 'no pairs in any size column'],
  ]);
});

test('CSV: rows it can\'t read are listed with their row number; no SKU / no Size column says so', () => {
  const r = csv('SKU,Size,Qty,Price\nDunk Low,9,1,10\nDZ5485-201,9,1,abc\nDZ5485-201,9,0,10\nDZ5485-201,,1,10\nDZ5485-201,9.25,1,10\nDZ5485-201,9,two,10\nDZ5485-201,9,1,100\n');
  expect(r.shoes).toEqual([{ sku: 'DZ5485-201', name: '', unitCost: 100, sizes: [{ size: '9', qty: 1 }] }]);
  expect(r.skipped.map((s) => [s.row, s.why])).toEqual([
    [2, '“Dunk Low” isn’t a style code'], [3, 'price “abc” isn’t an amount'], [4, 'quantity 0'], [5, 'no size on this row'],
    [6, 'size “9.25” isn’t a shoe size'], [7, 'quantity “two” isn’t a whole number of pairs'],
  ]);
  expect(csv('Name,Size,Qty\nDunk,9,1\n').error).toMatch(/^No SKU column/);
  expect(csv('SKU,Qty\nDZ5485-201,1\n').error).toMatch(/^No Size column/);
  expect(csv('').error).toBe('The file is empty.');
});

test('CSV with no official format: loose headers, ticks and emoji, a title line, notes and a repeated header', () => {
  const r = csv('Kevin order ✅ — Nike style list\n\n'
    + 'Style Code / SKU,Shoe,Size (US Men),Qty Ordered ✅,Price Paid,Retail\n'
    + '900001-007 ✅,AJ1,8,1,$42.71 ✅,$120\n'
    + '900011-077,Air Max,9.5 ✅,2 ✔️,"$100.00 ✅",$170\n'
    + 'Notes: ship Friday 🚚,,,,,\n'
    + 'Style Code / SKU,Shoe,Size (US Men),Qty Ordered ✅,Price Paid,Retail\n'
    + 'ZQ0077-001,,10,1,❌,\n');
  expect(r.columns.map((c) => `${c.role}=${c.header}`)).toEqual(['SKU=Style Code / SKU', 'Size=Size (US Men)', 'Qty=Qty Ordered', 'Price ea=Price Paid']);
  expect(r.shoes).toEqual([
    { sku: '900001-007', name: '', unitCost: 42.71, sizes: [{ size: '8', qty: 1 }] },
    { sku: '900011-077', name: '', unitCost: 100, sizes: [{ size: '9.5', qty: 2 }] },
    { sku: 'ZQ0077-001', name: '', unitCost: null, sizes: [{ size: '10', qty: 1 }] },
  ]);
  // The notes line is listed, never dropped; the retail column is never the price we paid.
  expect(r.skipped.map((s) => [s.row, s.why])).toEqual([[6, '“Notes: ship Friday” isn’t a style code']]);
});

test('the file reader: .xlsx (first sheet), and a .txt that is just the message goes to the paste box', async () => {
  const bytes = buildXlsx({ columns: [{ label: 'SKU' }, { label: 'Size', type: 'text' }, { label: 'Qty', type: 'int' }, { label: 'Cost', type: 'money' }],
    rows: [['DZ5485-201', '9.5', 2, 110], ['DZ5485-201', '10', 1, 110]] });
  const x = await readPoFile(new File([bytes], 'order.xlsx'));
  expect(x.error).toBeUndefined();
  expect(x.shoes).toEqual([{ sku: 'DZ5485-201', name: '', unitCost: 110, sizes: [{ size: '9.5', qty: 2 }, { size: '10', qty: 1 }] }]);
  const t = await readPoFile(new File(['DZ5485-201\n9 x 2 $110\n'], 'msg.txt'));
  expect(t.text).toBe('DZ5485-201\n9 x 2 $110\n');
  expect((await readPoFile(new File(['x'], 'order.xls'))).error).toMatch(/Save it as CSV/);
});

test('scan-bulk takes a size\'s own price over the shoe\'s', async ({ request }) => {
  const { po, box } = await order();
  const r = await bulk(request, supTok, { poBoxId: box.id, shoes: parsePoPaste('DZ5485-201 $120\n9 x 2 $110\n10 x 1').shoes });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await lines(po.id)).map((l) => [l.size, l.qty, l.cost])).toEqual([['10', 1, 120], ['9', 2, 110]]);
});

test('a supplier pastes onto their own label; pasting again tops up; the guards hold', async ({ request }) => {
  const { po, box } = await order();
  const shoes = parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3\n9.5 x 4\n\nIB4025-100 $120\n10 x 1').shoes;
  const r = await bulk(request, supTok, { poBoxId: box.id, shoes });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await r.json()).pairs).toBe(10);
  expect(await lines(po.id)).toEqual([
    { sku: 'DZ5485-201', size: '8.5', qty: 2, cost: null, po_box_id: box.id, entered_on_behalf: false },
    { sku: 'DZ5485-201', size: '9', qty: 3, cost: null, po_box_id: box.id, entered_on_behalf: false },
    { sku: 'DZ5485-201', size: '9.5', qty: 4, cost: null, po_box_id: box.id, entered_on_behalf: false },
    { sku: 'IB4025-100', size: '10', qty: 1, cost: 120, po_box_id: box.id, entered_on_behalf: false },
  ]);
  // A second paste of the same sizes adds to them — no duplicate rows.
  await bulk(request, supTok, { poBoxId: box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '9', qty: 2 }] }] });
  expect((await lines(po.id)).find((l) => l.size === '9').qty).toBe(5);
  expect(await lines(po.id)).toHaveLength(4);

  // Someone else's order; a whole-order list on top of a per-box one; a bad quantity — nothing written.
  expect((await bulk(request, otherTok, { poBoxId: box.id, shoes })).status()).toBe(403);
  expect((await bulk(request, supTok, { poId: po.id, shoes })).status()).toBe(409);
  const bad = await bulk(request, supTok, { poBoxId: box.id, shoes: [{ sku: 'X1-100', sizes: [{ size: '9', qty: 1 }] }, { sku: 'Y1-100', sizes: [{ size: '9', qty: 0 }] }] });
  expect(bad.status()).toBe(400);
  expect((await lines(po.id)).some((l) => l.sku === 'X1-100')).toBe(false);
  // A label that has left the supplier is closed to the supplier.
  await q(`UPDATE po_boxes SET status = 'shipped' WHERE id = $1`, [box.id]);
  expect((await bulk(request, supTok, { poBoxId: box.id, shoes })).status()).toBe(409);
});

test('PH pastes on the supplier\'s behalf — onto a label, or as the whole-order list; a boxes order is refused', async ({ request }) => {
  const a = await order();
  expect((await bulk(request, PH, { poBoxId: a.box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '8', qty: 1 }] }] })).ok()).toBeTruthy();
  expect((await lines(a.po.id))[0]).toMatchObject({ entered_on_behalf: true, po_box_id: a.box.id });

  const b = await order({ scope: 'po' });
  const r = await bulk(request, PH, { poId: b.po.id, shoes: parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3').shoes });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await lines(b.po.id)).map((l) => [l.size, l.qty, l.po_box_id])).toEqual([['8.5', 2, null], ['9', 3, null]]);
  expect((await q('SELECT manifest_scope FROM purchase_orders WHERE id = $1', [b.po.id]))[0].manifest_scope).toBe('po');

  const c = await order({ kind: 'boxes' });
  expect((await bulk(request, PH, { poBoxId: c.box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '9', qty: 1 }] }] })).status()).toBe(409);
});

test('a supplier pastes ONE list for the whole order (not split by box); the guards hold', async ({ request }) => {
  const { po, box } = await order();
  const r = await bulk(request, supTok, { poId: po.id, shoes: parsePoPaste('DZ5485-201\n8.5 x 2\n9 x 3\n\nIB4025-100 $120\n10 x 1').shoes });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect(await lines(po.id)).toEqual([
    { sku: 'DZ5485-201', size: '8.5', qty: 2, cost: null, po_box_id: null, entered_on_behalf: false },
    { sku: 'DZ5485-201', size: '9', qty: 3, cost: null, po_box_id: null, entered_on_behalf: false },
    { sku: 'IB4025-100', size: '10', qty: 1, cost: 120, po_box_id: null, entered_on_behalf: false },
  ]);
  expect((await q('SELECT manifest_scope FROM purchase_orders WHERE id = $1', [po.id]))[0].manifest_scope).toBe('po');
  // Now the boxes carry nothing of their own: a label paste is refused, and a box closes empty.
  expect((await bulk(request, supTok, { poBoxId: box.id, shoes: [{ sku: 'DZ5485-201', sizes: [{ size: '8', qty: 1 }] }] })).status()).toBe(409);
  const closed = await request.post('/api/po/close-box', { headers: hdr(supTok), data: { poBoxId: box.id } });
  expect(closed.ok(), await closed.text()).toBeTruthy();

  const one = [{ sku: 'DZ5485-201', sizes: [{ size: '8', qty: 1 }] }];
  // Someone else's order.
  expect((await bulk(request, otherTok, { poId: po.id, shoes: one })).status()).toBe(403);
  // A buying-request order: the order-level list is OUR receipt — theirs is per label.
  const receipt = await order({ scope: 'order+box' });
  expect((await bulk(request, supTok, { poId: receipt.po.id, shoes: one })).status()).toBe(409);
  // Once every label has shipped, it's PH's to correct.
  const gone = await order();
  await q(`UPDATE purchase_orders SET status = 'receiving' WHERE id = $1`, [gone.po.id]);
  expect((await bulk(request, supTok, { poId: gone.po.id, shoes: one })).status()).toBe(409);
  expect(await lines(gone.po.id)).toHaveLength(0);
});

test('the supplier portal: Paste the whole-order manifest → the box closes with nothing listed on it', async ({ page }) => {
  const { po } = await order();
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_paste_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.route('**/api/sku-search**', (route) => route.fulfill({ json: { ok: true, product: { name: 'Air Jordan 1 Low Test', sku: 'DZ5485-201', sizes: [] } } }));
  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: '📋 Paste the whole-order manifest' }).click();
  // Straight into the paste box — no scanner toggle on the whole-order list.
  await expect(page.getByRole('button', { name: '📋 Paste a list' })).toHaveCount(0);
  await page.getByLabel('Paste the list').fill('DZ5485-201\n8.5 x 2\n9 x 3');
  await page.getByRole('button', { name: 'Add 5 pairs (1 SKU) to order' }).click();
  await expect(page.getByRole('status')).toContainText('Added 5 pairs · 1 SKU to the whole order');
  await page.locator('.modal-head .btn.icon').click();
  expect((await lines(po.id)).map((l) => [l.size, l.qty, l.po_box_id])).toEqual([['8.5', 2, null], ['9', 3, null]]);
  // The label no longer takes items of its own, and closes with nothing listed on it.
  await expect(page.getByRole('button', { name: /^Add items$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review & close box' }).click();
  await expect(page.getByRole('dialog')).toContainText('one manifest for the whole order');
  await page.getByRole('button', { name: 'Close box for shipment' }).click();
  await expect(page.getByRole('dialog')).toContainText('is closed');
});

test('the supplier portal: upload a CSV as the whole-order manifest → preview with prices → Add', async ({ page }) => {
  const { po } = await order();
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_paste_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.route('**/api/sku-search**', (route) => route.fulfill({ json: { ok: true, product: { name: 'Air Jordan 1 Low Test', sku: 'DZ5485-201', sizes: [] } } }));
  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: '📋 Paste the whole-order manifest' }).click();
  await expect(page.getByRole('button', { name: '📄 Upload a CSV' })).toBeVisible();
  await page.locator('.po-paste input[type=file]').setInputFiles({
    name: 'order.csv', mimeType: 'text/csv',
    buffer: Buffer.from('Supplier order\nStyle,Size,Qty,Price ea\nDZ5485-201,8.5,2,$100\nDZ5485-201,9,3,$110.00\nDZ5485-201,9.5,1,\nnot-a-code,9,1,$5\nTotal,,6,\n'),
  });
  await expect(page.locator('.po-paste-file')).toContainText('order.csv');
  await expect(page.locator('.po-paste-file')).toContainText('SKU = “Style”');
  await expect(page.getByLabel('Paste the list')).toHaveCount(0);
  await expect(page.locator('.po-paste-list')).toContainText('Air Jordan 1 Low Test');
  await expect(page.locator('.po-paste-list')).toContainText('8.5 ×2 · $100.00');
  await expect(page.locator('.po-paste-skipped')).toContainText('Row 6');
  await page.locator('.po-paste-price input').fill('105');   // the unpriced size
  await page.getByRole('button', { name: 'Add 6 pairs (1 SKU) to order' }).click();
  await expect(page.getByRole('status')).toContainText('Added 6 pairs · 1 SKU to the whole order');
  expect((await lines(po.id)).map((l) => [l.size, l.qty, l.cost, l.po_box_id])).toEqual([['8.5', 2, 100, null], ['9', 3, 110, null], ['9.5', 1, 105, null]]);
});

test('the supplier portal: upload the owner\'s real one-column CSV → 77 shoes, 260 pairs at their prices', async ({ page }) => {
  const { po } = await order();
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_paste_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.route('**/api/sku-search**', (route) => route.fulfill({ json: { ok: true, product: { name: 'Nike Test Shoe', sizes: [] } } }));
  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: '📋 Paste the whole-order manifest' }).click();
  await page.locator('.po-paste input[type=file]').setInputFiles(fileURLToPath(REAL_ONE_COLUMN));
  await expect(page.locator('.po-paste-file')).toContainText('po-manifest-one-column.csv');
  await expect(page.locator('.po-paste-file')).toContainText('Read as a pasted list');
  await expect(page.locator('.po-paste-list > li')).toHaveCount(77);
  await expect(page.locator('.po-paste-skipped')).toHaveCount(0);
  await expect(page.locator('.po-paste-list > li').first()).toContainText('900001-007');
  await expect(page.locator('.po-paste-list > li').first().locator('.po-paste-price input')).toHaveValue('42.71');
  await page.getByRole('button', { name: 'Add 260 pairs (77 SKUs) to order' }).click();
  await expect(page.getByRole('status')).toContainText('Added 260 pairs · 77 SKUs to the whole order');
  const got = await q(`SELECT count(DISTINCT sku)::int AS skus, sum(qty_expected)::int AS pairs, sum(qty_expected * unit_cost)::float AS dollars,
                              count(*) FILTER (WHERE unit_cost IS NULL)::int AS unpriced
                         FROM po_lines WHERE po_id = $1 AND po_box_id IS NULL`, [po.id]);
  expect(got[0]).toEqual({ skus: 77, pairs: 260, dollars: 11261.21, unpriced: 0 });
  expect((await lines(po.id)).find((l) => l.sku === 'ZQ0077-001' && l.size === '12')).toMatchObject({ qty: 1, cost: 61.16 });
});

test('the supplier portal: Paste a list → preview → Add', async ({ page }) => {
  const { po } = await order();
  await page.addInitScript(([t, u]) => { sessionStorage.setItem('sb_session_token', t); sessionStorage.setItem('sb_user', u); },
    [supTok, JSON.stringify({ username: 'e2e_paste_sup', name: SUPPLIER, role: 'supplier' })]);
  await page.route('**/api/sku-search**', (route) => route.fulfill({ json: { ok: true, product: { name: 'Air Jordan 1 Low Test', sku: 'DZ5485-201', sizes: [] } } }));
  await page.goto('/orders');
  await page.locator('.po-card').filter({ hasText: po.po_code }).first().click();
  await page.getByRole('button', { name: /^Add items$/ }).first().click();
  await page.getByRole('button', { name: '📋 Paste a list' }).click();
  await page.getByLabel('Paste the list').fill('DZ5485-201\n8.5 x 2\n9 x 3\n9.5 x 4\noops\n10 x 9');
  await expect(page.locator('.po-paste-list li')).toHaveCount(1);
  await expect(page.locator('.po-paste-list')).toContainText('Air Jordan 1 Low Test');
  await expect(page.locator('.po-paste-skipped')).toContainText('oops');
  await page.locator('.po-paste-price input').fill('95');
  await page.getByRole('button', { name: 'Add 9 pairs (1 SKU) to label' }).click();
  await expect(page.getByRole('status')).toContainText('Added 9 pairs · 1 SKU to Label 1');
  expect((await lines(po.id)).map((l) => [l.size, l.qty, l.cost])).toEqual([['8.5', 2, 95], ['9', 3, 95], ['9.5', 4, 95]]);
});
