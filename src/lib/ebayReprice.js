// eBay reprice — the pure half (docs/context/ebay-reprice.md). Ported from the
// ebay-reprice skill's scripts (csvraw / add_styleid / apply_reprice / finalize /
// verify), which stay the reference: every rule here is one of theirs.
//
// Everything works on the RAW TEXT of the eBay file. The export carries a UTF-8 BOM, LF
// endings, inconsistent quoting and a comma-padded #INFO first line; a generic CSV
// writer restyles all of it and eBay then misparses the file. So a line is split on
// commas outside quotes KEEPING each field's quotes, one field is swapped, and the line
// is joined back byte-for-byte. The uploads themselves are never modified — every
// function returns new text, and `verifyOutput` diffs the result against the original.

const BOM = '﻿';

/* ------------------------------ raw CSV lines ------------------------------ */

// Split one line on commas outside quotes, keeping each field's raw text (quotes and
// all), so `fields.join(',')` rebuilds the line exactly.
export function splitRaw(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '""'; i++; continue; }
      inQ = !inQ;
      cur += c;
    } else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (raw) => {
  const t = raw.replace(/\r$/, '');
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t;
};
// Field VALUES for one line (quotes resolved) — for reading, never for writing.
export const parseLine = (line) => splitRaw(line).map(unquote);

// { lines, trailing, bom } — lines exclude the BOM; `trailing` = the file ended in "\n".
export function loadText(text) {
  const bom = text.startsWith(BOM);
  const lines = (bom ? text.slice(1) : text).split('\n');
  const trailing = lines.length > 0 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  return { lines, trailing, bom };
}
// Back to file text with the BOM and LF endings eBay's template uses.
export const saveText = (lines, trailing) => BOM + lines.join('\n') + (trailing ? '\n' : '');

// The header is the row whose first cell is exactly "Action" (row 0 is the #INFO line).
export function headerIndex(lines) {
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const f = parseLine(lines[i]);
    if (f.length && f[0].trim() === 'Action') return { hdr: new Map(f.map((n, idx) => [n.trim(), idx])), hrow: i };
  }
  return null;
}

// Render a price in the style of the cell it replaces: quoted stays quoted, "85.0" → "96.0".
export function formatLike(oldRaw, dollars) {
  const quoted = oldRaw.length >= 2 && oldRaw.startsWith('"') && oldRaw.endsWith('"');
  const inner = quoted ? oldRaw.slice(1, -1) : oldRaw;
  const text = inner.includes('.') ? `${dollars}.0` : String(dollars);
  return quoted ? `"${text}"` : text;
}

// Sizes named by a "Relationship details" cell. A size row names ONE ("Size=9"); a
// parent row lists them all ("Size=6;6.5;7") — a table of contents, not a sellable size.
export function sizesOf(rel) {
  let v = String(rel || '').trim();
  if (v.includes('=')) v = v.slice(v.indexOf('=') + 1);
  return v.split(';').map((s) => s.trim()).filter(Boolean);
}

// A whole CSV file → rows of values (RFC 4180: quoted commas, "" escapes, CRLF or LF).
export function parseCsv(text) {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* ------------------------------- the uploads ------------------------------- */

const REVISE_COLUMNS = ['Action', 'Item number', 'Title', 'Start price', 'Available quantity', 'Relationship details', 'Custom label (SKU)'];

// FIELD 1 — the eBay revise-price export. Returns { ok, error } or the parsed shape.
export function readReviseFile(text) {
  const { lines, trailing } = loadText(text);
  const h = headerIndex(lines);
  if (!h) return { ok: false, error: 'This isn’t an eBay revise-price file — no row starting with “Action” in its first 5 lines.' };
  const missing = REVISE_COLUMNS.filter((c) => !h.hdr.has(c));
  if (missing.length) return { ok: false, error: `The eBay file is missing ${missing.map((m) => `“${m}”`).join(', ')}.` };
  const sizeRows = lines.slice(h.hrow + 1).filter((l) => {
    const f = parseLine(l);
    return String(f[h.hdr.get('Custom label (SKU)')] || '').trim() && sizesOf(f[h.hdr.get('Relationship details')]).length === 1;
  }).length;
  return { ok: true, lines, trailing, ...h, dataRows: lines.length - h.hrow - 1, sizeRows };
}

const norm = (s) => String(s).trim().toLowerCase().replace(/[\s_]/g, '');

// FIELD 2 — the inventory information report. Columns are found BY NAME (their order
// changes month to month); a missing one is a hard stop, never a positional guess —
// reading by position once mapped every SKU to a product name.
export function readInventoryFile(text) {
  const rows = parseCsv(text);
  const header = rows[0] || [];
  const find = (...names) => {
    for (const want of names) { const i = header.findIndex((c) => norm(c) === want); if (i >= 0) return i; }
    return -1;
  };
  const cStyle = find('styleid', 'style');
  const cSku = find('sku', 'customlabel');
  if (cStyle < 0 || cSku < 0) {
    return { ok: false, error: `Couldn’t find the “Style ID” and “SKU” columns. Header was: ${header.map((h) => `“${h}”`).join(', ') || '(empty)'}` };
  }
  const sku2style = new Map();
  const styles = new Set();
  const conflicts = new Map();   // sku → Set of every style it maps to
  let units = 0;
  for (const r of rows.slice(1)) {
    if (r.length <= Math.max(cStyle, cSku)) continue;
    const style = r[cStyle].trim();
    const sku = r[cSku].trim();
    if (!sku && !style) continue;
    units++;
    if (style) styles.add(style);
    if (sku && style) {
      const had = sku2style.get(sku);
      if (had && had !== style) conflicts.set(sku, new Set([...(conflicts.get(sku) || [had]), style]));
      if (!had) sku2style.set(sku, style);
    }
  }
  return { ok: true, sku2style, styles, conflicts, units, columns: { style: header[cStyle], sku: header[cSku] } };
}

/* ------------------------- step 1: StyleID per row ------------------------- */

// Last resort: the style code printed in the title. The last parenthetical is as often
// "(Women's)" or "(GS)" as a code, so every candidate is judged: a real code has a digit
// and ≥ 4 characters, and one the inventory report already knows wins (corroborated).
export function styleFromTitle(title, knownStyles = new Set()) {
  const t = String(title || '');
  const candidates = [...t.matchAll(/\(([^()]+)\)/g)].map((m) => m[1].trim()).reverse();
  const m = t.trim().match(/[-–]\s*([A-Z0-9][A-Z0-9\- ]{3,})$/);
  if (m) candidates.push(m[1].trim());
  const plausible = candidates.filter((c) => /\d/.test(c) && c.length >= 4 && /^[A-Za-z0-9][A-Za-z0-9 ./-]*$/.test(c));
  return plausible.find((c) => knownStyles.has(c)) || plausible[0] || '';
}

// Group each parent row with the size rows after it, and give every row a StyleID:
// direct SKU match → the listing's sibling sizes (only if they agree) → the title.
// Returns { groups, stats }. A group's `issue` is why a person has to decide first:
//   'blank'        some rows have no style at all
//   'conflict'     the sizes' known styles disagree — left blank rather than guessed
//   'sku_conflict' a SKU here maps to two styles in the report
// `unverified` (not blocking) = a title-derived code the report has never seen.
export function resolveStyles(revise, inv) {
  const { lines, hdr, hrow } = revise;
  const cSku = hdr.get('Custom label (SKU)');
  const cTitle = hdr.get('Title');
  const groups = [];
  let cur = null;
  for (let i = hrow + 1; i < lines.length; i++) {
    const f = parseLine(lines[i]);
    const sku = (f[cSku] || '').trim();
    if (!sku) {
      cur = { id: groups.length, parent: i, title: f[cTitle] || '', item: f[hdr.get('Item number')] || '', rows: [] };
      groups.push(cur);
    } else {
      if (!cur) { cur = { id: groups.length, parent: null, title: '', item: '', rows: [] }; groups.push(cur); }
      cur.rows.push({ line: i, sku });
    }
  }
  const stats = { direct: 0, fromSibling: 0, fromTitle: 0, blank: 0, groupConflict: 0 };
  for (const g of groups) {
    const known = new Set(g.rows.filter((r) => inv.sku2style.has(r.sku)).map((r) => inv.sku2style.get(r.sku)));
    let fallback = '';
    g.knownStyles = [...known];
    if (known.size > 1) { stats.groupConflict++; g.issue = 'conflict'; } else fallback = known.size ? [...known][0] : '';
    if (!fallback && !g.issue && g.title) {
      const guess = styleFromTitle(g.title, inv.styles);
      if (guess) {
        fallback = guess;
        g.fromTitle = true;
        stats.fromTitle++;
        if (!inv.styles.has(guess)) g.unverified = guess;
      }
    }
    for (const r of g.rows) {
      if (inv.sku2style.has(r.sku)) { stats.direct++; r.style = inv.sku2style.get(r.sku); r.source = 'direct'; } else if (fallback) { stats.fromSibling++; r.style = fallback; r.source = g.fromTitle ? 'title' : 'sibling'; } else { stats.blank++; r.style = ''; r.source = 'blank'; }
      if (inv.conflicts.has(r.sku)) { g.issue = g.issue || 'sku_conflict'; g.skuConflicts = [...(g.skuConflicts || []), [r.sku, [...inv.conflicts.get(r.sku)]]]; }
    }
    if (g.issue === 'conflict') for (const r of g.rows) { if (r.source !== 'direct') r.style = ''; }
    if (!g.issue && g.rows.some((r) => !r.style)) g.issue = 'blank';
    g.style = fallback;
  }
  return { groups, stats };
}

// Every row's effective StyleID once the person's decisions are in. `decisions` maps a
// group id → { style } (use it for every size of that listing) or { skip: true } (leave
// the listing's prices alone). An undecided issue group returns `pending`.
export function effectiveStyles(groups, decisions = {}) {
  const styleAt = new Map();
  const pending = [];
  for (const g of groups) {
    const d = decisions[g.id];
    if (g.issue && !d) pending.push(g);
    for (const r of g.rows) {
      const s = d?.skip ? '' : d?.style ? d.style.trim() : g.issue === 'conflict' || g.issue === 'sku_conflict' ? '' : r.style;
      styleAt.set(r.line, s);
    }
  }
  return { styleAt, pending };
}

/* ----------------------------- step 2: the jobs ----------------------------- */

const codesOf = (style) => String(style || '').split('/').map((p) => p.trim()).filter(Boolean);
export const cacheKey = (sku, size) => `${sku}|${size}`;

// Every (style code, size) the file needs priced: single-size rows with a style and a
// Start price. "G57540 / 100252505" is one job PER CODE — the API takes the joined
// string without complaint and prices only the first.
export function jobsFor(revise, styleAt) {
  const { lines, hdr, hrow } = revise;
  const cRel = hdr.get('Relationship details');
  const cPrice = hdr.get('Start price');
  const seen = new Map();
  for (let i = hrow + 1; i < lines.length; i++) {
    const f = parseLine(lines[i]);
    const sizes = sizesOf(f[cRel]);
    const style = styleAt.get(i) || '';
    if (sizes.length !== 1 || !style || !String(f[cPrice] || '').trim()) continue;
    for (const code of codesOf(style)) seen.set(cacheKey(code, sizes[0]), { sku: code, size: sizes[0] });
  }
  return [...seen.values()];
}

/* --------------------------- step 3: the markup ----------------------------- */

// The markup as typed ("12", "12.5") → hundredths of a percent, or null when invalid.
// 0–100 % only: a fat finger can't push the whole store somewhere absurd.
export function parseMarkup(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const h = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  return h >= 0 && h <= 10000 ? h : null;
}
// 1200 → "1.12", 1250 → "1.125", 0 → "1" — the label every output carries.
export function multiplierLabel(pctH) {
  const n = 10000 + pctH;
  return `${Math.floor(n / 10000)}${n % 10000 ? `.${String(n % 10000).padStart(4, '0').replace(/0+$/, '')}` : ''}`;
}
// round_half_up(market × (1 + pct/100)) to whole dollars, in integers — no float ever
// touches the arithmetic. 86 @ 12 % → 96 (96.32), 144 @ 12 % → 161 (161.28).
export function repriceDollars(marketCents, pctH) {
  const p = BigInt(marketCents) * BigInt(10000 + pctH);   // dollars × 1,000,000
  return Number((p + 500000n) / 1000000n);
}
// "85.0" / "85" / "85.50" → cents; null when it isn't a plain price.
export function priceCents(text) {
  const m = String(text ?? '').trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const frac = (m[2] || '').padEnd(3, '0');
  return Number(m[1]) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
}
const dollarsText = (cents) => (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

/* ------------------------ step 3: apply + finalize ------------------------- */

export const DROP_COLUMNS = ['Available quantity'];

// Cut every size row priced above market+markup down to it — never up. Returns the
// finished upload text (unless `dryRun`), the audit report rows and the tally.
export function applyReprice(revise, styleAt, cache, pctH, { dryRun = false } = {}) {
  const { lines, hdr, hrow, trailing } = revise;
  const cPrice = hdr.get('Start price');
  const cRel = hdr.get('Relationship details');
  const cSku = hdr.get('Custom label (SKU)');
  const cTitle = hdr.get('Title');
  const out = lines.slice(0, hrow + 1);
  const report = [];
  const n = { lower: 0, higher: 0, equal: 0, nodata: 0, reductionCents: 0 };
  let title = '';
  for (let i = hrow + 1; i < lines.length; i++) {
    let line = lines[i];
    const f = parseLine(line);
    const sizes = sizesOf(f[cRel]);
    if (sizes.length > 1 || !String(f[cSku] || '').trim()) title = f[cTitle] || title;
    const style = styleAt.get(i) || '';
    if (sizes.length !== 1 || !style || !String(f[cPrice] || '').trim()) { out.push(line); continue; }
    const size = sizes[0];
    const codes = codesOf(style);
    const quotes = codes.map((c) => [c, cache[cacheKey(c, size)] || {}]);
    const priced = quotes.filter(([, q]) => q.status === 'ok' && q.valueCents != null);
    const oldCents = priceCents(f[cPrice]);
    const base = { sku: f[cSku], style, size, old: f[cPrice], title };
    if (!priced.length || oldCents == null) {
      n.nodata++;
      report.push({ ...base, market: '', reprice: '', action: 'no data -- left unchanged',
        note: oldCents == null ? 'bad_start_price' : quotes.map(([c, q]) => `${c}:${q.status || 'missing'}`).join(';') });
      out.push(line);
      continue;
    }
    // One style holding several codes is one shoe under several catalogue entries —
    // selling fast means meeting the cheapest of them.
    const [codeUsed, best] = priced.reduce((a, b) => (b[1].valueCents < a[1].valueCents ? b : a));
    const next = repriceDollars(best.valueCents, pctH);
    let action;
    if (next * 100 < oldCents) {
      n.lower++;
      n.reductionCents += oldCents - next * 100;
      action = 'REPRICED';
      if (!dryRun) {
        const raw = splitRaw(line);
        raw[cPrice] = formatLike(raw[cPrice].replace(/\r$/, ''), next) + (raw[cPrice].endsWith('\r') ? '\r' : '');
        line = raw.join(',');
      }
    } else if (next * 100 > oldCents) { n.higher++; action = 'kept (market higher)'; } else { n.equal++; action = 'kept (equal)'; }
    report.push({ ...base, market: dollarsText(best.valueCents), reprice: String(next), action, note: codes.length > 1 ? codeUsed : '' });
    out.push(line);
  }
  return { text: dryRun ? null : finalizeText(out, hrow, hdr, trailing), report, n };
}

// Drop "Available quantity" (eBay revises every column it is handed — the download's
// quantities would undo every sale since the export). Short rows are padded to the
// header's width first, so the #INFO line loses a comma with everyone else.
export function finalizeText(lines, hrow, hdr, trailing) {
  const drop = new Set(DROP_COLUMNS.map((c) => hdr.get(c)).filter((i) => i != null));
  const width = splitRaw(lines[hrow]).length;
  const out = lines.map((line) => {
    const f = splitRaw(line);
    while (f.length < width) f.push('');
    return f.filter((_, i) => !drop.has(i)).join(',');
  });
  return saveText(out, trailing);
}

/* ------------------------------ step 4: verify ------------------------------ */

// Prove the finished file differs from the original in Start price only: same row
// count, exactly the original columns minus the dropped one with no ragged rows, and
// every changed cell in Start price. A shifted column survives a skim and then revises
// thousands of live listings — so this gates the download.
export function verifyOutput(originalText, finishedText) {
  const old = parseCsv(originalText);
  const neu = parseCsv(finishedText);
  const hRow = (rows) => rows.slice(0, 5).findIndex((r) => r.length && r[0].trim() === 'Action');
  const oh = hRow(old);
  const nh = hRow(neu);
  const checks = [];
  checks.push({ label: 'Row count unchanged', ok: old.length === neu.length, detail: `${old.length} → ${neu.length}` });
  if (oh < 0 || nh < 0) {
    checks.push({ label: 'Header row found', ok: false, detail: 'No “Action” header row' });
    return { ok: false, checks, changed: 0 };
  }
  const oldHdr = old[oh].map((h) => h.trim());
  const newHdr = neu[nh].map((h) => h.trim());
  const expected = oldHdr.filter((c) => !DROP_COLUMNS.includes(c));
  const colsOk = expected.length === newHdr.length && expected.every((c, i) => c === newHdr[i]);
  const widths = new Set(neu.map((r) => r.length));
  checks.push({ label: `Columns = original minus ${DROP_COLUMNS.join(', ')}`, ok: colsOk, detail: `${newHdr.length} columns` });
  checks.push({ label: 'No ragged rows', ok: widths.size === 1 && widths.has(newHdr.length), detail: `widths ${[...widths].join(', ')}` });
  let changed = 0;
  let bad = 0;
  const badRows = [];
  if (colsOk) {
    const keep = oldHdr.map((c, i) => (DROP_COLUMNS.includes(c) ? -1 : i)).filter((i) => i >= 0);
    const price = newHdr.indexOf('Start price');
    for (let k = 0; k < Math.min(old.length - oh, neu.length - nh); k++) {
      const o = old[oh + k];
      const nr = neu[nh + k];
      const projected = keep.map((i) => o[i] ?? '');
      if (projected.length === nr.length && projected.every((v, j) => v === nr[j])) continue;
      changed++;
      if (projected.some((v, j) => j !== price && v !== (nr[j] ?? '')) || projected.length !== nr.length) {
        bad++;
        if (badRows.length < 5) badRows.push(oh + k + 1);
      }
    }
  }
  checks.push({ label: 'Every difference is in Start price', ok: colsOk && bad === 0,
    detail: bad ? `${bad} rows changed something else (lines ${badRows.join(', ')}…)` : `${changed} rows changed, all in Start price` });
  return { ok: checks.every((c) => c.ok), checks, changed };
}

/* -------------------------------- outputs --------------------------------- */

// "eBay-edit-price-quantity-template-2026-09-01-…csv" → "eBay reprice (9.1.2026).csv".
export function outputName(sourceName, fallbackYmd) {
  const m = String(sourceName || '').match(/(\d{4})-(\d{2})-(\d{2})/) || String(fallbackYmd || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `eBay reprice (${Number(m[2])}.${Number(m[3])}.${m[1]}).csv` : 'eBay reprice.csv';
}

const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportText(report, pctH) {
  const head = ['SKU', 'StyleID', 'Size', 'Old start price', 'Market price', `Reprice (x${multiplierLabel(pctH)})`, 'Action', 'Note'];
  const rows = report.map((r) => [r.sku, r.style, r.size, r.old, r.market, r.reprice, r.action, r.note]);
  return BOM + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
