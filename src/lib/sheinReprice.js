// SHEIN Reprice — PURE helpers (docs/context/shein-reprice.md). Same job as eBay Reprice:
// cut every SHEIN listing priced above today's market + markup down to it, never up. The
// difference is the files: SHEIN works in .xlsx both ways.
//   in   SHEIN Seller Center → Products → Export Products (sheet "Product Information")
//   out  SHEIN's own "Edit+Price" template, its sheet "sheet1" filled from row 4 down; the
//        Guide and Site currency list tabs and rows 1–3 left exactly as SHEIN made them.
// The spec is the PH team's narrated walkthrough of 2026-10-10.
import { unzipSync, zipSync } from 'fflate';
import { styleFromTitle, cacheKey } from './ebayReprice.js';

/* ------------------------------ reading xlsx ------------------------------ */

const td = new TextDecoder();
const te = new TextEncoder();
const unescXml = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
// Every <t>…</t> inside one <si> / <is> (rich text is several runs).
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescXml(m[1])).join('');
const colIndex = (ref) => {
  const letters = String(ref).match(/^[A-Z]+/)?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

// The zip's entries and where each sheet NAME lives (workbook.xml + its rels).
function openWorkbook(bytes) {
  let files;
  try { files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch { return null; }
  const wb = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (!wb || !rels) return null;
  const relXml = td.decode(rels);
  const target = new Map([...relXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    (m[0].match(/\bId="([^"]+)"/) || [])[1], (m[0].match(/\bTarget="([^"]+)"/) || [])[1],
  ]));
  const sheets = [...td.decode(wb).matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = unescXml((m[0].match(/\bname="([^"]*)"/) || [])[1] || '');
    const rid = (m[0].match(/\br:id="([^"]+)"/) || [])[1];
    let t = target.get(rid) || '';
    t = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
    return { name, path: t };
  });
  return { files, sheets };
}

// One sheet as rows of strings, by its position in the sheet: grid[r][c] (0-based).
function readSheet(book, name) {
  const sheet = book.sheets.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  if (!sheet || !book.files[sheet.path]) return null;
  const ss = book.files['xl/sharedStrings.xml'];
  const shared = ss ? [...td.decode(ss).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const grid = [];
  for (const rm of td.decode(book.files[sheet.path]).matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number((rm[1].match(/\br="(\d+)"/) || [])[1]) - 1;
    const row = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const c = colIndex((attrs.match(/\br="([A-Z]+)\d+"/) || [])[1]);
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      const inner = cm[2] || '';
      let v = '';
      if (type === 'inlineStr') v = textOf(inner);
      else {
        const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (raw != null) v = type === 's' ? (shared[Number(raw)] ?? '') : unescXml(raw);
      }
      row[c] = v;
    }
    if (r >= 0) grid[r] = row;
  }
  return grid;
}

// A sheet of any .xlsx as rows of strings (tests read the download back with it).
export function readSheetRows(bytes, name) {
  const book = openWorkbook(bytes);
  return book ? readSheet(book, name) : null;
}

/* --------------------------- the export, row by row ------------------------- */

// Columns found BY HEADER NAME (SHEIN reorders exports): what each one is for.
const COLS = {
  sku: (h) => h === 'SKU',
  size: (h) => h === 'Secondary Specification Value1',
  desc: (h) => h === 'Default product description(en)',
  name: (h) => h === 'Default Product Name(en)',
  price: (h) => /^Original Price\(/.test(h),
  special: (h) => /^Special Offer\(/.test(h),
};
const NEEDED = { sku: 'SKU', size: 'Secondary Specification Value1', desc: 'Default product description(en)', price: 'Original Price(…)' };

// "US10.5" / "US9.5W" / "US 7" → "10.5" / "9.5" / "7". The narration: drop "US", "W" and
// any letter. Anything that isn't a single US size (EUR 38, CN 40, "7 Toddler", US7-8) is
// NOT guessed at — those rows are skipped and named in the report.
export function sheinSize(raw) {
  const m = String(raw ?? '').trim().match(/^US\s*(\d{1,2}(?:\.\d)?)\s*[A-Z]{0,2}$/i);
  return m ? String(Number(m[1])) : '';
}

const plausibleCode = (t) => /\d/.test(t) && t.length >= 4 && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(t);
// The style code: the first line of the description starts with it ("CD5010-100" then the
// store blurb). A few listings put it at the END of that line ("… – IB4025-100") or only in
// the product name; those are found the way eBay Reprice reads a title. None → skipped.
export function sheinStyle(desc, name) {
  const first = String(desc ?? '').split(/\r?\n/)[0].trim();
  const lead = first.split(/\s+/)[0] || '';
  if (plausibleCode(lead)) return { style: lead.toUpperCase(), from: 'description' };
  const inLine = styleFromTitle(first);
  if (inLine) return { style: inLine.toUpperCase(), from: 'description (in the line)' };
  const inName = styleFromTitle(name);
  if (inName) return { style: inName.toUpperCase(), from: 'product name' };
  return { style: '', from: '' };
}

// Plain price text → cents; null when it isn't one. "82.00" → 8200.
export function priceCents(text) {
  const m = String(text ?? '').trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : null;
}

export function readExportFile(bytes) {
  const book = openWorkbook(bytes);
  if (!book) return { ok: false, error: 'Not an Excel file (.xlsx) — use SHEIN’s Export Products download.' };
  const grid = readSheet(book, 'Product Information');
  if (!grid) return { ok: false, error: `No "Product Information" sheet — this file has: ${book.sheets.map((s) => s.name).join(', ')}. Is it the Export Products file?` };
  const head = (grid[0] || []).map((h) => String(h ?? '').replace(/ /g, ' ').trim());
  const at = {};
  for (const [k, test] of Object.entries(COLS)) { const i = head.findIndex(test); if (i >= 0) at[k] = i; }
  const missing = Object.keys(NEEDED).filter((k) => at[k] == null);
  if (missing.length) return { ok: false, error: `Missing column${missing.length === 1 ? '' : 's'}: ${missing.map((k) => NEEDED[k]).join(', ')}.` };
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const g = grid[r];
    if (!g || !String(g[at.sku] ?? '').trim()) continue;
    const { style, from } = sheinStyle(g[at.desc], at.name != null ? g[at.name] : '');
    const sizeRaw = String(g[at.size] ?? '').trim();
    rows.push({
      line: r + 1,
      sku: String(g[at.sku]).trim(),
      name: at.name != null ? String(g[at.name] ?? '').trim() : '',
      sizeRaw, size: sheinSize(sizeRaw),
      style, styleFrom: from,
      priceText: String(g[at.price] ?? '').trim(),
      priceCents: priceCents(g[at.price]),
      specialCents: at.special != null ? priceCents(g[at.special]) : null,
      specialText: at.special != null ? String(g[at.special] ?? '').trim() : '',
    });
  }
  if (!rows.length) return { ok: false, error: 'No product rows in the Product Information sheet.' };
  const dupes = rows.length - new Set(rows.map((x) => x.sku)).size;
  return {
    ok: true, rows, dupes,
    stats: {
      rows: rows.length,
      noSize: rows.filter((x) => !x.sizeRaw).length,
      oddSize: rows.filter((x) => x.sizeRaw && !x.size).length,
      noStyle: rows.filter((x) => !x.style).length,
      noPrice: rows.filter((x) => x.priceCents == null).length,
    },
  };
}

// Why a row can't be priced, or '' when it can.
export function skipReason(x) {
  if (!x.sizeRaw) return 'No size';
  if (!x.size) return `Size "${x.sizeRaw}" is not a single US size`;
  if (!x.style) return 'No style code in the description or name';
  if (x.priceCents == null) return `No current price ("${x.priceText}")`;
  return '';
}

const codesOf = (style) => String(style || '').split('/').map((p) => p.trim()).filter(Boolean);

// Every (style, size) the file needs priced — the same jobs eBay Reprice sends, so the
// two pages share one day's cache.
export function jobsFor(rows) {
  const seen = new Map();
  for (const x of rows) {
    if (skipReason(x)) continue;
    for (const code of codesOf(x.style)) seen.set(cacheKey(code, x.size), { sku: code, size: x.size });
  }
  return [...seen.values()];
}

/* ------------------------------- the markup -------------------------------- */

// ALWAYS rounded UP to a whole dollar (the walkthrough: 120.75 → 121, "we will do a round
// up"), in integers — no float touches it. 100 @ 15 % → 115; 104.35 @ 15 % → 121 (120.0025).
export function sheinRepriceDollars(marketCents, pctH) {
  const p = BigInt(marketCents) * BigInt(10000 + pctH);   // dollars × 1,000,000
  return Number((p + 999999n) / 1000000n);
}

// Cut every priced row above market+markup down to it — never up. Returns the rows for the
// upload (only the cuts) and a report row for EVERY export row.
export function applyReprice(rows, cache, pctH) {
  const n = { lower: 0, higher: 0, equal: 0, nodata: 0, skipped: 0, special: 0, reductionCents: 0 };
  const upload = [];
  const report = [];
  for (const x of rows) {
    const base = { sku: x.sku, style: x.style, sizeRaw: x.sizeRaw, size: x.size, old: x.priceText, special: x.specialText, market: '', reprice: '' };
    const why = skipReason(x);
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
    const dollars = sheinRepriceDollars(market, pctH);
    const cents = dollars * 100;
    const row = { ...base, market: (market / 100).toFixed(2), reprice: String(dollars) };
    if (cents >= x.priceCents) {
      if (cents === x.priceCents) n.equal++; else n.higher++;
      report.push({ ...row, action: 'kept', note: cents === x.priceCents ? 'Already at market + markup' : 'Market + markup is higher — never raised' });
      continue;
    }
    // SHEIN rejects an original price at or under the special offer, and the row would fail
    // in their upload — so it isn't sent; a person decides (end the promo, or leave it).
    if (x.specialCents > 0 && cents <= x.specialCents) {
      n.special++;
      report.push({ ...row, action: 'kept', note: `Special offer $${x.specialText} is at or above the new price — not sent` });
      continue;
    }
    n.lower++;
    n.reductionCents += x.priceCents - cents;
    // A live special offer is carried over rather than blanked: blank may END the promo.
    upload.push({ sku: x.sku, price: String(dollars), special: x.specialCents > 0 ? x.specialText : '' });
    report.push({ ...row, action: 'lowered', note: x.specialCents > 0 ? `Special offer $${x.specialText} kept` : '' });
  }
  return { upload, report, n };
}

/* ------------------------------ the template ------------------------------- */

const SHEET = 'sheet1';
const FIRST_ROW = 4;   // rows 1–3 are SHEIN's header, guide and example

// The template's own check: it has a "sheet1" whose row 1 is the five columns we fill.
export function readTemplateFile(bytes) {
  const book = openWorkbook(bytes);
  if (!book) return { ok: false, error: 'Not an Excel file (.xlsx) — use SHEIN’s Edit+Price template.' };
  const grid = readSheet(book, SHEET);
  if (!grid) return { ok: false, error: `No "${SHEET}" sheet — this file has: ${book.sheets.map((s) => s.name).join(', ')}.` };
  const head = (grid[0] || []).slice(0, 5).map((h) => String(h ?? '').trim());
  const want = ['Field Code', 'SKU', 'Currency', 'Original Price', 'Special Offer'];
  if (want.some((w, i) => head[i] !== w)) return { ok: false, error: `Row 1 of ${SHEET} should read ${want.join(' · ')} — it reads ${head.join(' · ') || '(blank)'}.` };
  const extra = grid.slice(FIRST_ROW - 1).filter((r) => r && r.some((v) => String(v ?? '').trim())).length;
  return { ok: true, bytes: new Uint8Array(bytes), extra };
}

// The filled template: every entry of the zip byte-for-byte as it came EXCEPT sheet1, where
// rows from 4 down are replaced with ours (A Field Code blank · B SKU · C USD · D Original
// Price · E Special Offer). Written as text cells, like SHEIN's own example row.
export function fillTemplate(templateBytes, upload) {
  const book = openWorkbook(templateBytes);
  const sheet = book.sheets.find((s) => s.name.trim().toLowerCase() === SHEET);
  let xml = td.decode(book.files[sheet.path]);
  // Drop anything already below row 3 (a template someone half-filled).
  xml = xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>\s*/g, (m, r) => (Number(r) >= FIRST_ROW ? '' : m));
  const cell = (ref, v) => (v === '' ? '' : `<c r="${ref}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`);
  const rowsXml = upload.map((u, i) => {
    const r = FIRST_ROW + i;
    return `<row r="${r}">${cell(`B${r}`, u.sku)}${cell(`C${r}`, 'USD')}${cell(`D${r}`, u.price)}${cell(`E${r}`, u.special)}</row>\n`;
  }).join('');
  xml = xml.replace(/<\/sheetData>/, `${rowsXml}</sheetData>`);
  const last = Math.max(FIRST_ROW - 1, FIRST_ROW - 1 + upload.length);
  xml = xml.replace(/<dimension ref="[^"]*"\s*\/>/, `<dimension ref="A1:E${last}"/>`);
  return zipSync({ ...book.files, [sheet.path]: te.encode(xml) }, { level: 6 });
}

// Read the built file back and check it is what we meant to send — the download stays
// locked unless every check passes (eBay Reprice does the same).
export function verifyOutput(templateBytes, outBytes, upload, exportRows) {
  const checks = [];
  const tpl = openWorkbook(templateBytes);
  const out = openWorkbook(outBytes);
  if (!out) return { ok: false, checks: [{ label: 'The file opens', ok: false, detail: 'not a valid .xlsx' }] };
  const sheetPath = tpl.sheets.find((s) => s.name.trim().toLowerCase() === SHEET).path;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
  const others = Object.keys(tpl.files).filter((k) => k !== sheetPath);
  const changed = others.filter((k) => !same(tpl.files[k], out.files[k]));
  checks.push({ label: 'Guide, Site currency list and the rest of the template untouched', ok: !changed.length && Object.keys(out.files).length === Object.keys(tpl.files).length,
    detail: changed.length ? `changed: ${changed.join(', ')}` : `${others.length} parts identical` });
  const a = readSheet(tpl, SHEET);
  const b = readSheet(out, SHEET);
  const head = [0, 1, 2].every((r) => JSON.stringify(a[r] || []) === JSON.stringify(b[r] || []));
  checks.push({ label: 'Rows 1–3 (header, guide, example) as SHEIN made them', ok: head, detail: head ? 'identical' : 'differ' });
  const data = b.slice(FIRST_ROW - 1).filter((r) => r && r.some((v) => String(v ?? '').trim()));
  checks.push({ label: 'One row per price cut', ok: data.length === upload.length, detail: `${data.length} rows, ${upload.length} cuts` });
  const byS = new Map(exportRows.map((x) => [x.sku, x]));
  let bad = 0; const badSkus = [];
  const seen = new Set();
  for (const r of data) {
    const sku = String(r[1] ?? ''); const price = priceCents(r[3]); const sp = priceCents(r[4]);
    const src = byS.get(sku);
    const fine = src && !seen.has(sku) && !String(r[0] ?? '').trim() && r[2] === 'USD'
      && price != null && price % 100 === 0 && price < src.priceCents && (!r[4] || sp < price);
    seen.add(sku);
    if (!fine) { bad++; if (badSkus.length < 5) badSkus.push(sku || '(blank)'); }
  }
  checks.push({ label: 'Every row: a SHEIN SKU from the export, once · USD · a whole-dollar price below today’s · special under it', ok: bad === 0,
    detail: bad ? `${bad} bad (${badSkus.join(', ')})` : `${data.length} rows OK` });
  return { ok: checks.every((c) => c.ok), checks };
}

/* -------------------------------- outputs --------------------------------- */

// "Export Products_2026-10-09 13_36_02.xlsx" → "SHEIN reprice (10.9.2026).xlsx".
export function outputName(sourceName, fallbackYmd) {
  const m = String(sourceName || '').match(/(\d{4})-(\d{2})-(\d{2})/) || String(fallbackYmd || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `SHEIN reprice (${Number(m[2])}.${Number(m[3])}.${m[1]}).xlsx` : 'SHEIN reprice.xlsx';
}

const BOM = '﻿';
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportText(report, pctLabel) {
  const head = ['SHEIN SKU', 'Style code', 'Size (SHEIN)', 'Size', 'Current price', 'Special offer', 'Market price', `New price (+${pctLabel}%, rounded up)`, 'Action', 'Note'];
  const rows = report.map((r) => [r.sku, r.style, r.sizeRaw, r.size, r.old, r.special, r.market, r.reprice, r.action, r.note]);
  return BOM + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
