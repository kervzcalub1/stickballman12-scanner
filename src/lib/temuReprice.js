// Temu Reprice — PURE helpers (docs/context/temu-reprice.md). The same idea as eBay and
// SHEIN Reprice — our floor is today's market + markup, a price only ever goes DOWN to it —
// in the shape Temu works in: Temu sends a list of "pricing opportunities" (a lower base
// price it recommends per SKU) and each row takes an answer.
//   in   Temu Seller Center → Pricing health → the batch template ("Traffic boost
//        opportunity_….xlsx", sheet "Template": header row 1, explanations row 2, one SKU per
//        row from row 3) + the store inventory report (SKU → Style ID), the eBay Reprice one
//   out  the SAME workbook with Action / New base price / Reasons filled on the rows we
//        answer; every other cell and every other part of the zip exactly as Temu made it
// Per row, floor = market × (1 + markup), rounded UP to the cent:
//   Temu's recommended price ≥ floor            → Accept
//   recommended < floor < current base price    → New proposal at the floor (if the row's own
//                                                 dropdown offers it, and counters are on)
//   floor ≥ current base price                  → left blank: never raised, and not accepted
import { unzipSync, zipSync } from 'fflate';
import { styleFromTitle, cacheKey } from './ebayReprice.js';
import { openWorkbook, readSheet, priceCents } from './sheinReprice.js';

const td = new TextDecoder();
const te = new TextEncoder();
const unescXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colNum = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const colLetters = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

export const SHEET = 'Template';
export const FIRST_ROW = 3;          // row 1 = headers, row 2 = Temu's explanations
export const MAX_FILLED = 1000;      // Temu: "up to 1000 lines of content" per file
export const ACCEPT = 'Accept';
export const PROPOSE = 'New proposal';
// The Reasons dropdown as Temu's template spells it (read from the file when it has one).
export const REASONS = ['Multiple piece set', 'IP licensed product', 'Unique attributes/material/style/craftsmanship',
  'Special dimensions', 'High production cost', 'Priced lower than similar products'];
export const DEFAULT_REASON = 'High production cost';

/* --------------------------------- the size -------------------------------- */

const SIZE = /^(\d{1,2}(?:\.5)?)\s*[WYCM]?$/i;
const sizeNum = (t) => String(Number(t.match(SIZE)[1]));
// Temu's Variation is whatever the listing's options were: "8.5W/Pink", "Grit/6", "4Y",
// "Team Red-11.5W/One-size", "As shown: 6-4Y-One-size/One-size". The size is the part that
// IS a size; failing that, the last size inside a dashed part (colour-size). The letter
// (W / Y / C) is dropped — the style code picks the catalogue, as on eBay Reprice. Two
// candidates that disagree, or none → '' and the row is skipped, never guessed.
export function temuSize(variation) {
  const parts = String(variation ?? '').split('/').map((p) => p.trim()).filter(Boolean);
  const whole = [...new Set(parts.filter((p) => SIZE.test(p)).map(sizeNum))];
  if (whole.length === 1) return whole[0];
  if (whole.length > 1) return '';
  const inside = new Set();
  for (const p of parts) {
    const sized = p.replace(/^as shown:\s*/i, '').split('-').map((t) => t.trim()).filter((t) => SIZE.test(t));
    if (sized.length) inside.add(sizeNum(sized[sized.length - 1]));
  }
  return inside.size === 1 ? [...inside][0] : '';
}

/* ----------------------------- reading the file ---------------------------- */

const COLS = {
  name: 'product name', goods: 'goods id', skuId: 'sku id', sku: 'sku', variation: 'variation', status: 'product status',
  current: 'current base price', recommended: 'recommended base price', action: 'action', newPrice: 'new base price', reason: 'reasons',
};
const LABEL = { name: 'Product name', skuId: 'SKU ID', sku: 'SKU', variation: 'Variation', current: 'Current base price',
  recommended: 'Recommended base price', action: 'Action', newPrice: 'New base price', reason: 'Reasons' };

// Each dropdown in the sheet: which rows of one column it covers and what it offers. Temu
// writes one per row for Action ("Accept" or "Accept,New proposal" — NOT every row may be
// countered) and one range for Reasons.
function dropdowns(xml) {
  const out = [];
  for (const m of xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)) {
    if (!/\btype="list"/.test(m[1])) continue;
    const f = (m[2].match(/<formula1>([\s\S]*?)<\/formula1>/) || [])[1];
    const sqref = (m[1].match(/\bsqref="([^"]*)"/) || [])[1];
    if (f == null || !sqref) continue;
    const text = unescXml(f).trim();
    if (!/^".*"$/.test(text)) continue;   // a range reference, not a typed list
    const values = text.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean);
    for (const ref of sqref.split(/\s+/)) {
      const r = ref.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
      if (!r || (r[3] && r[3] !== r[1])) continue;
      out.push({ col: colNum(r[1]), from: Number(r[2]), to: Number(r[4] || r[2]), values });
    }
  }
  return out;
}

export function readTemuFile(bytes) {
  const book = openWorkbook(bytes);
  if (!book) return { ok: false, error: 'Not an Excel file (.xlsx) — use the template Temu’s Pricing health page gives you.' };
  const sheet = book.sheets.find((s) => s.name.trim().toLowerCase() === SHEET.toLowerCase());
  const grid = readSheet(book, SHEET);
  if (!sheet || !grid) return { ok: false, error: `No "${SHEET}" sheet — this file has: ${book.sheets.map((s) => s.name).join(', ')}. Is it Temu’s pricing template?` };
  const head = (grid[0] || []).map((h) => String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase());
  const at = {};
  for (const [k, want] of Object.entries(COLS)) { const i = head.indexOf(want); if (i >= 0) at[k] = i; }
  const missing = Object.keys(LABEL).filter((k) => at[k] == null);
  if (missing.length) return { ok: false, error: `Missing column${missing.length === 1 ? '' : 's'}: ${missing.map((k) => LABEL[k]).join(', ')}.` };
  const drops = dropdowns(td.decode(book.files[sheet.path]));
  const offered = (col, line) => drops.find((d) => d.col === col && line >= d.from && line <= d.to)?.values || null;
  const cell = (g, k) => (at[k] == null ? '' : String(g[at[k]] ?? '').trim());
  const rows = [];
  for (let r = FIRST_ROW - 1; r < grid.length; r++) {
    const g = grid[r];
    if (!g || !cell(g, 'skuId')) continue;
    const line = r + 1;
    const variation = cell(g, 'variation');
    rows.push({
      line, name: cell(g, 'name'), goods: cell(g, 'goods'), skuId: cell(g, 'skuId'), sku: cell(g, 'sku'),
      variation, size: temuSize(variation), status: cell(g, 'status'),
      currentText: cell(g, 'current'), currentCents: priceCents(cell(g, 'current')),
      recText: cell(g, 'recommended'), recCents: priceCents(cell(g, 'recommended')),
      filled: cell(g, 'action') || cell(g, 'newPrice') || cell(g, 'reason') ? cell(g, 'action') || 'a price / reason' : '',
      // No dropdown on the row = nothing we can be sure Temu takes; only Accept is assumed.
      actions: offered(at.action, line) || [ACCEPT],
    });
  }
  if (!rows.length) return { ok: false, error: `No SKU rows in the ${SHEET} sheet (they start at row ${FIRST_ROW}).` };
  const reasons = drops.find((d) => d.col === at.reason)?.values || REASONS;
  return {
    ok: true, bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), rows, at, reasons,
    stats: {
      rows: rows.length,
      inactive: rows.filter((x) => x.status && x.status.toLowerCase() !== 'active').length,
      acceptOnly: rows.filter((x) => !x.actions.includes(PROPOSE)).length,
      filled: rows.filter((x) => x.filled).length,
    },
  };
}

/* ------------------------------- style codes ------------------------------- */

// SKU → Style ID from the store inventory report; a SKU the report doesn't carry (sold out)
// or maps to two styles falls back to the code printed in the product name.
export function resolveStyles(rows, inv) {
  const n = { report: 0, name: 0, none: 0 };
  const out = rows.map((x) => {
    const direct = x.sku && !inv.conflicts.has(x.sku) ? inv.sku2style.get(x.sku) : '';
    if (direct) { n.report++; return { ...x, style: direct, styleFrom: 'inventory report' }; }
    const t = styleFromTitle(x.name, inv.styles);
    if (t) { n.name++; return { ...x, style: t, styleFrom: 'product name' }; }
    n.none++;
    return { ...x, style: '', styleFrom: '' };
  });
  return { rows: out, n };
}

// Why a row is not answered, or '' when it can be priced.
export function skipReason(x, { activeOnly = false } = {}) {
  if (x.filled) return `Already answered in the file (${x.filled})`;
  if (activeOnly && x.status && x.status.toLowerCase() !== 'active') return `Product is ${x.status}`;
  if (!x.variation) return 'No size (blank Variation)';
  if (!x.size) return `No single US size in "${x.variation}"`;
  if (!x.style) return 'No Style ID in the inventory report or the product name';
  if (x.currentCents == null || x.recCents == null) return 'No current / recommended price';
  return '';
}

const codesOf = (style) => String(style || '').split('/').map((p) => p.trim()).filter(Boolean);

// The same jobs eBay and SHEIN Reprice send, so all three share one day's price cache.
export function jobsFor(rows, opts) {
  const seen = new Map();
  for (const x of rows) {
    if (skipReason(x, opts)) continue;
    for (const code of codesOf(x.style)) seen.set(cacheKey(code, x.size), { sku: code, size: x.size });
  }
  return [...seen.values()];
}

/* -------------------------------- the answer ------------------------------- */

// Market + markup, rounded UP to the cent (Temu takes 2 decimals), in integers.
export function temuFloorCents(marketCents, pctH) {
  return Number((BigInt(marketCents) * BigInt(10000 + pctH) + 9999n) / 10000n);
}
const usd = (cents) => (cents / 100).toFixed(2);

// One answer per row. `fills` = what goes in the file; `report` = every row of the file.
export function applyReprice(rows, cache, pctH, { counter = true, reason = DEFAULT_REASON, activeOnly = false } = {}) {
  const n = { accept: 0, propose: 0, tooLow: 0, noCounter: 0, nodata: 0, skipped: 0, reductionCents: 0 };
  const fills = [];
  const report = [];
  for (const x of rows) {
    const base = { ...x, market: '', floor: '', action: '', newPrice: '' };
    const why = skipReason(x, { activeOnly });
    if (why) { n.skipped++; report.push({ ...base, note: why }); continue; }
    const answers = codesOf(x.style).map((c) => cache[cacheKey(c, x.size)]);
    const ok = answers.filter((a) => a?.status === 'ok' && a.valueCents > 0);
    if (!ok.length) {
      n.nodata++;
      const s = answers.find(Boolean)?.status;
      report.push({ ...base, note: s === 'not_listed' ? 'Not on Alias' : s === 'bad_size' ? 'Size not in the Alias catalogue' : 'No market price today' });
      continue;
    }
    const market = Math.min(...ok.map((a) => a.valueCents));
    const floor = temuFloorCents(market, pctH);
    const row = { ...base, market: usd(market), floor: usd(floor) };
    if (x.recCents >= floor) {
      n.accept++; n.reductionCents += x.currentCents - x.recCents;
      fills.push({ line: x.line, skuId: x.skuId, action: ACCEPT, price: '', reason: '' });
      report.push({ ...row, action: ACCEPT, note: 'Temu’s price is at or above market + markup' });
    } else if (floor >= x.currentCents) {
      n.tooLow++;
      report.push({ ...row, note: 'Market + markup is at or above today’s price — never raised, Temu’s price not accepted' });
    } else if (!counter || !x.actions.includes(PROPOSE)) {
      n.noCounter++;
      report.push({ ...row, note: counter ? 'Temu’s price is under market + markup and this row only offers Accept' : 'Temu’s price is under market + markup (counter-offers are off)' });
    } else {
      n.propose++; n.reductionCents += x.currentCents - floor;
      fills.push({ line: x.line, skuId: x.skuId, action: PROPOSE, price: usd(floor), reason });
      report.push({ ...row, action: PROPOSE, newPrice: usd(floor), note: 'Temu’s price is under market + markup — countered at it' });
    }
  }
  return { fills, report, n };
}

// Temu takes up to 1,000 answered lines per file: more than that becomes several files,
// each the whole template with its own share of the answers.
export const partsOf = (fills) => {
  const out = [];
  for (let i = 0; i < fills.length; i += MAX_FILLED) out.push(fills.slice(i, i + MAX_FILLED));
  return out;
};

/* ------------------------------ filling the file --------------------------- */

// Put text in one cell of a row's XML: the cell's own style is kept; a cell Excel dropped
// on save is put back in column order.
function setCell(rowXml, col, line, text) {
  const ref = `${colLetters(col)}${line}`;
  const make = (attrs) => {
    const s = (attrs.match(/\bs="(\d+)"/) || [])[1];
    return `<c r="${ref}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t>${escXml(text)}</t></is></c>`;
  };
  let done = false;
  let out = rowXml.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (m, attrs) => {
    if (done || (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1] !== ref) return m;
    done = true;
    return make(attrs);
  });
  if (done) return out;
  out = rowXml.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (m, attrs) => {
    const c = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
    if (done || !c || colNum(c) < col) return m;
    done = true;
    return make('') + m;
  });
  return done ? out : rowXml.replace(/<\/row>\s*$/, `${make('')}</row>`);
}

export function fillTemplate(file, fills) {
  const book = openWorkbook(file.bytes);
  const path = book.sheets.find((s) => s.name.trim().toLowerCase() === SHEET.toLowerCase()).path;
  const by = new Map(fills.map((f) => [f.line, f]));
  const xml = td.decode(book.files[path]).replace(/<row\b[^>]*?\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g, (m, r) => {
    const f = by.get(Number(r));
    if (!f) return m;
    let row = setCell(m, file.at.action, f.line, f.action);
    if (f.price) row = setCell(row, file.at.newPrice, f.line, f.price);
    if (f.reason) row = setCell(row, file.at.reason, f.line, f.reason);
    return row;
  });
  return zipSync({ ...book.files, [path]: te.encode(xml) }, { level: 6 });
}

// Read the built file back and check it is what we meant to send — the download stays
// locked unless every check passes (eBay and SHEIN Reprice do the same).
export function verifyOutput(file, outBytes, fills, floorBySkuId = new Map()) {
  let out = null;
  try { out = openWorkbook(outBytes); unzipSync(outBytes); } catch { out = null; }
  if (!out) return { ok: false, checks: [{ label: 'The file opens', ok: false, detail: 'not a valid .xlsx' }] };
  const checks = [];
  const tpl = openWorkbook(file.bytes);
  const path = tpl.sheets.find((s) => s.name.trim().toLowerCase() === SHEET.toLowerCase()).path;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const others = Object.keys(tpl.files).filter((k) => k !== path);
  const changed = others.filter((k) => !same(tpl.files[k], out.files[k]));
  checks.push({ label: 'Instructions, Data Definitions and the rest of Temu’s file untouched', ok: !changed.length && Object.keys(out.files).length === Object.keys(tpl.files).length,
    detail: changed.length ? `changed: ${changed.join(', ')}` : `${others.length} parts identical` });

  const a = readSheet(tpl, SHEET);
  const b = readSheet(out, SHEET);
  const ours = new Set([file.at.action, file.at.newPrice, file.at.reason]);
  const byLine = new Map(fills.map((f) => [f.line, f]));
  let drift = 0;
  for (let r = 0; r < Math.max(a.length, b.length); r++) {
    const ra = a[r] || []; const rb = b[r] || [];
    for (let c = 0; c < Math.max(ra.length, rb.length); c++) {
      if (byLine.has(r + 1) && ours.has(c)) continue;
      if (String(ra[c] ?? '') !== String(rb[c] ?? '')) drift++;
    }
  }
  checks.push({ label: 'Every cell outside the answers is as Temu sent it', ok: a.length === b.length && drift === 0, detail: drift ? `${drift} cells differ` : `${a.length} rows identical` });

  const src = new Map(file.rows.map((x) => [x.line, x]));
  let bad = 0; const badAt = [];
  for (const f of fills) {
    const g = b[f.line - 1] || []; const x = src.get(f.line);
    const act = String(g[file.at.action] ?? ''); const price = String(g[file.at.newPrice] ?? ''); const reason = String(g[file.at.reason] ?? '');
    const cents = priceCents(price);
    const floor = floorBySkuId.get(f.skuId);
    let fine = !!x && String(g[file.at.skuId] ?? '') === f.skuId && x.actions.includes(act);
    if (fine && act === ACCEPT) fine = !price && !reason && (floor == null || x.recCents >= floor);
    else if (fine && act === PROPOSE) fine = /^\d+\.\d{2}$/.test(price) && cents < x.currentCents && cents > x.recCents && file.reasons.includes(reason) && (floor == null || cents === floor);
    else fine = false;
    if (!fine) { bad++; if (badAt.length < 5) badAt.push(`row ${f.line}`); }
  }
  checks.push({ label: 'Every answer: one the row’s own dropdown offers · Accept only at or above market + markup · a counter below today’s price, with a reason from Temu’s list', ok: bad === 0,
    detail: bad ? `${bad} bad (${badAt.join(', ')})` : `${fills.length} answers OK` });
  checks.push({ label: `No more than ${MAX_FILLED.toLocaleString('en-US')} answered lines in one file`, ok: fills.length <= MAX_FILLED, detail: `${fills.length}` });
  return { ok: checks.every((c) => c.ok), checks };
}

/* --------------------------------- outputs --------------------------------- */

// Today's EST day: Temu's file name carries a number, not a date.
export function outputName(ymd, part, parts) {
  const m = String(ymd || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  const day = m ? ` (${Number(m[2])}.${Number(m[3])}.${m[1]})` : '';
  return `Temu reprice${day}${parts > 1 ? ` part ${part} of ${parts}` : ''}.xlsx`;
}

const BOM = '﻿';
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportText(report, pctLabel) {
  const head = ['Row', 'Goods ID', 'SKU ID', 'SKU', 'Product name', 'Variation', 'Size', 'Style ID', 'Style from', 'Product status',
    'Current base price', 'Temu recommended', 'Market price', `Market +${pctLabel}%`, 'Action', 'New base price', 'Note'];
  const rows = report.map((r) => [r.line, r.goods, r.skuId, r.sku, r.name, r.variation, r.size, r.style, r.styleFrom, r.status,
    r.currentText, r.recText, r.market, r.floor, r.action, r.newPrice, r.note]);
  return BOM + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
